import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { startCoordinatorServer } from '../src/coordinator/main.js';
import { coordinatedAcquire, coordinatedRelease, coordinatedStatus } from '../src/coordinator/client.js';
import { reconcileBootTasks } from '../src/node/boot-recovery.js';
import { ResultStore } from '../src/node/result-store.js';
import { NodeTaskStore } from '../src/node/task-store.js';
import { appendReceipt, listReceipts, verifyReceiptChain } from '../src/shared/receipts.js';
import { deriveIdempotencyKey } from '../src/shared/durable-execution.js';

const actorId = 'actor_c14_fixture';
const nodeId = 'macbook-air.local';
const policyHash = 'c'.repeat(64);
const operation = 'dex.file.write';

async function listenLoopback(server: net.Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen({ host: '127.0.0.1', port: 0 }, () => resolve());
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return address.port;
}

async function closeServer(server: net.Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>(resolve => server.close(() => resolve()));
}

async function waitFor<T>(read: () => Promise<T | undefined>, predicate: (value: T) => boolean): Promise<T> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const value = await read();
    if (value !== undefined && predicate(value)) return value;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('timed out waiting for isolated durable recovery fixture');
}

test('C14-A recovers a dropped response from one durable execution over loopback', async () => {
  const state = await fs.mkdtemp(path.join(os.tmpdir(), 'dex-c14-response-loss-'));
  const previousState = process.env.DEX_REACH_STATE_DIR;
  process.env.DEX_REACH_STATE_DIR = state;
  let coordinator: net.Server | undefined;
  let transport: net.Server | undefined;
  let taskLeaseId: string | undefined;
  let unrelatedLeaseId: string | undefined;
  let executionCount = 0;

  try {
    coordinator = await startCoordinatorServer();
    const unrelated = await coordinatedAcquire({ executor: 'other', access: 'read', workload: 'light', phase: 'unrelated-fixture' }, { requireDaemon: true });
    assert.equal(unrelated.status, 'acquired');
    if (unrelated.status !== 'acquired') throw new Error('isolated coordinator failed to admit unrelated fixture lease');
    unrelatedLeaseId = unrelated.lease.id;

    const taskStore = new NodeTaskStore(state);
    const results = new ResultStore(64 * 1024, 60_000, state);
    const requestArgs = { path: path.join(state, 'fixture.txt'), text: 'one durable mutation' };
    const idempotency = deriveIdempotencyKey({
      actorId, nodeId, operation, args: requestArgs, policyHash, requestedKey: 'c14-dropped-response'
    });
    const task = await taskStore.create({
      actorId, nodeId, operation, idempotencyKey: idempotency.key, payloadSha256: idempotency.payloadHash,
      policyHash, safetyClass: 'SIDE_EFFECTING_IDEMPOTENT', mutationLevel: 'STATE_MUTATION', attemptBudget: 1
    });
    await taskStore.transition(task.taskId, 'PREPARING', 'C14 isolated loopback fixture admitted.');
    await taskStore.transition(task.taskId, 'RUNNING', 'C14 isolated loopback execution started.');

    const admission = await coordinatedAcquire({
      executor: 'other', access: 'read', workload: 'light', phase: operation,
      taskId: task.taskId, attempt: task.attemptNumber, pid: process.pid, pidIsWorkload: true
    }, { requireDaemon: true });
    assert.equal(admission.status, 'acquired');
    if (admission.status !== 'acquired') throw new Error('isolated coordinator failed to admit task lease');
    taskLeaseId = admission.lease.id;

    transport = net.createServer(socket => {
      let input = '';
      socket.setEncoding('utf8');
      socket.on('data', chunk => {
        input += chunk;
        const newline = input.indexOf('\n');
        if (newline < 0) return;
        socket.pause();
        void (async () => {
          const request = JSON.parse(input.slice(0, newline)) as { taskId: string; nodeId: string; actorId: string };
          assert.equal(request.taskId, task.taskId);
          assert.equal(request.nodeId, nodeId);
          assert.equal(request.actorId, actorId);
          executionCount += 1;
          const value = { accepted: true, executionCount, taskId: request.taskId };
          const stored = await results.boundWithReference(value, task.taskId);
          await appendReceipt({ nodeId, operation, args: requestArgs, actor: { kind: 'other', clientId: actorId, clientName: 'C14 isolated fixture' }, ok: true, result: value, durationMs: 1, policy: { policyHash } });
          // Simulate a process restart boundary after result persistence but before the terminal
          // task transition. Boot reconciliation must finish from the verified durable result.
          await taskStore.update(task.taskId, { resultRef: stored.metadata.handle, resultHash: stored.metadata.resultHash });
          await coordinatedRelease(taskLeaseId!, { requireDaemon: true });
          taskLeaseId = undefined;
          socket.end(JSON.stringify({ ok: true, result: value }) + '\n');
        })().catch(error => socket.destroy(error instanceof Error ? error : undefined));
      });
    });
    const port = await listenLoopback(transport);

    await new Promise<void>((resolve, reject) => {
      const socket = net.createConnection({ host: '127.0.0.1', port });
      socket.once('error', reject);
      socket.once('connect', () => {
        socket.end(JSON.stringify({ taskId: task.taskId, nodeId, actorId }) + '\n', () => {
          // Deliberately lose the response. The server continues the isolated operation and
          // persists its result/receipt before attempting to answer this closed requester.
          socket.destroy();
          resolve();
        });
      });
    });

    const persisted = await waitFor(
      async () => new NodeTaskStore(state).read(task.taskId),
      value => Boolean(value?.resultRef && value.resultHash)
    );
    assert.ok(persisted);
    assert.equal(persisted.taskId, task.taskId);
    assert.equal(executionCount, 1);
    const firstResultRef = persisted.resultRef;
    const firstResultHash = persisted.resultHash;
    assert.ok(firstResultRef && firstResultHash);
    assert.equal(persisted.state, 'RUNNING');

    const duringRecovery = await coordinatedStatus({ requireDaemon: true });
    assert.ok(duringRecovery.leases.some(lease => lease.id === unrelatedLeaseId), 'recovery did not release an unrelated lease');
    assert.equal(duringRecovery.leases.some(lease => lease.taskId === task.taskId), false, 'task lease leaked after durable persistence');
    assert.equal(duringRecovery.tickets.some(ticket => ticket.taskId === task.taskId), false, 'task queue ticket leaked after durable persistence');

    await closeServer(transport);
    transport = undefined;
    const reopenedTasks = new NodeTaskStore(state);
    const reopenedResults = new ResultStore(64 * 1024, 60_000, state);
    const recovery = await reconcileBootTasks(reopenedTasks, reopenedResults);
    assert.deepEqual(recovery.map(report => report.taskId), [task.taskId]);
    assert.equal(recovery[0]?.decision.kind, 'FINISH_FROM_DURABLE_EVIDENCE');

    const reattached = await reopenedTasks.read(task.taskId);
    assert.equal(reattached?.taskId, task.taskId);
    assert.equal(reattached?.nodeId, nodeId, 'recovery changed the selected node');
    assert.equal(reattached?.actorId, actorId, 'recovery widened task authority');
    assert.equal(reattached?.idempotencyKey, idempotency.key);
    assert.equal(reattached?.resultRef, firstResultRef);
    assert.equal(reattached?.resultHash, firstResultHash);
    assert.equal(reattached?.state, 'COMPLETED');
    assert.deepEqual(await reopenedResults.readValue(firstResultRef!), { accepted: true, executionCount: 1, taskId: task.taskId });
    assert.equal(executionCount, 1, 'reattachment replayed the side effect');

    const receipts = await listReceipts(nodeId);
    assert.equal(receipts.length, 1);
    assert.equal(verifyReceiptChain(receipts), true);
    assert.equal(receipts[0]?.nodeId, nodeId);
    assert.equal(receipts[0]?.ok, true);

    const afterRecovery = await coordinatedStatus({ requireDaemon: true });
    assert.ok(afterRecovery.leases.some(lease => lease.id === unrelatedLeaseId));
    assert.equal(afterRecovery.leases.some(lease => lease.taskId === task.taskId), false);
    assert.equal(afterRecovery.tickets.some(ticket => ticket.taskId === task.taskId), false);
  } finally {
    if (taskLeaseId) await coordinatedRelease(taskLeaseId, { requireDaemon: true }).catch(() => undefined);
    if (unrelatedLeaseId) await coordinatedRelease(unrelatedLeaseId, { requireDaemon: true }).catch(() => undefined);
    await closeServer(transport ?? net.createServer());
    await closeServer(coordinator ?? net.createServer());
    await fs.rm(state, { recursive: true, force: true });
    if (previousState === undefined) delete process.env.DEX_REACH_STATE_DIR;
    else process.env.DEX_REACH_STATE_DIR = previousState;
  }
});
