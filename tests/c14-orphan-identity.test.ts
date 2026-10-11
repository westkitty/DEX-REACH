import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createSyntheticWorkspace } from '../scripts/lib/recovery-rehearsal.js';
import { NodeTaskStore, type ReachTaskRecord } from '../src/node/task-store.js';
import { ResultStore } from '../src/node/result-store.js';
import { reconcileBootTasks, superviseAmbiguousTasks } from '../src/node/boot-recovery.js';
import { decideExistingTask } from '../src/shared/durable-execution.js';
import { listProcessActivities, startProcessActivity, type ProcessActivity } from '../src/shared/activity.js';
import { assertIdentityBindingUnchanged, captureProcessIdentity, parseProcessIdentity, pidExists, verifyProcessIdentity, type ProcessIdentity } from '../src/shared/process-identity.js';
import type { WorkStatus } from '../src/shared/work-coordinator.js';

// Repairs C and D. Sandbox tests use synthetic evidence and real processes; they cannot prove macOS
// behaviour. The macOS start-identity path (ps lstart) is verified only on a Mac (see OPERATIONAL_STATE.md).

const NODE = 'macbook-air.local';
const PAYLOAD = 'd'.repeat(64);
const UNUSED_PID = 2_147_483_646; // beyond any kernel pid_max, so the PID cannot exist.
const LINUX = process.platform === 'linux';

async function withStateDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dex-orphan-'));
  const previous = process.env.DEX_REACH_STATE_DIR;
  process.env.DEX_REACH_STATE_DIR = dir;
  try { return await fn(dir); } finally {
    if (previous === undefined) delete process.env.DEX_REACH_STATE_DIR; else process.env.DEX_REACH_STATE_DIR = previous;
    await fs.rm(dir, { recursive: true, force: true });
  }
}

async function runningTask(store: NodeTaskStore, key: string, safetyClass: 'PROCESS_UNKNOWN_EFFECT' | 'PURE_READ_IDEMPOTENT' = 'PROCESS_UNKNOWN_EFFECT'): Promise<ReachTaskRecord> {
  const t = await store.create({ actorId: 'synthetic-actor', nodeId: NODE, operation: 'dex.process.run', idempotencyKey: key, payloadSha256: PAYLOAD, safetyClass, mutationLevel: 'STATE_MUTATION' });
  await store.transition(t.taskId, 'PREPARING');
  return store.transition(t.taskId, 'RUNNING');
}

function activityFor(task: ReachTaskRecord, pid: number, state: ProcessActivity['state'] = 'running', identity?: ProcessIdentity): ProcessActivity {
  return {
    id: `activity-${task.taskId}`, kind: 'native-process', state, pid, operation: 'dex.process.run', processLabel: 'sh',
    taskId: task.taskId, attempt: task.attemptNumber, startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    ...(identity ? { identity } : {})
  };
}

function leaseFor(task: ReachTaskRecord, id = `lease-${task.taskId}`): WorkStatus {
  return { leases: [{ id, taskId: task.taskId, attempt: task.attemptNumber, pid: UNUSED_PID }], tickets: [] } as unknown as WorkStatus;
}

const syntheticIdentity = (pid: number, startToken = 'synthetic-start-token'): ProcessIdentity =>
  ({ version: 1, pid, platform: process.platform as 'linux' | 'darwin', startToken, capturedAt: new Date().toISOString() });

// ---- Repair D: process identity ----

test('a PID with no recorded identity is never proof of life (legacy metadata fails closed)', async () => {
  assert.equal(await verifyProcessIdentity(undefined, process.pid), 'UNVERIFIABLE');
});

test('a dead PID is GONE; kill(pid,0) alone is not used as proof of life', async () => {
  assert.equal(pidExists(UNUSED_PID), false);
  assert.equal(await verifyProcessIdentity(syntheticIdentity(UNUSED_PID), UNUSED_PID), 'GONE');
});

test('synthetic PID reuse: a live PID with a different start token is REUSED, not SAME', { skip: !LINUX && process.platform !== 'darwin' }, async () => {
  assert.equal(await verifyProcessIdentity(syntheticIdentity(process.pid, 'some-other-process'), process.pid), 'REUSED');
});

test('a real identity captured for this process verifies SAME, and a foreign identity never matches', { skip: !LINUX && process.platform !== 'darwin' }, async () => {
  const identity = await captureProcessIdentity(process.pid);
  assert.ok(identity, 'identity is captured on this platform');
  assert.equal(await verifyProcessIdentity(identity, process.pid), 'SAME');
  assert.equal(await verifyProcessIdentity({ ...identity!, pid: process.pid + 1 }, process.pid), 'UNVERIFIABLE', 'a contradictory PID is refused');
});

