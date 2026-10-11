import { assertNotQuarantined } from '../shared/task-quarantine.js';
import crypto from 'node:crypto';
import { AuditLog } from '../shared/audit.js';
import { listProcessActivities, type ProcessActivity } from '../shared/activity.js';
import { inspectAccessPolicyFile, resolveMode } from '../shared/access.js';
import { retryAllowed } from '../shared/durable-execution.js';
import { listReceipts, verifyReceipt } from '../shared/receipts.js';
import { stateDir } from '../shared/local-env.js';
import { isValidTraceId, readTrace, type TraceSpan } from '../shared/trace.js';
import { TaskEventLog, type TaskEvent } from '../shared/task-events.js';
import { NodeTaskStore, TERMINAL_TASK_STATES, type ReachTaskRecord } from './task-store.js';
import { ResultStore } from './result-store.js';

export type NeedsAndrew = {
  required: boolean;
  decision: string;
  evidence: string[];
  choices: string[];
};

export type TaskLog = {
  task: ReachTaskRecord;
  events: TaskEvent[];
  activities: ProcessActivity[];
  audit: Array<{ at: string; operation: string; ok: boolean; durationMs?: number; error?: string }>;
  receipts: Array<{ receiptId: string; at: string; ok: boolean; receiptHash: string; verified: boolean; linkage: 'operation-node-candidate' }>;
  trace: { status: 'linked' | 'unknown' | 'missing'; traceId?: string; spans?: TraceSpan[] };
  authority: { policyValid: boolean; effectiveMode: string; revision: number };
};

const CONTROL_REF = /^[A-Za-z0-9._:-]{1,160}$/;

export function needsAndrew(task: ReachTaskRecord): NeedsAndrew | null {
  if (task.state === 'INPUT_REQUIRED') {
    return {
      required: true,
      decision: task.summary.status,
      evidence: [`Task state is INPUT_REQUIRED. Node status: ${task.summary.status}`],
      choices: ['provide the missing input and resume', 'cancel the task']
    };
  }
  if (task.state === 'AMBIGUOUS' || task.failureClass === 'AMBIGUOUS_EFFECT') {
    return {
      required: true,
      decision: 'Decide whether verified evidence reconciles the uncertain external effect or the task must be cancelled.',
      evidence: [task.summary.status, ...(task.failureClass ? [`failureClass=${task.failureClass}`] : [])],
      choices: ['reconcile with an evidence reference', 'cancel the task']
    };
  }
  return null;
}

export async function ownerControlAuthority(nodeId: string, dir = stateDir()): Promise<{ policyValid: boolean; effectiveMode: string; revision: number }> {
  const inspection = await inspectAccessPolicyFile(nodeId, dir);
  if (!inspection.valid) throw new Error(`owner control refused: current policy is invalid (${inspection.errors.join('; ')})`);
  return { policyValid: true, effectiveMode: resolveMode(inspection.state), revision: inspection.state.revision };
}

export async function taskEvents(taskId: string, dir = stateDir()): Promise<TaskEvent[]> {
  return new TaskEventLog(dir).list(taskId);
}

async function linkedTrace(task: ReachTaskRecord): Promise<TaskLog['trace']> {
  if (!task.traceId || !isValidTraceId(task.traceId)) return { status: 'unknown' };
  const spans = await readTrace(task.traceId);
  return spans.length ? { status: 'linked', traceId: task.traceId, spans } : { status: 'missing', traceId: task.traceId };
}

