import { hashValue } from '../../src/shared/hash.js';
import type { ReachTaskRecord } from '../../src/node/task-store.js';
import { TASK_ID_PATTERN } from '../../src/node/task-store.js';

export type Decision = 'SAFE TO RETRY' | 'SAFE TO ROLLBACK' | 'NEEDS RECONCILIATION' | 'REQUIRES OWNER INPUT' | 'RETAIN CANDIDATE' | 'ROLLED BACK';
export type Observation = {
  statusFresh: boolean; complete: boolean; helperIdle: boolean;
  snapshotValid: boolean; previousIntact: boolean; candidateIntact: boolean;
  uncertainOperation?: boolean; cleanupPending?: boolean; snapshotPresent?: boolean;
  definitionsKnown: boolean; previousRunning: boolean; candidateRunning: boolean;
};
/** A stopped helper and known transaction files are required before any recovery write. */
export function recoveryDecision(o: Observation): Decision {
  if (o.uncertainOperation) return 'NEEDS RECONCILIATION';
  if (o.cleanupPending) return 'NEEDS RECONCILIATION';
  if (!o.helperIdle || !o.definitionsKnown) return 'NEEDS RECONCILIATION';
  if (!o.previousIntact) return 'REQUIRES OWNER INPUT';
  if (o.previousRunning && !o.snapshotValid && !o.snapshotPresent) return 'SAFE TO RETRY';
  if (!o.snapshotValid) return 'REQUIRES OWNER INPUT';
  return 'SAFE TO ROLLBACK';
}
/** Historical failed attempts use the newly verified published checkout only for retry eligibility. */
export function expectedHeadForObservation(journalHead: string, mode: 'active' | 'historical-retry'): string | undefined {
  return mode === 'historical-retry' ? undefined : journalHead;
}

export function installedReady(o: Observation): boolean {
  return !o.uncertainOperation && !o.cleanupPending && o.statusFresh && o.complete && o.helperIdle && o.snapshotValid && o.previousIntact && o.candidateIntact && o.definitionsKnown && o.candidateRunning;
}
export function freshTask(tasks: ReachTaskRecord[], since: string, nodeId: string): ReachTaskRecord {
  const matches = tasks.filter(t => t.nodeId === nodeId && t.operation === 'dex.fingerprint' && Date.parse(t.createdAtUtc) >= Date.parse(since));
  const pending = matches.filter(t => !['COMPLETED', 'FAILED', 'CANCELLED', 'RECONCILED'].includes(t.state));
  if (pending.length) throw new Error('REQUIRES OWNER INPUT: another fresh fingerprint task is unresolved');
  // Retain failed/cancelled historical task evidence, but never let it mask one new successful proof.
  const completed = matches.filter(t => t.state === 'COMPLETED');
  if (completed.length !== 1) throw new Error('REQUIRES OWNER INPUT: exactly one completed fresh fingerprint task required; connector readback must bind its actor');
  const task = completed[0]!;
  if (!TASK_ID_PATTERN.test(task.taskId) || task.attemptNumber !== 1 || !task.resultRef || !task.resultHash || task.mutationLevel !== 'NONE' || task.failureClass === 'AMBIGUOUS_EFFECT') throw new Error('fresh task has not completed safely with a persisted result');
  return task;
}

export function priorJournalAllowsInstall(decision: string | undefined, observation: Observation): boolean {
  if (decision !== 'ROLLED BACK') return recoveryDecision(observation) === 'SAFE TO RETRY';
  // A new transaction may begin only after a verified rollback restored the exact LKG.
  return !observation.uncertainOperation && !observation.cleanupPending && observation.helperIdle &&
    observation.definitionsKnown && observation.snapshotValid && observation.previousIntact &&
    observation.previousRunning && !observation.candidateRunning;
}
export async function acceptCandidate(checks: { runtime(): Promise<void>; task(): Promise<void>; queue(): Promise<void> }): Promise<Decision> {
  await checks.runtime();
  await checks.task();
  await checks.queue();
  await checks.runtime();
  return 'RETAIN CANDIDATE';
}
/** Cleanup errors are observable even when the assertion also fails. Never release unrelated work. */
export class QueueProofFailure extends AggregateError {
  repositoryRoot?: string;
  constructor(errors: unknown[], readonly cleanupFailed: boolean) {
    super(errors, `queue regression or cleanup failed: ${errors.map(e => e instanceof Error ? e.message : String(e)).join('; ')}`);
  }
}
export async function withQueueCleanup<T>(body: () => Promise<T>, cleanup: () => Promise<void>): Promise<T> {
  let result: T | undefined;
  const errors: unknown[] = [];
  try { result = await body(); } catch (error) { errors.push(error); }
  let cleanupFailed = false;
  try { await cleanup(); } catch (error) { cleanupFailed = true; errors.push(error); }
  if (errors.length) throw new QueueProofFailure(errors, cleanupFailed);
  return result as T;
}
export async function conditionalRecovery(o: Observation, authorized: boolean, rollback: () => Promise<void>): Promise<Decision> {
  const decision = recoveryDecision(o);
  if (decision !== 'SAFE TO ROLLBACK' || !authorized) return decision;
  await rollback(); // a rejection remains a failure, never a recovered receipt
  return 'ROLLED BACK';
}

/** Owner-supplied connector result readback is evidence input, not execution authority. */
export function validateConnectorReadback(value: any, task: ReachTaskRecord, localResult: unknown): void {
  const decoded = value?.content?.[0]?.type === 'text' ? JSON.parse(value.content[0].text) : value;
  const body = decoded?.structuredContent ?? decoded;
  if (body?.task?.taskId !== task.taskId || body.task.nodeId !== task.nodeId || body.task.actorId !== task.actorId || body.task.state !== 'COMPLETED' || body.task.resultRef !== task.resultRef || body.task.resultHash !== task.resultHash || !body.result || hashValue(body.result) !== hashValue(localResult)) throw new Error('connector same-ID readback does not match fresh node-owned task/result');
}

export function installStatusFresh(status: any, transactionId: string, runtimeRoot: string, since: string): boolean {
  return status?.transactionId === transactionId && status?.runtimeRoot === runtimeRoot && Number.isFinite(Date.parse(since)) && Date.parse(status.startedAt ?? status.scheduledAt) >= Date.parse(since);
}
export function assertTarget(target: { root: string; platform: string; arch: string; hostname: string; user: string; branch: string; head: string; remoteHead: string; expectedHead: string; dirty: boolean }): void {
  if (target.root !== '/Users/andrew/dex-reach-c13-worker-repair' || target.platform !== 'darwin' || target.arch !== 'arm64' || target.hostname !== 'MacBook-Air.local' || target.user !== 'andrew' || target.branch !== 'c13-worker-repair' || target.dirty || target.head !== target.expectedHead || target.head !== target.remoteHead) throw new Error('incorrect host/revision or dirty worktree');
}