test('identity metadata is versioned: unknown versions and malformed shapes are refused, absent is legacy', () => {
  assert.equal(parseProcessIdentity(undefined), undefined);
  assert.equal(parseProcessIdentity({ ...syntheticIdentity(7), version: 2 }), null);
  assert.equal(parseProcessIdentity({ ...syntheticIdentity(7), startToken: '' }), null);
  assert.equal(parseProcessIdentity({ ...syntheticIdentity(7), platform: 'plan9' }), null);
  assert.ok(parseProcessIdentity(syntheticIdentity(7)));
});

test('identity bindings are immutable: a changed start token or PID is refused, never merged', () => {
  const before = syntheticIdentity(9, 'first');
  assert.doesNotThrow(() => assertIdentityBindingUnchanged(before, { ...before }));
  assert.throws(() => assertIdentityBindingUnchanged(before, { ...before, startToken: 'second' }), /immutable/);
  assert.throws(() => assertIdentityBindingUnchanged(before, { ...before, pid: 10 }), /immutable/);
  assert.throws(() => assertIdentityBindingUnchanged(before, undefined), /immutable/);
});

test('activity rows capture identity at spawn; a PID-reuse row is marked ended, a legacy live row is kept', { skip: !LINUX && process.platform !== 'darwin' }, async () => {
  await withStateDir(async dir => {
    const spawned = await startProcessActivity({ kind: 'native-process', pid: process.pid, operation: 'dex.process.run', command: 'node' });
    assert.ok(spawned.identity, 'identity captured at spawn');
    // Rewrite the store with a synthetic reused identity and a legacy row for the same live PID.
    const file = path.join(dir, 'activity', 'processes.json');
    const records = JSON.parse(await fs.readFile(file, 'utf8')) as ProcessActivity[];
    records[0]!.identity = syntheticIdentity(process.pid, 'reused-by-another-process');
    records.push({ ...activityFor({ taskId: 'rtsk_0123456789a_0123456789abcdef0123' } as ReachTaskRecord, process.pid), id: 'activity-legacy-row', taskId: undefined, attempt: undefined });
    await fs.writeFile(file, JSON.stringify(records));
    const after = await listProcessActivities({ includeFinished: true });
    assert.equal(after.find(r => r.id === spawned.id)?.state, 'exited', 'a reused PID does not keep the recorded process alive');
    assert.equal(after.find(r => r.id === 'activity-legacy-row')?.state, 'running', 'a legacy row is never claimed dead on a live PID');
  });
});

test('activity rows with a malformed or unknown-version identity are refused, not ignored', async () => {
  await withStateDir(async dir => {
    await fs.mkdir(path.join(dir, 'activity'), { recursive: true });
    const row = { ...activityFor({ taskId: 'rtsk_0123456789a_0123456789abcdef0123' } as ReachTaskRecord, process.pid), identity: { ...syntheticIdentity(process.pid), version: 9 } };
    await fs.writeFile(path.join(dir, 'activity', 'processes.json'), JSON.stringify([row]));
    await assert.rejects(listProcessActivities({ includeFinished: true }), /malformed/);
  });
});

// ---- Repair C: orphan monitoring and boot recovery (synthetic evidence at the durable-task boundary) ----

test('restart while the orphan is active: the task is AMBIGUOUS, the lease is kept fresh, and nothing is replayed', async () => {
  const w = await createSyntheticWorkspace(); try {
    const store = new NodeTaskStore(w.source.state), results = new ResultStore(64 * 1024, 60_000, w.source.state);
    const task = await runningTask(store, 'orphan-active');
    const heartbeats: string[] = [];
    const [report] = await reconcileBootTasks(store, results, {
      coordinator: leaseFor(task), transportConnected: true,
      activities: [activityFor(task, UNUSED_PID)],
      verify: async () => 'SAME', heartbeatLease: async id => { heartbeats.push(id); return true; }
    });
    assert.equal(report?.decision.kind, 'MONITOR_ORPHAN');
    const after = (await store.read(task.taskId))!;
    assert.equal(after.state, 'AMBIGUOUS');
    assert.equal(after.failureClass, 'AMBIGUOUS_EFFECT');
    assert.equal(after.resultRef, undefined);
    assert.deepEqual(heartbeats, [`lease-${task.taskId}`]);
    // A later supervision pass with the orphan still verified keeps observing; it never transitions.
    await superviseAmbiguousTasks(store, { coordinator: leaseFor(task), activities: [activityFor(task, UNUSED_PID, 'running')], verify: async () => 'SAME', heartbeatLease: async id => { heartbeats.push(id); return true; } });
    assert.equal((await store.read(task.taskId))?.state, 'AMBIGUOUS');
    assert.equal(heartbeats.length, 2);
  } finally { await w.cleanup(); }
});

