import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { TransactionEvidenceLog, ExpectationStore, artifactDigest, reconcileTransaction } from '../scripts/lib/recovery-evidence.js';
import { WRITER_OWNERSHIP, ownershipBlockers } from '../scripts/lib/recovery-checkpoint.js';
import { CheckpointParticipant, CheckpointAdmissionClosedError, processCheckpoint, NODE_PARTICIPANT_GROUPS, WRITER_GROUPS, assertControlDirectory } from '../src/shared/checkpoint.js';
import { validateLiveBoundaryEvidence } from '../scripts/lib/c14-recovery-preflight.js';

const nodeId = 'macbook-air.local', H = 'a'.repeat(64);
async function dirs() {
  const base = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'dexevt-'));
  const make = async (n: string) => { const d = path.join(base, n); await fs.mkdir(d, { mode: 0o700 }); return d; };
  return { base, evidence: await make('evidence'), expectations: await make('expectations'), destination: await make('destination'), source: await make('source') };
}
async function stores(d: Awaited<ReturnType<typeof dirs>>, node = nodeId) {
  return { log: await TransactionEvidenceLog.open(d.evidence, node, [d.expectations, d.destination, d.source]), expectations: await ExpectationStore.open(d.expectations, node, [d.evidence, d.destination, d.source]) };
}
async function artifact(d: Awaited<ReturnType<typeof dirs>>, txn: string) {
  for (const r of ['state', 'agents', 'worker']) await fs.mkdir(path.join(d.destination, txn, r), { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(d.destination, txn, 'state', 'tasks.json'), '{"synthetic":true}', { mode: 0o600 });
  return artifactDigest(path.join(d.destination, txn));
}
async function certifiedChain(d: Awaited<ReturnType<typeof dirs>>) {
  const { log, expectations } = await stores(d), txn = crypto.randomUUID(), digest = await artifact(d, txn);
  await expectations.record(txn, H, H);
  for (const [state, data] of [['PREPARED', {}], ['ACKNOWLEDGED', {}], ['FENCED', {}], ['CAPTURING', {}], ['CAPTURED', { manifestDigest: H, artifactDigest: digest }], ['RESTORE_VERIFIED', {}], ['CERTIFIED', {}]] as const) await log.append(txn, state, data);
  return { log, expectations, txn };
}

test('evidence chain certifies only with a matching artifact and an independent expectation', async () => {
  const d = await dirs(); try {
    const { log, expectations, txn } = await certifiedChain(d);
    assert.equal((await reconcileTransaction(log, expectations, d.destination, txn)).state, 'CERTIFIED_VERIFIED');
    // Backup artifact substitution: same manifest claims, different bytes.
    await fs.writeFile(path.join(d.destination, txn, 'state', 'tasks.json'), '{"synthetic":false}', { mode: 0o600 });
    const r = await reconcileTransaction(log, expectations, d.destination, txn);
    assert.equal(r.state, 'CERTIFIED_ARTIFACT_CHANGED'); assert.equal(r.retryAuthorized, false); assert.equal(r.installationAuthority, false);
  } finally { await fs.rm(d.base, { recursive: true, force: true }); }
});
test('a certified chain without its independent expectation does not verify', async () => {
  const d = await dirs(); try {
    const { log, expectations, txn } = await certifiedChain(d);
    await fs.rm(path.join(d.expectations, `${txn}.json`));
    assert.equal((await reconcileTransaction(log, expectations, d.destination, txn)).state, 'CERTIFIED_ARTIFACT_CHANGED');
  } finally { await fs.rm(d.base, { recursive: true, force: true }); }
});
test('evidence history is append-only: tamper, gaps, overwrite, reorder and illegal transitions refuse', async () => {
  const d = await dirs(); try {
    const { log, txn } = await certifiedChain(d), dir = path.join(d.evidence, txn);
    await assert.rejects(log.append(txn, 'CERTIFIED'), /EVIDENCE_TRANSITION_REFUSED/);
    const fresh = crypto.randomUUID();
    await assert.rejects(log.append(fresh, 'CERTIFIED'), /EVIDENCE_TRANSITION_REFUSED:NONE/);
    await log.append(fresh, 'PREPARED'); await assert.rejects(log.append(fresh, 'CAPTURED'), /EVIDENCE_TRANSITION_REFUSED/);
    const file = path.join(dir, '0004.json'), original = await fs.readFile(file, 'utf8');
    await fs.writeFile(file, original.replace(H, 'b'.repeat(64)));
    await assert.rejects(log.read(txn), /EVIDENCE_CHAIN_INVALID/);
    await fs.writeFile(file, original); await fs.rename(path.join(dir, '0002.json'), path.join(dir, '0009.json'));
    await assert.rejects(log.read(txn), /EVIDENCE_SEQUENCE_BROKEN/);
  } finally { await fs.rm(d.base, { recursive: true, force: true }); }
});
test('cross-node evidence substitution and corrupt expectations refuse', async () => {
  const d = await dirs(); try {
    const { txn } = await certifiedChain(d), other = await stores(d, 'other-node');
    await assert.rejects(other.log.read(txn), /EVIDENCE_CHAIN_INVALID/);
    await assert.rejects(other.expectations.expected(txn), /EXPECTATION_CORRUPT/);
    const { expectations } = await stores(d);
    await assert.rejects(expectations.record(txn, H, H), /EEXIST/);
  } finally { await fs.rm(d.base, { recursive: true, force: true }); }
});
test('an interrupted transaction stays UNCERTAIN whatever survives; nothing authorizes retry', async () => {
  const d = await dirs(); try {
    const { log, expectations } = await stores(d);
    for (const stop of ['PREPARED', 'FENCED', 'CAPTURING', 'CAPTURED', 'RESTORE_VERIFIED'] as const) {
      const txn = crypto.randomUUID(), digest = await artifact(d, txn);
      for (const s of ['PREPARED', 'ACKNOWLEDGED', 'FENCED', 'CAPTURING', 'CAPTURED', 'RESTORE_VERIFIED'] as const) {
        await log.append(txn, s, s === 'CAPTURED' ? { manifestDigest: H, artifactDigest: digest } : {}); if (s === stop) break;
      }
      const r = await reconcileTransaction(log, expectations, d.destination, txn);
      assert.equal(r.state, 'UNCERTAIN_INTERRUPTED', stop); assert.equal(r.retryAuthorized, false);
    }
    assert.equal((await reconcileTransaction(log, expectations, d.destination, crypto.randomUUID())).state, 'UNKNOWN');
  } finally { await fs.rm(d.base, { recursive: true, force: true }); }
});
test('evidence and expectation roots must be private and independent of each other, the source and the destination', async () => {
  const d = await dirs(); try {
    await assert.rejects(TransactionEvidenceLog.open(d.evidence, nodeId, [d.evidence]), /EVIDENCE_ROOT_OVERLAP/);
    await assert.rejects(ExpectationStore.open(path.join(d.destination), nodeId, [d.destination]), /EXPECTATION_ROOT_OVERLAP/);
    await fs.chmod(d.source, 0o755); await assert.rejects(TransactionEvidenceLog.open(d.source, nodeId, []), /EVIDENCE_ROOT_NOT_PRIVATE/);
    const link = path.join(d.base, 'link'); await fs.symlink(d.evidence, link);
    await assert.rejects(TransactionEvidenceLog.open(link, nodeId, []));
  } finally { await fs.rm(d.base, { recursive: true, force: true }); }
});
test('every documented writer group has exactly one registered owner and defined quiescence', () => {
  assert.deepEqual(ownershipBlockers(), []);
  assert.deepEqual(WRITER_OWNERSHIP.map(m => m.group).sort(), [...WRITER_GROUPS].sort());
  assert.ok(ownershipBlockers(WRITER_OWNERSHIP.filter(m => m.group !== 'oauth')).includes('WRITER_OWNERSHIP_UNKNOWN:oauth'));
  assert.ok(ownershipBlockers([...WRITER_OWNERSHIP, WRITER_OWNERSHIP[0]!]).some(i => i.startsWith('WRITER_OWNERSHIP_UNKNOWN')));
  assert.ok(ownershipBlockers(WRITER_OWNERSHIP.map(m => m.group === 'oauth' ? { ...m, participants: [] } : m)).includes('WRITER_QUIESCENCE_UNDEFINED:oauth'));
  assert.ok(ownershipBlockers(WRITER_OWNERSHIP.map(m => m.group === 'coordinator' ? { ...m, participants: ['gateway' as const] } : m)).includes('PARTICIPANT_DOES_NOT_OWN:gateway:coordinator'));
});
test('the process gate is IDLE by default: a direct call with no refusal, timers or sockets', async () => {
  const gate = processCheckpoint();
  assert.equal(gate.enabled, false);
  assert.equal(await gate.admit(async () => 1), 1); assert.equal(await gate.track(async () => 2), 2); assert.equal(await gate.defer(async () => 3), 3);
  let ran = false; await gate.skipWhileHeld(async () => { ran = true; }); assert.ok(ran);
  await assert.rejects(gate.admit(async () => { throw new Error('propagates'); }), /propagates/);
});
test('participant semantics: refuse before start, drain admitted continuations, expire a lost holder, sign every reply', async () => {
  const p = new CheckpointParticipant('node', nodeId, NODE_PARTICIPANT_GROUPS, { path: '/synthetic', dev: 1, ino: 2 });
  let release!: () => void; const inFlight = p.admit(() => new Promise<void>(r => { release = r; }));
  const txn = crypto.randomUUID(), nonce = 'c'.repeat(64);
  const preparing = p.prepare({ txn, nonce, holdMs: 300, drainMs: 250 });
  let ran = false; await assert.rejects(p.admit(async () => { ran = true; }), CheckpointAdmissionClosedError); assert.equal(ran, false);
  let continued = false; const continuation = p.track(async () => { continued = true; });
  let skipped = true; await p.skipWhileHeld(async () => { skipped = false; }); assert.ok(skipped);
  release(); await inFlight; await continuation; assert.ok(continued);
  const ack = (await preparing).payload; assert.equal(ack.type, 'ack'); assert.equal(ack.inFlight, 0);
  assert.equal((await p.prepare({ txn: crypto.randomUUID(), nonce, holdMs: 300, drainMs: 10 })).payload.reason, 'CHECKPOINT_ALREADY_HELD');
  let deferred = false; const deferring = p.defer(async () => { deferred = true; });
  await new Promise(r => setTimeout(r, 50)); assert.equal(deferred, false);
  await new Promise(r => setTimeout(r, 350)); await deferring; assert.ok(deferred);
  assert.equal(p.verify({ txn, nonce }).payload.held, false);
  assert.equal(await p.admit(async () => 'open'), 'open');
  await assert.rejects(p.prepare({ txn: 'not-a-uuid', nonce, holdMs: 1, drainMs: 0 }), /CHECKPOINT_REQUEST_INVALID/);
  await assert.rejects(p.prepare({ txn, nonce, holdMs: 60 * 60_000, drainMs: 0 }), /CHECKPOINT_REQUEST_INVALID/);
});
test('control directory must be owner-only and not a symlink', async () => {
  const base = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'dexctl-')); try {
    await fs.chmod(base, 0o700); await assertControlDirectory(base);
    await fs.chmod(base, 0o750); await assert.rejects(assertControlDirectory(base), /UNSAFE/);
    await fs.chmod(base, 0o700); const link = `${base}-link`; await fs.symlink(base, link);
    await assert.rejects(assertControlDirectory(link), /UNSAFE/); await fs.rm(link);
    await assert.rejects(assertControlDirectory('relative/dir'), /INVALID/);
  } finally { await fs.rm(base, { recursive: true, force: true }); }
});
test('certified synthetic checkpoint evidence still cannot satisfy any live boundary gate', () => {
  const gates = validateLiveBoundaryEvidence({ scope: 'live', version: 1, symlinkPolicy: true, knownFamilies: true, consistency: true, manifestTrust: true, destination: true, durableBackup: true, restore: true, taskDisposition: true, provenance: true, candidateIdentity: true });
  assert.ok(Object.values(gates).every(v => v === false));
});
test('checkpoint gate overhead on matched synthetic workloads (idle, enabled-open)', async () => {
  const N = 200_000, work = async () => 1;
  const time = async (f: () => Promise<unknown>) => { for (let i = 0; i < 5_000; i++) await f(); const t = process.hrtime.bigint(); for (let i = 0; i < N; i++) await f(); return Number(process.hrtime.bigint() - t) / N; };
  const direct = await time(work), idle = await time(() => processCheckpoint().admit(work));
  const enabled = new CheckpointParticipant('node', nodeId, NODE_PARTICIPANT_GROUPS, { path: '/synthetic', dev: 1, ino: 2 });
  const open = await time(() => enabled.admit(work));
  console.log(`CHECKPOINT_OVERHEAD_NS direct=${direct.toFixed(0)} idle=${idle.toFixed(0)} enabledOpen=${open.toFixed(0)} perCall`);
  // Bound on absolute added cost, not a ratio: a sub-microsecond gate on a millisecond operation.
  assert.ok(idle - direct < 2_000, `idle gate overhead ${idle - direct}ns`); assert.ok(open - direct < 5_000, `enabled gate overhead ${open - direct}ns`);
});
test('matched real-module workload: durable task create and transitions, direct versus gated', async () => {
  const { createSyntheticWorkspace } = await import('../scripts/lib/recovery-rehearsal.js');
  const { NodeTaskStore } = await import('../src/node/task-store.js');
  const w = await createSyntheticWorkspace(); try {
    const store = new NodeTaskStore(w.source.state), gate = new CheckpointParticipant('node', nodeId, NODE_PARTICIPANT_GROUPS, { path: '/synthetic', dev: 1, ino: 2 });
    let n = 0; const op = async () => { const t = await store.create({ actorId: 'synthetic-actor', nodeId, operation: 'dex.fingerprint', idempotencyKey: `perf-${n++}`, payloadSha256: H, safetyClass: 'PURE_READ_IDEMPOTENT', mutationLevel: 'NONE' }); await store.transition(t.taskId, 'PREPARING'); await store.transition(t.taskId, 'RUNNING'); };
    const time = async (f: () => Promise<unknown>, k = 40) => { const samples: number[] = []; for (let i = 0; i < k; i++) { const t = process.hrtime.bigint(); await f(); samples.push(Number(process.hrtime.bigint() - t) / 1e6); } return samples.sort((a, b) => a - b)[Math.floor(k / 2)]!; };
    await time(op, 10);
    const direct = await time(op), idle = await time(() => processCheckpoint().admit(op)), enabled = await time(() => gate.admit(op));
    console.log(`CHECKPOINT_WORKLOAD_MEDIAN_MS direct=${direct.toFixed(3)} idle=${idle.toFixed(3)} enabledOpen=${enabled.toFixed(3)}`);
  } finally { await w.cleanup(); }
});
test('fenced lock paths are exactly the production writers\' own lock files', async () => {
  const { secretsFile } = await import('../src/shared/secrets.js');
  const { taskStoreLockFile } = await import('../src/node/task-store.js');
  const { accessLockFile } = await import('../src/shared/access.js');
  const state = '/synthetic/state', locks = WRITER_OWNERSHIP.flatMap(m => m.locks(state, nodeId));
  for (const expected of [`${secretsFile(nodeId, state)}.lock`, taskStoreLockFile(state), accessLockFile(nodeId, state)]) assert.ok(locks.includes(expected), expected);
  // Helpers that resolve from the process state directory, checked under an isolated DEX_REACH_STATE_DIR.
  const previous = process.env.DEX_REACH_STATE_DIR; process.env.DEX_REACH_STATE_DIR = state;
  try {
    const { coordinatorLockFile, historyLockFile } = await import('../src/shared/work-coordinator.js');
    const { activityLockFile } = await import('../src/shared/activity.js');
    for (const expected of [coordinatorLockFile(), historyLockFile(), activityLockFile()]) assert.ok(locks.includes(expected), expected);
  } finally { if (previous === undefined) delete process.env.DEX_REACH_STATE_DIR; else process.env.DEX_REACH_STATE_DIR = previous; }
  assert.equal(new Set(locks).size, locks.length);
});
for (const kind of ['receipt-edited', 'manifest-deleted', 'extra-top-level-file']) test(`artifact digest covers the whole transaction directory: ${kind}`, async () => {
  const d = await dirs(); try {
    const { log, expectations } = await stores(d), txn = crypto.randomUUID(), root = path.join(d.destination, txn);
    for (const r of ['state', 'agents', 'worker']) await fs.mkdir(path.join(root, r), { recursive: true, mode: 0o700 });
    await fs.writeFile(path.join(root, 'manifest.private.json'), '{"m":1}', { mode: 0o600 }); await fs.writeFile(path.join(root, 'receipt.private.json'), '{"r":1}', { mode: 0o600 });
    const digest = await artifactDigest(root); await expectations.record(txn, H, H);
    for (const [s, data] of [['PREPARED', {}], ['ACKNOWLEDGED', {}], ['FENCED', {}], ['CAPTURING', {}], ['CAPTURED', { manifestDigest: H, artifactDigest: digest }], ['RESTORE_VERIFIED', {}], ['CERTIFIED', {}]] as const) await log.append(txn, s, data);
    assert.equal((await reconcileTransaction(log, expectations, d.destination, txn)).state, 'CERTIFIED_VERIFIED');
    if (kind === 'receipt-edited') await fs.writeFile(path.join(root, 'receipt.private.json'), '{"r":2}');
    if (kind === 'manifest-deleted') await fs.rm(path.join(root, 'manifest.private.json'));
    if (kind === 'extra-top-level-file') await fs.writeFile(path.join(root, 'planted.json'), '{}', { mode: 0o600 });
    assert.equal((await reconcileTransaction(log, expectations, d.destination, txn)).state, 'CERTIFIED_ARTIFACT_CHANGED');
  } finally { await fs.rm(d.base, { recursive: true, force: true }); }
});
test('a second participant cannot displace a live control socket', async () => {
  const { enableProcessCheckpoint } = await import('../src/shared/checkpoint.js');
  const base = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'dexsk-')); try {
    const sock = path.join(base, 'node.sock'), net = await import('node:net');
    const live = net.createServer(); await new Promise<void>(r => live.listen(sock, () => r()));
    await assert.rejects(enableProcessCheckpoint('node', nodeId, NODE_PARTICIPANT_GROUPS, sock, base), /CHECKPOINT_SOCKET_IN_USE/);
    assert.ok((await fs.lstat(sock)).isSocket());
    await new Promise<void>(r => live.close(() => r()));
  } finally { await fs.rm(base, { recursive: true, force: true }); }
});
test('checkpoint refusal reasons are fixed codes, never raw error text', async () => {
  const { refusalCode } = await import('../scripts/lib/recovery-checkpoint.js');
  assert.equal(refusalCode(new Error('WRITER_ACK_INVALID:node')), 'WRITER_ACK_INVALID:node');
  assert.equal(refusalCode(Object.assign(new Error("ENOENT: no such file or directory, open '/Users/andrew/.dex-reach/secrets.env'"), { code: 'ENOENT' })), 'CHECKPOINT_FAILED:ENOENT');
  assert.equal(refusalCode(new SyntaxError('Unexpected token s in JSON at position 0: "secret-value"')), 'CHECKPOINT_FAILED');
  assert.equal(refusalCode('x'), 'CHECKPOINT_FAILED');
});