export async function buildTaskLog(task: ReachTaskRecord, dir = stateDir()): Promise<TaskLog> {
  const events = await taskEvents(task.taskId, dir);
  const activities = (await listProcessActivities({ includeFinished: true, limit: 500 })).filter(activity => activity.taskId === task.taskId);
  const audit = (await new AuditLog().tail(500))
    .filter(entry => entry.nodeId === task.nodeId && entry.operation === task.operation)
    .map(entry => ({ at: entry.at, operation: entry.operation, ok: entry.ok, ...(entry.durationMs !== undefined ? { durationMs: entry.durationMs } : {}), ...(entry.error ? { error: entry.error } : {}) }));
  const receipts = (await listReceipts(task.nodeId, 100))
    .filter(receipt => receipt.operation === task.operation)
    .map(receipt => ({ receiptId: receipt.receiptId, at: receipt.at, ok: receipt.ok, receiptHash: receipt.receiptHash, verified: verifyReceipt(receipt), linkage: 'operation-node-candidate' as const }));
  return {
    task, events, activities, audit, receipts,
    trace: await linkedTrace(task),
    authority: await ownerControlAuthority(task.nodeId, dir)
  };
}

export async function resetTask(store: NodeTaskStore, taskId: string, control: 'reset' | 'retry' = 'reset'): Promise<ReachTaskRecord> {
  await assertNotQuarantined(store.rootDir, taskId);
  const source = await store.read(taskId);
  if (!source) throw new Error(`task not found: ${taskId}`);
  await ownerControlAuthority(source.nodeId, store.rootDir);
  if (control === 'retry' && (!source.failureClass || !retryAllowed((source.safetyClass || 'DESTRUCTIVE') as never, source.failureClass as never))) {
    throw new Error(`retry refused: failure ${source.failureClass || 'UNKNOWN'} is not retry-safe for ${source.safetyClass || 'UNKNOWN'}`);
  }
  if (!TERMINAL_TASK_STATES.includes(source.state)) throw new Error(`task ${taskId} is ${source.state}; RESET requires a terminal task and preserves the active run`);
  const archived = await store.archive(taskId);
  const child = await store.create({
    actorId: source.actorId, nodeId: source.nodeId, operation: source.operation,
    idempotencyKey: `${control}_${source.taskId.slice(-20)}_${crypto.randomBytes(6).toString('hex')}`,
    payloadSha256: source.payloadSha256, ...(source.policyHash ? { policyHash: source.policyHash } : {}),
    ...(source.traceId ? { traceId: source.traceId } : {}), parentTaskId: archived.taskId, rootTaskId: source.rootTaskId,
    taskDepth: source.taskDepth + 1, attemptBudget: source.attemptBudget,
    ...(source.safetyClass ? { safetyClass: source.safetyClass } : {}),
    ...(source.mutationLevel ? { mutationLevel: source.mutationLevel } : {}),
    ...(source.repoContext ? { repoContext: source.repoContext } : {})
  });
  await new TaskEventLog(store.rootDir).append({ taskId: child.taskId, kind: 'control', state: child.state, control, evidenceRef: source.taskId, summary: `Created from preserved ${control} source ${source.taskId}.`, ...(child.traceId ? { traceId: child.traceId } : {}) });
  return child;
}

export async function cancelTask(store: NodeTaskStore, taskId: string): Promise<ReachTaskRecord> {
  await assertNotQuarantined(store.rootDir, taskId);
  const task = await store.read(taskId);
  if (!task) throw new Error(`task not found: ${taskId}`);
  await ownerControlAuthority(task.nodeId, store.rootDir);
  if (TERMINAL_TASK_STATES.includes(task.state)) return task;
  return store.transition(taskId, 'CANCELLED', 'Task cancellation requested by the owner CLI after current policy re-check.');
}

export async function reconcileTask(store: NodeTaskStore, taskId: string, evidenceRef: string): Promise<ReachTaskRecord> {
  await assertNotQuarantined(store.rootDir, taskId);
  if (!CONTROL_REF.test(evidenceRef)) throw new Error('evidence reference must be a bounded identifier; payload text is not accepted');
  const task = await store.read(taskId);
  if (!task) throw new Error(`task not found: ${taskId}`);
  await ownerControlAuthority(task.nodeId, store.rootDir);
  if (task.state !== 'AMBIGUOUS') throw new Error(`reconcile requires AMBIGUOUS task state, got ${task.state}`);
  const updated = await store.transition(taskId, 'RECONCILED', `Owner reconciled the task using evidence reference ${evidenceRef}.`);
  await new TaskEventLog(store.rootDir).append({ taskId, kind: 'control', state: updated.state, control: 'reconcile', evidenceRef, summary: updated.summary.status, ...(updated.traceId ? { traceId: updated.traceId } : {}) });
  return updated;
}

