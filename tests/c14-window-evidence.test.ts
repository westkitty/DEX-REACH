import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { expandedFixture } from './helpers/recovery-fixture.js';
import { captureOffline, type HostProbe } from '../scripts/lib/recovery-offline-capture.js';
import { TransactionEvidenceLog, ExpectationStore } from '../scripts/lib/recovery-evidence.js';
import { inspectCoverage } from '../scripts/lib/recovery-coverage.js';
import { COMPAT_HOME_PRESERVATION_RULE } from '../scripts/lib/recovery-symlinks.js';
import { recoveryStoragePlan } from '../scripts/lib/recovery-storage.js';
import { verifyWindowEvidence, authorizationDigest, isVerifiedWindowEvidence, readWindowAuthorization, type WindowAuthorization } from '../scripts/lib/c14-window-evidence.js';
import { validateLiveBoundaryEvidence } from '../scripts/lib/c14-recovery-preflight.js';
import { appendQuarantine, type QuarantinedTaskIdentity } from '../src/shared/task-quarantine.js';
import type { DestinationFacts } from '../scripts/lib/recovery-destination.js';
import type { TaskInspection } from '../scripts/lib/recovery-reconciliation.js';

const nodeId = 'macbook-air.local' as const, head = 'c'.repeat(40);
const retained = { release: 'synthetic-retained', source: 'a'.repeat(40), transaction: '11111111-1111-4111-8111-111111111111' };
const probe: HostProbe = { launchctlPrint: async () => false, processTable: async () => '', selfPid: process.pid };

async function window(options: { compat?: boolean } = {}) {
  const w = await expandedFixture(), state = w.source.state;
  await fs.rm(path.join(state, 'coordinator/leases/synthetic.json'));
  // The expanded fixture's retained release, with an install journal naming it as C13's does.
  await fs.writeFile(path.join(state, 'runtime/c13-maintenance.json'), JSON.stringify({ transactionId: retained.transaction, head: retained.source, candidateId: retained.release, decision: 'RETAIN CANDIDATE' }), { mode: 0o600 });
  if (options.compat) { const d = path.join(state, 'compat-home/Library/pnpm/store/v11/projects'); await fs.mkdir(d, { recursive: true, mode: 0o700 }); await fs.symlink('../tmp/absent', path.join(d, 'b6579c7d425767a91f64fbe80a6bc696')); }
  const root = path.join(w.directory, 'window'); await fs.mkdir(root, { mode: 0o700 });
  const roots = { root, destination: path.join(root, 'destination'), evidence: path.join(root, 'evidence'), expectations: path.join(root, 'expectations'), authorization: path.join(root, 'authorization.json'), capture: path.join(root, 'capture.json') };
  for (const d of [roots.destination, roots.evidence, roots.expectations]) await fs.mkdir(d, { mode: 0o700 });
  const sourceRoot = path.join(w.directory, 'source-root'); await fs.mkdir(sourceRoot);
  await fs.writeFile(path.join(sourceRoot, 'package.json'), JSON.stringify({ version: '0.3.2' })); await fs.writeFile(path.join(sourceRoot, 'package-lock.json'), '{"lock":1}');
  const lock = crypto.createHash('sha256').update('{"lock":1}').digest('hex').slice(0, 12);
  const body = { version: 1 as const, grantedAt: new Date().toISOString(), grantedBy: 'owner' as const, channel: 'fixture', statement: 'fixture grant', approvedSha: head, approvedVersion: '0.3.2', candidateReleaseId: `0.3.2-${head.slice(0, 12)}-${lock}`, releaseScope: 'local-runtime-only' as const, compatHomeLinkPolicy: true, historicalTaskQuarantine: true, retainC13: true, maintenanceWindow: true };
  const authorization: WindowAuthorization = { ...body, digest: authorizationDigest(body) };
  const linkPolicy = options.compat ? { version: 1 as const, rules: [COMPAT_HOME_PRESERVATION_RULE] } : undefined;
  const log = await TransactionEvidenceLog.open(roots.evidence, nodeId, [...Object.values(w.source), roots.destination]);
  const expectations = await ExpectationStore.open(roots.expectations, nodeId, [...Object.values(w.source), roots.destination, log.root]);
  const st = await fs.lstat(roots.destination), v = await fs.statfs(roots.destination);
  const destination: DestinationFacts = { root: roots.destination, approvedRoot: roots.destination, approved: true, device: st.dev, approvedDevice: st.dev, inode: st.ino, approvedInode: st.ino, mountIdentity: 'fixture-volume', approvedMountIdentity: 'fixture-volume', ownerUid: st.uid, expectedUid: st.uid, mode: 0o700, writable: true, cloudSynced: false, cloudApproved: false, encrypted: true, durable: true, freeBytes: v.bavail * v.bsize, measured: true, space: recoveryStoragePlan(await inspectCoverage(w.source, 'inspection', linkPolicy)), sources: w.source, gitRoots: ['/synthetic/git'] };
  const transactionId = crypto.randomUUID();
  const outcome = await captureOffline({ nodeId, transactionId, sourceSha: head, roots: w.source, destination, log, expectations, probe, ...(linkPolicy ? { linkPolicy } : {}) });
  assert.equal(outcome.status, 'OFFLINE_BACKUP_CERTIFIED', outcome.reason);
  const verify = (overrides: Partial<Parameters<typeof verifyWindowEvidence>[0]> = {}) => verifyWindowEvidence({ head, sourceRoot, nodeId, roots: w.source, tasks: [], storeRecords: {}, authorization, captureTransactionId: transactionId, window: roots, retained, ...overrides });
  return { w, roots, authorization, transactionId, verify };
}

