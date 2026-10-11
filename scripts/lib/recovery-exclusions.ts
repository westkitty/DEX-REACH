import fs from 'node:fs/promises';
import path from 'node:path';
import { hashValue } from '../../src/shared/hash.js';

/**
 * Explicit, visible exclusions from owner-state coverage. An excluded subtree is never hashed, never
 * copied, and never followed through links: it is inventoried by lstat only (counts, logical bytes and a
 * listing digest), recorded in the manifest, and treated as intentionally absent by verification.
 *
 * Exclusions are opt-in. Every option defaults to off, so the default inspection includes everything.
 */
export const EXCLUSION_POLICY_VERSION = 1;
export type RuntimeReleasePolicy = 'all' | 'current-and-rollback';
export type ExclusionOptions = { ownerPolicy?: boolean; runtimeReleases?: RuntimeReleasePolicy };
export type ExclusionPolicyRecord = { version: 1; ownerPolicy: boolean; runtimeReleases: RuntimeReleasePolicy; retainedRuntimeReleases: string[] };
export type ExcludedSubtree = {
  rule: string; family: string; root: 'state'; relative: string; reason: string;
  files: number; links: number; directories: number; other: number; bytes: number; digest: string;
};
/** Problems that refuse a capture outright, with their exact code rather than SNAPSHOT_UNPROVEN. */
export const EXCLUSION_REFUSALS: ReadonlySet<string> = new Set(['EXCLUSION_HIDES_AUTHORITATIVE_FILE', 'LINK_TARGET_EXCLUDED_BY_POLICY', 'EXCLUSION_REMOVES_REQUIRED_FAMILY']);
export type ExclusionContext = { owner: boolean; runtime: RuntimeReleasePolicy; retained: ReadonlySet<string> };

/** Top-level owner-state names that exclusions may never reach into (ancestor, equal, or descendant). */
const PROTECTED_TOP = new Set([
  'tasks', 'results', 'receipts', 'nodes', 'node-auth.json', 'oauth.json', 'secrets.env', 'plans', 'coordinator',
  'recovery', 'runtime', 'LaunchAgents', 'worker', 'revoked-nodes.json', 'audit.jsonl', 'install-macos.status.json', 'config.json'
]);

/** Refuses any exclusion prefix that overlaps protected authority. Called for every rule at load time. */
export function assertExclusionPrefixAllowed(prefix: string): void {
  const parts = prefix.split('/');
  const top = parts[0] ?? '';
  if (!top || path.isAbsolute(prefix) || parts.some(p => !p || p === '.' || p === '..')) throw new Error('EXCLUSION_POLICY_INVALID_PREFIX');
  if (PROTECTED_TOP.has(top) || top.startsWith('oauth') || top.startsWith('com.stinkyweasel.dex-reach.')) throw new Error('EXCLUSION_POLICY_OVERLAPS_PROTECTED');
}

type OwnerRule = { id: string; family: 'compatibility' | 'checkpoints'; exact?: string; pattern?: RegExp; hint: string };
/** Owner-approved rules. Each names the excluded subtree root; nothing else is excluded by this policy. */
const OWNER_RULES: readonly OwnerRule[] = Object.freeze([
  { id: 'compat-home-pnpm-store', family: 'compatibility', exact: 'compat-home/Library/pnpm', hint: 'compat-home/Library/pnpm' },
  { id: 'compat-home-npm-cache', family: 'compatibility', exact: 'compat-home/.npm', hint: 'compat-home/.npm' },
  { id: 'compat-home-library-caches', family: 'compatibility', exact: 'compat-home/Library/Caches', hint: 'compat-home/Library/Caches' },
  { id: 'checkpoint-untracked-node-modules', family: 'checkpoints', pattern: /^checkpoints\/[^/]+\/untracked\/(?:[^/]+\/)*node_modules$/, hint: 'checkpoints' }
]);
for (const rule of OWNER_RULES) assertExclusionPrefixAllowed(rule.hint);

/**
 * Names that are authority wherever they appear, including inside an excluded cache tree. Finding one there
 * refuses the capture: an excluded name must never silently hide authoritative state.
 */
const AUTHORITY_NAME_ANYWHERE = /^(secrets\.env|node-auth\.json|revoked-nodes\.json|oauth[^/]*\.json|oauth-canary[^/]*\.json|.*\.access\.json|.*\.ed25519(\.pub)?\.pem|com\.stinkyweasel\.dex-reach\..+\.plist|install-macos\.status\.json|retained-evidence\.json|c13-maintenance\.json|macbook-air\.local\..*)$/;
/** Generic names that are authority only at their exact owner-state location. */
const AUTHORITY_AT_OWNER_LOCATION: ReadonlySet<string> = new Set(['tasks/store.json', 'tasks/events.jsonl', 'audit.jsonl', 'coordinator/history/events.jsonl']);
const AUTHORITY_UNDER_OWNER_LOCATION = /^receipts\/[^/]+\.jsonl$/;
/**
 * Cache trees hold third-party tool content. A `store.json` or `events.jsonl` inside pnpm, npm or a Library
 * cache is ordinary cache content, not owner authority, so it is judged by location, not by basename.
 */
const CACHE_TREES: readonly string[] = Object.freeze(['compat-home/']);

/** Source- and path-aware authority test for one entry, identified by its path relative to the state root. */
export function isAuthoritativeEntry(relative: string): boolean {
  if (AUTHORITY_NAME_ANYWHERE.test(path.posix.basename(relative))) return true;
  if (CACHE_TREES.some(tree => relative.startsWith(tree))) return false;
  return AUTHORITY_AT_OWNER_LOCATION.has(relative) || AUTHORITY_UNDER_OWNER_LOCATION.test(relative);
}