test('node-only SIGKILL with a surviving shell: a real orphan is monitored, and the identical key never runs it again', { skip: !LINUX && process.platform !== 'darwin' }, async () => {
  const effects = await fs.mkdtemp(path.join(os.tmpdir(), 'dex-orphan-effects-'));
  const oracle = path.join(effects, 'effect.txt');
  const release = path.join(effects, 'release');
  const w = await createSyntheticWorkspace();
  // A real detached shell stands in for the orphan: it outlives the node and writes its effect only when released.
  const shell = spawn('sh', ['-c', `while [ ! -f "${release}" ]; do sleep 0.05; done; printf effect >> "${oracle}"`], { stdio: 'ignore', detached: true });
  shell.unref();
  try {
    const store = new NodeTaskStore(w.source.state), results = new ResultStore(64 * 1024, 60_000, w.source.state);
    const task = await runningTask(store, 'real-orphan');
    const identity = await captureProcessIdentity(shell.pid!);
    assert.ok(identity, 'identity captured for the real shell');
    const activity = activityFor(task, shell.pid!, 'running', identity!);
    const [report] = await reconcileBootTasks(store, results, { coordinator: leaseFor(task), transportConnected: true, activities: [activity], heartbeatLease: async () => true });
    assert.equal(report?.decision.kind, 'MONITOR_ORPHAN');
    assert.equal((await store.read(task.taskId))?.state, 'AMBIGUOUS');
    // Identical-key retrieval is refused; the effect count stays zero until the orphan itself writes.
    const again = decideExistingTask({ existing: (await store.read(task.taskId)) ?? undefined, actorId: 'synthetic-actor', nodeId: NODE, operation: 'dex.process.run', payloadSha256: PAYLOAD, policyHash: 'unknown-policy' });
    assert.equal(again.kind, 'REFUSE_AMBIGUOUS');
    await assert.rejects(fs.access(oracle), /ENOENT/);
    // Release the orphan. Its own effect is the only one; the node does not observe the exit and does not complete.
    await fs.writeFile(release, 'release');
    const waitEnd = Date.now() + 15_000;
    while (Date.now() < waitEnd && await fs.access(oracle).then(() => false, () => true)) await new Promise(resolve => setTimeout(resolve, 50));
    await reconcileBootTasks(store, results, { coordinator: leaseFor(task), transportConnected: true, activities: [{ ...activity, state: 'exited' }] });
    assert.equal((await store.read(task.taskId))?.state, 'AMBIGUOUS', 'an orphan that exited is never a completion');
    assert.equal(await fs.readFile(oracle, 'utf8'), 'effect', 'no second side effect');
  } finally {
    try { process.kill(-shell.pid!, 'SIGKILL'); } catch { /* already gone */ }
    await w.cleanup(); await fs.rm(effects, { recursive: true, force: true });
  }
});

test('orphan killed or gone at restart: the task is AMBIGUOUS and not completed', async () => {
  const w = await createSyntheticWorkspace(); try {
    const store = new NodeTaskStore(w.source.state), results = new ResultStore(64 * 1024, 60_000, w.source.state);
    const task = await runningTask(store, 'orphan-gone');
    // With the lease still held, the process and coordinator evidence disagree: DEGRADED. Either way it is AMBIGUOUS.
    const [report] = await reconcileBootTasks(store, results, { coordinator: leaseFor(task), transportConnected: true, activities: [activityFor(task, UNUSED_PID, 'exited')], verify: async () => 'GONE' });
    assert.ok(report?.decision.kind === 'DEGRADED' || report?.decision.kind === 'AMBIGUOUS');
    assert.equal((await store.read(task.taskId))?.state, 'AMBIGUOUS');
    // Whichever path, the effect is unknown and recorded as such.
    assert.equal((await store.read(task.taskId))?.failureClass, 'AMBIGUOUS_EFFECT');
    // With no lease, the same gone process resolves to AMBIGUOUS directly.
    const other = await runningTask(store, 'orphan-gone-no-lease');
    const reports = await reconcileBootTasks(store, results, { coordinator: { leases: [], tickets: [] } as unknown as WorkStatus, transportConnected: true, activities: [activityFor(task, UNUSED_PID, 'exited'), activityFor(other, UNUSED_PID, 'exited')], verify: async () => 'GONE' });
    const clean = reports.find(r => r.taskId === other.taskId);
    // An activity row with no lease is contradictory (DEGRADED); either way the task is AMBIGUOUS and not completed.
    assert.ok(clean?.decision.kind === 'DEGRADED' || clean?.decision.kind === 'AMBIGUOUS');
    assert.equal((await store.read(other.taskId))?.state, 'AMBIGUOUS');
    assert.equal((await store.read(other.taskId))?.failureClass, 'AMBIGUOUS_EFFECT');
    // No activity and no lease for a RUNNING task: nothing proves an effect, so it is AMBIGUOUS directly.
    const bare = await runningTask(store, 'orphan-gone-no-evidence');
    const bareReports = await reconcileBootTasks(store, results, { coordinator: { leases: [], tickets: [] } as unknown as WorkStatus, transportConnected: true, activities: [] });
    assert.equal(bareReports.find(r => r.taskId === bare.taskId)?.decision.kind, 'AMBIGUOUS');
    assert.equal((await store.read(bare.taskId))?.state, 'AMBIGUOUS');
  } finally { await w.cleanup(); }
});

