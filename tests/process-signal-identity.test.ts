import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { listProcessActivities } from '../src/shared/activity.js';
import { nativeProcess } from '../src/node/native.js';
import { ProcessSignalTerminationError, classifyFailure } from '../src/shared/durable-execution.js';

// Signal identity for interrupted process work (ADR-0001 section 8, docs/C5_TASK_CONTRACT.md).
// A child that ends by a signal has no exit code and an unknown effect. The contract is that it is
// never reported as a completed success and never carries an invented exit code.

async function withStateDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dex-reach-signal-'));
  const previous = process.env.DEX_REACH_STATE_DIR;
  process.env.DEX_REACH_STATE_DIR = dir;
  try {
    return await fn(dir);
  } finally {
    if (previous === undefined) delete process.env.DEX_REACH_STATE_DIR;
    else process.env.DEX_REACH_STATE_DIR = previous;
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test('a child terminated by SIGTERM is rejected as uncertain, with its signal and no exit code', async () => {
  await withStateDir(async dir => {
    const cwd = path.join(dir, 'work');
    await fs.mkdir(cwd);
    const error = await nativeProcess('kill -TERM $$', cwd, 'development', 2000, [cwd]).then(
      () => assert.fail('a signal-terminated process must not resolve as a completed result'),
      (caught: unknown) => caught
    );
    assert.ok(error instanceof ProcessSignalTerminationError, 'expected ProcessSignalTerminationError');
    assert.equal(error.signal, 'SIGTERM');
    assert.equal(error.cause, 'signal');
    assert.equal(error.exitCode, null);
    assert.match(error.message, /SIGTERM/);
    assert.match(error.message, /uncertain/);

    const record = (await listProcessActivities({ includeFinished: true })).find(item => item.kind === 'native-process');
    assert.ok(record);
    assert.equal(record.state, 'terminated');
    assert.equal(record.signal, 'SIGTERM');
    assert.equal(record.exitCode, undefined, 'the activity record must not carry an invented exit code');
  });
});

test('a child that exits on its own keeps its real exit code and is not a signal termination', async () => {
  await withStateDir(async dir => {
    const cwd = path.join(dir, 'work');
    await fs.mkdir(cwd);
    const result = await nativeProcess('exit 3', cwd, 'development', 2000, [cwd]);
    assert.equal(result.exitCode, 3);

    const record = (await listProcessActivities({ includeFinished: true })).find(item => item.kind === 'native-process');
    assert.equal(record?.state, 'failed');
    assert.equal(record?.exitCode, 3);
    assert.equal(record?.signal, undefined);
  });
});

test('a child stopped by the node time limit is uncertain, not a completed exit code of 1', async () => {
  await withStateDir(async dir => {
    const cwd = path.join(dir, 'work');
    await fs.mkdir(cwd);
    // `exec` replaces the shell so the timeout signal reaches the sleeper directly and the output pipes close.
    const error = await nativeProcess('exec sleep 5', cwd, 'development', 100, [cwd]).then(
      () => assert.fail('a time-limited process must not resolve as a completed result'),
      (caught: unknown) => caught
    );
    assert.ok(error instanceof ProcessSignalTerminationError);
    assert.equal(error.cause, 'time-limit');
    assert.equal(error.exitCode, null);

    const record = (await listProcessActivities({ includeFinished: true })).find(item => item.kind === 'native-process');
    assert.equal(record?.state, 'timed-out');
    assert.equal(record?.exitCode, undefined);
  });
});

test('a process that never started reports no exit code and is not a signal termination', async () => {
  await withStateDir(async dir => {
    const missing = path.join(dir, 'missing-directory');
    const error = await nativeProcess('true', missing, 'development', 2000, [dir]).then(
      () => assert.fail('a process that never started must not resolve'),
      (caught: unknown) => caught as Error
    );
    assert.equal(error instanceof ProcessSignalTerminationError, false);
    assert.match(error.message, /could not be started/);
    assert.doesNotMatch(error.message, /exit code/i);

    // No pid was ever assigned, so no activity record exists: nothing ran and nothing needs reconciling.
    const records = (await listProcessActivities({ includeFinished: true })).filter(item => item.kind === 'native-process');
    assert.equal(records.length, 0);
  });
});

test('the failure classifier maps a signal termination to AMBIGUOUS_EFFECT before message matching', () => {
  const signalled = new ProcessSignalTerminationError('SIGTERM', 'signal', 'process was terminated by SIGTERM before reporting an exit status');
  assert.equal(classifyFailure({ error: signalled, safety: 'PROCESS_UNKNOWN_EFFECT' }), 'AMBIGUOUS_EFFECT');
  // The generic rule still reads a plain cancellation message as a deliberate cancel, unchanged.
  assert.equal(classifyFailure({ error: new Error('received SIGTERM from owner'), safety: 'PROCESS_UNKNOWN_EFFECT' }), 'SYSTEM_CANCELLED');
});
