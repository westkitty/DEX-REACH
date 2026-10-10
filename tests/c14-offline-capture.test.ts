import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fixture } from './helpers/recovery-fixture.js';
import { captureOffline, offlineQuiescenceBlockers, type HostProbe } from '../scripts/lib/recovery-offline-capture.js';
import { TransactionEvidenceLog, ExpectationStore, reconcileTransaction } from '../scripts/lib/recovery-evidence.js';
import { inspectCoverage } from '../scripts/lib/recovery-coverage.js';
import { COMPAT_HOME_PRESERVATION_RULE } from '../scripts/lib/recovery-symlinks.js';
import { recoveryStoragePlan } from '../scripts/lib/recovery-storage.js';
import type { DestinationFacts } from '../scripts/lib/recovery-destination.js';
import { withFileLock } from '../src/shared/state-io.js';
import { taskStoreLockFile } from '../src/node/task-store.js';

const nodeId = 'macbook-air.local' as const;
const content = (m: Awaited<ReturnType<typeof inspectCoverage>>) => m.entries.map(e => `${e.root}/${e.relative}:${e.sha256}:${e.mode}`).join('\n');
const quietProbe = (overrides: Partial<HostProbe> = {}): HostProbe => ({ launchctlPrint: async () => false, processTable: async () => '', selfPid: process.pid, ...overrides });

async function setup() {
  const w = await fixture();
  // The shared fixture carries a stale coordinator lease; an offline window requires none.
  await fs.rm(path.join(w.source.state, 'coordinator/leases/synthetic.json'));
  const priv = async (name: string) => { const d = path.join(w.directory, name); await fs.mkdir(d, { mode: 0o700 }); return d; };
  const root = await priv('backups'), evidenceRoot = await priv('evidence'), expectationRoot = await priv('expectations');
  const forbidden = [...Object.values(w.source), root];
  const log = await TransactionEvidenceLog.open(evidenceRoot, nodeId, forbidden);
  const expectations = await ExpectationStore.open(expectationRoot, nodeId, [...forbidden, evidenceRoot]);
  const manifest = await inspectCoverage(w.source, 'inspection');
  const st = await fs.lstat(root), v = await fs.statfs(root);
  const destination: DestinationFacts = { root, approvedRoot: root, approved: true, device: st.dev, approvedDevice: st.dev, inode: st.ino, approvedInode: st.ino, mountIdentity: 'synthetic-volume', approvedMountIdentity: 'synthetic-volume', ownerUid: st.uid, expectedUid: st.uid, mode: 0o700, writable: true, cloudSynced: false, cloudApproved: false, encrypted: true, durable: true, freeBytes: v.bavail * v.bsize, measured: true, space: recoveryStoragePlan(manifest), sources: w.source, gitRoots: ['/synthetic/git'] };
  const request = (overrides: Partial<Parameters<typeof captureOffline>[0]> = {}) => ({ nodeId, transactionId: crypto.randomUUID(), sourceSha: 'c'.repeat(40), roots: w.source, destination, log, expectations, probe: quietProbe(), ...overrides });
  return { w, root, log, expectations, destination, request };
}

test('a stopped installation is captured, restore-verified and certified once, without touching the source', async () => {
  const s = await setup(); try {
    const before = await inspectCoverage(s.w.source, 'inspection');
    const req = s.request(), outcome = await captureOffline(req);
    assert.equal(outcome.status, 'OFFLINE_BACKUP_CERTIFIED', outcome.reason);
    assert.equal(outcome.retryAuthorized, false); assert.equal(outcome.installationAuthority, false); assert.equal(outcome.servicesRestarted, false);
    assert.match(outcome.manifestDigest ?? '', /^[a-f0-9]{64}$/);
    assert.deepEqual((await s.log.read(req.transactionId)).map(r => r.state), ['PREPARED', 'ACKNOWLEDGED', 'FENCED', 'CAPTURING', 'CAPTURED', 'RESTORE_VERIFIED', 'CERTIFIED']);
    assert.equal((await reconcileTransaction(s.log, s.expectations, s.root, req.transactionId)).state, 'CERTIFIED_VERIFIED');
    assert.deepEqual((await fs.readdir(s.root)).sort(), [req.transactionId], 'the restore check is removed after it passes');
    assert.equal(content(await inspectCoverage(s.w.source, 'inspection')), content(before), 'source unchanged');
    assert.ok((outcome.preservedNonterminalTasks ?? -1) >= 0);
  } finally { await s.w.cleanup(); }
});