test('a fresh certified capture with approved scope satisfies every live boundary gate', async () => {
  const x = await window(); try {
    const facts = await x.verify();
    assert.deepEqual(facts.blockers, []);
    assert.ok(isVerifiedWindowEvidence(facts.boundary));
    assert.ok(Object.values(validateLiveBoundaryEvidence(facts.boundary)).every(Boolean));
    assert.ok(facts.backupCertified && facts.ownerPreservationVerified && facts.exactLegacyPairingVerified && facts.spaceMeasured);
    // A structurally identical copy is not evidence.
    assert.ok(Object.values(validateLiveBoundaryEvidence(JSON.parse(JSON.stringify(facts.boundary)))).every(v => !v));
  } finally { await x.w.cleanup(); }
});

test('the compat-home link rule satisfies the symlink gate only with owner approval', async () => {
  const x = await window({ compat: true }); try {
    assert.deepEqual((await x.verify()).blockers, []);
    const body = { ...x.authorization, compatHomeLinkPolicy: false } as Omit<WindowAuthorization, 'digest'> & { digest?: string }; delete body.digest;
    assert.ok((await x.verify({ authorization: { ...body, digest: authorizationDigest(body) } as WindowAuthorization })).blockers.includes('SYMLINK_POLICY_UNAPPROVED_OR_UNPROVEN'));
  } finally { await x.w.cleanup(); }
});

for (const [name, alter, blocker] of [
  ['an authorization for another revision', async (x: any) => ({ head: 'd'.repeat(40) }), 'WINDOW_AUTHORIZATION_FOR_OTHER_SHA'],
  ['a capture taken from other source', async (x: any) => ({ head: 'd'.repeat(40) }), 'CAPTURE_FROM_OTHER_SOURCE'],
  ['no authorization', async () => ({ authorization: null }), 'WINDOW_AUTHORIZATION_MISSING'],
  ['no capture', async () => ({ captureTransactionId: null }), 'CERTIFIED_CAPTURE_MISSING'],
  ['a stale capture', async () => ({ now: Date.now() + 25 * 3600_000 }), 'CAPTURE_NOT_FRESH'],
  ['backup bytes changed after certification', async (x: any) => { await fs.appendFile(path.join(x.roots.destination, x.transactionId, 'state/audit.jsonl'), 'x'); return {}; }, 'CAPTURE_CERTIFIED_ARTIFACT_CHANGED'],
  ['service configuration changed since capture', async (x: any) => { await fs.appendFile(path.join(x.w.source.agents, 'com.stinkyweasel.dex-reach.node.plist'), ' '); return {}; }, 'RETAINED_PROVENANCE'],
  ['access policy changed since capture', async (x: any) => { const f = path.join(x.w.source.state, `nodes/${nodeId}.access.json`); await fs.writeFile(f, (await fs.readFile(f, 'utf8')).replace('"revision":1', '"revision":2')); return {}; }, 'RETAINED_PROVENANCE'],
  ['a missing install journal', async (x: any) => { await fs.rm(path.join(x.w.source.state, 'runtime/c13-maintenance.json')); return {}; }, 'RETAINED_PROVENANCE'],
  ['a mismatched candidate release id', async (x: any) => { const b = { ...x.authorization, candidateReleaseId: '0.3.2-other' }; delete b.digest; return { authorization: { ...b, digest: authorizationDigest(b) } }; }, 'CANDIDATE_RELEASE_IDENTITY'],
  ['a destination replaced after capture', async (x: any) => { await fs.rename(x.roots.destination, x.roots.destination + '.old'); await fs.mkdir(x.roots.destination, { mode: 0o700 }); await fs.cp(x.roots.destination + '.old', x.roots.destination, { recursive: true }); return {}; }, 'BACKUP_DESTINATION']
] as const) test(`window evidence refuses ${name}`, async () => {
  const x = await window(); try {
    const facts = await x.verify(await (alter as any)(x));
    assert.ok(facts.blockers.includes(blocker), facts.blockers.join(','));
    assert.ok(Object.values(validateLiveBoundaryEvidence(facts.boundary)).every(v => !v));
  } finally { await x.w.cleanup(); }
});

