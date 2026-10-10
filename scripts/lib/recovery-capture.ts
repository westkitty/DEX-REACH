import fs from 'node:fs/promises';
import path from 'node:path';
import { recoveryStoragePlan } from './recovery-storage.js';
import { requiredFreeBytes } from './c14-recovery-preflight.js';
import { hashValue } from '../../src/shared/hash.js';
import { safeRead, realDirectory } from './recovery-reconciliation.js';
import { assertOwned, rehearseRestore, type SyntheticWorkspace } from './recovery-rehearsal.js';
import { validateBoundary, type SnapshotBoundary } from './recovery-consistency.js';
import { verifyCoverage, type Manifest, type Roots } from './recovery-coverage.js';
import { destinationBlockers, type DestinationFacts } from './recovery-destination.js';

export type SyntheticCaptureReceipt = Readonly<{ scope: 'synthetic'; status: 'SYNTHETIC_BACKUP_CERTIFIED'; transactionId: string; manifestDigest: string; artifactDigest: string; applicationRestore: true; installationAuthority: false }>;
const receipts = new WeakSet<object>();
const transactions = new WeakMap<SyntheticWorkspace, Map<string, { state: 'COPYING' | 'UNCERTAIN' | 'CERTIFIED'; receipt?: SyntheticCaptureReceipt }>>();
function ledger(w: SyntheticWorkspace) { let l = transactions.get(w); if (!l) { l = new Map(); transactions.set(w, l); } return l; }
/** The three captured roots inside one transaction directory. */
export const stagingRoots = (staging: string): Roots => ({ state: path.join(staging, 'state'), agents: path.join(staging, 'agents'), worker: path.join(staging, 'worker') });
/**
 * Copy exactly the manifest's directories, files and links from `source` into a new staging directory.
 * The staging directory is created exclusively; files are written exclusively and fsynced. `beforeFile`
 * runs before every file so the caller can re-prove its source boundary. Links are recreated from the
 * manifest's recorded text, never by reading or following the source.
 */
