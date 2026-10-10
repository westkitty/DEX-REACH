import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { hashValue } from '../../src/shared/hash.js';
import { realDirectory, safeRead } from './recovery-reconciliation.js';

export type Roots = { state: string; agents: string; worker: string };
export type Coverage = 'INCLUDED' | 'EXCLUDED_BY_POLICY' | 'MISSING' | 'UNKNOWN' | 'UNREADABLE' | 'DERIVED_ONLY';
export type Family = { id: string; root: keyof Roots; relative: string; required: boolean; sensitive: boolean; derived?: boolean; dependency: string };
/** Owner-state families are explicit, including signing keys and authority-bearing optional policies. */
export function recoveryFamilies(nodeId: string): Family[] {
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
    { id: 'worker', root: 'worker', relative: 'config.json', required: true, sensitive: true, dependency: 'exact node and roots' }
  ];
}
export type Entry = { family: string; root: keyof Roots; relative: string; bytes: number; mode: number; uid: number; gid: number; sha256: string; schema?: number; mtimeMs: number; sensitive: boolean };
export type DirectoryEntry = { root: keyof Roots; relative: string; mode: number; uid: number; gid: number; names: string[] };
export type Manifest = { version: 1; scope: 'inspection' | 'synthetic'; nodeId: string; startedAt: string; endedAt: string; roots: Roots; directories: DirectoryEntry[]; volumes: Record<keyof Roots, number>; families: Array<{ id: string; status: Coverage; dependency: string }>; entries: Entry[]; totalBytes: number; consistent: boolean; problems: string[]; digest: string };
const sha = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');
const labels = ['coordinator', 'worker', 'gateway', 'node', 'oauth-canary'];
const mandatory = ['results/manifest.json', 'nodes/macbook-air.local.env', 'nodes/macbook-air.local.access.json', 'nodes/macbook-air.local.transport.ed25519.pem', 'nodes/macbook-air.local.transport.ed25519.pub.pem', 'receipts/macbook-air.local.jsonl', 'receipts/macbook-air.local.ed25519.pem', 'receipts/macbook-air.local.ed25519.pub.pem'];
export function manifestDigest(m: Omit<Manifest, 'digest'> | Manifest): string { const { digest: _digest, ...body } = m as Manifest; return hashValue(body); }