test('task disposition requires every unresolved record to carry a still-matching quarantine entry', async () => {
  const x = await window(); try {
    const record: QuarantinedTaskIdentity = { taskId: 'rtsk_historical', rootTaskId: 'rtsk_historical', parentTaskId: null, actorId: 'a', nodeId, operation: 'dex.process.run', idempotencyKey: 'k', payloadSha256: 'a'.repeat(64), createdAtUtc: '2026-10-09T00:00:00.000Z', attemptNumber: 1, state: 'PREPARING' };
    const row = { taskId: record.taskId, classification: 'AMBIGUOUS_EFFECT', evidence: { activity: false, lease: false, ticket: false } } as unknown as TaskInspection;
    let facts = await x.verify({ tasks: [row], storeRecords: { [record.taskId]: record } });
    assert.ok(facts.blockers.includes('TASK_DISPOSITION_INCOMPLETE')); assert.equal(facts.unresolved, 1);
    await appendQuarantine(x.w.source.state, [{ task: record, classification: 'AMBIGUOUS_EFFECT' }], { kind: 'owner-authorization', grantedAt: x.authorization.grantedAt, scope: 'fixture' });
    facts = await x.verify({ tasks: [row], storeRecords: { [record.taskId]: record } });
    assert.equal(facts.quarantined, 1); assert.equal(facts.unresolved, 0); assert.ok(!facts.blockers.includes('TASK_DISPOSITION_INCOMPLETE'));
    // The record changed after quarantine: the acknowledgement no longer covers it.
    facts = await x.verify({ tasks: [row], storeRecords: { [record.taskId]: { ...record, state: 'FAILED' } } });
    assert.ok(facts.blockers.includes('TASK_DISPOSITION_INCOMPLETE'));
    // Live execution evidence is never quarantinable.
    facts = await x.verify({ tasks: [{ ...row, evidence: { ...row.evidence, lease: true } } as TaskInspection], storeRecords: { [record.taskId]: record } });
    assert.ok(facts.blockers.includes('TASK_DISPOSITION_INCOMPLETE'));
  } finally { await x.w.cleanup(); }
});

test('the authorization record must be private and intact', async () => {
  const x = await window(); try {
    await fs.writeFile(x.roots.authorization, JSON.stringify(x.authorization), { mode: 0o600 });
    assert.equal((await readWindowAuthorization(x.roots.authorization))?.approvedSha, head);
    await fs.chmod(x.roots.authorization, 0o644); await assert.rejects(readWindowAuthorization(x.roots.authorization), /NOT_PRIVATE/);
    await fs.chmod(x.roots.authorization, 0o600); await fs.writeFile(x.roots.authorization, JSON.stringify({ ...x.authorization, maintenanceWindow: false }));
    await assert.rejects(readWindowAuthorization(x.roots.authorization), /AUTHORIZATION_INVALID/);
  } finally { await x.w.cleanup(); }
});