export async function materializeManifest(manifest: Manifest, source: Roots, staging: string, beforeFile: () => Promise<void> = async () => {}): Promise<Roots> {
  const roots = stagingRoots(staging);
  await fs.mkdir(staging, { mode: 0o700 });
  for (const r of Object.values(roots)) await fs.mkdir(r, { mode: 0o700 });
  for (const d of manifest.directories) { const target = path.join(roots[d.root], d.relative); await fs.mkdir(target, { recursive: true, mode: d.mode }); await realDirectory(target); await fs.chmod(target, d.mode); }
  for (const e of manifest.entries.filter(e => e.kind !== 'link')) {
    await beforeFile(); await fs.mkdir(path.dirname(path.join(roots[e.root], e.relative)), { recursive: true, mode: 0o700 }); await realDirectory(path.dirname(path.join(roots[e.root], e.relative)));
    await durableWrite(path.join(roots[e.root], e.relative), await safeRead(source[e.root], e.relative, 512 * 1024 * 1024), e.mode);
  }
  for (const e of manifest.entries.filter(e => e.kind === 'link')) { if (!e.link) throw new Error('LINK_MANIFEST'); await realDirectory(path.dirname(path.join(roots[e.root], e.relative))); await fs.symlink(e.link.target, path.join(roots[e.root], e.relative)); }
  return roots;
}
/** Every containing directory, including symlink parents, must be durable before certification. */
export async function syncDirectories(directory: string): Promise<void> {
  await realDirectory(directory);
  for (const name of await fs.readdir(directory)) {
    const child = path.join(directory, name), st = await fs.lstat(child);
    if (st.isDirectory() && !st.isSymbolicLink()) await syncDirectories(child);
  }
  const handle = await fs.open(directory, 'r'); try { await handle.sync(); } finally { await handle.close(); }
}
export async function durableWrite(file: string, bytes: Buffer, mode: number) {
  await realDirectory(path.dirname(file)); const h = await fs.open(file, 'wx', mode);
  try { await h.writeFile(bytes); await h.chmod(mode); await h.sync(); } finally { await h.close(); }
}
/** Synthetic-only capture. No source root/destination/approval JSON can mint a live capability. */
export async function captureSynthetic(workspace: SyntheticWorkspace, boundary: SnapshotBoundary, facts: DestinationFacts, fault?: 'interrupt' | 'lost-response'): Promise<SyntheticCaptureReceipt> {
  await assertOwned(workspace); await validateBoundary(boundary, workspace);
  const expected = path.join(workspace.directory, 'backups');
  if (facts.root !== expected || JSON.stringify(facts.sources) !== JSON.stringify(workspace.source) || destinationBlockers(facts).length) throw new Error('CAPTURE_ADMISSION_REFUSED');
  const measured = recoveryStoragePlan(boundary.manifest);
  if (facts.space.backupBytes < measured.backupBytes || facts.space.restoreBytes < measured.restoreBytes || facts.space.stagingBytes < measured.stagingBytes) throw new Error('CAPTURE_BUDGET_UNDERESTIMATED');
  await realDirectory(expected); const capacity = await fs.statfs(expected);
  if (capacity.bavail * capacity.bsize < requiredFreeBytes(facts.space)) throw new Error('CAPTURE_CAPACITY_CHANGED');
  const before = await fs.lstat(expected);
  if (before.ino !== facts.approvedInode || before.dev !== facts.approvedDevice || before.uid !== facts.expectedUid || (before.mode & 0o077)) throw new Error('DESTINATION_CHANGED');
  const l = ledger(workspace), existing = l.get(boundary.transactionId);
  if (existing) throw new Error('TRANSACTION_ALREADY_EXISTS_INSPECT_ONLY');
  l.set(boundary.transactionId, { state: 'COPYING' });
  // Exclusive reservation is also the private staging container. No replacing rename exists.
  const staging = path.join(expected, boundary.transactionId);
  const roots: Roots = { state: path.join(staging, 'state'), agents: path.join(staging, 'agents'), worker: path.join(staging, 'worker') };
  try {
    await materializeManifest(boundary.manifest, workspace.source, staging, async () => { await assertOwned(workspace); if (fault === 'interrupt') throw new Error('SYNTHETIC_INTERRUPTED_COPY'); });
    await validateBoundary(boundary, workspace); await verifyCoverage(boundary.manifest, roots, boundary.manifest.digest);
    // Existing application restore mechanism is reused; source remains frozen throughout.
    await rehearseRestore(workspace, boundary.manifest, boundary.manifest.digest, roots);
    await validateBoundary(boundary, workspace);
    const receipt: SyntheticCaptureReceipt = Object.freeze({ scope: 'synthetic', status: 'SYNTHETIC_BACKUP_CERTIFIED', transactionId: boundary.transactionId, manifestDigest: boundary.manifest.digest, artifactDigest: hashValue({ transactionId: boundary.transactionId, manifestDigest: boundary.manifest.digest, applicationRestore: true }), applicationRestore: true, installationAuthority: false });
    await durableWrite(path.join(staging, 'manifest.private.json'), Buffer.from(JSON.stringify(boundary.manifest)), 0o600);
    await durableWrite(path.join(staging, 'receipt.private.json'), Buffer.from(JSON.stringify(receipt)), 0o600);
    await syncDirectories(staging);
    const now = await fs.lstat(expected);
    if (now.ino !== before.ino || now.dev !== before.dev || now.mode !== before.mode || now.uid !== before.uid) throw new Error('DESTINATION_CHANGED');
    await realDirectory(expected);
    const parent = await fs.open(expected, 'r'); try { await parent.sync(); } finally { await parent.close(); }
    // Last word before certification: the frozen source generation must still be exactly the captured one.
    await validateBoundary(boundary, workspace);
    receipts.add(receipt); l.set(boundary.transactionId, { state: 'CERTIFIED', receipt });
    if (fault === 'lost-response') throw new Error('SYNTHETIC_RESPONSE_LOST');
    return receipt;
  } catch (error) { if (l.get(boundary.transactionId)?.state !== 'CERTIFIED') l.set(boundary.transactionId, { state: 'UNCERTAIN' }); throw error; }
}
export async function inspectSyntheticTransaction(workspace: SyntheticWorkspace, boundary: SnapshotBoundary) {
  await assertOwned(workspace); await validateBoundary(boundary, workspace);
  const status = ledger(workspace).get(boundary.transactionId);
  if (!status || status.state !== 'CERTIFIED') return { state: status?.state ?? 'UNKNOWN', retryAuthorized: false };
  const root = path.join(workspace.directory, 'backups', boundary.transactionId), bytes = await safeRead(root, 'receipt.private.json');
  if (bytes.toString() !== JSON.stringify(status.receipt)) throw new Error('TRANSACTION_RECEIPT_CHANGED');
  if ((await safeRead(root, 'manifest.private.json')).toString() !== JSON.stringify(boundary.manifest)) throw new Error('TRANSACTION_MANIFEST_CHANGED');
  await verifyCoverage(boundary.manifest, { state: path.join(root, 'state'), agents: path.join(root, 'agents'), worker: path.join(root, 'worker') }, boundary.manifest.digest);
  return { state: 'CERTIFIED', retryAuthorized: false, receipt: status.receipt };
}
export function isSyntheticCaptureReceipt(value: unknown): value is SyntheticCaptureReceipt { return !!value && typeof value === 'object' && receipts.has(value); }
export function liveCapture(): never { throw new Error('LIVE_CAPTURE_UNAVAILABLE_OWNER_AUTHORIZATION_ADAPTER_REQUIRED'); }
