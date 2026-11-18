import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { NodeTaskStore } from '../src/node/task-store.js';
import { hashValue } from '../src/shared/hash.js';
import { decideBootRecovery } from '../src/shared/task-recovery.js';
import { isReplayableRead, savePrivateReadDescriptor, loadVerifiedPrivateReadDescriptor, discardPrivateReadDescriptor } from '../src/node/private-read-recovery.js';
import type { RequestActor } from '../src/shared/protocol.js';

const actor: RequestActor = { kind: 'chatgpt', clientId: 'test-client', clientName: 'Recovery Test' };
const actorId = 'actor_' + hashValue({ kind: actor.kind, clientId: actor.clientId }).slice(0, 24);
const nodeId = 'macbook-air.local';
const operation = 'dex.fingerprint';
const args = { cwd: '/Users/andrew/DEX-REACH' };
const policyHash = 'b'.repeat(64);
const payloadSha256 = hashValue({ operation, args });

async function fixture(t: { after: (cleanup: () => Promise<void>) => void }) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dex-read-recovery-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new NodeTaskStore(root);
  const task = await store.create({
    actorId, nodeId, operation, policyHash, payloadSha256,
    idempotencyKey: 'idem_' + Math.random().toString(16).slice(2), safetyClass: 'PURE_READ_IDEMPOTENT',
    attemptBudget: 3
  });
  const descriptor = { schemaVersion: 1 as const, taskId: task.taskId, nodeId, actor, operation, args, policyHash, payloadSha256 };
  return { root, store, task, descriptor };
}

test('private read input is persisted owner-only and bound to original actor, request, node and policy', async t => {
  const f = await fixture(t);
  assert.equal(await loadVerifiedPrivateReadDescriptor(f.root, f.task), null);
  await savePrivateReadDescriptor(f.root, f.descriptor);
  const saved = await loadVerifiedPrivateReadDescriptor(f.root, f.task);
  assert.deepEqual(saved, f.descriptor);
  const name = path.join(f.root, 'tasks', 'private-read-recovery', f.task.taskId + '.json');
  assert.equal((await fs.stat(name)).mode & 0o077, 0);
  assert.equal(JSON.stringify(await f.store.read(f.task.taskId)).includes('test-client'), false);
  await assert.rejects(savePrivateReadDescriptor(f.root, f.descriptor), /already exists/);
  await discardPrivateReadDescriptor(f.root, f.task.taskId);
  assert.equal(await loadVerifiedPrivateReadDescriptor(f.root, f.task), null);
});

test('recovery refuses corrupt or misbound private input, never copies it into task record', async t => {
  const f = await fixture(t);
  await assert.rejects(savePrivateReadDescriptor(f.root, { ...f.descriptor, args: { cwd: '/another' } }), /hash mismatch/);
  await savePrivateReadDescriptor(f.root, f.descriptor);
  const name = path.join(f.root, 'tasks', 'private-read-recovery', f.task.taskId + '.json');
  await fs.writeFile(name, JSON.stringify({ ...f.descriptor, actor: { ...actor, clientId: 'intruder' } }), { mode: 0o600 });
  await assert.rejects(loadVerifiedPrivateReadDescriptor(f.root, f.task), /binding mismatch/);
});

test('private request symlinks are refused; arbitrary shell is never replayable', async t => {
  const f = await fixture(t);
  assert.equal(isReplayableRead('dex.process.run'), false);
  assert.equal(isReplayableRead('dex.file.write'), false);
  await assert.rejects(savePrivateReadDescriptor(f.root, { ...f.descriptor, operation: 'dex.process.run' }), /not eligible/);
  await savePrivateReadDescriptor(f.root, f.descriptor);
  const name = path.join(f.root, 'tasks', 'private-read-recovery', f.task.taskId + '.json');
  await fs.rename(name, name + '.safe');
  await fs.symlink(name + '.safe', name);
  await assert.rejects(loadVerifiedPrivateReadDescriptor(f.root, f.task));
});

test('one logical pure read can reserve bounded attempts, including across reopened task store', async t => {
  const f = await fixture(t);
  await f.store.transition(f.task.taskId, 'PREPARING');
  await f.store.transition(f.task.taskId, 'RUNNING');
  const retry2 = await f.store.reserveBootReadRetry(f.task.taskId, 1);
  assert.equal(retry2.taskId, f.task.taskId);
  assert.equal(retry2.attemptNumber, 1); // old schema readers require this
  assert.equal(retry2.recoveryAttempt, 2);
  assert.equal(retry2.state, 'PREPARING');
  await f.store.transition(f.task.taskId, 'RUNNING');
  const reopened = new NodeTaskStore(f.root);
  const retry3 = await reopened.reserveBootReadRetry(f.task.taskId, 2);
  assert.equal(retry3.attemptNumber, 1);
  assert.equal(retry3.recoveryAttempt, 3);
  await assert.rejects(f.store.reserveBootReadRetry(f.task.taskId, 2), /state changed/);
  await reopened.transition(f.task.taskId, 'RUNNING');
  await assert.rejects(reopened.reserveBootReadRetry(f.task.taskId, 3), /budget exhausted/);
  const persisted = await reopened.read(f.task.taskId);
  assert.equal(persisted?.state, 'RUNNING');
  assert.equal(persisted?.attemptNumber, 1);
  assert.equal(persisted?.recoveryAttempt, 3);
});


test('private recovery rejects a symlinked descriptor directory', async t => {
  const f = await fixture(t);
  const dir = path.join(f.root, 'tasks', 'private-read-recovery');
  const safe = path.join(f.root, 'separate-directory');
  await fs.mkdir(path.dirname(dir), { recursive: true });
  await fs.mkdir(safe);
  await fs.symlink(safe, dir);
  await assert.rejects(savePrivateReadDescriptor(f.root, f.descriptor), /directory is unsafe or symlinked/);
  await assert.rejects(loadVerifiedPrivateReadDescriptor(f.root, f.task), /directory is unsafe or symlinked/);
});

test('queued pure read is eligible for bounded recovery; a queued unknown-effect operation remains attached', () => {
  const base = {
    state: 'PREPARING' as const, safetyClass: 'PURE_READ_IDEMPOTENT',
    hasDurableResult: false, hasMatchingLiveActivity: false,
    hasMatchingLease: false, hasMatchingQueueTicket: true,
    processAlive: false, transportConnected: true, contradictoryEvidence: false
  };
  assert.equal(decideBootRecovery(base).kind, 'RETRY_SAFE');
  assert.equal(decideBootRecovery({ ...base, safetyClass: 'PROCESS_UNKNOWN_EFFECT' }).kind, 'REATTACH');
});
