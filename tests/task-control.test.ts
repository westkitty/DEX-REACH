import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { NodeTaskStore } from '../src/node/task-store.js';
import { updateAccessState } from '../src/shared/access.js';

const execFileAsync = promisify(execFile);
const hash = 'b'.repeat(64);

async function tempStore(): Promise<string> { return fs.mkdtemp(path.join(os.tmpdir(), 'dex-reach-c6-')); }
async function policy(root: string): Promise<void> {
  await updateAccessState('node_local', current => current, root);
}
function input(index: string, extra: Record<string, unknown> = {}) {
  return {
    actorId: 'actor_andrew_admin', nodeId: 'node_local', operation: 'dex.fingerprint',
    idempotencyKey: `c6_${index}`, payloadSha256: hash, ...extra
  };
}
async function cli(root: string, args: string[]) {
  return execFileAsync(process.execPath, ['--import', 'tsx', 'scripts/dex-reach.ts', ...args], {
    cwd: process.cwd(), env: { ...process.env, DEX_REACH_STATE_DIR: root }
  });
}

test('C6 owner CLI records lifecycle events and emits content-free continuation state', async () => {
  const root = await tempStore();
  try {
    await policy(root);
    const store = new NodeTaskStore(root);
    const task = await store.create(input('log', { traceId: '0123456789abcdef0123456789abcdef' }));
    await store.transition(task.taskId, 'PREPARING');
    await store.transition(task.taskId, 'RUNNING');
    const events = JSON.parse((await cli(root, ['task', task.taskId, 'events', '--json'])).stdout) as Array<{ kind: string }>;
    assert.ok(events.some(event => event.kind === 'accepted'));
    assert.ok(events.some(event => event.kind === 'transition'));
    const continuation = JSON.parse((await cli(root, ['task', task.taskId, 'continuation'])).stdout) as Record<string, unknown>;
    assert.equal(continuation.schema, 'dex-reach.continuation.v1');
    assert.equal((continuation.task as Record<string, unknown>).payload, undefined);
    assert.equal((continuation.links as Record<string, unknown>).git, 'UNKNOWN');
    const log = JSON.parse((await cli(root, ['task', task.taskId, 'log', '--json'])).stdout) as Record<string, unknown>;
    assert.equal((log.trace as Record<string, unknown>).status, 'missing');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('C6 cancel is owner-local, policy-rechecked, and durable', async () => {
  const root = await tempStore();
  try {
    await policy(root);
    const store = new NodeTaskStore(root);
    const task = await store.create(input('cancel'));
    const cancelled = JSON.parse((await cli(root, ['task', task.taskId, 'cancel'])).stdout) as { state: string };
    assert.equal(cancelled.state, 'CANCELLED');
    assert.equal((await new NodeTaskStore(root).read(task.taskId))?.state, 'CANCELLED');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('C6 NEEDS ANDREW and reconciliation require an explicit evidence reference', async () => {
  const root = await tempStore();
  try {
    await policy(root);
    const store = new NodeTaskStore(root);
    const task = await store.create(input('ambiguous', { safetyClass: 'PROCESS_UNKNOWN_EFFECT', mutationLevel: 'STATE_MUTATION' }));
    await store.transition(task.taskId, 'PREPARING');
    await store.transition(task.taskId, 'RUNNING');
    await store.update(task.taskId, { failureClass: 'AMBIGUOUS_EFFECT' });
    await store.transition(task.taskId, 'AMBIGUOUS', 'External effect is not proven.');
    const detail = JSON.parse((await cli(root, ['task', task.taskId, '--json'])).stdout) as { needsAndrew: { required: boolean; choices: string[] } };
    assert.equal(detail.needsAndrew.required, true);
    assert.ok(detail.needsAndrew.choices.includes('reconcile with an evidence reference'));
    await assert.rejects(() => cli(root, ['task', task.taskId, 'reconcile']), /evidence-ref/);
    const reconciled = JSON.parse((await cli(root, ['task', task.taskId, 'reconcile', '--evidence-ref', 'receipt-verified'])).stdout) as { state: string };
    assert.equal(reconciled.state, 'RECONCILED');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('C6 retry refuses uncertain effects and RESET preserves lineage', async () => {
  const root = await tempStore();
  try {
    await policy(root);
    const store = new NodeTaskStore(root);
    const unsafe = await store.create(input('unsafe', { safetyClass: 'PROCESS_UNKNOWN_EFFECT', mutationLevel: 'STATE_MUTATION' }));
    await store.transition(unsafe.taskId, 'PREPARING');
    await store.transition(unsafe.taskId, 'RUNNING');
    await store.update(unsafe.taskId, { failureClass: 'AMBIGUOUS_EFFECT' });
    await store.transition(unsafe.taskId, 'AMBIGUOUS');
    await assert.rejects(() => cli(root, ['task', unsafe.taskId, 'retry']), /retry refused/);

    const completed = await store.create(input('reset'));
    await store.transition(completed.taskId, 'PREPARING');
    await store.transition(completed.taskId, 'RUNNING');
    await store.transition(completed.taskId, 'COMPLETED');
    const child = JSON.parse((await cli(root, ['task', completed.taskId, 'reset'])).stdout) as { taskId: string; parentTaskId: string; rootTaskId: string; state: string };
    assert.equal(child.parentTaskId, completed.taskId);
    assert.equal(child.rootTaskId, completed.taskId);
    assert.equal(child.state, 'ACCEPTED');
    assert.equal((await new NodeTaskStore(root).read(completed.taskId))?.archivedAtUtc !== undefined, true);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('C6 consequential controls preview and refuse execution even after confirmation', async () => {
  const root = await tempStore();
  try {
    await policy(root);
    const task = await new NodeTaskStore(root).create(input('preview'));
    const preview = JSON.parse((await cli(root, ['task', task.taskId, 'control', 'restart', '--preview', '--json'])).stdout) as { executed: boolean; confirmationRequired: boolean };
    assert.equal(preview.executed, false);
    assert.equal(preview.confirmationRequired, true);
    await assert.rejects(() => cli(root, ['task', task.taskId, 'control', 'restart', '--preview', '--confirm', 'fixture'] ), /fixture-only/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
