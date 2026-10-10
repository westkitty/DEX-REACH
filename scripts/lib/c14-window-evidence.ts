import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { hashValue } from '../../src/shared/hash.js';
import { readQuarantine, quarantineMatches, type QuarantinedTaskIdentity } from '../../src/shared/task-quarantine.js';
import { manifestDigest, recoveryFamilies, type Manifest, type Roots } from './recovery-coverage.js';
import { TransactionEvidenceLog, ExpectationStore, reconcileTransaction, type EvidenceRecord } from './recovery-evidence.js';
import { recoveryStoragePlan } from './recovery-storage.js';
import { RETAINED_RELEASE, RETAINED_SOURCE, RETAINED_TRANSACTION, requiredFreeBytes, type RecoveryBoundaryEvidence, type RetainedProvenance, type SpacePlan } from './c14-recovery-preflight.js';
import type { TaskInspection } from './recovery-reconciliation.js';

/** Private, owner-only maintenance-window roots on the encrypted internal volume, outside every source root. */
export const WINDOW_ROOT = '/Users/andrew/.dex-reach-backups';
export const WINDOW = {
  root: WINDOW_ROOT,
  destination: path.join(WINDOW_ROOT, 'destination'),
  evidence: path.join(WINDOW_ROOT, 'evidence'),
  expectations: path.join(WINDOW_ROOT, 'expectations'),
  authorization: path.join(WINDOW_ROOT, 'authorization.json'),
  capture: path.join(WINDOW_ROOT, 'capture.json')
};
/** A capture older than this is no longer a fresh rollback baseline for an installation. */
export const CAPTURE_FRESHNESS_MS = 24 * 60 * 60 * 1000;

/**
 * The owner's grant for one maintenance window, transcribed once by the operator and then made
 * read-only. It is the only authority input; everything it permits is still independently verified.
 */
export type WindowAuthorization = Readonly<{
  version: 1; grantedAt: string; grantedBy: 'owner'; channel: string; statement: string;
  approvedSha: string; approvedVersion: string; candidateReleaseId: string; releaseScope: 'local-runtime-only';
  compatHomeLinkPolicy: boolean; historicalTaskQuarantine: boolean; retainC13: boolean; maintenanceWindow: boolean; digest: string;
}>;
export function authorizationDigest(a: Omit<WindowAuthorization, 'digest'>): string { return hashValue(a); }
async function privateFile(file: string): Promise<string> {
  const st = await fs.lstat(file);
  if (!st.isFile() || st.uid !== process.getuid?.() || (st.mode & 0o077) !== 0) throw new Error('WINDOW_FILE_NOT_PRIVATE');
  return fs.readFile(file, 'utf8');
}
export async function readWindowAuthorization(file = WINDOW.authorization): Promise<WindowAuthorization | null> {
  let raw: string;
  try { raw = await privateFile(file); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  const a = JSON.parse(raw) as WindowAuthorization; const { digest, ...body } = a;
  if (a.version !== 1 || a.grantedBy !== 'owner' || a.releaseScope !== 'local-runtime-only' || !/^[a-f0-9]{40}$/.test(a.approvedSha) || !a.statement?.trim() || !Number.isFinite(Date.parse(a.grantedAt)) || authorizationDigest(body) !== digest) throw new Error('WINDOW_AUTHORIZATION_INVALID');
  return Object.freeze(a);
}
export async function readCapturePointer(file = WINDOW.capture): Promise<string | null> {
  let raw: string;
  try { raw = await privateFile(file); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  const value = JSON.parse(raw) as { version: number; transactionId: string };
  if (value.version !== 1 || !/^[0-9a-f-]{36}$/.test(value.transactionId)) throw new Error('CAPTURE_POINTER_INVALID');
  return value.transactionId;
}

const verified = new WeakSet<object>();
/** Only objects minted by verifyWindowEvidence satisfy the live boundary gates; JSON never does. */
export function isVerifiedWindowEvidence(value: unknown): value is RecoveryBoundaryEvidence { return !!value && typeof value === 'object' && verified.has(value); }

export type WindowFacts = {
  boundary: RecoveryBoundaryEvidence; backupCertified: boolean; ownerPreservationVerified: boolean; exactLegacyPairingVerified: boolean;
  quarantined: number; unresolved: number; provenance?: RetainedProvenance; captureTransactionId?: string; capturedAt?: string;
  space?: SpacePlan; spaceMeasured: boolean; blockers: string[];
};
const sha = (b: Buffer | string) => crypto.createHash('sha256').update(b).digest('hex');
const pick = (m: Manifest, test: (e: Manifest['entries'][number]) => boolean) => hashValue(m.entries.filter(test).map(e => [e.root, e.relative, e.sha256, e.mode]));
async function liveDigest(roots: Roots, entries: Manifest['entries']) {
  return hashValue(await Promise.all(entries.map(async e => [e.root, e.relative, sha(await fs.readFile(path.join(roots[e.root], e.relative))), (await fs.lstat(path.join(roots[e.root], e.relative))).mode & 0o777])));
}
async function treeBytes(directory: string): Promise<number> {
  let total = 0;
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) total += await treeBytes(file); else if (entry.isFile()) total += Math.max(4096, Math.ceil((await fs.lstat(file)).size / 4096) * 4096);
  }
  return total;
}

