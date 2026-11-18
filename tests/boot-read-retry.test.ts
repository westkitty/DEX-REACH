import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { RecoveryCoordinatorUnavailableError, retryCoordinatorRecovery, bootReadStopState } from '../src/node/boot-read-retry.js';
import { NodeTaskStore } from '../src/node/task-store.js';
import { hashValue } from '../src/shared/hash.js';
import { savePrivateReadDescriptor, loadVerifiedPrivateReadDescriptor, discardPrivateReadIfClosed } from '../src/node/private-read-recovery.js';

test('a timed-out accepted, preparing or running read uses only legal stop states', () => {
  assert.equal(bootReadStopState('ACCEPTED'), 'CANCELLED');
  assert.equal(bootReadStopState('PREPARING'), 'FAILED');
  assert.equal(bootReadStopState('RUNNING'), 'INPUT_REQUIRED');
  assert.throws(() => bootReadStopState('COMPLETED'), /not in an executable recovery state/);
});

test('coordinator probe outage retries with bounded backoff, then resumes once', async () => {
  let attempts = 0;
  const waits: number[] = [];
  const result = await retryCoordinatorRecovery(async () => {
    if (++attempts < 3) throw new RecoveryCoordinatorUnavailableError();
    return 'validated read';
  }, async ms => { waits.push(ms); });
  assert.equal(result, 'validated read');
  assert.equal(attempts, 3);
  assert.deepEqual(waits, [500, 1000]);
});

test('unknown or post-admission failures are never retried', async () => {
  let attempts = 0;
  await assert.rejects(retryCoordinatorRecovery(async () => {
    attempts++;
    throw new Error('unknown side effect');
  }, async () => {}), /unknown side effect/);
  assert.equal(attempts, 1);
});

test('persistent coordinator outage respects an exact finite retry budget', async () => {
  let attempts = 0;
  const waits: number[] = [];
  await assert.rejects(retryCoordinatorRecovery(async () => {
    attempts++;
    throw new RecoveryCoordinatorUnavailableError();
  }, async ms => { waits.push(ms); }), RecoveryCoordinatorUnavailableError);
  assert.equal(attempts, 8);
  assert.deepEqual(waits, [500, 1000, 2000, 4000, 8000, 8000, 8000]);
  await assert.rejects(retryCoordinatorRecovery(async () => 'never', async () => {}, 9), /attempt budget/);
});

test('private descriptor is purged on INPUT_REQUIRED but retained for RUNNING read', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dex-boot-read-close-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const actor = { kind: 'chatgpt' as const, clientId: 'test-actor', clientName: 'test' };
  const operation = 'dex.fingerprint';
  const args = { cwd: '/Users/andrew/DEX-REACH' };
  const store = new NodeTaskStore(root);
  const task = await store.create({
    actorId: 'actor_' + hashValue({ kind: actor.kind, clientId: actor.clientId }).slice(0, 24),
    nodeId: 'macbook-air.local', operation, safetyClass: 'PURE_READ_IDEMPOTENT',
    payloadSha256: hashValue({ operation, args }), policyHash: 'e'.repeat(64),
    idempotencyKey: 'idem_cleanup_fixture', attemptBudget: 3
  });
  await savePrivateReadDescriptor(root, {
    schemaVersion: 1, taskId: task.taskId, nodeId: task.nodeId, actor,
    operation, args, policyHash: task.policyHash!, payloadSha256: task.payloadSha256
  });
  await store.transition(task.taskId, 'PREPARING');
  await store.transition(task.taskId, 'RUNNING');
  await discardPrivateReadIfClosed(root, await store.read(task.taskId));
  assert.ok(await loadVerifiedPrivateReadDescriptor(root, (await store.read(task.taskId))!));
  await store.transition(task.taskId, 'INPUT_REQUIRED');
  await discardPrivateReadIfClosed(root, await store.read(task.taskId));
  assert.equal(await loadVerifiedPrivateReadDescriptor(root, (await store.read(task.taskId))!), null);
});
