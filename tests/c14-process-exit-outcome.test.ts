import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createSyntheticWorkspace } from '../scripts/lib/recovery-rehearsal.js';
import { NodeTaskStore } from '../src/node/task-store.js';
import { ResultStore } from '../src/node/result-store.js';
import { persistTaskFailure, persistProcessExitFailure } from '../src/node/task-failure.js';
import { nativeProcess } from '../src/node/native.js';
import { processExitCode, assertProcessSucceeded, ProcessExitError } from '../src/shared/process-outcome.js';
import { classifyFailure, decideExistingTask, classifyOperationSafety } from '../src/shared/durable-execution.js';

// Durable-task boundary for ADR-0001 outcome identity: a real child process produces the outcome, the
// task layer records it. The effect oracle is a file each execution appends to, never a sleep.

const NODE = 'macbook-air.local';
const KEY = 'synthetic-exit-key';
const PAYLOAD = 'b'.repeat(64);

async function withStateDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(process.env.TMPDIR ?? '/tmp', 'dex-exit-'));
  const previous = process.env.DEX_REACH_STATE_DIR;
  process.env.DEX_REACH_STATE_DIR = dir;
  try { return await fn(dir); } finally {
    if (previous === undefined) delete process.env.DEX_REACH_STATE_DIR; else process.env.DEX_REACH_STATE_DIR = previous;
    await fs.rm(dir, { recursive: true, force: true });
  }
}

async function runningTask(store: NodeTaskStore, key = KEY, payloadSha256 = PAYLOAD) {
  const t = await store.create({ actorId: 'synthetic-actor', nodeId: NODE, operation: 'dex.process.run', idempotencyKey: key, payloadSha256, safetyClass: 'PROCESS_UNKNOWN_EFFECT', mutationLevel: 'STATE_MUTATION' });
  await store.transition(t.taskId, 'PREPARING');
  return store.transition(t.taskId, 'RUNNING');
}

test('a real child exiting 3 is FAILED with its numeric status and bound stdout/stderr, never COMPLETED', async () => {
  await withStateDir(async dir => {
    const w = await createSyntheticWorkspace(); try {
      const store = new NodeTaskStore(w.source.state), results = new ResultStore(64 * 1024, 30 * 60 * 1000, w.source.state);
      const task = await runningTask(store);
      const cwd = path.join(dir, 'work'); await fs.mkdir(cwd);
      const value = await nativeProcess('echo synthetic-out; echo synthetic-err 1>&2; exit 3', cwd, 'development', 5000, [cwd]);
      assert.equal(processExitCode('dex.process.run', value), 3);
      assert.throws(() => assertProcessSucceeded('dex.process.run', value), (e: unknown) => e instanceof ProcessExitError && e.exitCode === 3);
      const failed = await persistProcessExitFailure(store, results, task.taskId, new ProcessExitError(3, value as Record<string, unknown>));
      assert.equal(failed.state, 'FAILED');
      assert.equal(failed.failureClass, 'EXECUTION_FAILED');
      assert.match(failed.summary.status, /process exited with status 3/);
      assert.ok(failed.resultRef && failed.resultHash, 'the outcome is bound to the task');
      const evidence = await results.readValueForTask(failed.resultRef!, task.taskId, failed.resultHash!) as { exitCode: number; stdout: string; stderr: string };
      assert.equal(evidence.exitCode, 3);
      assert.match(evidence.stdout, /synthetic-out/);
      assert.match(evidence.stderr, /synthetic-err/);
    } finally { await w.cleanup(); }
  });
});

test('exit 0 is a success: the outcome is accepted and no failure is raised', async () => {
  await withStateDir(async dir => {
    const cwd = path.join(dir, 'work'); await fs.mkdir(cwd);
    const value = await nativeProcess('echo ok', cwd, 'development', 5000, [cwd]);
    assert.equal(processExitCode('dex.process.run', value), 0);
    assert.doesNotThrow(() => assertProcessSucceeded('dex.process.run', value));
  });
});

test('a repeated identical key after FAILED is refused without a second execution; a different payload is a collision', async () => {
  // The effect oracle lives outside the DEX state directory, which the command guard protects.
  const effects = await fs.mkdtemp(path.join(os.tmpdir(), 'dex-effects-')); const marker = path.join(effects, 'effects.txt');
  try {
  await withStateDir(async dir => {
    const w = await createSyntheticWorkspace(); try {
      const store = new NodeTaskStore(w.source.state), results = new ResultStore(64 * 1024, 30 * 60 * 1000, w.source.state);
      const cwd = path.join(dir, 'work'); await fs.mkdir(cwd);
      const identity = { actorId: 'synthetic-actor', nodeId: NODE, operation: 'dex.process.run', payloadSha256: PAYLOAD, policyHash: 'unknown-policy' };
      // Admission: the first request runs once and its outcome is recorded.
      assert.equal(decideExistingTask({ existing: undefined, ...identity }).kind, 'NEW');
      const task = await runningTask(store);
      const value = await nativeProcess(`echo run >> ${marker}; exit 3`, cwd, 'development', 5000, [cwd]);
      await persistProcessExitFailure(store, results, task.taskId, new ProcessExitError(3, value as Record<string, unknown>));
      // Retries with the same key consult the durable record first and never reach the child again.
      const failed = (await store.read(task.taskId))!;
      assert.equal(decideExistingTask({ existing: failed, ...identity }).kind, 'REFUSE_TERMINAL');
      assert.equal(decideExistingTask({ existing: failed, ...identity, payloadSha256: 'c'.repeat(64) }).kind, 'COLLISION');
      assert.equal((await fs.readFile(marker, 'utf8')).trim().split('\n').length, 1, 'exactly one execution');
    } finally { await w.cleanup(); }
  });
  } finally { await fs.rm(effects, { recursive: true, force: true }); }
});