import { verifyRestoredApplication } from '../scripts/lib/recovery-application.js';
import { fixture } from './helpers/recovery-fixture.js';
import { RETAINED_RELEASE, RETAINED_SOURCE, RETAINED_TRANSACTION } from '../scripts/lib/c14-recovery-preflight.js';
for (const [name, journal] of [
  ['no install journal', null],
  ['a journal with another decision', { transactionId: RETAINED_TRANSACTION, head: RETAINED_SOURCE, candidateId: RETAINED_RELEASE, decision: 'ROLLBACK' }],
  ['a journal for another release', { transactionId: RETAINED_TRANSACTION, head: RETAINED_SOURCE, candidateId: '0.3.2-other', decision: 'RETAIN CANDIDATE' }],
  ['a matching journal but a tree that is not the trusted C13 tree', { transactionId: RETAINED_TRANSACTION, head: RETAINED_SOURCE, candidateId: RETAINED_RELEASE, decision: 'RETAIN CANDIDATE' }]
] as const) test(`journal-bound runtime provenance refuses ${name}`, async () => {
  const w = await fixture(); try {
    await fs.mkdir(path.join(w.source.state, 'runtime/releases', RETAINED_RELEASE), { recursive: true, mode: 0o700 });
    await fs.writeFile(path.join(w.source.state, 'runtime/releases', RETAINED_RELEASE, 'package.json'), '{"forged":true}', { mode: 0o600 });
    if (journal) await fs.writeFile(path.join(w.source.state, 'runtime/c13-maintenance.json'), JSON.stringify(journal), { mode: 0o600 });
    await assert.rejects(verifyRestoredApplication(w.source), /APPLICATION_RUNTIME/);
  } finally { await w.cleanup(); }
});

test('a capture whose restored credentials the candidate cannot authenticate fails and is never certified', async () => {
  const w = await expandedFixture(); try {
    await fs.rm(path.join(w.source.state, 'coordinator/leases/synthetic.json'));
    // Replace the node's transport key so it no longer matches its enrollment.
    const { generateTransportKeyPair } = await import('../src/shared/node-transport-auth.js');
    await fs.writeFile(path.join(w.source.state, `nodes/${nodeId}.transport.ed25519.pem`), generateTransportKeyPair().privateKey, { mode: 0o600 });
    const root = path.join(w.directory, 'w'); await fs.mkdir(root, { mode: 0o700 });
    const dest = path.join(root, 'd'), ev = path.join(root, 'e'), ex = path.join(root, 'x'); for (const d of [dest, ev, ex]) await fs.mkdir(d, { mode: 0o700 });
    const log = await TransactionEvidenceLog.open(ev, nodeId, [...Object.values(w.source), dest]), expectations = await ExpectationStore.open(ex, nodeId, [...Object.values(w.source), dest, log.root]);
    const st = await fs.lstat(dest), v = await fs.statfs(dest);
    const destination: DestinationFacts = { root: dest, approvedRoot: dest, approved: true, device: st.dev, approvedDevice: st.dev, inode: st.ino, approvedInode: st.ino, mountIdentity: 'v', approvedMountIdentity: 'v', ownerUid: st.uid, expectedUid: st.uid, mode: 0o700, writable: true, cloudSynced: false, cloudApproved: false, encrypted: true, durable: true, freeBytes: v.bavail * v.bsize, measured: true, space: recoveryStoragePlan(await inspectCoverage(w.source, 'inspection')), sources: w.source, gitRoots: ['/g'] };
    const o = await captureOffline({ nodeId, transactionId: crypto.randomUUID(), sourceSha: head, roots: w.source, destination, log, expectations, probe });
    assert.equal(o.status, 'FAILED_UNCERTAIN', o.reason); assert.match(o.reason ?? '', /^(APPLICATION_ENROLLMENT|LEGACY_TRANSPORT_PROOF_REFUSED)$/); assert.notEqual(o.status, 'OFFLINE_BACKUP_CERTIFIED');
  } finally { await w.cleanup(); }
});

import { verifyLegacyCompatibility } from '../scripts/lib/recovery-compatibility.js';
test('candidate compatibility signs with the real private key and authenticates it against the real enrollment', async () => {
  const w = await expandedFixture(); try {
    assert.equal((await verifyLegacyCompatibility(w.source)).authMode, 'asymmetric');
    const { generateTransportKeyPair } = await import('../src/shared/node-transport-auth.js');
    await fs.writeFile(path.join(w.source.state, `nodes/${nodeId}.transport.ed25519.pem`), generateTransportKeyPair().privateKey, { mode: 0o600 });
    await assert.rejects(verifyLegacyCompatibility(w.source), /LEGACY_TRANSPORT_PROOF_REFUSED/);
  } finally { await w.cleanup(); }
});
