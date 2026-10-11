import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { reconcileBootTasks } from '../src/node/boot-recovery.js';
import { NodeTaskStore } from '../src/node/task-store.js';
import { ResultStore } from '../src/node/result-store.js';
import { decideExistingTask } from '../src/shared/durable-execution.js';
import { machineStateDir, stateDir } from '../src/shared/local-env.js';
import { TaskEventLog } from '../src/shared/task-events.js';
import { coordinatorDir, coordinatorSocketPath, historyFile, leasesDir, queueDir } from '../src/shared/work-coordinator.js';

const hash = 'a'.repeat(64);

async function tempState(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'dex-c14-security-'));
}

async function runningTask(store: NodeTaskStore, idempotencyKey: string, nodeId = 'node-c14'): Promise<Awaited<ReturnType<NodeTaskStore['create']>>> {
  const task = await store.create({
    actorId: 'actor-c14', nodeId, operation: 'dex.file.write', idempotencyKey,
    payloadSha256: hash, policyHash: hash, safetyClass: 'PROCESS_UNKNOWN_EFFECT', mutationLevel: 'STATE_MUTATION'
  });
  await store.transition(task.taskId, 'PREPARING');
  return store.transition(task.taskId, 'RUNNING');
}

test('C14-C binds durable results to both task identity and persisted hash', async () => {
  const state = await tempState();
  try {
    const store = new NodeTaskStore(state);
    const owner = await store.create({ actorId: 'actor-owner', nodeId: 'node-c14', operation: 'dex.file.write', idempotencyKey: 'owner-result', payloadSha256: hash, policyHash: hash, safetyClass: 'SIDE_EFFECTING_IDEMPOTENT' });
    const other = await store.create({ actorId: 'actor-other', nodeId: 'node-c14', operation: 'dex.file.write', idempotencyKey: 'other-result', payloadSha256: hash, policyHash: hash, safetyClass: 'SIDE_EFFECTING_IDEMPOTENT' });
    const results = new ResultStore(64 * 1024, 60_000, state);
    const stored = await results.boundWithReference({ owner: true }, other.taskId);

    await assert.rejects(() => results.readValueForTask(stored.metadata.handle, owner.taskId, stored.metadata.resultHash), /binding mismatch/);
    await assert.rejects(() => results.readValueForTask(stored.metadata.handle, other.taskId, 'b'.repeat(64)), /binding mismatch/);
    assert.deepEqual(await results.readValueForTask(stored.metadata.handle, other.taskId, stored.metadata.resultHash), { owner: true });

    const recovering = await runningTask(store, 'wrong-result-recovery');
    await store.update(recovering.taskId, { resultRef: stored.metadata.handle, resultHash: stored.metadata.resultHash });
    const reports = await reconcileBootTasks(new NodeTaskStore(state), results);
    const report = reports.find(item => item.taskId === recovering.taskId);
    assert.equal(report?.decision.kind, 'AMBIGUOUS');
    const after = await new NodeTaskStore(state).read(recovering.taskId);
    assert.equal(after?.state, 'AMBIGUOUS');
    assert.equal(after?.failureClass, 'AMBIGUOUS_EFFECT');
    assert.equal(after?.resultRef, stored.metadata.handle);
    assert.equal(after?.nodeId, 'node-c14');
    await reconcileBootTasks(new NodeTaskStore(state), results);
    const beforeStableRepeat = await new NodeTaskStore(state).read(recovering.taskId);
    const eventsBeforeStableRepeat = await new TaskEventLog(state).list(recovering.taskId, 500);
    await reconcileBootTasks(new NodeTaskStore(state), results);
    const afterStableRepeat = await new NodeTaskStore(state).read(recovering.taskId);
    const eventsAfterStableRepeat = await new TaskEventLog(state).list(recovering.taskId, 500);
    assert.equal(afterStableRepeat?.updatedAtUtc, beforeStableRepeat?.updatedAtUtc, 'repeated ambiguous recovery must not rewrite unchanged status');
    assert.equal(eventsAfterStableRepeat.length, eventsBeforeStableRepeat.length, 'repeated ambiguous recovery must not append duplicate status events');
  } finally {
    await fs.rm(state, { recursive: true, force: true });
  }
});

test('C14-E temporary state redirects every persistent path away from owner state', async () => {
  const state = await tempState();
  const previous = process.env.DEX_REACH_STATE_DIR;
  process.env.DEX_REACH_STATE_DIR = state;
  try {
    const owner = path.resolve(os.homedir(), '.dex-reach');
    const persistent = [stateDir(), machineStateDir(), coordinatorDir(), leasesDir(), queueDir(), historyFile(), path.join(state, 'tasks'), path.join(state, 'results')].map(candidate => path.resolve(candidate));
    for (const candidate of persistent) {
      const relative = path.relative(state, candidate);
      assert.ok(relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative)), candidate);
      assert.ok(candidate !== owner && !candidate.startsWith(owner + path.sep), candidate);
    }
    assert.ok(!coordinatorSocketPath().startsWith(owner + path.sep));
  } finally {
    if (previous === undefined) delete process.env.DEX_REACH_STATE_DIR;
    else process.env.DEX_REACH_STATE_DIR = previous;
    await fs.rm(state, { recursive: true, force: true });
  }
});

test('C14-C rejects incomplete completed-task bindings instead of authorizing recovery', () => {
  const decision = decideExistingTask({
    existing: {
      taskId: 'rtsk_123456789ab_1234567890abcdef', actorId: 'actor-c14', nodeId: 'node-c14',
      operation: 'dex.file.write', state: 'COMPLETED', summaryStatus: 'completed',
      payloadSha256: hash, policyHash: hash, resultRef: 'result-without-hash'
    },
    actorId: 'actor-c14', nodeId: 'node-c14', operation: 'dex.file.write', payloadSha256: hash, policyHash: hash
  });
  assert.equal(decision.kind, 'REFUSE_CORRUPT');
});

test('C14-C task summaries redact synthetic credential material while retaining safe status', async () => {
  const state = await tempState();
  try {
    const store = new NodeTaskStore(state);
    const task = await runningTask(store, 'privacy-summary');
    const updated = await store.update(task.taskId, { status: 'transport failed Authorization=Bearer synthetic-token-123' });
    assert.equal(updated.summary.isShareSafe, true);
    assert.doesNotMatch(updated.summary.status, /synthetic-token-123/);
    assert.match(updated.summary.status, /REDACTED/);
    assert.equal(updated.taskId, task.taskId);
  } finally {
    await fs.rm(state, { recursive: true, force: true });
  }
});