export async function requestPause(store: NodeTaskStore, taskId: string, phase: string): Promise<ReachTaskRecord> {
  await assertNotQuarantined(store.rootDir, taskId);
  if (!CONTROL_REF.test(phase)) throw new Error('pause phase must be a bounded identifier');
  const task = await store.read(taskId);
  if (!task) throw new Error(`task not found: ${taskId}`);
  await ownerControlAuthority(task.nodeId, store.rootDir);
  const updated = await store.update(taskId, { status: `Pause requested after phase ${phase}; worker acknowledgement remains observable in the task log.` });
  await new TaskEventLog(store.rootDir).append({ taskId, kind: 'control', state: updated.state, control: `pause-after-phase:${phase}`, summary: updated.summary.status, ...(updated.traceId ? { traceId: updated.traceId } : {}) });
  return updated;
}

export async function resumeTask(store: NodeTaskStore, taskId: string): Promise<ReachTaskRecord> {
  await assertNotQuarantined(store.rootDir, taskId);
  const task = await store.read(taskId);
  if (!task) throw new Error(`task not found: ${taskId}`);
  await ownerControlAuthority(task.nodeId, store.rootDir);
  const updated = await store.update(taskId, { status: 'Resume requested by the owner CLI after current policy re-check.' });
  await new TaskEventLog(store.rootDir).append({ taskId, kind: 'control', state: updated.state, control: 'resume', summary: updated.summary.status, ...(updated.traceId ? { traceId: updated.traceId } : {}) });
  return updated;
}

export async function continuationExport(task: ReachTaskRecord, dir = stateDir()): Promise<Record<string, unknown>> {
  const log = await buildTaskLog(task, dir);
  let result: { available: boolean; handle?: string; hash?: string } = { available: false };
  if (task.resultRef) {
    try {
      const metadata = await new ResultStore(64 * 1024, 30 * 60 * 1000, dir).metadata(task.resultRef);
      result = { available: true, handle: metadata.handle, hash: metadata.resultHash };
    } catch { result = { available: false, handle: task.resultRef, hash: task.resultHash }; }
  }
  return {
    schema: 'dex-reach.continuation.v1',
    exportedAtUtc: new Date().toISOString(),
    task: {
      taskId: task.taskId, rootTaskId: task.rootTaskId, parentTaskId: task.parentTaskId, taskDepth: task.taskDepth,
      actorId: task.actorId, nodeId: task.nodeId, operation: task.operation, state: task.state,
      attemptNumber: task.attemptNumber, attemptBudget: task.attemptBudget, createdAtUtc: task.createdAtUtc,
      updatedAtUtc: task.updatedAtUtc, payloadSha256: task.payloadSha256, policyHash: task.policyHash,
      resultRef: task.resultRef, resultHash: task.resultHash, failureClass: task.failureClass, traceId: task.traceId,
      summary: task.summary, repoContext: task.repoContext
    },
    needsAndrew: needsAndrew(task),
    eventHistory: log.events,
    phaseEvidence: log.activities,
    resultReference: result,
    links: {
      trace: log.trace.status,
      receipts: log.receipts.length ? 'operation-node-candidates' : 'UNKNOWN',
      git: 'UNKNOWN', ci: 'UNKNOWN', deploy: 'UNKNOWN', install: 'UNKNOWN'
    },
    unknowns: [
      ...(log.trace.status === 'unknown' ? ['No task trace id was recorded; DEX//TRACE linkage is UNKNOWN.'] : []),
      ...(log.trace.status === 'missing' ? ['The recorded task trace id has no persisted spans.'] : []),
      'Git, hosted CI, deployment, and installation links are not inferred from local task state.'
    ]
  };
}
