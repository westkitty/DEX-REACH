import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyFailure,
  classifyOperationSafety,
  defaultAttemptBudget,
  deriveIdempotencyKey,
  reconcile,
  retryAllowed,
  retryDelayMs
} from '../src/shared/durable-execution.js';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { NodeTaskStore } from '../src/node/task-store.js';
import { ResultStore } from '../src/node/result-store.js';

const base = { actorId: 'actor_a', nodeId: 'node_a', operation: 'dex.file.write', policyHash: 'a'.repeat(64) };

test('idempotency binds actor, node, operation, policy and explicit key while payload mismatch remains visible', () => {
  const first = deriveIdempotencyKey({ ...base, requestedKey: 'client-key', args: { path: '/tmp/a', text: 'one' } });
  const changedPayload = deriveIdempotencyKey({ ...base, requestedKey: 'client-key', args: { path: '/tmp/a', text: 'two' } });
  const changedActor = deriveIdempotencyKey({ ...base, actorId: 'actor_b', requestedKey: 'client-key', args: { path: '/tmp/a', text: 'one' } });
  const changedPolicy = deriveIdempotencyKey({ ...base, policyHash: 'b'.repeat(64), requestedKey: 'client-key', args: { path: '/tmp/a', text: 'one' } });
  assert.equal(first.key, changedPayload.key);
  assert.notEqual(first.payloadHash, changedPayload.payloadHash);
  assert.notEqual(first.key, changedActor.key);
  assert.equal(first.key, changedPolicy.key);
  const requestOne = deriveIdempotencyKey({ ...base, requestId: 'request-1', args: { path: '/tmp/a', text: 'one' } });
  const requestOneRetry = deriveIdempotencyKey({ ...base, requestId: 'request-1', args: { path: '/tmp/a', text: 'one' } });
  const requestTwo = deriveIdempotencyKey({ ...base, requestId: 'request-2', args: { path: '/tmp/a', text: 'one' } });
  assert.equal(requestOne.key, requestOneRetry.key);
  assert.notEqual(requestOne.key, requestTwo.key);
  const planOne = deriveIdempotencyKey({ ...base, operation: 'dex.commitPlan', requestId: 'request-1', args: { planId: '11111111-1111-4111-8111-111111111111' } });
  const planRetry = deriveIdempotencyKey({ ...base, operation: 'dex.commitPlan', requestId: 'request-2', args: { planId: '11111111-1111-4111-8111-111111111111' } });
  assert.equal(planOne.key, planRetry.key);
});

test('safety classification and bounded retry refuse uncertain or unsafe replay', () => {
  assert.equal(classifyOperationSafety('dex.repoInfo'), 'PURE_READ_IDEMPOTENT');
  assert.equal(classifyOperationSafety('dex.commitPlan'), 'PLAN_COMMIT');
  assert.equal(classifyOperationSafety('dex.process.run'), 'PROCESS_UNKNOWN_EFFECT');
  assert.equal(defaultAttemptBudget('PURE_READ_IDEMPOTENT'), 3);
  assert.equal(defaultAttemptBudget('PROCESS_UNKNOWN_EFFECT'), 1);
  assert.equal(retryAllowed('PURE_READ_IDEMPOTENT', 'TRANSIENT_TRANSPORT'), true);
  assert.equal(retryAllowed('PROCESS_UNKNOWN_EFFECT', 'TRANSIENT_TRANSPORT'), false);
  assert.equal(retryAllowed('PURE_READ_IDEMPOTENT', 'AMBIGUOUS_EFFECT'), false);
  assert.equal(retryDelayMs(1, 'TRANSIENT_TRANSPORT', 0), 250);
  assert.equal(retryDelayMs(1, 'AMBIGUOUS_EFFECT', 0), null);
});

test('failure classifier separates transport uncertainty from safe read timeout', () => {
  assert.equal(classifyFailure({ safety: 'PURE_READ_IDEMPOTENT', transportTimedOut: true }), 'TRANSIENT_TRANSPORT');
  assert.equal(classifyFailure({ safety: 'PROCESS_UNKNOWN_EFFECT', transportTimedOut: true }), 'AMBIGUOUS_EFFECT');
  assert.equal(classifyFailure({ safety: 'SIDE_EFFECTING_IDEMPOTENT', policyRefused: true }), 'AUTHORITY_REFUSAL');
  assert.equal(classifyFailure({ safety: 'PROCESS_UNKNOWN_EFFECT', corruptState: true }), 'CORRUPT_STATE');
});

test('reconciliation chooses evidence-supported recovery and never invents completion', () => {
  assert.equal(reconcile({ resultAvailable: true }, 'PROCESS_UNKNOWN_EFFECT'), 'FINISH_FROM_DURABLE_EVIDENCE');
  assert.equal(reconcile({ processAlive: true }, 'PROCESS_UNKNOWN_EFFECT'), 'REATTACH');
  assert.equal(reconcile({ policyStillAllows: false }, 'PURE_READ_IDEMPOTENT'), 'INPUT_REQUIRED');
  assert.equal(reconcile({}, 'PURE_READ_IDEMPOTENT'), 'RETRY_SAFE');
  assert.equal(reconcile({}, 'PLAN_COMMIT'), 'AMBIGUOUS');
  assert.equal(reconcile({ externalJobId: 'job-1' }, 'PURE_READ_IDEMPOTENT'), 'REATTACH');
});

test('dropped response is recovered from the durable task and result records without re-execution', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dex-reach-recovery-'));
  try {
    const taskStore = new NodeTaskStore(root);
    const results = new ResultStore(64, 60000, root);
    const idempotency = deriveIdempotencyKey({ ...base, operation: 'dex.file.write', requestedKey: 'dropped-response', args: { path: '/tmp/a', text: 'one' } });
    const task = await taskStore.create({
      actorId: base.actorId, nodeId: base.nodeId, operation: base.operation,
      idempotencyKey: idempotency.key, payloadSha256: idempotency.payloadHash,
      policyHash: base.policyHash, safetyClass: 'SIDE_EFFECTING_IDEMPOTENT', attemptBudget: 2
    });
    await taskStore.transition(task.taskId, 'PREPARING');
    await taskStore.transition(task.taskId, 'RUNNING');
    let executions = 0;
    const executeOnce = () => {
      executions += 1;
      return { accepted: true, executions };
    };
    const stored = await results.boundWithReference(executeOnce(), task.taskId);
    await taskStore.update(task.taskId, { state: 'COMPLETED', resultRef: stored.metadata.handle, resultHash: stored.metadata.resultHash });

    const reopenedTasks = new NodeTaskStore(root);
    const reopenedResults = new ResultStore(64, 60000, root);
    const existing = (await reopenedTasks.list({ idempotencyKey: idempotency.key }))[0];
    assert.equal(existing?.state, 'COMPLETED');
    assert.deepEqual(await reopenedResults.readValue(existing!.resultRef!), { accepted: true, executions: 1 });
    assert.equal(executions, 1);
    if (existing?.state === 'COMPLETED') await reopenedResults.readValue(existing.resultRef!);
    assert.equal(executions, 1);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