test('orphan exits normally after restart: supervision records it gone, the task stays AMBIGUOUS, never COMPLETED', async () => {
  const w = await createSyntheticWorkspace(); try {
    const store = new NodeTaskStore(w.source.state), results = new ResultStore(64 * 1024, 60_000, w.source.state);
    const task = await runningTask(store, 'orphan-exits');
    await reconcileBootTasks(store, results, { coordinator: leaseFor(task), transportConnected: true, activities: [activityFor(task, UNUSED_PID)], verify: async () => 'SAME', heartbeatLease: async () => true });
    const [report] = await superviseAmbiguousTasks(store, { coordinator: leaseFor(task), activities: [activityFor(task, UNUSED_PID, 'exited')], verify: async () => 'GONE' });
    assert.equal(report?.decision.kind, 'INPUT_REQUIRED');
    assert.match(report!.decision.reason, /has ended/);
    const after = (await store.read(task.taskId))!;
    assert.equal(after.state, 'AMBIGUOUS');
    assert.notEqual(after.state, 'COMPLETED');
  } finally { await w.cleanup(); }
});

test('metadata and coordinator evidence disagree: the task is preserved AMBIGUOUS, never monitored as healthy', async () => {
  const w = await createSyntheticWorkspace(); try {
    const store = new NodeTaskStore(w.source.state), results = new ResultStore(64 * 1024, 60_000, w.source.state);
    const task = await runningTask(store, 'disagree');
    // Live process identity, but the coordinator holds no lease for this task.
    const [report] = await reconcileBootTasks(store, results, { coordinator: { leases: [], tickets: [] } as unknown as WorkStatus, transportConnected: true, activities: [activityFor(task, UNUSED_PID)], verify: async () => 'SAME' });
    assert.equal(report?.decision.kind, 'DEGRADED');
    assert.equal((await store.read(task.taskId))?.state, 'AMBIGUOUS');
  } finally { await w.cleanup(); }
});

test('coordinator restart during recovery (transport down) never monitors an orphan as live', async () => {
  const w = await createSyntheticWorkspace(); try {
    const store = new NodeTaskStore(w.source.state), results = new ResultStore(64 * 1024, 60_000, w.source.state);
    const task = await runningTask(store, 'coordinator-down');
    const [report] = await reconcileBootTasks(store, results, { coordinator: null, transportConnected: false, activities: [activityFor(task, UNUSED_PID)], verify: async () => 'SAME' });
    assert.notEqual(report?.decision.kind, 'MONITOR_ORPHAN');
    assert.equal((await store.read(task.taskId))?.state, 'AMBIGUOUS');
  } finally { await w.cleanup(); }
});

test('legacy or unverifiable orphan identity: fail closed to AMBIGUOUS and the lease is kept, not released', async () => {
  const w = await createSyntheticWorkspace(); try {
    const store = new NodeTaskStore(w.source.state), results = new ResultStore(64 * 1024, 60_000, w.source.state);
    const task = await runningTask(store, 'legacy-orphan');
    const heartbeats: string[] = [];
    await reconcileBootTasks(store, results, { coordinator: leaseFor(task), transportConnected: true, activities: [activityFor(task, UNUSED_PID)], verify: async () => 'UNVERIFIABLE', heartbeatLease: async id => { heartbeats.push(id); return true; } });
    assert.equal((await store.read(task.taskId))?.state, 'AMBIGUOUS');
    assert.equal(heartbeats.length, 0, 'a DEGRADED task is recorded, not heartbeated as a monitored orphan');
  } finally { await w.cleanup(); }
});