test('a lost response while RUNNING recovers the existing task identity and does not run again', async () => {
  const w = await createSyntheticWorkspace(); try {
    const store = new NodeTaskStore(w.source.state);
    const task = await runningTask(store, 'synthetic-lost-response');
    const again = decideExistingTask({ existing: task, actorId: 'synthetic-actor', nodeId: NODE, operation: 'dex.process.run', payloadSha256: PAYLOAD, policyHash: 'unknown-policy' });
    assert.equal(again.kind, 'REFUSE_IN_FLIGHT');
    assert.equal(again.task.taskId, task.taskId);
  } finally { await w.cleanup(); }
});

test('a signal-terminated child is AMBIGUOUS, not FAILED and not COMPLETED, and carries no exit status', async () => {
  await withStateDir(async dir => {
    const w = await createSyntheticWorkspace(); try {
      const store = new NodeTaskStore(w.source.state);
      const task = await runningTask(store, 'synthetic-signal');
      const cwd = path.join(dir, 'work'); await fs.mkdir(cwd);
      const error = await nativeProcess('kill -TERM $$', cwd, 'development', 2000, [cwd]).then(() => null, (e: unknown) => e);
      assert.ok(error instanceof Error);
      const recorded = await persistTaskFailure(store, task.taskId, 'PROCESS_UNKNOWN_EFFECT', error, true);
      assert.equal(recorded.state, 'AMBIGUOUS');
      assert.equal(recorded.failureClass, 'AMBIGUOUS_EFFECT');
      assert.equal(recorded.resultRef, undefined);
    } finally { await w.cleanup(); }
  });
});

test('a time-limit kill is AMBIGUOUS, not FAILED (user-accepted rule)', async () => {
  await withStateDir(async dir => {
    const w = await createSyntheticWorkspace(); try {
      const store = new NodeTaskStore(w.source.state);
      const task = await runningTask(store, 'synthetic-timelimit');
      const cwd = path.join(dir, 'work'); await fs.mkdir(cwd);
      const error = await nativeProcess('sleep 30', cwd, 'development', 100, [cwd]).then(() => null, (e: unknown) => e);
      assert.ok(error instanceof Error);
      const recorded = await persistTaskFailure(store, task.taskId, 'PROCESS_UNKNOWN_EFFECT', error, true);
      assert.equal(recorded.state, 'AMBIGUOUS');
    } finally { await w.cleanup(); }
  });
});

test('outcome recognition is operation-aware: an exitCode on a non-process operation is never a process failure', () => {
  assert.equal(processExitCode('dex.file.read', { exitCode: 3, stdout: '', stderr: '' }), null);
  assert.doesNotThrow(() => assertProcessSucceeded('dex.file.read', { exitCode: 3 }));
});

test('a malformed process outcome is refused, never recorded as a completed success', () => {
  for (const bad of [{ exitCode: '3', stdout: '', stderr: '' }, { exitCode: 256, stdout: '', stderr: '' }, { exitCode: 1.5, stdout: '', stderr: '' }, { exitCode: 0 }, null, 'exit 0']) {
    assert.throws(() => processExitCode('dex.process.run', bad), /completion refused/, JSON.stringify(bad));
  }
});

test('a nonzero exit cannot become FAILED from a task that is not RUNNING; the conservative path applies', async () => {
  const w = await createSyntheticWorkspace(); try {
    const store = new NodeTaskStore(w.source.state), results = new ResultStore(64 * 1024, 30 * 60 * 1000, w.source.state);
    const t = await store.create({ actorId: 'synthetic-actor', nodeId: NODE, operation: 'dex.process.run', idempotencyKey: 'synthetic-not-running', payloadSha256: PAYLOAD, safetyClass: 'PROCESS_UNKNOWN_EFFECT', mutationLevel: 'STATE_MUTATION' });
    await store.transition(t.taskId, 'PREPARING');
    const err = new ProcessExitError(3, { exitCode: 3, stdout: '', stderr: '' });
    await assert.rejects(persistProcessExitFailure(store, results, t.taskId, err), /not recorded as a deterministic failure/);
    // The conservative path cannot legally reach AMBIGUOUS from PREPARING, so it refuses. The task is never completed.
    await assert.rejects(persistTaskFailure(store, t.taskId, 'PROCESS_UNKNOWN_EFFECT', err, true), /illegal task transition PREPARING -> AMBIGUOUS/);
    assert.equal((await store.read(t.taskId))?.state, 'PREPARING');
  } finally { await w.cleanup(); }
});

test('the process classifier leaves the existing signal rule intact', () => {
  assert.equal(classifyFailure({ error: new Error('process exited with status 3'), safety: 'PROCESS_UNKNOWN_EFFECT' }), 'EXECUTION_FAILED');
  assert.equal(classifyOperationSafety('dex.process.run'), 'PROCESS_UNKNOWN_EFFECT');
});
