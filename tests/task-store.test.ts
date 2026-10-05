import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { NodeTaskStore, TASK_STATES, taskStoreFile, TaskStoreCorruptError, TaskStoreVersionError } from '../src/node/task-store.js';

const execFileAsync = promisify(execFile);
const hash = 'a'.repeat(64);

async function tempStore(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'dex-reach-task-store-'));
}

function input(index = 0) {
  return {
    actorId: 'actor_andrew_admin',
    nodeId: 'node_local',
    operation: 'reach_execute_plan',
    idempotencyKey: `idem_${index}`,
    payloadSha256: hash
  };
}

async function complete(store: NodeTaskStore, taskId: string): Promise<void> {
  await store.transition(taskId, 'PREPARING');
  await store.transition(taskId, 'RUNNING');
  await store.transition(taskId, 'COMPLETED', 'Completed with durable evidence.');
}

test('TaskStore creates, reads, updates, persists, and rejects illegal transitions', async () => {
  const root = await tempStore();
  try {
    const store = new NodeTaskStore(root);
    const task = await store.create(input());
    assert.match(task.taskId, /^rtsk_[0-9a-f]{11,13}_[0-9a-f]{32}$/);
    assert.equal((await store.read(task.taskId))?.state, 'ACCEPTED');
    await assert.rejects(() => store.create({ ...input(), taskId: task.taskId, operation: 'reach_file_write' }), /conflicting binding/);
    await assert.rejects(() => store.create({ ...input(), taskId: task.taskId }), /use read instead/);
    const updated = await store.update(task.taskId, { status: 'Waiting for admission.' });
    assert.equal(updated.summary.status, 'Waiting for admission.');
    await store.transition(task.taskId, 'PREPARING');
    await assert.rejects(() => store.transition(task.taskId, 'COMPLETED'), /illegal task transition PREPARING -> COMPLETED/);
    await store.transition(task.taskId, 'RUNNING');
    await store.transition(task.taskId, 'INPUT_REQUIRED');
    await store.transition(task.taskId, 'RUNNING');
    await store.transition(task.taskId, 'FAILED');
    await assert.rejects(() => store.transition(task.taskId, 'RUNNING'), /illegal task transition FAILED -> RUNNING/);

    const reopened = new NodeTaskStore(root);
    assert.equal((await reopened.read(task.taskId))?.state, 'FAILED');
    assert.equal((await reopened.list({ taskId: task.taskId }))[0]?.taskId, task.taskId);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('TaskStore binds lineage and indexed query fields without exposing input payloads', async () => {
  const root = await tempStore();
  try {
    const store = new NodeTaskStore(root);
    const parent = await store.create({ ...input(), idempotencyKey: 'idem_parent' });
    const child = await store.create({ ...input(), idempotencyKey: 'idem_child', parentTaskId: parent.taskId });
    assert.equal(child.rootTaskId, parent.taskId);
    assert.equal(child.taskDepth, 1);
    assert.equal((await store.list({ rootTaskId: parent.taskId })).length, 2);
    assert.equal((await store.list({ nodeId: 'node_local' })).length, 2);
    assert.equal((await store.list({ actorId: 'actor_andrew_admin' })).length, 2);
    assert.equal((await store.list({ idempotencyKey: 'idem_child' }))[0]?.taskId, child.taskId);
    assert.equal((await store.list({ updatedAfter: new Date(0).toISOString() })).length, 2);
    assert.equal('arguments' in child, false);
    await assert.rejects(() => store.read('../escape'), /invalid task id/);
    await assert.rejects(() => store.create({ ...input(), nodeId: '../other' }), /invalid nodeId/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('concurrent writers commit coherent task snapshots', async () => {
  const root = await tempStore();
  try {
    const store = new NodeTaskStore(root);
    const tasks = await Promise.all(Array.from({ length: 32 }, (_, index) => store.create(input(index))));
    assert.equal(new Set(tasks.map(task => task.taskId)).size, 32);
    const listed = await store.list();
    assert.equal(listed.length, 32);
    const parsed = JSON.parse(await fs.readFile(taskStoreFile(root), 'utf8')) as { records: Record<string, unknown>; index: unknown };
    assert.equal(Object.keys(parsed.records).length, 32);
    assert.ok(parsed.index);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('malformed and future-version stores fail closed, while explicit compatibility is read-only', async () => {
  const root = await tempStore();
  try {
    await fs.mkdir(path.dirname(taskStoreFile(root)), { recursive: true });
    await fs.writeFile(taskStoreFile(root), '{not-json');
    await assert.rejects(() => new NodeTaskStore(root).create(input()), TaskStoreCorruptError);

    await fs.writeFile(taskStoreFile(root), JSON.stringify({ schemaVersion: 999 }));
    await assert.rejects(() => new NodeTaskStore(root).list(), TaskStoreVersionError);

    const source = new NodeTaskStore(root);
    // A compatibility reader may inspect an explicitly selected older document but cannot mutate it.
    const legacyRecord = {
      schemaVersion: 1,
      taskId: 'rtsk_01925b6a7c8d_3f8a9e2b1c4d5e6f',
      rootTaskId: 'rtsk_01925b6a7c8d_3f8a9e2b1c4d5e6f',
      parentTaskId: null, taskDepth: 0, lineageIndex: 0,
      actorId: 'actor_andrew_admin', nodeId: 'node_local', operation: 'reach_execute_plan',
      state: 'ACCEPTED', attemptNumber: 1, attemptBudget: 1,
      createdAtUtc: '2026-10-05T01:45:00.000Z', updatedAtUtc: '2026-10-05T01:45:00.000Z',
      idempotencyKey: 'idem_legacy', payloadSha256: hash,
      summary: { status: 'legacy', isShareSafe: true }
    };
    await fs.writeFile(taskStoreFile(root), JSON.stringify({ schemaVersion: 0, records: { [legacyRecord.taskId]: legacyRecord }, archived: {} }));
    const compatibility = new NodeTaskStore(root, true);
    assert.equal((await compatibility.list())[0]?.taskId, legacyRecord.taskId);
    await assert.rejects(() => compatibility.create(input()), /compatibility mode is read-only/);
    await assert.rejects(() => source.read(legacyRecord.taskId), TaskStoreVersionError);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('retention archives only terminal work and never sweeps active tasks', async () => {
  const root = await tempStore();
  try {
    const store = new NodeTaskStore(root);
    const active = await store.create(input(1));
    const terminal = await store.create(input(2));
    await complete(store, terminal.taskId);
    const now = new Date(Date.now() + 2_000);
    const first = await store.sweep({ now, terminalRetentionMs: 0, archiveRetentionMs: 60_000 });
    assert.deepEqual(first, { archived: 1, deleted: 0 });
    assert.equal((await store.read(active.taskId))?.state, 'ACCEPTED');
    assert.equal((await store.list({ includeArchived: true })).length, 2);
    assert.equal((await store.list()).length, 1);
    const second = await store.sweep({ now: new Date(now.getTime() + 120_000), terminalRetentionMs: 0, archiveRetentionMs: 0 });
    assert.deepEqual(second, { archived: 0, deleted: 1 });
    assert.equal(await store.read(terminal.taskId), null);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('owner CLI lists and details durable tasks read-only', async () => {
  const root = await tempStore();
  try {
    const task = await new NodeTaskStore(root).create(input());
    const env = { ...process.env, DEX_REACH_STATE_DIR: root };
    const listed = await execFileAsync(process.execPath, ['--import', 'tsx', 'scripts/dex-reach.ts', 'tasks', '--json'], { cwd: process.cwd(), env });
    assert.match(listed.stdout, new RegExp(task.taskId));
    const detail = await execFileAsync(process.execPath, ['--import', 'tsx', 'scripts/dex-reach.ts', 'task', task.taskId, '--json'], { cwd: process.cwd(), env });
    assert.equal((JSON.parse(detail.stdout) as { taskId: string }).taskId, task.taskId);
    assert.ok(TASK_STATES.includes((JSON.parse(detail.stdout) as { state: typeof TASK_STATES[number] }).state));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