/**
 * Independently re-verify every live boundary fact from durable evidence. Each failure is a named
 * blocker; nothing is inferred from the authorization alone.
 */
export async function verifyWindowEvidence(input: {
  head: string; sourceRoot: string; nodeId: 'macbook-air.local'; roots: Roots; tasks: TaskInspection[]; storeRecords: Record<string, QuarantinedTaskIdentity>;
  authorization: WindowAuthorization | null; captureTransactionId: string | null; now?: number; window?: typeof WINDOW;
  /** Trust anchors of the retained release; production uses the verified C13 constants. */
  retained?: { release: string; source: string; transaction: string };
}): Promise<WindowFacts> {
  const r = input.retained ?? { release: RETAINED_RELEASE, source: RETAINED_SOURCE, transaction: RETAINED_TRANSACTION };
  const w = input.window ?? WINDOW, blockers: string[] = [], now = input.now ?? Date.now();
  const gates = { symlinkPolicy: false, knownFamilies: false, consistency: false, manifestTrust: false, destination: false, durableBackup: false, restore: false, taskDisposition: false, provenance: false, candidateIdentity: false };
  const result: WindowFacts = { boundary: { scope: 'live', version: 1, ...gates }, backupCertified: false, ownerPreservationVerified: false, exactLegacyPairingVerified: false, quarantined: 0, unresolved: input.tasks.length, spaceMeasured: false, blockers };

  // Task disposition: every unresolved historical record must carry a quarantine entry that still matches it.
  const quarantine = await readQuarantine(input.roots.state).catch(() => { blockers.push('QUARANTINE_LOG_CORRUPT'); return new Map(); });
  for (const row of input.tasks) {
    const entry = quarantine.get(row.taskId), record = input.storeRecords[row.taskId];
    const quarantinable = row.classification === 'AMBIGUOUS_EFFECT' || row.classification === 'INSUFFICIENT_EVIDENCE';
    if (entry && record && quarantinable && quarantineMatches(entry, record) && !row.evidence.activity && !row.evidence.lease && !row.evidence.ticket) result.quarantined++;
  }
  result.unresolved = input.tasks.length - result.quarantined;
  gates.taskDisposition = result.unresolved === 0 && !blockers.includes('QUARANTINE_LOG_CORRUPT');
  if (!gates.taskDisposition) blockers.push('TASK_DISPOSITION_INCOMPLETE');

  const a = input.authorization;
  if (!a) blockers.push('WINDOW_AUTHORIZATION_MISSING');
  else if (a.approvedSha !== input.head) blockers.push('WINDOW_AUTHORIZATION_FOR_OTHER_SHA');
  const txn = input.captureTransactionId;
  if (!txn) { blockers.push('CERTIFIED_CAPTURE_MISSING'); return finish(); }

  const log = await TransactionEvidenceLog.open(w.evidence, input.nodeId, [...Object.values(input.roots), w.destination]);
  const expectations = await ExpectationStore.open(w.expectations, input.nodeId, [...Object.values(input.roots), w.destination, log.root]);
  const reconciliation = await reconcileTransaction(log, expectations, w.destination, txn);
  if (reconciliation.state !== 'CERTIFIED_VERIFIED') { blockers.push(`CAPTURE_${reconciliation.state}`); return finish(); }
  const records = await log.read(txn), at = (state: EvidenceRecord['state']) => records.find(r => r.state === state);
  const prepared = at('PREPARED')!, acknowledged = at('ACKNOWLEDGED')!, restored = at('RESTORE_VERIFIED')!, certified = at('CERTIFIED')!;
  result.captureTransactionId = txn; result.capturedAt = certified.at;
  if (prepared.data.sourceSha !== input.head || certified.data.sourceSha !== input.head) blockers.push('CAPTURE_FROM_OTHER_SOURCE');
  if (now - Date.parse(certified.at) > CAPTURE_FRESHNESS_MS || Date.parse(certified.at) > now + 60_000) blockers.push('CAPTURE_NOT_FRESH');

  // Independent manifest trust: the stored manifest must hash to the separately recorded expectation.
  const expected = await expectations.expected(txn), manifest = JSON.parse(await fs.readFile(path.join(w.destination, txn, 'manifest.private.json'), 'utf8')) as Manifest;
  gates.manifestTrust = !!expected && manifestDigest(manifest) === manifest.digest && manifest.digest === expected.manifestDigest && manifest.digest === certified.data.manifestDigest;
  if (!gates.manifestTrust) blockers.push('MANIFEST_TRUST');
  gates.consistency = manifest.consistent && manifest.problems.length === 0;
  const policy = recoveryFamilies(input.nodeId, manifest.directories.find(d => d.root === 'state' && d.relative === '')?.names);
  gates.knownFamilies = !manifest.families.some(f => f.status === 'UNKNOWN') && policy.every(f => manifest.families.some(x => x.id === f.id));
  result.ownerPreservationVerified = gates.knownFamilies && policy.filter(f => f.required).every(f => manifest.families.find(x => x.id === f.id)?.status === 'INCLUDED');
  const compat = prepared.data.linkPolicy === 'compat-home-preservation';
  gates.symlinkPolicy = gates.consistency && (prepared.data.linkPolicy === 'default' || (compat && !!a?.compatHomeLinkPolicy));
  if (!gates.symlinkPolicy) blockers.push('SYMLINK_POLICY_UNAPPROVED_OR_UNPROVEN');

  // Destination: the recorded identity still holds, privately, on an encrypted, durable, non-cloud volume.
  const d = acknowledged.data.destination as { root: string; device: number; inode: number; volume: string; encrypted: boolean; durable: boolean; cloudSynced: boolean } | undefined;
  const st = d ? await fs.lstat(d.root).catch(() => null) : null;
  gates.destination = !!d && !!st && d.root === w.destination && st.dev === d.device && st.ino === d.inode && st.uid === process.getuid?.() && (st.mode & 0o077) === 0 && d.encrypted && d.durable && !d.cloudSynced && !!d.volume;
  if (!gates.destination) blockers.push('BACKUP_DESTINATION');
  gates.durableBackup = gates.manifestTrust && records.some(r => r.state === 'CAPTURED') && reconciliation.artifact === 'MATCHES_RECORD';
  const legacy = restored.data.legacyCompatibility as { authMode?: string; policyValid?: boolean; sourceSha?: string } | undefined;
  gates.restore = restored.data.application === 'VERIFIED';
  result.exactLegacyPairingVerified = legacy?.authMode === 'asymmetric' && legacy.policyValid === true && legacy.sourceSha === input.head;
  if (!result.exactLegacyPairingVerified) blockers.push('LEGACY_COMPATIBILITY_UNVERIFIED');

  // Retained C13 provenance: install journal, captured release and unchanged configuration/policy.
  try {
    const journal = JSON.parse(await fs.readFile(path.join(input.roots.state, 'runtime', 'c13-maintenance.json'), 'utf8')) as Record<string, unknown>;
    const releasePrefix = `runtime/releases/${r.release}/`;
    const releaseEntries = manifest.entries.filter(e => e.root === 'state' && e.relative.startsWith(releasePrefix));
    const configEntries = manifest.entries.filter(e => e.root === 'agents' || e.root === 'worker');
    const policyEntries = manifest.entries.filter(e => e.root === 'state' && new RegExp(`^nodes/${input.nodeId.replace(/\./g, '\\.')}\\.(access\\.json|env|transport\\.ed25519(\\.pub)?\\.pem)$`).test(e.relative));
    const provenance: RetainedProvenance = {
      sourceSha: journal.head === r.source && journal.candidateId === r.release && journal.decision === 'RETAIN CANDIDATE' ? r.source : `UNMATCHED:${String(journal.head)}`,
      installTransaction: String(journal.transactionId),
      dependencyDigest: pick(manifest, e => releaseEntries.includes(e)),
      configDigest: pick(manifest, e => configEntries.includes(e)), expectedConfigDigest: await liveDigest(input.roots, configEntries),
      policyDigest: pick(manifest, e => policyEntries.includes(e)), expectedPolicyDigest: await liveDigest(input.roots, policyEntries),
      ownerManifestDigest: manifest.digest, trustedManifestDigest: expected?.manifestDigest ?? '',
      snapshotComplete: gates.consistency && releaseEntries.length > 0 && configEntries.length > 0 && policyEntries.length >= 4, metadataVerified: reconciliation.artifact === 'MATCHES_RECORD', reserveVerified: false
    };
    const candidateBytes = await treeBytes(path.join(input.roots.state, 'runtime', 'releases', r.release));
    const space = { ...recoveryStoragePlan(manifest, candidateBytes) };
    const volume = await fs.statfs(input.roots.state);
    provenance.reserveVerified = volume.bavail * volume.bsize >= requiredFreeBytes(space);
    result.provenance = provenance; result.space = space; result.spaceMeasured = true;
    gates.provenance = provenance.installTransaction === r.transaction && provenance.sourceSha === r.source && provenance.configDigest === provenance.expectedConfigDigest && provenance.policyDigest === provenance.expectedPolicyDigest && provenance.snapshotComplete && provenance.metadataVerified && provenance.reserveVerified;
  } catch { /* An unreadable journal or tree refuses. */ }
  if (!gates.provenance) blockers.push('RETAINED_PROVENANCE');

  // Candidate identity: the approved release id is exactly what the installer will derive from this source.
  try {
    const pkg = JSON.parse(await fs.readFile(path.join(input.sourceRoot, 'package.json'), 'utf8')) as { version: string };
    const lock = sha(await fs.readFile(path.join(input.sourceRoot, 'package-lock.json'))).slice(0, 12);
    gates.candidateIdentity = !!a && a.candidateReleaseId === `${pkg.version}-${input.head.slice(0, 12)}-${lock}` && a.approvedVersion === pkg.version;
  } catch { /* Unreadable package metadata refuses. */ }
  if (!gates.candidateIdentity) blockers.push('CANDIDATE_RELEASE_IDENTITY');
  result.backupCertified = gates.manifestTrust && gates.consistency && gates.durableBackup && gates.destination && gates.restore && !blockers.includes('CAPTURE_FROM_OTHER_SOURCE') && !blockers.includes('CAPTURE_NOT_FRESH');
  return finish();

  function finish(): WindowFacts {
    const boundary = Object.freeze({ scope: 'live' as const, version: 1 as const, ...gates });
    if (!blockers.length) verified.add(boundary);
    result.boundary = boundary;
    return result;
  }
}
