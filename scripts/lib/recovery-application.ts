import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { loadRevokedNodes } from '../../src/shared/revoked-nodes.js';
import { workspaceWorkerRootsHash } from '../../src/shared/workspace-worker.js';
import { WORK_EVENT_KINDS, WORK_EXECUTORS, WORK_ACCESS_CLASSES, WORK_WORKLOAD_CLASSES } from '../../src/shared/work-coordinator.js';
import { NodeTaskStore } from '../../src/node/task-store.js';
import { ResultStore } from '../../src/node/result-store.js';
import { TaskEventLog } from '../../src/shared/task-events.js';
import { verifyReceiptChain, type ExecutionReceipt } from '../../src/shared/receipts.js';
import { inspectBudgetPolicy } from '../../src/shared/budget-policy.js';
import { loadBudgetUsage } from '../../src/shared/budget-usage.js';
import { runtimeTreeSha256 } from './runtime-rollback.js';
import { retryAllowed } from '../../src/shared/durable-execution.js';
import { inspectAccessPolicyFile, authorizeOperation } from '../../src/shared/access.js';
import { decideExistingTask } from '../../src/shared/durable-execution.js';
import { decideBootRecovery } from '../../src/shared/task-recovery.js';
import { safeRead } from './recovery-reconciliation.js';
import type { Roots } from './recovery-coverage.js';