/** No directories, locks, caches or output files are created. Manifest contains PRIVATE hashes. */
export async function inspectCoverage(roots: Roots, scope: Manifest['scope'] = 'inspection'): Promise<Manifest> {
  for (const root of Object.values(roots)) await realDirectory(root);
  const startedAt = new Date().toISOString(), entries: Entry[] = [], problems: string[] = [], families: Manifest['families'] = [], directories: DirectoryEntry[] = [];
  const observedDirectories = new Map<string, { inode: number; dev: number; names: string[] }>();
  const volumes = { state: (await fs.lstat(roots.state)).dev, agents: (await fs.lstat(roots.agents)).dev, worker: (await fs.lstat(roots.worker)).dev };
  let consistent = true;
  const known = new Set(recoveryFamilies('macbook-air.local').filter(f => f.root === 'state').map(f => f.relative.split('/')[0]));
  const stateNames = (await fs.readdir(roots.state)).sort();
  for (const name of stateNames) if (!known.has(name)) { problems.push('UNKNOWN_OWNER_STATE_FAMILY'); families.push({ id: `unknown-${families.length}`, status: 'UNKNOWN', dependency: 'unmapped owner-state requires explicit coverage policy' }); }
  const rootStat = await fs.lstat(roots.state);
  observedDirectories.set(roots.state, { inode: rootStat.ino, dev: rootStat.dev, names: stateNames });
  directories.push({ root: 'state', relative: '', mode: rootStat.mode & 0o777, uid: rootStat.uid, gid: rootStat.gid, names: stateNames });
  for (const family of recoveryFamilies('macbook-air.local')) {
    let status: Coverage = family.derived ? 'DERIVED_ONLY' : 'INCLUDED';
    const base = roots[family.root], device = (await fs.lstat(base)).dev;
    async function visit(relative: string): Promise<void> {
      const file = path.join(base, relative), before = await fs.lstat(file);
      if (before.isSymbolicLink()) throw new Error('SYMLINK');
      if (before.dev !== device) throw new Error('CROSS_VOLUME');
      if (before.isDirectory()) {
        const names = (await fs.readdir(file)).sort();
        observedDirectories.set(file, { inode: before.ino, dev: before.dev, names });
        directories.push({ root: family.root, relative, mode: before.mode & 0o777, uid: before.uid, gid: before.gid, names });
        for (const name of names) {
          if (/\.lock$|\.tmp$/.test(name)) { problems.push(`${family.id}:TRANSIENT_WRITE_OR_LOCK_PRESENT`); continue; }
          await visit(relative ? `${relative}/${name}` : name);
        }
        return;
      }
      if (!before.isFile()) throw new Error('SPECIAL_FILE');
      const bytes = await safeRead(base, relative, 512 * 1024 * 1024), after = await fs.lstat(file);
      if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ino !== after.ino) { consistent = false; problems.push(`${family.id}:CHANGED_DURING_INSPECTION`); }
      let schema: number | undefined;
      if (relative.endsWith('.json')) {
        const value = JSON.parse(bytes.toString()); schema = value.schemaVersion ?? (typeof value.version === 'number' ? value.version : undefined);
        if (schema !== undefined && (!Number.isInteger(schema) || schema < 1)) throw new Error('SCHEMA');
      }
      entries.push({ family: family.id, root: family.root, relative, bytes: bytes.length, mode: before.mode & 0o777, uid: before.uid, gid: before.gid, sha256: sha(bytes), ...(schema !== undefined ? { schema } : {}), mtimeMs: before.mtimeMs, sensitive: family.sensitive });
    }
    try {
      if (family.id === 'services') for (const label of labels) await visit(`com.stinkyweasel.dex-reach.${label}.plist`);
      else await visit(family.relative);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      status = code === 'ENOENT' ? (family.required ? 'MISSING' : 'EXCLUDED_BY_POLICY') : 'UNREADABLE';
      if (status !== 'EXCLUDED_BY_POLICY') problems.push(`${family.id}:${code ?? 'INVALID_OR_UNSUPPORTED'}`);
    }
    if (family.required && status === 'INCLUDED' && !entries.some(e => e.family === family.id)) { status = 'MISSING'; problems.push(`${family.id}:EMPTY_REQUIRED_FAMILY`); }
    families.push({ id: family.id, status, dependency: family.dependency });
  }
  // A live read is not a coordinated snapshot. Require unchanged files at the end as well.
  for (const entry of entries) {
    const st = await fs.lstat(path.join(roots[entry.root], entry.relative)).catch(() => null);
    if (!st || st.size !== entry.bytes || st.mtimeMs !== entry.mtimeMs) { consistent = false; problems.push(`${entry.family}:SNAPSHOT_CHANGED`); }
  }
  for (const [file, before] of observedDirectories) {
    const st = await fs.lstat(file).catch(() => null), names = st?.isDirectory() ? (await fs.readdir(file)).sort() : [];
    if (!st || st.isSymbolicLink() || st.ino !== before.inode || st.dev !== before.dev || JSON.stringify(names) !== JSON.stringify(before.names)) { consistent = false; problems.push('DIRECTORY_MEMBERSHIP_CHANGED'); }
  }
  entries.sort((a, b) => `${a.root}/${a.relative}`.localeCompare(`${b.root}/${b.relative}`));
  for (const relative of mandatory) if (!entries.some(e => e.root === 'state' && e.relative === relative)) problems.push('MISSING_RECOVERY_DEPENDENCY');
  const body: Omit<Manifest, 'digest'> = { version: 1, scope, nodeId: 'macbook-air.local', startedAt, endedAt: new Date().toISOString(), roots, directories, volumes, families, entries, totalBytes: entries.reduce((sum, e) => sum + e.bytes, 0), consistent, problems };
  return { ...body, digest: manifestDigest(body) };
}
function validateManifest(raw: unknown, expectedDigest: string): Manifest {
  const m = raw as Manifest;
  if (!m || m.version !== 1 || m.nodeId !== 'macbook-air.local' || !Array.isArray(m.entries) || !Array.isArray(m.directories) || !m.volumes || !Array.isArray(m.families) || !m.consistent || !Array.isArray(m.problems) || m.problems.length || manifestDigest(m) !== expectedDigest || m.digest !== expectedDigest) throw new Error('MANIFEST_INVALID_OR_UNTRUSTED');
  if (!Number.isFinite(Date.parse(m.startedAt)) || !Number.isFinite(Date.parse(m.endedAt)) || Date.parse(m.endedAt) < Date.parse(m.startedAt)) throw new Error('INCONSISTENT_TIMESTAMPS');
  const policy = recoveryFamilies(m.nodeId), ids = m.families.map(f => f.id);
  if (new Set(ids).size !== policy.length || ids.length !== policy.length || policy.some(f => !ids.includes(f.id) || (f.required && m.families.find(x => x.id === f.id)?.status !== 'INCLUDED'))) throw new Error('INCOMPLETE_COVERAGE');
  const keys = m.entries.map(e => `${e.root}/${e.relative}`);
  if (new Set(keys).size !== keys.length || m.totalBytes !== m.entries.reduce((n, e) => n + e.bytes, 0)) throw new Error('DUPLICATE_OR_TRUNCATED_INVENTORY');
  for (const e of m.entries) {
    const f = policy.find(f => f.id === e.family);
    if (!f || e.root !== f.root || !e.relative || path.isAbsolute(e.relative) || e.relative.split(/[\\/]/).some(v => !v || v === '.' || v === '..') || (f.relative && e.relative !== f.relative && !e.relative.startsWith(`${f.relative}/`)) || !/^[a-f0-9]{64}$/.test(e.sha256) || !Number.isSafeInteger(e.bytes) || e.bytes < 0 || !Number.isInteger(e.mode) || !Number.isInteger(e.uid) || !Number.isInteger(e.gid)) throw new Error('INVALID_ENTRY');
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
  const observed = await inspectCoverage(roots, m.scope);
  if (JSON.stringify(observed.volumes) !== JSON.stringify(m.volumes)) throw new Error('VOLUME_IDENTITY_MISMATCH');
  if (!observed.consistent || observed.problems.length || observed.entries.length !== m.entries.length || observed.directories.length !== m.directories.length) throw new Error('SNAPSHOT_INCOMPLETE_OR_CHANGED');
  for (const e of m.entries) {
    const actual = observed.entries.find(a => a.root === e.root && a.relative === e.relative);
    if (!actual || ['family', 'sha256', 'bytes', 'mode', 'uid', 'gid', 'schema'].some(k => (actual as any)[k] !== (e as any)[k])) throw new Error('INTEGRITY_PERMISSION_OR_SCHEMA_MISMATCH');
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
