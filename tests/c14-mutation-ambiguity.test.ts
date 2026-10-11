import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { startCoordinatorServer } from '../src/coordinator/main.js';
import { coordinatedAcquire, coordinatedRelease, coordinatedStatus } from '../src/coordinator/client.js';
import { reconcileBootTasks } from '../src/node/boot-recovery.js';
import { NodeTaskStore } from '../src/node/task-store.js';
import { ResultStore } from '../src/node/result-store.js';
import { decideExistingTask, deriveIdempotencyKey } from '../src/shared/durable-execution.js';
import { listReceipts } from '../src/shared/receipts.js';

const actorId = 'actor_c14_ambiguity';
const nodeId = 'macbook-air.local';
const operation = 'dex.file.write';
const policyHash = 'd'.repeat(64);

async function closeServer(server: net.Server | undefined): Promise<void> {
  if (!server?.listening) return;
  await new Promise<void>(resolve => server.close(() => resolve()));
}

async function waitForEffect(pathname: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      const value = JSON.parse(await fs.readFile(pathname, 'utf8')) as { executions: number };
      if (value.executions === 1) return;
    } catch { /* the fake external system has not committed yet */ }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('timed out waiting for the isolated external side-effect oracle');
}

test('C14-B preserves an uncertain mutation and refuses every replay path after restart', async () => {
  const state = await fs.mkdtemp(path.join(os.tmpdir(), 'dex-c14-ambiguity-'));
  const previousState = process.env.DEX_REACH_STATE_DIR;
  process.env.DEX_REACH_STATE_DIR = state;
  const effectOracle = path.join(state, 'external-effect-oracle.json');
  let coordinator: net.Server | undefined;
  let transport: net.Server | undefined;
  let taskLeaseId: string | undefined;
  let unrelatedLeaseId: string | undefined;
  let taskId = '';
  let executionCount = 0;

  try {
    coordinator = await startCoordinatorServer();
    const unrelatedLease = await coordinatedAcquire({ executor: 'other', access: 'read', workload: 'light', phase: 'unrelated-ambiguity-fixture' }, { requireDaemon: true });
    assert.equal(unrelatedLease.status, 'acquired');
    if (unrelatedLease.status !== 'acquired') throw new Error('isolated coordinator failed to admit unrelated lease');
    unrelatedLeaseId = unrelatedLease.lease.id;

    const taskStore = new NodeTaskStore(state);
    const results = new ResultStore(64 * 1024, 60_000, state);
    const args = { path: path.join(state, 'mutation-target.txt'), text: 'effect may have committed' };
    const idempotency = deriveIdempotencyKey({ actorId, nodeId, operation, args, policyHash, requestedKey: 'c14-ambiguous-mutation' });
    const task = await taskStore.create({
      actorId, nodeId, operation, idempotencyKey: idempotency.key, payloadSha256: idempotency.payloadHash,
      policyHash, safetyClass: 'PROCESS_UNKNOWN_EFFECT', mutationLevel: 'STATE_MUTATION', attemptBudget: 1
    });
    taskId = task.taskId;
    await taskStore.transition(taskId, 'PREPARING', 'C14-B isolated mutation admitted.');
    await taskStore.transition(taskId, 'RUNNING', 'C14-B isolated mutation started.');

    const admission = await coordinatedAcquire({
      executor: 'other', access: 'read', workload: 'light', phase: operation,
      taskId, attempt: task.attemptNumber, pid: process.pid, pidIsWorkload: true
    }, { requireDaemon: true });
    assert.equal(admission.status, 'acquired');
    if (admission.status !== 'acquired') throw new Error('isolated coordinator failed to admit mutation lease');
    taskLeaseId = admission.lease.id;

    transport = net.createServer(socket => {
      let input = '';
      socket.setEncoding('utf8');
      socket.on('data', chunk => {
        input += chunk;
        if (!input.includes('\n')) return;
        socket.pause();
        void (async () => {
          const request = JSON.parse(input.slice(0, input.indexOf('\n'))) as { taskId: string; actorId: string; nodeId: string };
          assert.equal(request.taskId, taskId);
          assert.equal(request.actorId, actorId);
          assert.equal(request.nodeId, nodeId);
          executionCount += 1;
          // This is the external-effect oracle. It is deliberately not a DEX receipt or result.
          await fs.writeFile(effectOracle, JSON.stringify({ executions: executionCount, target: args.path }) + '\n', { mode: 0o600 });
          await coordinatedRelease(taskLeaseId!, { requireDaemon: true });
          taskLeaseId = undefined;
          // The simulated transport/process terminates before a result or receipt is persisted.
          socket.destroy();
        })().catch(error => socket.destroy(error instanceof Error ? error : undefined));
      });
    });
    await new Promise<void>((resolve, reject) => {
      transport!.once('error', reject);
      transport!.listen({ host: '127.0.0.1', port: 0 }, () => resolve());
    });
    const address = transport.address();
    assert.ok(address && typeof address === 'object');
    await new Promise<void>((resolve, reject) => {
      const socket = net.createConnection({ host: '127.0.0.1', port: address.port });
      socket.once('error', reject);
      socket.once('connect', () => {
        socket.end(JSON.stringify({ taskId, actorId, nodeId }) + '\n');
        socket.once('close', () => resolve());
      });
    });
    await waitForEffect(effectOracle);
    assert.equal(executionCount, 1);

    const beforeRecovery = await new NodeTaskStore(state).read(taskId);
    assert.equal(beforeRecovery?.state, 'RUNNING');
    assert.equal(beforeRecovery?.resultRef, undefined);
    assert.equal((await listReceipts(nodeId)).length, 0, 'the side-effect oracle is not a receipt');

    const firstRecovery = await reconcileBootTasks(new NodeTaskStore(state), new ResultStore(64 * 1024, 60_000, state));
    assert.equal(firstRecovery[0]?.taskId, taskId);
    assert.equal(firstRecovery[0]?.decision.kind, 'AMBIGUOUS');
    const ambiguous = await new NodeTaskStore(state).read(taskId);
    assert.equal(ambiguous?.state, 'AMBIGUOUS');
    assert.equal(ambiguous?.failureClass, 'AMBIGUOUS_EFFECT');
    assert.equal(ambiguous?.taskId, taskId);
    assert.equal(ambiguous?.actorId, actorId);
    assert.equal(ambiguous?.nodeId, nodeId);
    assert.equal(ambiguous?.idempotencyKey, idempotency.key);
    assert.equal(ambiguous?.resultRef, undefined);

    const duplicate = decideExistingTask({
      existing: { ...ambiguous!, summaryStatus: ambiguous!.summary.status },
      actorId, nodeId, operation, payloadSha256: idempotency.payloadHash, policyHash
    });
    assert.equal(duplicate.kind, 'REFUSE_AMBIGUOUS');
    assert.equal(duplicate.task.taskId, taskId);
    assert.equal(executionCount, 1, 'same-identity duplicate was replayed');

    const changedActor = decideExistingTask({
      existing: { ...ambiguous!, summaryStatus: ambiguous!.summary.status },
      actorId: 'actor_substitute', nodeId, operation, payloadSha256: idempotency.payloadHash, policyHash
    });
    const changedNode = decideExistingTask({
      existing: { ...ambiguous!, summaryStatus: ambiguous!.summary.status },
      actorId, nodeId: 'other-node.local', operation, payloadSha256: idempotency.payloadHash, policyHash
    });
    const changedPayload = decideExistingTask({
      existing: { ...ambiguous!, summaryStatus: ambiguous!.summary.status },
      actorId, nodeId, operation, payloadSha256: 'e'.repeat(64), policyHash
    });
    assert.equal(changedActor.kind, 'COLLISION');
    assert.equal(changedNode.kind, 'COLLISION');
    assert.equal(changedPayload.kind, 'COLLISION');
    assert.equal(executionCount, 1);

    const reopenedTasks = new NodeTaskStore(state);
    // Corrupt/incomplete recovery metadata must not turn the ambiguous task into a completed one.
    await reopenedTasks.update(taskId, { resultRef: 'result_missing', resultHash: 'f'.repeat(64) });
    const secondRecovery = await reconcileBootTasks(reopenedTasks, new ResultStore(64 * 1024, 60_000, state));
    assert.equal(secondRecovery[0]?.taskId, taskId);
    assert.equal(secondRecovery[0]?.decision.kind, 'INPUT_REQUIRED');
    const afterRestart = await reopenedTasks.read(taskId);
    assert.equal(afterRestart?.state, 'AMBIGUOUS');
    assert.equal(afterRestart?.failureClass, 'AMBIGUOUS_EFFECT');
    assert.equal(afterRestart?.taskId, taskId);
    assert.equal(afterRestart?.resultRef, 'result_missing');
    assert.equal((await listReceipts(nodeId)).length, 0);
    assert.equal(executionCount, 1, 'restart recovery replayed the mutation');

    const status = await coordinatedStatus({ requireDaemon: true });
    assert.ok(status.leases.some(lease => lease.id === unrelatedLeaseId), 'ambiguity cleanup released an unrelated lease');
    assert.equal(status.leases.some(lease => lease.taskId === taskId), false);
    assert.equal(status.tickets.some(ticket => ticket.taskId === taskId), false);
  } finally {
    if (taskLeaseId) await coordinatedRelease(taskLeaseId, { requireDaemon: true }).catch(() => undefined);
    if (unrelatedLeaseId) await coordinatedRelease(unrelatedLeaseId, { requireDaemon: true }).catch(() => undefined);
    await closeServer(transport);
    await closeServer(coordinator);
    await fs.rm(state, { recursive: true, force: true });
    if (previousState === undefined) delete process.env.DEX_REACH_STATE_DIR;
    else process.env.DEX_REACH_STATE_DIR = previousState;
  }
});
