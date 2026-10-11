import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { inspectLink, classifyLink, defaultLinkPolicy, type LinkPolicy } from './recovery-symlinks.js';
import { hashValue } from '../../src/shared/hash.js';
import { realDirectory, safeRead } from './recovery-reconciliation.js';

export type Roots = { state: string; agents: string; worker: string };
export type Coverage = 'INCLUDED' | 'EXCLUDED_BY_POLICY' | 'MISSING' | 'UNKNOWN' | 'UNREADABLE' | 'DERIVED_ONLY' | 'BLOCKED_BY_LINK_POLICY';
export type Family = { id: string; root: keyof Roots; relative: string; required: boolean; sensitive: boolean; derived?: boolean; dependency: string };
/** Owner-state families are explicit, including signing keys and authority-bearing optional policies. */
export function recoveryFamilies(nodeId: string, preservation: string[] = []): Family[] {
  if (nodeId !== 'macbook-air.local') throw new Error('WRONG_NODE');
  const state = (id: string, relative: string, dependency: string, required = true, sensitive = true, derived = false): Family => ({ id, root: 'state', relative, dependency, required, sensitive, derived });
  return [
    state('tasks', 'tasks/store.json', 'lineage and task binding'), state('events', 'tasks/events.jsonl', 'persisted lifecycle'),
    state('results', 'results', 'task result references'), state('receipts', 'receipts', 'signed outcomes and signing keys'),
    state('enrollment', 'nodes', 'transport keys and per-node authority'), state('node-auth', 'node-auth.json', 'revocations and enrollment'),
    state('revocations', 'revoked-nodes.json', 'gateway independent revocation authority', false),
    state('oauth', 'oauth.json', 'client/token continuity'), state('secrets', 'secrets.env', 'gateway authentication'),
    state('plans', 'plans', 'one-use execution claims'), state('recovery', 'recovery', 'historical reconciliation evidence'),
    state('coordinator', 'coordinator', 'claims and history'), state('runtime', 'runtime', 'immutable releases and transactions'),
    state('audit', 'audit.jsonl', 'execution history'), state('checkpoints', 'checkpoints', 'workspace recovery'),
    state('install-status', 'install-macos.status.json', 'activation transaction'),
    state('activity', 'activity', 'process associations'),
    state('compatibility', 'compat-home', 'legacy protocol environment', false),
    state('install-rollback', 'install-rollback', 'historical installer preservation', false),
    state('canary', 'oauth-canary.json', 'OAuth canary configuration', false),
    state('canary-status', 'oauth-canary-status.json', 'derived OAuth diagnostic', false, true, true),
    state('oauth-health', 'oauth-health.json', 'derived OAuth diagnostic', false, true, true),
    state('logs', 'logs', 'diagnostics', false, true, true), state('traces', 'traces', 'causal evidence', false),
    { id: 'services', root: 'agents', relative: '', required: true, sensitive: true, dependency: 'five LaunchAgents' },
    { id: 'worker', root: 'worker', relative: 'config.json', required: true, sensitive: true, dependency: 'exact node and roots' },
    ...preservation.filter(n => /^macos-hardening-rollback-[A-Za-z0-9]{6}$/.test(n)).sort().map((n, i) => state(`historical-preservation-${i}`, n, 'five historical service definitions retained without rewriting'))
  ];
}
export function familyRegistry(names: string[] = []) {
  const writers: Record<string, string> = { tasks: 'src/node/task-store.ts', events: 'src/shared/task-events.ts', results: 'src/node/result-store.ts', receipts: 'src/shared/receipts.ts', enrollment: 'src/shared/access.ts + budget-policy.ts + budget-usage.ts + node-transport-auth.ts', 'node-auth': 'src/gateway/node-auth.ts', revocations: 'src/shared/revoked-nodes.ts', oauth: 'src/gateway/auth.ts', plans: 'src/shared/plans.ts', coordinator: 'src/shared/work-coordinator.ts', runtime: 'scripts/lib/runtime-release.ts + runtime-rollback.ts + install-macos.ts', services: 'scripts/install-macos.ts', worker: 'scripts/install-macos.ts', checkpoints: 'src/node/native.ts', compatibility: 'src/node/adapters/desktop-commander.ts', secrets: 'scripts/bootstrap.ts', 'install-status': 'scripts/install-macos.ts', canary: 'scripts/oauth-canary.ts', 'canary-status': 'scripts/oauth-canary.ts', 'oauth-health': 'src/shared/oauth-diagnostics.ts', logs: 'service stdout/stderr via installer-defined launchd paths', 'install-rollback': 'historical installer rollback preservation', recovery: 'src/node/task-recovery integration and historical owner evidence', activity: 'src/shared/activity.ts', traces: 'src/shared/trace.ts', audit: 'src/shared/audit.ts' };
  return { version: 1, families: recoveryFamilies('macbook-air.local', names).map(f => ({ ...f, category: f.id.startsWith('historical-preservation-') || ['recovery', 'install-rollback'].includes(f.id) ? 'HISTORICAL_PRESERVATION' : f.derived ? 'DERIVED' : !f.required ? 'OPTIONAL' : 'AUTHORITATIVE', writer: writers[f.id] ?? (f.id.startsWith('historical-preservation-') ? 'historical macOS service-preservation artifact; five plist inventory observed read-only' : 'owner/installer diagnostic or configuration writer; explicit path policy'), requiredContents: f.id === 'services' || f.id.startsWith('historical-preservation-') ? labels.map(l => `com.stinkyweasel.dex-reach.${l}.plist`) : mandatory.filter(p => p === f.relative || p.startsWith(f.relative + '/')), absenceNormal: !f.required, schemaHandling: 'canonical authority JSON; immutable-release dependencies, checkpoint payloads and compatibility-home contents are opaque integrity-bound bytes', retention: 'preserve; no pruning authority', backup: f.derived ? 'included as derived evidence' : 'include if present; required families must be complete' })) };
}
export type Entry = { residue?: 'ORPHANED_ATOMIC_TEMP'; family: string; root: keyof Roots; relative: string; bytes: number; mode: number; uid: number; gid: number; sha256: string; schema?: number; mtimeMs: number; sensitive: boolean; kind?: 'file' | 'link'; inode?: number; ctimeMs?: number; link?: Awaited<ReturnType<typeof inspectLink>> };
export type DirectoryEntry = { root: keyof Roots; relative: string; mode: number; uid: number; gid: number; inode: number; ctimeMs: number; names: string[] };
export type Manifest = { version: 1; scope: 'inspection' | 'synthetic'; nodeId: string; startedAt: string; endedAt: string; roots: Roots; linkPolicy: LinkPolicy; directories: DirectoryEntry[]; volumes: Record<keyof Roots, number>; families: Array<{ id: string; status: Coverage; dependency: string }>; entries: Entry[]; totalBytes: number; consistent: boolean; problems: string[]; digest: string };
const opaquePayload = (family: string, relative: string) => family === 'runtime' && /^runtime\/releases\/[a-z0-9][a-z0-9._-]{0,119}\//.test(relative) || family === 'compatibility' || family === 'checkpoints' && /^checkpoints\/[^/]+\/untracked\//.test(relative);
/**
 * `atomicWriteFile` writes `<file>.<pid>.<uuid>.tmp` and removes it in `finally`, so one only survives when its
 * writer process died before the rename commit point. Once that pid is gone the rename can never happen: the
 * bytes are uncommitted residue, never authoritative. A live pid (including a reused one) stays a blocking
 * transient write, failing closed.
 */