test('missing or corrupt activity evidence: a RUNNING task is AMBIGUOUS, never retried', async () => {
  const w = await createSyntheticWorkspace(); try {
    const store = new NodeTaskStore(w.source.state), results = new ResultStore(64 * 1024, 60_000, w.source.state);
    const task = await runningTask(store, 'no-evidence', 'PURE_READ_IDEMPOTENT');
    await reconcileBootTasks(store, results, { coordinator: leaseFor(task), transportConnected: true, activities: null });
    assert.equal((await store.read(task.taskId))?.state, 'AMBIGUOUS');
  } finally { await w.cleanup(); }
});

test('an interrupted pure read with no execution evidence is FAILED as retryable, never left RUNNING', async () => {
  const w = await createSyntheticWorkspace(); try {
    const store = new NodeTaskStore(w.source.state), results = new ResultStore(64 * 1024, 60_000, w.source.state);
    const task = await runningTask(store, 'pure-read-gone', 'PURE_READ_IDEMPOTENT');
    await reconcileBootTasks(store, results, { coordinator: { leases: [], tickets: [] } as unknown as WorkStatus, transportConnected: true, activities: [] });
    const after = (await store.read(task.taskId))!;
    assert.equal(after.state, 'FAILED');
    assert.equal(after.failureClass, 'TRANSIENT_TRANSPORT');
  } finally { await w.cleanup(); }
});

test('repeated identical key after restart never reaches a second side effect while the task is AMBIGUOUS', async () => {
  const w = await createSyntheticWorkspace(); try {
    const store = new NodeTaskStore(w.source.state), results = new ResultStore(64 * 1024, 60_000, w.source.state);
    const task = await runningTask(store, 'after-restart');
    await reconcileBootTasks(store, results, { coordinator: leaseFor(task), transportConnected: true, activities: [activityFor(task, UNUSED_PID)], verify: async () => 'SAME', heartbeatLease: async () => true });
    const decision = decideExistingTask({ existing: (await store.read(task.taskId)) ?? undefined, actorId: 'synthetic-actor', nodeId: NODE, operation: 'dex.process.run', payloadSha256: PAYLOAD, policyHash: 'unknown-policy' });
    assert.equal(decision.kind, 'REFUSE_AMBIGUOUS');
    assert.equal(decision.task.taskId, task.taskId);
  } finally { await w.cleanup(); }
});

test('supervision releases the lease only of an orphan proven ended; live and unverifiable orphans keep theirs; no state changes', async () => {
  const w = await createSyntheticWorkspace(); try {
    const store = new NodeTaskStore(w.source.state);
    const ended = await runningTask(store, 'lease-ended');
    const live = await runningTask(store, 'lease-live');
    const unknown = await runningTask(store, 'lease-unverifiable');
    for (const task of [ended, live, unknown]) await store.transition(task.taskId, 'AMBIGUOUS', 'synthetic orphan evidence');
    const lease = (task: ReachTaskRecord, pid: number) => ({ id: `lease-${task.idempotencyKey}`, taskId: task.taskId, attempt: task.attemptNumber, pid });
    const coordinator = { leases: [lease(ended, UNUSED_PID), lease(live, process.pid), lease(unknown, process.pid)], tickets: [] } as unknown as WorkStatus;
    const activities = [activityFor(ended, UNUSED_PID), activityFor(live, process.pid), activityFor(unknown, process.pid)];
    const verdicts: Record<string, 'GONE' | 'SAME' | 'UNVERIFIABLE'> = { [ended.taskId]: 'GONE', [live.taskId]: 'SAME', [unknown.taskId]: 'UNVERIFIABLE' };
    const released: string[] = [], heartbeats: string[] = [];
    await superviseAmbiguousTasks(store, {
      coordinator, transportConnected: true, activities,
      verify: async activity => verdicts[activity.taskId!]!,
      releaseLease: async id => { released.push(id); return { released: true }; },
      heartbeatLease: async id => { heartbeats.push(id); return true; }
    });
    assert.deepEqual(released, ['lease-lease-ended'], 'only the proven-ended orphan releases its lease');
    assert.deepEqual(heartbeats.sort(), ['lease-lease-live', 'lease-lease-unverifiable'], 'live and unverifiable orphans keep their leases');
    for (const task of [ended, live, unknown]) assert.equal((await store.read(task.taskId))?.state, 'AMBIGUOUS', 'supervision never transitions state');
  } finally { await w.cleanup(); }
});