for (const [name, probe, reason] of [
  ['a still-loaded service', quietProbe({ launchctlPrint: async label => label.endsWith('.node') }), 'SERVICE_LOADED:node'],
  ['a running compiled service', quietProbe({ processTable: async () => '4242 /opt/homebrew/opt/node/bin/node /Users/x/.dex-reach/runtime/releases/r/dist/src/gateway/main.js\n' }), 'WRITER_PROCESS_PRESENT'],
  ['a tsx development node', quietProbe({ processTable: async () => '4243 node node_modules/tsx/dist/cli.mjs src/node/main.ts\n' }), 'WRITER_PROCESS_PRESENT'],
  ['the adapter child', quietProbe({ processTable: async () => '4244 node /Users/x/.dex-reach/runtime/releases/r/node_modules/@wonderwhy-er/desktop-commander/dist/index.js\n' }), 'WRITER_PROCESS_PRESENT'],
  ['a running installer', quietProbe({ processTable: async () => '4245 node --import tsx scripts/install-macos.ts\n' }), 'MAINTENANCE_PROCESS_PRESENT'],
  ['unobservable launchd', quietProbe({ launchctlPrint: async () => { throw new Error('QUIESCENCE_UNOBSERVABLE'); } }), 'QUIESCENCE_UNOBSERVABLE']
] as const) test(`${name} refuses before anything is written`, async () => {
  const s = await setup(); try {
    const req = s.request({ probe }), outcome = await captureOffline(req);
    assert.equal(outcome.status, 'REFUSED'); assert.equal(outcome.reason, reason);
    assert.deepEqual(await fs.readdir(s.root), []);
    assert.equal(await s.expectations.expected(req.transactionId), null);
    assert.deepEqual((await s.log.read(req.transactionId)).map(r => r.state).at(-1), 'REFUSED');
  } finally { await s.w.cleanup(); }
});

test('the capturing process itself is not mistaken for a writer', async () => {
  const blockers = await offlineQuiescenceBlockers(quietProbe({ processTable: async () => `${process.pid} node --import tsx scripts/c14-recovery.ts capture-offline src/node/main.ts\n` }), '/nonexistent');
  assert.deepEqual(blockers, []);
});

test('a coordinator lease or ticket refuses the window', async () => {
  const s = await setup(); try {
    await fs.writeFile(path.join(s.w.source.state, 'coordinator/queue/ticket.json'), '{}', { mode: 0o600 });
    const outcome = await captureOffline(s.request());
    assert.equal(outcome.reason, 'COORDINATOR_CLAIM_PRESENT');
  } finally { await s.w.cleanup(); }
});

test('an unapproved destination or one bound to other sources refuses', async () => {
  const s = await setup(); try {
    assert.equal((await captureOffline(s.request({ destination: { ...s.destination, approved: false } }))).reason, 'DESTINATION_UNAPPROVED');
    assert.equal((await captureOffline(s.request({ destination: { ...s.destination, sources: { ...s.w.source, worker: '/elsewhere' } } }))).reason, 'DESTINATION_SOURCE_BINDING');
    assert.deepEqual(await fs.readdir(s.root), []);
  } finally { await s.w.cleanup(); }
});

test('an unproven snapshot refuses; the compat-home rule must be explicitly supplied to cover its links', async () => {
  const s = await setup(); try {
    const dir = path.join(s.w.source.state, 'compat-home/Library/pnpm/store/v11/projects'); await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    await fs.symlink('../tmp/pnpm-engine-absent', path.join(dir, 'b6579c7d425767a91f64fbe80a6bc696'));
    assert.equal((await captureOffline(s.request())).reason, 'SNAPSHOT_UNPROVEN');
    const outcome = await captureOffline(s.request({ linkPolicy: { version: 1, rules: [COMPAT_HOME_PRESERVATION_RULE] }, destination: { ...s.destination, space: recoveryStoragePlan(await inspectCoverage(s.w.source, 'inspection', { version: 1, rules: [COMPAT_HOME_PRESERVATION_RULE] })) } }));
    assert.equal(outcome.status, 'OFFLINE_BACKUP_CERTIFIED', outcome.reason);
  } finally { await s.w.cleanup(); }
});

test('lock-serialized writers are blocked for the whole fenced window', async () => {
  const s = await setup(); try {
    let blocked = false;
    const outcome = await captureOffline(s.request({ hooks: { afterFence: async () => {
      blocked = await withFileLock(taskStoreLockFile(s.w.source.state), async () => false, { timeoutMs: 200 }).then(() => false, () => true);
    } } }));
    assert.equal(blocked, true); assert.equal(outcome.status, 'OFFLINE_BACKUP_CERTIFIED', outcome.reason);
  } finally { await s.w.cleanup(); }
});

for (const [name, hook, reason] of [
  ['a service started during the copy', 'afterCopy', 'QUIESCENCE_LOST'],
  ['an unlocked source change during the copy', 'afterCopy', undefined],
  ['backup bytes changed after the restore check', 'afterRestore', 'ARTIFACT_CHANGED_BEFORE_CERTIFICATION']
] as const) test(`${name} is FAILED_UNCERTAIN, never certified and never retried`, async () => {
  const s = await setup(); try {
    let loaded = false; const req = s.request({ probe: quietProbe({ launchctlPrint: async () => loaded }) });
    const fault = async () => {
      if (name.startsWith('a service')) loaded = true;
      else if (name.startsWith('an unlocked')) await fs.appendFile(path.join(s.w.source.state, 'audit.jsonl'), '{"late":true}\n');
      else await fs.appendFile(path.join(s.root, req.transactionId, 'state/audit.jsonl'), 'tampered\n');
    };
    const outcome = await captureOffline({ ...req, hooks: { [hook]: fault } });
    assert.equal(outcome.status, 'FAILED_UNCERTAIN');
    if (reason) assert.equal(outcome.reason, reason);
    assert.equal(outcome.retryAuthorized, false);
    assert.equal((await reconcileTransaction(s.log, s.expectations, s.root, req.transactionId)).state, 'FAILED');
    // The same transaction cannot be run again: its evidence chain is terminal.
    await assert.rejects(captureOffline(req), /EVIDENCE_TRANSITION_REFUSED/);
  } finally { await s.w.cleanup(); }
});
