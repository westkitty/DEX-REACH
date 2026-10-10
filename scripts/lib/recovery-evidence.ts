import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { hashValue } from '../../src/shared/hash.js';
import { realDirectory } from './recovery-reconciliation.js';

/**
 * Durable checkpoint evidence. Two independent stores:
 *  - the transaction log: an append-only, hash-chained, exclusively created sequence of states;
 *  - the expectation store: the expected source-manifest digest, written before any byte is copied,
 *    in a root that must not overlap the log, the backup destination or the source.
 * Neither store certifies itself: certification recomputes the artifact from the destination and
 * compares it with both. A record is data; nothing read back from either store grants authority.
 * Records hold identities, digests and public keys only, never payloads or credentials.
 */
export const EVIDENCE_STATES = ['PREPARED', 'ACKNOWLEDGED', 'FENCED', 'CAPTURING', 'CAPTURED', 'RESTORE_VERIFIED', 'CERTIFIED', 'REFUSED', 'FAILED'] as const;
export type EvidenceState = typeof EVIDENCE_STATES[number];
const TERMINAL: readonly EvidenceState[] = ['CERTIFIED', 'REFUSED', 'FAILED'];
const ORDER: Record<EvidenceState, readonly EvidenceState[]> = {
  PREPARED: ['ACKNOWLEDGED', 'REFUSED', 'FAILED'], ACKNOWLEDGED: ['FENCED', 'REFUSED', 'FAILED'], FENCED: ['CAPTURING', 'REFUSED', 'FAILED'],
  CAPTURING: ['CAPTURED', 'FAILED'], CAPTURED: ['RESTORE_VERIFIED', 'FAILED'], RESTORE_VERIFIED: ['CERTIFIED', 'FAILED'], CERTIFIED: [], REFUSED: [], FAILED: []
};
export type EvidenceRecord = { version: 1; nodeId: string; transactionId: string; sequence: number; state: EvidenceState; at: string; holder: { pid: number; bootId: string }; data: Record<string, unknown>; previous: string | null; digest: string };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HASH = /^[a-f0-9]{64}$/;
const overlaps = (a: string, b: string) => a === b || a.startsWith(b + path.sep) || b.startsWith(a + path.sep);

async function syncDirectory(directory: string): Promise<void> {
  const handle = await fs.open(directory, 'r'); try { await handle.sync(); } finally { await handle.close(); }
}
async function exclusiveDurable(file: string, text: string): Promise<void> {
  const handle = await fs.open(file, 'wx', 0o600);
  try { await handle.writeFile(text); await handle.sync(); } finally { await handle.close(); }
  await syncDirectory(path.dirname(file));
}
async function privateRoot(root: string): Promise<string> {
  const resolved = await realDirectory(root), st = await fs.lstat(resolved);
  if (st.uid !== process.getuid?.() || (st.mode & 0o077) !== 0) throw new Error('EVIDENCE_ROOT_NOT_PRIVATE');
  return resolved;
}