export function exclusionRuleFor(family: string, relative: string, ctx: ExclusionContext): { id: string; reason: string } | undefined {
  if (ctx.owner) {
    for (const rule of OWNER_RULES) {
      if (rule.family === family && (rule.exact !== undefined ? relative === rule.exact : rule.pattern!.test(relative))) return { id: rule.id, reason: 'excluded by owner policy' };
    }
  }
  if (ctx.runtime === 'current-and-rollback' && family === 'runtime') {
    const release = relative.match(/^runtime\/releases\/([^/]+)$/);
    if (release && !ctx.retained.has(release[1]!)) return { id: 'superseded-runtime-release', reason: 'superseded runtime release excluded by policy' };
  }
  return undefined;
}

export type SubtreeScan = { files: number; links: number; directories: number; other: number; bytes: number; digest: string; authoritative: string[] };
/**
 * lstat-only inventory of an excluded subtree. Symlinks are counted, never followed; no file content is read.
 * `bytes` is the logical size of regular files only.
 */
export async function scanExcludedSubtree(base: string, relative: string, device: number): Promise<SubtreeScan> {
  const lines: string[] = [], authoritative: string[] = [];
  const totals = { files: 0, links: 0, directories: 0, other: 0, bytes: 0 };
  const walk = async (rel: string): Promise<void> => {
    const st = await fs.lstat(path.join(base, rel));
    if (st.dev !== device) throw new Error('CROSS_VOLUME');
    const kind = st.isSymbolicLink() ? 'link' : st.isDirectory() ? 'directory' : st.isFile() ? 'file' : 'other';
    if (isAuthoritativeEntry(rel)) authoritative.push(rel);
    lines.push(`${kind}\t${rel}\t${st.size}\t${st.mode & 0o777}`);
    if (kind === 'file') { totals.files++; totals.bytes += st.size; }
    else if (kind === 'link') totals.links++;
    else if (kind === 'directory') totals.directories++;
    else totals.other++;
    if (kind === 'directory') for (const name of (await fs.readdir(path.join(base, rel))).sort()) await walk(`${rel}/${name}`);
  };
  await walk(relative);
  return { ...totals, digest: hashValue(lines.sort()), authoritative: authoritative.sort() };
}

const RELEASE_ID = /^[a-z0-9][a-z0-9._-]{0,119}$/;
const decodeXml = (value: string) => value.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

/**
 * The runtime release that LaunchAgents execute (`WorkingDirectory`, identical across all five labels) and the
 * single rollback target recorded by the installer for that release. Any ambiguity throws; nothing is guessed.
 */
export async function retainedRuntimeReleases(roots: { state: string; agents: string }, installRoot: string = roots.state): Promise<string[]> {
  const labels = ['coordinator', 'worker', 'gateway', 'node', 'oauth-canary'];
  const ids = new Set<string>();
  for (const role of labels) {
    const xml = await fs.readFile(path.join(roots.agents, `com.stinkyweasel.dex-reach.${role}.plist`), 'utf8').catch(() => { throw new Error('RUNTIME_RELEASE_UNDETERMINED'); });
    const declared = xml.match(/<key>WorkingDirectory<\/key>\s*<string>([^<]+)<\/string>/);
    if (!declared) throw new Error('RUNTIME_RELEASE_UNDETERMINED');
    const match = decodeXml(declared[1]!).match(/^(.+)\/runtime\/releases\/([^/]+)$/);
    // LaunchAgents name the live install root. A copy is checked against that recorded root, not its own location.
    if (!match || path.resolve(match[1]!) !== path.resolve(installRoot) || !RELEASE_ID.test(match[2]!)) throw new Error('RUNTIME_RELEASE_UNDETERMINED');
    ids.add(match[2]!);
  }
  if (ids.size !== 1) throw new Error('RUNTIME_RELEASE_UNDETERMINED');
  const current = [...ids][0]!;
  const rollbackRoot = path.join(roots.state, 'runtime', 'rollback');
  const candidates = await fs.readdir(rollbackRoot).catch(e => { if (e.code === 'ENOENT') return []; throw new Error('RUNTIME_ROLLBACK_UNDETERMINED'); });
  const targets: string[] = [];
  for (const dirName of candidates) {
    const raw = await fs.readFile(path.join(rollbackRoot, dirName, 'snapshot.json'), 'utf8').catch(e => { if (e.code === 'ENOENT') return null; throw new Error('RUNTIME_ROLLBACK_UNDETERMINED'); });
    if (raw === null) continue;
    let snapshot: { schemaVersion?: unknown; candidateReleaseId?: unknown; previousReleaseId?: unknown };
    try { snapshot = JSON.parse(raw); } catch { throw new Error('RUNTIME_ROLLBACK_UNDETERMINED'); }
    if (snapshot.schemaVersion !== 1 || snapshot.candidateReleaseId !== current) continue;
    if (snapshot.candidateReleaseId !== dirName || typeof snapshot.previousReleaseId !== 'string' || !RELEASE_ID.test(snapshot.previousReleaseId)) throw new Error('RUNTIME_ROLLBACK_UNDETERMINED');
    targets.push(snapshot.previousReleaseId);
  }
  if (targets.length !== 1) throw new Error('RUNTIME_ROLLBACK_UNDETERMINED');
  const previous = targets[0]!;
  if (previous === current) throw new Error('RUNTIME_ROLLBACK_UNDETERMINED');
  for (const id of [current, previous]) {
    const releaseDirectory = await fs.lstat(path.join(roots.state, 'runtime', 'releases', id)).catch(() => null);
    if (!releaseDirectory?.isDirectory()) throw new Error(id === current ? 'RUNTIME_RELEASE_UNDETERMINED' : 'RUNTIME_ROLLBACK_UNDETERMINED');
  }
  return [current, previous].sort();
}