const ATOMIC_TEMP = /^(.+)\.([1-9]\d{0,9})\.[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.tmp$/;
export function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
}
export function orphanedAtomicTemp(name: string, alive: (pid: number) => boolean = processAlive): boolean {
  const match = name.match(ATOMIC_TEMP);
  return !!match && !alive(Number(match[2]));
}
/** The committed file an atomic-write temp belongs to: `store.json.<pid>.<uuid>.tmp` -> `store.json`. */
export const atomicTempBase = (name: string) => name.match(ATOMIC_TEMP)?.[1];
const sha = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');
const labels = ['coordinator', 'worker', 'gateway', 'node', 'oauth-canary'];
const mandatory = ['results/manifest.json', 'nodes/macbook-air.local.env', 'nodes/macbook-air.local.access.json', 'nodes/macbook-air.local.transport.ed25519.pem', 'nodes/macbook-air.local.transport.ed25519.pub.pem', 'receipts/macbook-air.local.jsonl', 'receipts/macbook-air.local.ed25519.pem', 'receipts/macbook-air.local.ed25519.pub.pem'];
export function manifestDigest(m: Omit<Manifest, 'digest'> | Manifest): string { const { digest: _digest, ...body } = m as Manifest; return hashValue(body); }

/** No directories, locks, caches or output files are created. Manifest contains PRIVATE hashes. */
export type CoverageOptions = { heldLocks?: ReadonlySet<string> };
/** Locks a checkpoint holder in this process holds while fencing writers; scoped to that fence only. */
const fenceScopes: Array<ReadonlySet<string>> = [];
export async function withFencedLocks<T>(locks: ReadonlySet<string>, fn: () => Promise<T>): Promise<T> {
  fenceScopes.push(locks);
  try { return await fn(); } finally { fenceScopes.splice(fenceScopes.indexOf(locks), 1); }
}
/** Runtime-only checkpoint control endpoints at the state root: sockets and the holder lock, never copied. */
const CONTROL_DIRECTORY = 'checkpoint';
export async function inspectCoverage(roots: Roots, scope: Manifest['scope'] = 'inspection', linkPolicy: LinkPolicy = defaultLinkPolicy(), options: CoverageOptions = {}): Promise<Manifest> {
  for (const root of Object.values(roots)) await realDirectory(root);
  const startedAt = new Date().toISOString(), entries: Entry[] = [], problems: string[] = [], families: Manifest['families'] = [], directories: DirectoryEntry[] = [];
  const observedDirectories = new Map<string, { inode: number; ctimeMs: number; dev: number; names: string[] }>();
  const volumes = { state: (await fs.lstat(roots.state)).dev, agents: (await fs.lstat(roots.agents)).dev, worker: (await fs.lstat(roots.worker)).dev };
  let consistent = true;
  // Only locks this process verifiably holds (a checkpoint fence) are excluded; any other lock still blocks.
  const held = new Set<string>();
  for (const file of [...(options.heldLocks ?? []), ...fenceScopes.flatMap(scope => [...scope])]) {
    try { if ((JSON.parse(await fs.readFile(file, 'utf8')) as { pid?: unknown }).pid === process.pid) held.add(path.resolve(file)); } catch { /* Unverifiable locks stay visible. */ }
  }
  const listNames = async (directory: string) => (await fs.readdir(directory)).filter(name => !held.has(path.resolve(directory, name))).sort();
  const stateNames = (await listNames(roots.state)).filter(name => name !== CONTROL_DIRECTORY);
  const policy = recoveryFamilies('macbook-air.local', stateNames);
  const known = new Set(policy.filter(f => f.root === 'state').map(f => f.relative.split('/')[0]));
  const unknownFamily = () => { problems.push('UNKNOWN_OWNER_STATE_FAMILY'); families.push({ id: `unknown-${families.length}`, status: 'UNKNOWN', dependency: 'unmapped owner-state requires explicit coverage policy' }); };
  for (const name of stateNames) if (!known.has(name)) unknownFamily();
  // Services and worker roots are closed-world too: only the shared LaunchAgents directory may hold non-DEX entries.
  const servicePlists = new Set(labels.map(label => `com.stinkyweasel.dex-reach.${label}.plist`));
  for (const name of await fs.readdir(roots.agents)) if (name.startsWith('com.stinkyweasel.dex-reach.') && !servicePlists.has(name)) unknownFamily();
  if ((await fs.readdir(roots.state)).includes(CONTROL_DIRECTORY)) {
    const control = path.join(roots.state, CONTROL_DIRECTORY), st = await fs.lstat(control);
    if (st.isSymbolicLink() || !st.isDirectory() || (st.mode & 0o077) !== 0) problems.push('checkpoint-control:INVALID_OR_UNSUPPORTED');
    else for (const name of await listNames(control)) {
      if (/^(node|gateway)\.sock$/.test(name) && (await fs.lstat(path.join(control, name))).isSocket()) continue;
      if (/\.lock$|\.recovery$/.test(name)) problems.push('checkpoint-control:TRANSIENT_WRITE_OR_LOCK_PRESENT'); else unknownFamily();
    }
  }
  for (const name of await fs.readdir(roots.worker)) {
    // worker.sock is the live IPC endpoint: runtime-only, never copied, but must actually be a socket.
    if (name === 'config.json') continue;
    if (name === 'worker.sock' && (await fs.lstat(path.join(roots.worker, name))).isSocket()) continue;
    unknownFamily();
  }
  const rootStat = await fs.lstat(roots.state);
  observedDirectories.set(roots.state, { inode: rootStat.ino, ctimeMs: rootStat.ctimeMs, dev: rootStat.dev, names: stateNames });
  directories.push({ root: 'state', relative: '', mode: rootStat.mode & 0o777, uid: rootStat.uid, gid: rootStat.gid, inode: rootStat.ino, ctimeMs: rootStat.ctimeMs, names: stateNames });
  // A directory holding file-level families (tasks/) is closed-world: unmapped siblings cannot hide beside them.
  const fileParents = new Map<string, Set<string>>(), residues = new Map<string, string>();
  for (const f of policy) if (f.root === 'state' && f.relative.includes('/')) { const parent = path.dirname(f.relative); fileParents.set(parent, (fileParents.get(parent) ?? new Set()).add(path.basename(f.relative))); }
  for (const [parent, allowed] of fileParents) {
    const dir = path.join(roots.state, parent), st = await fs.lstat(dir).catch(() => null);
    if (!st) continue; // Required file families report MISSING themselves.
    if (st.isSymbolicLink() || !st.isDirectory()) { problems.push(`${parent}:INVALID_OR_UNSUPPORTED`); continue; }
    const names = await listNames(dir);
    observedDirectories.set(dir, { inode: st.ino, ctimeMs: st.ctimeMs, dev: st.dev, names });
    directories.push({ root: 'state', relative: parent, mode: st.mode & 0o777, uid: st.uid, gid: st.gid, inode: st.ino, ctimeMs: st.ctimeMs, names });
    for (const name of names) if (!allowed.has(name)) {
      const owner = policy.find(f => f.root === 'state' && f.relative === `${parent}/${atomicTempBase(name)}`);
      if (owner && orphanedAtomicTemp(name) && (await fs.lstat(path.join(dir, name))).isFile()) residues.set(`${parent}/${name}`, owner.id);
      else if (/\.lock$|\.tmp$/.test(name)) problems.push(`${parent}:TRANSIENT_WRITE_OR_LOCK_PRESENT`); else unknownFamily();
    }
  }
  for (const family of policy) {
    let status: Coverage = family.derived ? 'DERIVED_ONLY' : 'INCLUDED';
    const base = roots[family.root], device = (await fs.lstat(base)).dev;
    let rootSeen = false, linkRefused = false;
    async function visit(relative: string): Promise<void> {
      const file = path.join(base, relative), before = await fs.lstat(file);
      if (relative === family.relative) rootSeen = true;
      if (before.isSymbolicLink()) {
        let link: Awaited<ReturnType<typeof inspectLink>>;
        try { link = await inspectLink(base, relative, linkPolicy); }
        catch (error) {
          // A refused link is reported precisely and left out; the walk continues so later entries stay inventoried.
          let code = (error as Error).message;
          if (code === 'UNAPPROVED_LINK') code += `_${await classifyLink(base, relative, family.relative).catch(e => `UNCLASSIFIABLE_${(e as Error).message}`)}`;
          linkRefused = true; problems.push(`${family.id}:LINK_REFUSED:${code}`);
          return;
        }
        entries.push({ family: family.id, root: family.root, relative, kind: 'link', link, bytes: Buffer.byteLength(link.target), mode: before.mode & 0o777, uid: before.uid, gid: before.gid, sha256: sha(Buffer.from(link.target)), mtimeMs: before.mtimeMs, ctimeMs: before.ctimeMs, inode: before.ino, sensitive: true });
        return;
      }
      if (before.dev !== device) throw new Error('CROSS_VOLUME');
      if (before.isDirectory()) {
        const names = await listNames(file);
        observedDirectories.set(file, { inode: before.ino, ctimeMs: before.ctimeMs, dev: before.dev, names });
        directories.push({ root: family.root, relative, mode: before.mode & 0o777, uid: before.uid, gid: before.gid, inode: before.ino, ctimeMs: before.ctimeMs, names });
        for (const name of names) {
          const childRelative = relative ? `${relative}/${name}` : name;
          if (!opaquePayload(family.id, childRelative) && /\.lock$|\.tmp$/.test(name) && !(orphanedAtomicTemp(name) && (await fs.lstat(path.join(file, name))).isFile())) { problems.push(`${family.id}:TRANSIENT_WRITE_OR_LOCK_PRESENT`); continue; }
          await visit(relative ? `${relative}/${name}` : name);
        }
        return;
      }
      if (!before.isFile()) throw new Error('SPECIAL_FILE');
      const bytes = await safeRead(base, relative, 512 * 1024 * 1024), after = await fs.lstat(file);
      if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ino !== after.ino) { consistent = false; problems.push(`${family.id}:CHANGED_DURING_INSPECTION`); }
      let schema: number | undefined;
      const residue = !opaquePayload(family.id, relative) && orphanedAtomicTemp(path.basename(relative)) ? { residue: 'ORPHANED_ATOMIC_TEMP' as const } : {};
      if (relative.endsWith('.json') && !opaquePayload(family.id, relative)) {
        const value = JSON.parse(bytes.toString()); schema = value.schemaVersion ?? (typeof value.version === 'number' ? value.version : undefined);
        if (schema !== undefined && (!Number.isInteger(schema) || schema < 1)) throw new Error('SCHEMA');
      }
      entries.push({ ...residue, family: family.id, root: family.root, relative, bytes: bytes.length, mode: before.mode & 0o777, uid: before.uid, gid: before.gid, sha256: sha(bytes), ...(schema !== undefined ? { schema } : {}), mtimeMs: before.mtimeMs, sensitive: family.sensitive, kind: 'file', inode: before.ino, ctimeMs: before.ctimeMs });
    }
    try {
      if (family.id === 'services') for (const label of labels) await visit(`com.stinkyweasel.dex-reach.${label}.plist`);
      else await visit(family.relative);
      for (const [relative, owner] of residues) if (owner === family.id) await visit(relative);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      // Only an absent family root is a policy exclusion; anything vanishing mid-walk truncated the inventory.
      status = code === 'ENOENT' && !rootSeen ? (family.required ? 'MISSING' : 'EXCLUDED_BY_POLICY') : 'UNREADABLE';
      if (code === 'ENOENT' && rootSeen) consistent = false;
      if (status !== 'EXCLUDED_BY_POLICY') problems.push(`${family.id}:${code ?? 'INVALID_OR_UNSUPPORTED'}`);
    }
    if (linkRefused && status === 'INCLUDED') status = 'BLOCKED_BY_LINK_POLICY';
    if (family.required && status === 'INCLUDED' && !entries.some(e => e.family === family.id)) { status = 'MISSING'; problems.push(`${family.id}:EMPTY_REQUIRED_FAMILY`); }
    families.push({ id: family.id, status, dependency: family.dependency });
  }
  // A live read is not a coordinated snapshot. Require unchanged files at the end as well.
  for (const entry of entries) {
    const st = await fs.lstat(path.join(roots[entry.root], entry.relative)).catch(() => null);
    if (!st || (entry.kind !== 'link' && st.size !== entry.bytes) || st.mtimeMs !== entry.mtimeMs || st.ctimeMs !== entry.ctimeMs || st.ino !== entry.inode) { consistent = false; problems.push(`${entry.family}:SNAPSHOT_CHANGED`); }
  }
  for (const entry of entries) {
    try {
      const actual = entry.kind === 'link' ? Buffer.from((await inspectLink(roots[entry.root], entry.relative, linkPolicy)).target) : await safeRead(roots[entry.root], entry.relative, 512 * 1024 * 1024);
      if (sha(actual) !== entry.sha256) { consistent = false; problems.push('CONTENT_CHANGED_AFTER_HASH'); }
    } catch { consistent = false; problems.push('ENTRY_CHANGED_AFTER_HASH'); }
  }
  for (const entry of entries.filter(e => e.kind === 'link' && e.link!.requiredTarget)) {
    if (!entries.some(e => e.root === entry.root && e.relative === entry.link!.resolvedRelative && e.kind !== 'link') && !directories.some(d => d.root === entry.root && d.relative === entry.link!.resolvedRelative)) problems.push('LINK_TARGET_NOT_INDEPENDENTLY_COVERED');
  }
  for (const [file, before] of observedDirectories) {
    const st = await fs.lstat(file).catch(() => null), names = st?.isDirectory() ? (file === roots.state ? (await listNames(file)).filter(n => n !== CONTROL_DIRECTORY) : await listNames(file)) : [];
    if (!st || st.isSymbolicLink() || st.ino !== before.inode || st.ctimeMs !== before.ctimeMs || st.dev !== before.dev || JSON.stringify(names) !== JSON.stringify(before.names)) { consistent = false; problems.push('DIRECTORY_MEMBERSHIP_CHANGED'); }
  }
  entries.sort((a, b) => `${a.root}/${a.relative}`.localeCompare(`${b.root}/${b.relative}`));
  for (const f of policy.filter(f => f.id.startsWith('historical-preservation-'))) for (const label of labels) if (!entries.some(e => e.relative === `${f.relative}/com.stinkyweasel.dex-reach.${label}.plist` && e.kind === 'file')) problems.push('HISTORICAL_PRESERVATION_INCOMPLETE');
  for (const relative of mandatory) if (!entries.some(e => e.root === 'state' && e.relative === relative)) problems.push('MISSING_RECOVERY_DEPENDENCY');
  const body: Omit<Manifest, 'digest'> = { version: 1, scope, nodeId: 'macbook-air.local', startedAt, endedAt: new Date().toISOString(), roots, linkPolicy, directories, volumes, families, entries, totalBytes: entries.reduce((sum, e) => sum + e.bytes, 0), consistent, problems };
  return { ...body, digest: manifestDigest(body) };
}
function validateManifest(raw: unknown, expectedDigest: string): Manifest {
  const m = raw as Manifest;
  if (!m || m.version !== 1 || m.nodeId !== 'macbook-air.local' || !m.linkPolicy || m.linkPolicy.version !== 1 || !Array.isArray(m.linkPolicy.rules) || !Array.isArray(m.entries) || !Array.isArray(m.directories) || !m.volumes || !Array.isArray(m.families) || !m.consistent || !Array.isArray(m.problems) || m.problems.length || manifestDigest(m) !== expectedDigest || m.digest !== expectedDigest) throw new Error('MANIFEST_INVALID_OR_UNTRUSTED');
  if (!Number.isFinite(Date.parse(m.startedAt)) || !Number.isFinite(Date.parse(m.endedAt)) || Date.parse(m.endedAt) < Date.parse(m.startedAt)) throw new Error('INCONSISTENT_TIMESTAMPS');
  const policy = recoveryFamilies(m.nodeId, m.directories.find(d => d.root === 'state' && d.relative === '')?.names), ids = m.families.map(f => f.id);
  if (new Set(ids).size !== policy.length || ids.length !== policy.length || policy.some(f => !ids.includes(f.id) || (f.required && m.families.find(x => x.id === f.id)?.status !== 'INCLUDED'))) throw new Error('INCOMPLETE_COVERAGE');
  const keys = m.entries.map(e => `${e.root}/${e.relative}`);
  if (new Set(keys).size !== keys.length || m.totalBytes !== m.entries.reduce((n, e) => n + e.bytes, 0)) throw new Error('DUPLICATE_OR_TRUNCATED_INVENTORY');
  for (const e of m.entries) {
    const f = policy.find(f => f.id === e.family);
    if (!f || e.root !== f.root || !e.relative || path.isAbsolute(e.relative) || e.relative.split(/[\\/]/).some(v => !v || v === '.' || v === '..') || (f.relative && e.relative !== f.relative && !e.relative.startsWith(`${f.relative}/`) && !(e.residue === 'ORPHANED_ATOMIC_TEMP' && path.dirname(e.relative) === path.dirname(f.relative) && atomicTempBase(path.basename(e.relative)) === path.basename(f.relative))) || (e.residue !== undefined && (e.residue !== 'ORPHANED_ATOMIC_TEMP' || e.kind !== 'file' || !ATOMIC_TEMP.test(path.basename(e.relative)))) || !/^[a-f0-9]{64}$/.test(e.sha256) || !Number.isSafeInteger(e.bytes) || e.bytes < 0 || !Number.isInteger(e.mode) || !Number.isInteger(e.uid) || !Number.isInteger(e.gid)) throw new Error('INVALID_ENTRY');
  }
  if (policy.some(f => f.required && !m.entries.some(e => e.family === f.id))) throw new Error('EMPTY_AUTHORITATIVE_FAMILY');
  if (mandatory.some(relative => !m.entries.some(e => e.root === 'state' && e.relative === relative))) throw new Error('MISSING_RECOVERY_DEPENDENCY');
  const directoryKeys = m.directories.map(d => `${d.root}/${d.relative}`);
  if (new Set(directoryKeys).size !== directoryKeys.length || m.directories.some(d => !['state', 'agents', 'worker'].includes(d.root) || path.isAbsolute(d.relative) || d.relative.split(/[\\/]/).some(v => v === '.' || v === '..') || !Array.isArray(d.names) || d.names.some(n => /[\\/]/.test(n) || n === '.' || n === '..'))) throw new Error('INVALID_DIRECTORY_INVENTORY');
  return m;
}
/** expectedDigest must come from a separately protected inventory, never from the backup itself. */
export async function verifyCoverage(raw: unknown, roots: Roots, expectedDigest: string): Promise<{ certified: true; files: number; bytes: number }> {
  const m = validateManifest(raw, expectedDigest);
  const observed = await inspectCoverage(roots, m.scope, m.linkPolicy);
  if (m.entries.some(e => e.kind === 'link' && (!e.link || e.sha256 !== sha(Buffer.from(e.link.target))))) throw new Error('INVALID_LINK_MANIFEST');
  if (JSON.stringify(observed.volumes) !== JSON.stringify(m.volumes)) throw new Error('VOLUME_IDENTITY_MISMATCH');
  if (!observed.consistent || observed.problems.length || observed.entries.length !== m.entries.length || observed.directories.length !== m.directories.length) throw new Error('SNAPSHOT_INCOMPLETE_OR_CHANGED');
  for (const e of m.entries) {
    const actual = observed.entries.find(a => a.root === e.root && a.relative === e.relative);
    if (!actual || ['family', 'sha256', 'bytes', 'mode', 'uid', 'gid', 'schema', 'kind', 'residue'].some(k => (actual as any)[k] !== (e as any)[k])) throw new Error('INTEGRITY_PERMISSION_OR_SCHEMA_MISMATCH');
    if (JSON.stringify(actual.link) !== JSON.stringify(e.link)) throw new Error('LINK_METADATA_MISMATCH');
  }
  // Directory membership and mode matter even when a directory has no files.
  for (const d of m.directories) {
    const actual = observed.directories.find(a => a.root === d.root && a.relative === d.relative);
    if (!actual || ['mode', 'uid', 'gid'].some(k => (actual as any)[k] !== (d as any)[k]) || JSON.stringify(actual.names) !== JSON.stringify(d.names)) throw new Error('DIRECTORY_INVENTORY_MISMATCH');
  }
  return { certified: true, files: m.entries.length, bytes: m.totalBytes };
}
/** Public output contains neither credential hashes nor private file paths or values. */
export function publicCoverage(m: Manifest) { return { version: m.version, scope: m.scope, nodeId: m.nodeId, consistent: m.consistent, certification: 'NOT_CERTIFIED_INSPECTION_ONLY', totalBytes: m.totalBytes, files: m.entries.length, families: m.families, problems: m.problems }; }