export class TransactionEvidenceLog {
  private constructor(readonly root: string, readonly nodeId: string, private readonly holder: { pid: number; bootId: string }) {}
  static async open(root: string, nodeId: string, forbidden: string[]): Promise<TransactionEvidenceLog> {
    const resolved = await privateRoot(root);
    if (forbidden.some(f => overlaps(path.resolve(f), resolved))) throw new Error('EVIDENCE_ROOT_OVERLAP');
    return new TransactionEvidenceLog(resolved, nodeId, { pid: process.pid, bootId: crypto.randomUUID() });
  }
  async append(transactionId: string, state: EvidenceState, data: Record<string, unknown> = {}): Promise<EvidenceRecord> {
    if (!UUID.test(transactionId)) throw new Error('EVIDENCE_TRANSACTION_INVALID');
    const existing = await this.read(transactionId);
    const last = existing.at(-1);
    if (!last ? state !== 'PREPARED' : !ORDER[last.state].includes(state)) throw new Error(`EVIDENCE_TRANSITION_REFUSED:${last?.state ?? 'NONE'}->${state}`);
    const directory = path.join(this.root, transactionId);
    if (!last) { await fs.mkdir(directory, { mode: 0o700 }); await syncDirectory(this.root); }
    const body = { version: 1 as const, nodeId: this.nodeId, transactionId, sequence: existing.length, state, at: new Date().toISOString(), holder: this.holder, data, previous: last?.digest ?? null };
    const record: EvidenceRecord = { ...body, digest: hashValue(body) };
    // Exclusive creation of the sequence slot: a concurrent or repeated writer cannot overwrite history.
    await exclusiveDurable(path.join(directory, `${String(record.sequence).padStart(4, '0')}.json`), JSON.stringify(record) + '\n');
    return record;
  }
  /** Full chain validation: contiguous sequence, digests, linkage, node and transaction identity. */
  async read(transactionId: string): Promise<EvidenceRecord[]> {
    if (!UUID.test(transactionId)) throw new Error('EVIDENCE_TRANSACTION_INVALID');
    const directory = path.join(this.root, transactionId);
    let names: string[];
    try { await realDirectory(directory); names = (await fs.readdir(directory)).sort(); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
    const records: EvidenceRecord[] = [];
    for (const [index, name] of names.entries()) {
      if (name !== `${String(index).padStart(4, '0')}.json`) throw new Error('EVIDENCE_SEQUENCE_BROKEN');
      const record = JSON.parse(await fs.readFile(path.join(directory, name), 'utf8')) as EvidenceRecord;
      const { digest, ...body } = record;
      if (record.version !== 1 || record.nodeId !== this.nodeId || record.transactionId !== transactionId || record.sequence !== index || !EVIDENCE_STATES.includes(record.state) || hashValue(body) !== digest || record.previous !== (records.at(-1)?.digest ?? null)) throw new Error('EVIDENCE_CHAIN_INVALID');
      if (index > 0 && !ORDER[records[index - 1]!.state].includes(record.state)) throw new Error('EVIDENCE_CHAIN_INVALID');
      records.push(record);
    }
    return records;
  }
}

export class ExpectationStore {
  private constructor(readonly root: string, readonly nodeId: string) {}
  static async open(root: string, nodeId: string, forbidden: string[]): Promise<ExpectationStore> {
    const resolved = await privateRoot(root);
    if (forbidden.some(f => overlaps(path.resolve(f), resolved))) throw new Error('EXPECTATION_ROOT_OVERLAP');
    return new ExpectationStore(resolved, nodeId);
  }
  /** Written once, before capture copies anything. A second expectation for the same transaction refuses. */
  async record(transactionId: string, manifestDigest: string, generation: string): Promise<void> {
    if (!UUID.test(transactionId) || !HASH.test(manifestDigest) || !HASH.test(generation)) throw new Error('EXPECTATION_INVALID');
    const body = { version: 1, nodeId: this.nodeId, transactionId, manifestDigest, generation };
    await exclusiveDurable(path.join(this.root, `${transactionId}.json`), JSON.stringify({ ...body, digest: hashValue(body) }) + '\n');
  }
  async expected(transactionId: string): Promise<{ manifestDigest: string; generation: string } | null> {
    if (!UUID.test(transactionId)) throw new Error('EXPECTATION_INVALID');
    let raw: string;
    try { raw = await fs.readFile(path.join(this.root, `${transactionId}.json`), 'utf8'); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
    const value = JSON.parse(raw) as { version: number; nodeId: string; transactionId: string; manifestDigest: string; generation: string; digest: string };
    const { digest, ...body } = value;
    if (value.version !== 1 || value.nodeId !== this.nodeId || value.transactionId !== transactionId || hashValue(body) !== digest || !HASH.test(value.manifestDigest)) throw new Error('EXPECTATION_CORRUPT');
    return { manifestDigest: value.manifestDigest, generation: value.generation };
  }
}

/** Digest of the bytes actually present in the destination, never of the manifest that describes them. */
// Integrity, not attestation: the chain is unkeyed, so CERTIFIED_VERIFIED means internally consistent
// against the independent expectation store, not proof against someone able to write both private roots.
export async function artifactDigest(transactionDirectory: string): Promise<string> {
  await realDirectory(transactionDirectory);
  const items: Array<[string, string, number, string]> = [];
  async function walk(relative: string): Promise<void> {
    const file = path.join(transactionDirectory, relative), st = await fs.lstat(file);
    if (st.isSymbolicLink()) { items.push([relative, 'link', st.mode & 0o777, await fs.readlink(file)]); return; }
    if (st.isDirectory()) {
      const names = (await fs.readdir(file)).sort();
      items.push([relative, 'dir', st.mode & 0o777, names.join('/')]);
      for (const name of names) await walk(relative ? `${relative}/${name}` : name);
      return;
    }
    if (!st.isFile()) throw new Error('ARTIFACT_ENTRY_UNSUPPORTED');
    items.push([relative, 'file', st.mode & 0o777, crypto.createHash('sha256').update(await fs.readFile(file)).digest('hex')]);
  }
  // The whole transaction directory, including the private manifest and receipt: nothing beside the
  // captured roots can be edited, removed or planted without changing the digest.
  await walk('');
  return hashValue(items);
}

export type Reconciliation = { transactionId: string; state: 'UNKNOWN' | 'CERTIFIED_VERIFIED' | 'CERTIFIED_ARTIFACT_CHANGED' | 'REFUSED' | 'FAILED' | 'UNCERTAIN_INTERRUPTED'; lastRecorded: EvidenceState | null; artifact: 'ABSENT' | 'MATCHES_RECORD' | 'DIFFERS' | 'PRESENT_UNRECORDED'; retryAuthorized: false; installationAuthority: false };
/**
 * Restart reconciliation reads; it never repeats a capture, completes a chain or certifies. An
 * interrupted transaction stays UNCERTAIN even when its artifact is intact: the boundary acknowledgements
 * that made it consistent cannot be re-proven after the fact.
 */
export async function reconcileTransaction(log: TransactionEvidenceLog, expectations: ExpectationStore, destinationRoot: string, transactionId: string): Promise<Reconciliation> {
  const records = await log.read(transactionId), last = records.at(-1);
  const directory = path.join(destinationRoot, transactionId);
  const present = await fs.lstat(directory).then(() => true, () => false);
  const recorded = records.find(r => r.state === 'CAPTURED')?.data.artifactDigest;
  let artifact: Reconciliation['artifact'] = 'ABSENT';
  if (present) artifact = typeof recorded !== 'string' ? 'PRESENT_UNRECORDED' : await artifactDigest(directory).then(d => d === recorded ? 'MATCHES_RECORD' as const : 'DIFFERS' as const, () => 'DIFFERS' as const);
  const base = { transactionId, lastRecorded: last?.state ?? null, artifact, retryAuthorized: false as const, installationAuthority: false as const };
  if (!last) return { ...base, state: 'UNKNOWN' };
  if (last.state === 'CERTIFIED') {
    const expected = await expectations.expected(transactionId);
    const ok = artifact === 'MATCHES_RECORD' && !!expected && expected.manifestDigest === records.find(r => r.state === 'CAPTURED')?.data.manifestDigest;
    return { ...base, state: ok ? 'CERTIFIED_VERIFIED' : 'CERTIFIED_ARTIFACT_CHANGED' };
  }
  if (last.state === 'REFUSED' || last.state === 'FAILED') return { ...base, state: last.state };
  return { ...base, state: 'UNCERTAIN_INTERRUPTED' };
}
export { TERMINAL as TERMINAL_EVIDENCE_STATES };