/** Application-level synthetic recovery checks; never executes tasks or initializes authentication. */
export async function verifyRestoredApplication(roots: Roots): Promise<void> {
  const nodeId = 'macbook-air.local';
  const tasks = await new NodeTaskStore(roots.state).list({ includeArchived: true });
  if (!tasks.length || tasks.some(t => t.nodeId !== nodeId)) throw new Error('APPLICATION_TASK_IDENTITY');
  const events = new TaskEventLog(roots.state), results = new ResultStore(64 * 1024, 30 * 60 * 1000, roots.state);
  for (const task of tasks) {
    const history = await events.list(task.taskId, 2000, true);
    if (!history.length) throw new Error('APPLICATION_EVENT_HISTORY_MISSING');
    if (history.some(e => e.actorId && e.actorId !== task.actorId || e.nodeId && e.nodeId !== task.nodeId || e.operation && e.operation !== task.operation || e.attempt !== undefined && e.attempt !== task.attemptNumber)) throw new Error('APPLICATION_EVENT_BINDING');
    const lastState = history.filter(e => e.state || e.toState).at(-1);
    if (!lastState || (lastState.toState ?? lastState.state) !== task.state) throw new Error('APPLICATION_EVENT_STATE');
    if (!tasks.some(t => t.taskId === task.rootTaskId) || task.parentTaskId && !tasks.some(t => t.taskId === task.parentTaskId)) throw new Error('APPLICATION_TASK_LINEAGE');
    const own = decideExistingTask({ existing: task, actorId: task.actorId, nodeId, operation: task.operation, payloadSha256: task.payloadSha256, policyHash: task.policyHash ?? 'unknown-policy' });
    if (task.state === 'AMBIGUOUS' && (own.kind !== 'REFUSE_AMBIGUOUS' || retryAllowed('PROCESS_UNKNOWN_EFFECT', 'AMBIGUOUS_EFFECT'))) throw new Error('APPLICATION_AMBIGUITY');
    if (task.resultRef || task.resultHash) {
      if (!task.resultRef || !task.resultHash) throw new Error('APPLICATION_RESULT_BINDING');
      if (task.state === 'COMPLETED' && own.kind !== 'RETURN_RESULT') throw new Error('APPLICATION_RESULT_AUTHORITY');
      await results.readValueForTask(task.resultRef, task.taskId, task.resultHash);
    } else if (task.state === 'COMPLETED') throw new Error('APPLICATION_COMPLETION_UNPROVEN');
    for (const identity of [{ actorId: 'wrong-actor', nodeId }, { actorId: task.actorId, nodeId: 'wrong-node' }]) {
      const decision = decideExistingTask({ existing: task, ...identity, operation: task.operation, payloadSha256: task.payloadSha256, policyHash: task.policyHash ?? 'unknown-policy' });
      if (decision.kind !== 'COLLISION') throw new Error('APPLICATION_AUTHORITY_REFUSAL_MISSING');
    }
    if (task.state === 'RUNNING' && task.resultRef) {
      const recovery = decideBootRecovery({ state: task.state, safetyClass: task.safetyClass ?? 'PROCESS_UNKNOWN_EFFECT', hasDurableResult: true, hasMatchingLiveActivity: false, hasMatchingLease: false, hasMatchingQueueTicket: false, processAlive: false, transportConnected: false, contradictoryEvidence: false });
      if (recovery.kind !== 'FINISH_FROM_DURABLE_EVIDENCE') throw new Error('APPLICATION_RECOVERY_REFUSED');
    }
  }
  const receipts = (await safeRead(roots.state, `receipts/${nodeId}.jsonl`)).toString().split('\n').filter(Boolean).map(l => JSON.parse(l) as ExecutionReceipt);
  const signingPrivate = await safeRead(roots.state, `receipts/${nodeId}.ed25519.pem`), signingPublic = (await safeRead(roots.state, `receipts/${nodeId}.ed25519.pub.pem`)).toString();
  const derived = crypto.createPublicKey(signingPrivate).export({ type: 'spki', format: 'pem' }).toString();
  if (!receipts.length || !verifyReceiptChain(receipts) || derived !== signingPublic || receipts.some(r => r.nodeId !== nodeId || r.publicKey !== signingPublic)) throw new Error('APPLICATION_RECEIPT_CHAIN');
  const policy = await inspectAccessPolicyFile(nodeId, roots.state);
  if (!policy.valid) throw new Error('APPLICATION_POLICY');
  for (const grant of policy.state.grants.filter(g => Date.parse(g.until) <= Date.now())) {
    const narrowed = { ...policy.state, mode: 'on' as const, until: null, clients: {}, grantRequired: { [grant.client]: true }, grants: [grant] };
    if (authorizeOperation(narrowed, { kind: grant.client, clientId: 'synthetic', clientName: 'synthetic' }, 'dex.file.write', 'full-local', Date.now(), { path: '/synthetic/workspace/file', content: 'synthetic' }).allowed) throw new Error('APPLICATION_EXPIRED_GRANT');
  }
  const budget = await inspectBudgetPolicy(nodeId, roots.state);
  if (budget.exists && !budget.valid) throw new Error('APPLICATION_BUDGET_POLICY');
  await loadBudgetUsage(nodeId, roots.state);
  const auth = JSON.parse((await safeRead(roots.state, 'node-auth.json')).toString());
  const worker = JSON.parse((await safeRead(roots.worker, 'config.json')).toString());
  const transportPrivate = await safeRead(roots.state, `nodes/${nodeId}.transport.ed25519.pem`), transportPublic = (await safeRead(roots.state, `nodes/${nodeId}.transport.ed25519.pub.pem`)).toString();
  const enrollment = auth.nodes?.[nodeId];
  if (auth.version !== 2 || !enrollment || enrollment.revoked !== false || enrollment.authMode !== 'asymmetric' || enrollment.active !== null || enrollment.transport?.publicKey !== transportPublic || worker.version !== 1 || worker.nodeId !== nodeId || !Array.isArray(worker.allowedRoots) || !worker.allowedRoots.length || worker.allowedRoots.some((r: unknown) => typeof r !== 'string' || !path.isAbsolute(r)) || worker.rootsHash !== workspaceWorkerRootsHash(worker.allowedRoots) || crypto.createPublicKey(transportPrivate).export({ type: 'spki', format: 'pem' }).toString() !== transportPublic) throw new Error('APPLICATION_ENROLLMENT');
  const revoked = JSON.parse((await safeRead(roots.state, 'revoked-nodes.json')).toString());
  if (!Array.isArray(revoked) || revoked.some(r => typeof r !== 'string' || !r) || (await loadRevokedNodes(roots.state)).has(nodeId)) throw new Error('APPLICATION_REVOCATIONS');
  for (const name of await fs.readdir(path.join(roots.state, 'plans'))) {
    if (!name.endsWith('.json') || name === 'fixture.json') continue;
    const plan = JSON.parse((await safeRead(roots.state, `plans/${name}`)).toString());
    if (plan.version !== 1 || typeof plan.used !== 'boolean' || plan.nodeId !== nodeId || !Number.isFinite(Date.parse(plan.expiresAt))) throw new Error('APPLICATION_PLAN');
    if (plan.used && plan.args?.reason === 'consumed') {
      const claim = JSON.parse((await safeRead(roots.state, `plans/${plan.id}.claim`)).toString());
      if (!Number.isInteger(claim.pid) || claim.pid < 1 || !Number.isFinite(Date.parse(claim.claimedAt))) throw new Error('APPLICATION_PLAN_CLAIM');
    }
  }
  const releaseEvidence = await safeRead(roots.state, 'runtime/retained-evidence.json').then(b => JSON.parse(b.toString())).catch(e => { if (e.code === 'ENOENT') return null; throw e; });
  const releases = await fs.readdir(path.join(roots.state, 'runtime/releases')).catch(e => { if (e.code === 'ENOENT') return []; throw e; });
  if (releases.length && !releaseEvidence) throw new Error('APPLICATION_RUNTIME_PROVENANCE_MISSING');
  if (releaseEvidence) {
    if (releaseEvidence.version !== 1 || !/^[a-z0-9][a-z0-9._-]{0,119}$/.test(releaseEvidence.releaseId) || !/^[a-f0-9]{40}$/.test(releaseEvidence.sourceSha) || await runtimeTreeSha256(path.join(roots.state, 'runtime/releases', releaseEvidence.releaseId)) !== releaseEvidence.treeDigest) throw new Error('APPLICATION_RUNTIME');
    for (const role of ['coordinator', 'worker', 'gateway', 'node', 'oauth-canary']) {
      const xml = (await safeRead(roots.agents, `com.stinkyweasel.dex-reach.${role}.plist`)).toString();
      if (!xml.includes(`<string>com.stinkyweasel.dex-reach.${role}</string>`) || !xml.includes(`<key>WorkingDirectory</key><string>`) || !xml.includes(`/runtime/releases/${releaseEvidence.releaseId}/${role === 'oauth-canary' ? 'dist/scripts/oauth-canary.js' : `dist/src/${role}/main.js`}`) || [...xml.matchAll(/\/runtime\/releases\/([^/<]+)/g)].some(m => m[1] !== releaseEvidence.releaseId)) throw new Error('APPLICATION_SERVICE_COMPATIBILITY');
    }
  }
  // Interpret canonical persisted coordination files without status/pruning/daemon calls.
  const history = (await safeRead(roots.state, 'coordinator/history/events.jsonl')).toString().split('\n').filter(Boolean).map(l => JSON.parse(l));
  let cursor = 0;
  for (const e of history) {
    if (!Number.isSafeInteger(e.cursor) || e.cursor <= cursor || !Number.isFinite(Date.parse(e.at)) || !WORK_EVENT_KINDS.includes(e.event)) throw new Error('APPLICATION_COORDINATION_HISTORY');
    cursor = e.cursor;
  }
  if (!history.length) throw new Error('APPLICATION_COORDINATION_HISTORY');
  for (const name of ['leases', 'queue']) for (const file of await fs.readdir(path.join(roots.state, 'coordinator', name))) {
    const claim = JSON.parse((await safeRead(roots.state, `coordinator/${name}/${file}`)).toString());
    if (!claim.id || !Number.isInteger(claim.pid) || claim.pid < 1 || !Number.isFinite(Date.parse(claim.heartbeatAt)) || !Number.isFinite(Date.parse(name === 'leases' ? claim.createdAt : claim.enqueuedAt)) || !WORK_EXECUTORS.includes(claim.executor) || !WORK_ACCESS_CLASSES.includes(claim.access) || !WORK_WORKLOAD_CLASSES.includes(claim.workload) || !tasks.some(t => t.taskId === claim.taskId && t.attemptNumber === claim.attempt)) throw new Error('APPLICATION_COORDINATION_CLAIM');
  }
}
