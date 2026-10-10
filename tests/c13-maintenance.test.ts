import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { EventEmitter } from 'node:events';
import { acceptCandidate, conditionalRecovery, recoveryDecision, installedReady, freshTask, installStatusFresh, assertTarget, expectedHeadForObservation, validateConnectorReadback, type Observation } from '../scripts/lib/c13-acceptance.js';
import { installedQueueProof, waitForCallerExit } from '../scripts/lib/c13-queue-proof.js';
import { coordinatedStatus, CoordinatorUnavailableError } from '../src/coordinator/client.js';
import { ResultStore } from '../src/node/result-store.js';
import type { ReachTaskRecord } from '../src/node/task-store.js';

const ready: Observation = { statusFresh: true, complete: true, helperIdle: true, snapshotValid: true, previousIntact: true, candidateIntact: true, definitionsKnown: true, previousRunning: false, candidateRunning: true };
const task = { taskId: 'rtsk_1a11dd2033f_bafe187416836f1b920ed7d2d4f9fc79', nodeId: 'macbook-air.local', operation: 'dex.fingerprint', actorId: 'actor_123', state: 'COMPLETED', attemptNumber: 1, mutationLevel: 'NONE', resultRef: 'fresh-ref', resultHash: 'a'.repeat(64), createdAtUtc: '2026-10-09T12:01:00Z' } as ReachTaskRecord;

test('successful staged acceptance retains candidate without invoking rollback', async () => {
  const calls: string[] = [];
  assert.equal(await acceptCandidate({ runtime: async () => { assert.ok(installedReady(ready)); calls.push('runtime'); }, task: async () => { calls.push('task'); }, queue: async () => { calls.push('queue'); } }), 'RETAIN CANDIDATE');
  assert.deepEqual(calls, ['runtime', 'task', 'queue', 'runtime']);
});
for (const stage of ['runtime', 'task', 'queue'] as const) test(`post-install ${stage} failure reaches conditional recovery`, async () => {
  const checks = { runtime: async () => {}, task: async () => {}, queue: async () => {} };
  checks[stage] = async () => { throw new Error(`${stage} failure`); };
  let restored = '';
  try { await acceptCandidate(checks); assert.fail('must reject'); }
  catch { assert.equal(await conditionalRecovery(ready, true, async () => { restored = 'exact-previous'; }), 'ROLLED BACK'); }
  assert.equal(restored, 'exact-previous');
});
test('failed installation before activation is safe to retry only after exact prior readback', async () => {
  const untouched = { ...ready, previousRunning: true, candidateRunning: false, snapshotValid: false, definitionsKnown: true };
  assert.equal(recoveryDecision(untouched), 'SAFE TO RETRY');
  assert.equal(recoveryDecision({ ...untouched, definitionsKnown: false }), 'NEEDS RECONCILIATION');
});
test('timeout, interrupted activation, unexpected revision and duplicate services never blindly replay', async () => {
  let effects = 0;
  for (const o of [{ ...ready, helperIdle: false }, { ...ready, definitionsKnown: false }]) {
    assert.equal(await conditionalRecovery(o, true, async () => { effects++; }), 'NEEDS RECONCILIATION');
    assert.equal(installedReady(o), false);
  }
  assert.equal(recoveryDecision({ ...ready, candidateRunning: false }), 'SAFE TO ROLLBACK');
  assert.equal(effects, 0);
});
test('missing/corrupt snapshots and prior integrity failures refuse recovery', async () => {
  let effects = 0;
  assert.equal(await conditionalRecovery({ ...ready, snapshotValid: false }, true, async () => { effects++; }), 'REQUIRES OWNER INPUT');
  assert.equal(recoveryDecision({ ...ready, previousIntact: false }), 'REQUIRES OWNER INPUT');
  assert.equal(installedReady({ ...ready, candidateIntact: false }), false);
  assert.equal(recoveryDecision({ ...ready, snapshotPresent: true, snapshotValid: false, previousRunning: true }), 'REQUIRES OWNER INPUT');
  assert.equal(effects, 0);
});
test('rollback requires separate authorization and failure remains visible', async () => {
  let effects = 0;
  assert.equal(await conditionalRecovery(ready, false, async () => { effects++; }), 'SAFE TO ROLLBACK');
  assert.equal(effects, 0);
  await assert.rejects(conditionalRecovery(ready, true, async () => { throw new Error('rollback failed'); }), /rollback failed/);
});
test('historical failed transaction can be assessed on a newly published clean revision without unpinning active acceptance', () => {
  const oldHead = '075e270';
  const newHead = 'repaired-next-commit';
  assert.equal(expectedHeadForObservation(oldHead, 'active'), oldHead);
  assert.equal(expectedHeadForObservation(oldHead, 'historical-retry'), undefined);
  const target = { root: '/Users/andrew/dex-reach-c13-worker-repair', platform: 'darwin', arch: 'arm64', hostname: 'MacBook-Air.local', user: 'andrew', branch: 'c13-worker-repair', head: newHead, remoteHead: newHead, expectedHead: expectedHeadForObservation(oldHead, 'historical-retry') ?? newHead, dirty: false };
  assert.doesNotThrow(() => assertTarget(target));
  assert.throws(() => assertTarget({ ...target, expectedHead: expectedHeadForObservation(oldHead, 'active')! }));
  assert.throws(() => assertTarget({ ...target, remoteHead: oldHead }));
  assert.equal(recoveryDecision({ ...ready, previousRunning: true, snapshotValid: false, snapshotPresent: false, candidateRunning: false }), 'SAFE TO RETRY');
});

