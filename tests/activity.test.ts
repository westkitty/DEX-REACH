import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  activityDir,
  activityFile,
  finishProcessActivityByPid,
  listProcessActivities,
  readProcessActivities,
  safeProcessLabel,
  shareSafeActivity,
  startProcessActivity
} from '../src/shared/activity.js';
import { nativeProcess } from '../src/node/native.js';
import { AdapterRegistry } from '../src/shared/adapter-contract.js';
import { DesktopCommanderAdapter } from '../src/node/adapters/desktop-commander.js';

async function withStateDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dex-reach-activity-'));
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

test('activity evidence stays machine-wide when HOME is virtualized', () => {
  const previousHome = process.env.HOME;
  const previousState = process.env.DEX_REACH_STATE_DIR;
  const virtualHome = path.join(os.tmpdir(), 'dex-virtual-home');
  try {
    process.env.HOME = virtualHome;
    delete process.env.DEX_REACH_STATE_DIR;
    assert.equal(activityDir(), path.join(os.userInfo().homedir, '.dex-reach', 'activity'));
    assert.notEqual(activityDir(), path.join(virtualHome, '.dex-reach', 'activity'));
  } finally {
    if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
    if (previousState === undefined) delete process.env.DEX_REACH_STATE_DIR; else process.env.DEX_REACH_STATE_DIR = previousState;
  }
});

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 1500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('timed out waiting for activity state');
}

test('activity ledger records process identity without persisting raw command arguments', async () => {
  await withStateDir(async dir => {
    const record = await startProcessActivity({
      kind: 'compat-process',
      pid: process.pid,
      operation: 'compat.start_process',
      command: 'python3 --token should-never-be-stored',
      cwd: '/private/project'
    });
    assert.equal(record.processLabel, 'python3');

    const raw = await fs.readFile(activityFile(), 'utf8');
    assert.doesNotMatch(raw, /should-never-be-stored|--token/);

    const share = shareSafeActivity([record]);
    assert.equal(share[0]?.processLabel, 'python3');
    assert.equal('pid' in (share[0] ?? {}), false);
    assert.equal('cwd' in (share[0] ?? {}), false);

    assert.equal(await finishProcessActivityByPid(process.pid, 'terminated'), true);
    const finished = await listProcessActivities({ includeFinished: true });
    assert.equal(finished[0]?.state, 'terminated');
  });
});

test('activity records preserve durable task correlation while share projection omits local process identity', async () => {
  await withStateDir(async () => {
    const taskId = `rtsk_${Date.now().toString(16)}_${'c'.repeat(32)}`;
    const record = await startProcessActivity({
      kind: 'native-process', pid: process.pid, operation: 'dex.process.run', command: 'sleep 1',
      taskId, attempt: 1, phase: 'dex.process.run'
    });
    assert.equal(record.taskId, taskId);
    assert.equal(record.attempt, 1);
    assert.equal(record.phase, 'dex.process.run');
    const share = shareSafeActivity([record])[0];
    assert.equal(share?.taskId, taskId);
    assert.equal(share?.attempt, 1);
    assert.equal(share?.phase, 'dex.process.run');
    assert.equal('pid' in share!, false);
    await finishProcessActivityByPid(process.pid, 'terminated');
  });
});

test('Control Room activity reads do not reconcile or write stale process records', async () => {
  await withStateDir(async () => {
    await startProcessActivity({ kind: 'native-process', pid: 99999999, operation: 'dex.process.run', command: 'node stale', taskId: `rtsk_${Date.now().toString(16)}_${'d'.repeat(32)}` });
    const before = await fs.readFile(activityFile(), 'utf8');
    const snapshot = await readProcessActivities({ includeFinished: true, limit: 20 });
    const after = await fs.readFile(activityFile(), 'utf8');
    assert.equal(snapshot[0]?.state, 'running');
    assert.equal(after, before);
  });
});

test('nativeProcess exposes the real child pid while work is running and records completion', async () => {
  await withStateDir(async dir => {
    const cwd = path.join(dir, 'work');
    await fs.mkdir(cwd);
    const pending = nativeProcess('sleep 0.35', cwd, 'development', 2000, [cwd]);

    await waitFor(async () => (await listProcessActivities()).some(item => item.kind === 'native-process'));
    const active = (await listProcessActivities()).find(item => item.kind === 'native-process');
    assert.ok(active);
    assert.notEqual(active.pid, process.pid);
    assert.equal(active.state, 'running');
    assert.equal(active.processLabel, 'sleep');

    const result = await pending;
    assert.equal(result.exitCode, 0);

    const history = await listProcessActivities({ includeFinished: true });
    const completed = history.find(item => item.id === active.id);
    assert.equal(completed?.state, 'completed');
    assert.equal(completed?.exitCode, 0);
  });
});

test('process labels are bounded executable identities rather than command text', () => {
  assert.equal(safeProcessLabel('/usr/bin/node --eval secret'), 'node');
  assert.equal(safeProcessLabel('"/Applications/Bad Tool" --arg'), 'process');
});

test('corrupt activity evidence fails visibly instead of disappearing from the owner view', async () => {
  await withStateDir(async () => {
    await fs.mkdir(path.dirname(activityFile()), { recursive: true });
    await fs.writeFile(activityFile(), JSON.stringify([{ id: 'activity-bad' }]) + '\n');
    await assert.rejects(() => listProcessActivities(), /malformed record/);
  });
});

test('compatibility start_process records the adapter-reported pid without storing command arguments', async () => {
  await withStateDir(async () => {
    const adapter = new DesktopCommanderAdapter(new AdapterRegistry());
    Object.assign(adapter as object, {
      client: {
        callTool: async () => ({
          isError: false,
          content: [{ type: 'text', text: 'Process started with PID 424242 (shell: /bin/zsh)' }]
        })
      }
    });

    await adapter.callTool('start_process', { command: 'python3 --token adapter-secret', timeout_ms: 1000 });
    const records = await listProcessActivities({ includeFinished: true });
    const record = records.find(item => item.kind === 'compat-process');
    assert.ok(record);
    assert.equal(record.pid, 424242);
    assert.equal(record.processLabel, 'python3');
    assert.doesNotMatch(await fs.readFile(activityFile(), 'utf8'), /adapter-secret|--token/);
  });
});
