import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyFailure, retryAllowed, unstartedFailureOutcome } from '../src/shared/durable-execution.js';
import { NodeTaskStore } from '../src/node/task-store.js';
import { createSyntheticWorkspace } from '../scripts/lib/recovery-rehearsal.js';

const timeout = new Error('COORDINATOR_WAIT_TIMEOUT: substantive slots exhausted (1/1, including 1 uncoordinated heavy workload(s))');
test('observed live mechanism: a coordinator wait timeout before execution was classified AMBIGUOUS_EFFECT', () => {
  // The generic classifier cannot know execution never started; this is the recorded live outcome.
  for (const safety of ['PROCESS_UNKNOWN_EFFECT', 'DESTRUCTIVE', 'PLAN_COMMIT'] as const) assert.equal(classifyFailure({ error: timeout, safety }), 'AMBIGUOUS_EFFECT');
});
test('observed live mechanism: PREPARING cannot become AMBIGUOUS, so the swallowed transition left records nonterminal', async () => {
  const w = await createSyntheticWorkspace(); try {
    const store = new NodeTaskStore(w.source.state);
    const t = await store.create({ actorId: 'synthetic-actor', nodeId: 'macbook-air.local', operation: 'dex.process.run', idempotencyKey: 'synthetic-unstarted', payloadSha256: 'a'.repeat(64), safetyClass: 'PROCESS_UNKNOWN_EFFECT', mutationLevel: 'STATE_MUTATION' });
    await store.transition(t.taskId, 'PREPARING');
    await assert.rejects(store.transition(t.taskId, 'AMBIGUOUS'), /illegal task transition PREPARING -> AMBIGUOUS/);
    assert.equal((await store.read(t.taskId))?.state, 'PREPARING');
  } finally { await w.cleanup(); }
});
test('a failure before the RUNNING transition is a definite non-execution: never AMBIGUOUS_EFFECT; PREPARING ends terminal FAILED', async () => {
  for (const safety of ['PROCESS_UNKNOWN_EFFECT', 'DESTRUCTIVE', 'PLAN_COMMIT', 'SIDE_EFFECTING_IDEMPOTENT', 'PURE_READ_IDEMPOTENT'] as const) {
    for (const state of ['ACCEPTED', 'PREPARING'] as const) {
      const o = unstartedFailureOutcome({ error: timeout, safety, persistedState: state, executionStarted: false })!;
      assert.equal(o.failureClass, 'TRANSIENT_RESOURCE'); assert.equal(o.next, state === 'PREPARING' ? 'FAILED' : 'CANCELLED'); // ACCEPTED -> FAILED is not a legal transition
      // Classification does not grant replay: unknown-effect operations still never retry automatically.
      if (safety !== 'PURE_READ_IDEMPOTENT' && safety !== 'SIDE_EFFECTING_IDEMPOTENT') assert.equal(retryAllowed(safety, o.failureClass), false);
    }
    assert.equal(unstartedFailureOutcome({ error: new Error('node request timed out'), safety, persistedState: 'PREPARING', executionStarted: false })!.failureClass, 'DEADLINE_EXCEEDED');
  }
  const w = await createSyntheticWorkspace(); try {
    const store = new NodeTaskStore(w.source.state);
    const t = await store.create({ actorId: 'synthetic-actor', nodeId: 'macbook-air.local', operation: 'dex.process.run', idempotencyKey: 'synthetic-unstarted-2', payloadSha256: 'a'.repeat(64), safetyClass: 'PROCESS_UNKNOWN_EFFECT', mutationLevel: 'STATE_MUTATION' });
    await store.transition(t.taskId, 'PREPARING');
    const o = unstartedFailureOutcome({ error: timeout, safety: 'PROCESS_UNKNOWN_EFFECT', persistedState: 'PREPARING', executionStarted: false })!;
    await store.transition(t.taskId, o.next!, `Task stopped: ${o.failureClass}.`);
    assert.equal((await store.read(t.taskId))?.state, 'FAILED');
  } finally { await w.cleanup(); }
});
test('once execution may have started, uncertainty is preserved exactly as before', () => {
  for (const persistedState of ['RUNNING', 'AMBIGUOUS', undefined] as const) assert.equal(unstartedFailureOutcome({ error: timeout, safety: 'PROCESS_UNKNOWN_EFFECT', persistedState, executionStarted: false }), null);
  assert.equal(unstartedFailureOutcome({ error: timeout, safety: 'PROCESS_UNKNOWN_EFFECT', persistedState: 'PREPARING', executionStarted: true }), null);
  assert.equal(classifyFailure({ error: timeout, safety: 'PROCESS_UNKNOWN_EFFECT' }), 'AMBIGUOUS_EFFECT');
});