test('missing task, historical handle, incomplete task and ambiguous fresh selection cannot pass', () => {
  const since = '2026-10-09T12:00:00Z';
  assert.throws(() => freshTask([], since, task.nodeId));
  assert.throws(() => freshTask([{ ...task, createdAtUtc: '2026-10-08T00:00:00Z' }], since, task.nodeId));
  for (const change of [{ state: 'RUNNING' }, { resultRef: undefined }, { taskId: 'expired-handle' }, { attemptNumber: 2 }, { nodeId: 'another-node' }]) assert.throws(() => freshTask([{ ...task, ...change } as ReachTaskRecord], since, task.nodeId));
  assert.throws(() => freshTask([task, { ...task, taskId: 'rtsk_1a11dd2033f_bafe187416836f1b920ed7d2d4f9fc80' }], since, task.nodeId));
  assert.equal(freshTask([task], since, task.nodeId).taskId, task.taskId);
});
test('expired actual persisted result cannot satisfy fresh acceptance', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'c13-result-'));
  try {
    const store = new ResultStore(65536, 1, directory);
    const result = await store.boundWithReference({ nodeId: task.nodeId }, task.taskId);
    await new Promise(resolve => setTimeout(resolve, 20));
    await assert.rejects(store.readValue(result.metadata.handle), /expired/);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
test('status success binds transaction, candidate path and fresh timestamp', () => {
  const status = { transactionId: 'new', runtimeRoot: '/candidate', startedAt: '2026-10-09T12:00:01Z', state: 'complete' };
  assert.ok(installStatusFresh(status, 'new', '/candidate', '2026-10-09T12:00:00Z'));
  for (const change of [{ transactionId: 'old' }, { runtimeRoot: '/previous' }, { startedAt: '2026-10-08T00:00:00Z' }, { startedAt: 'invalid' }]) assert.equal(installStatusFresh({ ...status, ...change }, 'new', '/candidate', '2026-10-09T12:00:00Z'), false);
  assert.equal(installedReady({ ...ready, statusFresh: false }), false);
});
test('incorrect physical host, branch, dirty tree or revision blocks execution', () => {
  const target = { root: '/Users/andrew/dex-reach-c13-worker-repair', platform: 'darwin', arch: 'arm64', hostname: 'MacBook-Air.local', user: 'andrew', branch: 'c13-worker-repair', head: 'expected', remoteHead: 'expected', expectedHead: 'expected', dirty: false };
  assert.doesNotThrow(() => assertTarget(target));
  for (const change of [{ hostname: 'Big-Mac.local' }, { root: '/another' }, { platform: 'linux' }, { arch: 'x64' }, { branch: 'main' }, { dirty: true }, { head: 'wrong' }, { remoteHead: 'wrong' }]) assert.throws(() => assertTarget({ ...target, ...change }));
});
test('connector readback binds returned fresh ID, actor and content without a manual ID placeholder', () => {
  const result = { nodeId: task.nodeId, hostname: 'MacBook-Air.local' };
  const evidence = { task, result };
  assert.doesNotThrow(() => validateConnectorReadback(evidence, task, result));
  assert.doesNotThrow(() => validateConnectorReadback({ content: [{ type: 'text', text: JSON.stringify(evidence) }] }, task, result));
  for (const value of [{ task: { ...task, taskId: 'old' }, result }, { task: { ...task, actorId: 'other' }, result }, { task, result: { nodeId: 'another' } }, { task }]) assert.throws(() => validateConnectorReadback(value, task, result));
});

for (const mode of ['success', 'wrong-pid', 'acquire-lost', 'cleanup-failed', 'signal-during-status'] as const) test(`installed queue proof cleans scoped reservations: ${mode}`, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'c13-queue-fixture-'));
  const socketPath = path.join(directory, 'coord.sock');
  await fs.mkdir(path.join(directory, 'real'));
  await fs.symlink(path.join(directory, 'real'), path.join(directory, 'alias'));
  const server = net.createServer(); await new Promise<void>(resolve => server.listen(socketPath, resolve));
  let repositoryRoot = ''; let leases: any[] = []; let tickets: any[] = [];
  const unrelated = { id: 'real-work', repositoryRoot: '/unrelated', pid: 3 };
  let count = 0; let currentChild: any;
  const client: any = {
    coordinatedStatus: async () => { count++; if (mode === 'signal-during-status' && count === 2) { process.emit('SIGTERM'); await new Promise(resolve => setImmediate(resolve)); } return { leases: [...leases], tickets: [...tickets] }; },
    coordinatedAcquire: async (request: any) => { repositoryRoot = request.repositoryRoot; assert.equal(repositoryRoot, await fs.realpath(repositoryRoot)); leases.push({ id: 'test-lease', repositoryRoot, pid: process.pid }); if (mode === 'acquire-lost') throw new Error('lost reply'); return { status: 'acquired', lease: leases[0] }; },
    coordinatedCancel: async (id: string) => { tickets = tickets.filter(t => t.id !== id); return true; },
    coordinatedRelease: async (id: string) => { if (mode === 'cleanup-failed') return { released: false }; leases = leases.filter(l => l.id !== id); return { released: true }; }
  };
  const spawnCaller: any = () => {
    const child: any = new EventEmitter(); currentChild = child; child.pid = 12345; child.exitCode = null; child.signalCode = null; child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
    const finish = () => { child.exitCode = 0; queueMicrotask(() => child.emit('exit', 0)); };
    child.stdin = { end: finish }; child.kill = finish;
    queueMicrotask(() => {
      tickets.push({ id: 'ticket', repositoryRoot, pid: mode === 'wrong-pid' ? 99 : child.pid, pidIsWorkload: false });
      // Other work appearing during the proof is never released by test cleanup.
      leases.push(unrelated);
      child.stdout.emit('data', JSON.stringify({ pid: child.pid, result: { status: 'queued', ticket: tickets[0] } }) + '\n');
    });
    return child;
  };
  try {
    const proof = installedQueueProof('/fixture-installed-release', { client, socketPath, spawnCaller, temporaryDirectory: path.join(directory, 'alias') });
    if (mode === 'success') await proof; else await assert.rejects(proof, /queue regression or cleanup failed/);
    assert.equal(tickets.length, 0);
    if (mode === 'cleanup-failed') await fs.rmdir(repositoryRoot);
    if (mode !== 'cleanup-failed') assert.ok(!leases.some(l => l.repositoryRoot === repositoryRoot));
    if (mode !== 'acquire-lost') assert.ok(leases.some(l => l.id === 'real-work'));
    assert.ok(count > 1);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); await fs.rm(directory, { recursive: true, force: true }); }
});

test('unresolved queue cleanup blocks rollback and later acceptance until reconciled', async () => {
  const unresolved = { ...ready, cleanupPending: true };
  let mutations = 0;
  assert.equal(installedReady(unresolved), false);
  assert.equal(await conditionalRecovery(unresolved, true, async () => { mutations++; }), 'NEEDS RECONCILIATION');
  assert.equal(mutations, 0);
});

test('daemon-required acceptance refuses direct fallback when socket is absent', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'c13-no-daemon-'));
  const before = process.env.DEX_REACH_STATE_DIR;
  process.env.DEX_REACH_STATE_DIR = directory;
  try { await assert.rejects(coordinatedStatus({ requireDaemon: true }), CoordinatorUnavailableError); }
  finally { if (before === undefined) delete process.env.DEX_REACH_STATE_DIR; else process.env.DEX_REACH_STATE_DIR = before; await fs.rm(directory, { recursive: true, force: true }); }
});

test('caller exit wait handles already-exited and bounds missing exit evidence', async () => {
  const child: any = new EventEmitter(); child.exitCode = 0; child.signalCode = null;
  await waitForCallerExit(child, 10);
  child.exitCode = null;
  await assert.rejects(waitForCallerExit(child, 10), /exit unproven/);
});

test('uncertain installer effects remain blocked until owning-system reconciliation', async () => {
  const unknown = { ...ready, uncertainOperation: true };
  let effects = 0;
  assert.equal(installedReady(unknown), false);
  assert.equal(await conditionalRecovery(unknown, true, async () => { effects++; }), 'NEEDS RECONCILIATION');
  assert.equal(effects, 0);
  assert.equal(recoveryDecision({ ...unknown, uncertainOperation: false, candidateRunning: false }), 'SAFE TO ROLLBACK');
});
