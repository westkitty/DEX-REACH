import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { NodeTaskStore, TERMINAL_TASK_STATES, type ReachTaskRecord } from '../../src/node/task-store.js';
import { ResultStore } from '../../src/node/result-store.js';
import { verifyReceipt } from '../../src/shared/receipts.js';

export type Classification = 'ACTIVE_CONFIRMED' | 'ACTIVE_UNVERIFIED' | 'RECOVERABLE_WITH_EVIDENCE' | 'AMBIGUOUS_EFFECT' | 'STRANDED_OR_STALE' | 'REQUIRES_OWNER_DECISION' | 'INSUFFICIENT_EVIDENCE';
export type Evidence = { result: 'verified' | 'missing' | 'invalid-or-expired'; activity: boolean; lease: boolean; ticket: boolean; process: 'matching' | 'absent' | 'unknown'; sharedProcess: boolean; stale: boolean; complete: boolean; eventState?: string };
export function classifyTask(task: Pick<ReachTaskRecord, 'state' | 'safetyClass' | 'failureClass'>, e: Evidence): Classification {
  if (task.state === 'AMBIGUOUS' || task.failureClass === 'AMBIGUOUS_EFFECT') return 'AMBIGUOUS_EFFECT';
  if (task.state === 'INPUT_REQUIRED') return 'REQUIRES_OWNER_DECISION';
  if (!e.complete || (e.eventState !== undefined && e.eventState !== task.state)) return 'INSUFFICIENT_EVIDENCE';
  if (e.result === 'verified') return 'RECOVERABLE_WITH_EVIDENCE';
  if (e.activity && e.lease && e.process === 'matching' && !e.sharedProcess && !e.stale) return 'ACTIVE_CONFIRMED';
  if (e.activity || e.lease || e.ticket || e.process === 'matching') return 'ACTIVE_UNVERIFIED';
  if (e.result === 'invalid-or-expired') return 'REQUIRES_OWNER_DECISION';
  if (task.state === 'RUNNING' && task.safetyClass !== 'PURE_READ_IDEMPOTENT') return 'AMBIGUOUS_EFFECT';
  if (e.stale && e.process !== 'unknown') return 'STRANDED_OR_STALE';
  return 'INSUFFICIENT_EVIDENCE';
}

/** Observed execution signals only; absence is reported as absence, never as proof that execution stopped. */
function executionEvidence(e: Evidence): string[] {
  const signals = [e.activity && 'ACTIVITY_RECORD', e.lease && 'COORDINATOR_LEASE', e.ticket && 'COORDINATOR_TICKET', e.process === 'matching' && 'MATCHING_PROCESS', e.process === 'absent' && 'RECORDED_PROCESS_ABSENT', e.sharedProcess && 'SHARED_PROCESS'].filter((s): s is string => !!s);
  return signals.length ? signals : ['NONE_OBSERVED_NOT_TERMINATION_PROOF'];
}
/** What remains unknown. Receipts are never task-bound and external effects are never proven by this reader. */
function unresolvedUncertainty(task: Pick<ReachTaskRecord, 'state' | 'failureClass' | 'idempotencyKey'>, e: Evidence): string[] {
  return [e.result !== 'verified' && 'TASK_BOUND_RESULT', 'RECEIPT_TASK_BINDING', 'EXTERNAL_EFFECT', e.process !== 'matching' && 'PROCESS_LIVENESS', task.failureClass === 'AMBIGUOUS_EFFECT' && 'PERSISTED_AMBIGUOUS_EFFECT', !task.idempotencyKey && 'IDEMPOTENCY_BINDING', !e.complete && 'EVIDENCE_INCOMPLETE'].filter((s): s is string => !!s);
}
export function describeTaskEvidence(task: Pick<ReachTaskRecord, 'state' | 'failureClass' | 'idempotencyKey'>, e: Evidence, receiptCandidates: Array<{ nodeId: string; resultHash: string; ok: boolean }>) {
  const conflict = new Set(receiptCandidates.map(r => `${r.ok}:${r.resultHash}`)).size > 1;
  return { OBSERVED_TASK_STATE: task.state, OBSERVED_PROCESS_STATE: e.process.toUpperCase(), EXECUTION_EVIDENCE: executionEvidence(e), RESULT_PROOF: e.result.toUpperCase(), RECEIPT_PROOF: conflict ? 'UNBOUND_CONFLICTING_CANDIDATES' : receiptCandidates.length ? 'UNBOUND_OPERATION_NODE_CANDIDATES' : 'MISSING', EXTERNAL_EFFECT_PROOF: 'UNPROVEN', SAFE_RECOVERY_ELIGIBILITY: e.result === 'verified' && task.failureClass !== 'AMBIGUOUS_EFFECT' && task.state !== 'AMBIGUOUS' ? 'TASK_BOUND_RESULT_OWNER_REVIEW_NO_REPLAY' : 'UNPROVEN_NO_REPLAY', OWNER_DECISION_REQUIRED: true, IDEMPOTENCY_BINDING: task.idempotencyKey ? 'PRESENT_PRIVATE' : 'MISSING', UNRESOLVED_UNCERTAINTY: unresolvedUncertainty(task, e), replayAuthorized: false };
}

/** Reject symlink ancestors before reading owner metadata. No initialization, locks or recovery calls. */
export async function realDirectory(root: string): Promise<string> {
  const resolved = path.resolve(root);
  for (let cursor = resolved; ; cursor = path.dirname(cursor)) {
    if ((await fs.lstat(cursor)).isSymbolicLink()) throw new Error('SYMLINK_ROOT_REFUSED');
    if (path.dirname(cursor) === cursor) break;
  }
  if (!(await fs.lstat(resolved)).isDirectory()) throw new Error('STATE_ROOT_NOT_DIRECTORY');
  return resolved;
}
/**
 * Synchronous twin of safeRead for long copy loops. A promise-based read whose completion is lost
 * stalls a capture while it holds every writer lock; a blocking call cannot silently vanish.
 */
export function safeReadSync(root: string, relative: string, maxBytes = 64 * 1024 * 1024): Buffer {
  if (!relative || path.isAbsolute(relative) || relative.split(/[\\/]/).some(v => !v || v === '.' || v === '..')) throw new Error('UNSAFE_RELATIVE_PATH');
  const base = path.resolve(root);
  if (fsSync.realpathSync(base) !== base || !fsSync.lstatSync(base).isDirectory()) throw new Error('SYMLINK_ROOT_REFUSED');
  const file = path.join(base, relative);
  for (let cursor = file; cursor !== base; cursor = path.dirname(cursor)) if (fsSync.lstatSync(cursor).isSymbolicLink()) throw new Error('SYMLINK_ENTRY_REFUSED');
  const st = fsSync.lstatSync(file);
  if (!st.isFile() || st.size > maxBytes) throw new Error('UNSUPPORTED_OR_OVERSIZED_FILE');
  const fd = fsSync.openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = fsSync.fstatSync(fd);
    if (!opened.isFile() || opened.ino !== st.ino || opened.dev !== st.dev || opened.size > maxBytes) throw new Error('FILE_CHANGED_BEFORE_READ');
    const bytes = fsSync.readFileSync(fd), after = fsSync.fstatSync(fd);
    if (bytes.length > maxBytes || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs) throw new Error('FILE_CHANGED_DURING_READ');
    return bytes;
  } finally { fsSync.closeSync(fd); }
}
export async function safeRead(root: string, relative: string, maxBytes = 64 * 1024 * 1024): Promise<Buffer> {
  if (!relative || path.isAbsolute(relative) || relative.split(/[\\/]/).some(v => !v || v === '.' || v === '..')) throw new Error('UNSAFE_RELATIVE_PATH');
  const base = await realDirectory(root), file = path.join(base, relative);
  for (let cursor = file; cursor !== base; cursor = path.dirname(cursor)) {
    if ((await fs.lstat(cursor)).isSymbolicLink()) throw new Error('SYMLINK_ENTRY_REFUSED');
  }
  const st = await fs.lstat(file);
  if (!st.isFile() || st.size > maxBytes) throw new Error('UNSUPPORTED_OR_OVERSIZED_FILE');
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.ino !== st.ino || opened.dev !== st.dev || opened.size > maxBytes) throw new Error('FILE_CHANGED_BEFORE_READ');
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (bytes.length > maxBytes || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs) throw new Error('FILE_CHANGED_DURING_READ');
    return bytes;
  } finally { await handle.close(); }
}
type Row = Record<string, any>;
export type TaskInspection = { taskId: string; rootTaskId: string; parentTaskId: string | null; nodeId: string; actorId: string; state: string; updatedAt: string; classification: Classification; evidence: Evidence; receiptCandidates: number; sections: ReturnType<typeof describeTaskEvidence>; replayAuthorized: false };
export async function inspectTasks(input: { root: string; expectedRoot: string; nodeId: string; now?: number; processMatches?: (pid: number, startedAt: string) => Promise<'matching' | 'absent' | 'unknown'> }): Promise<TaskInspection[]> {
  const root = await realDirectory(input.root);
  if (root !== path.resolve(input.expectedRoot) || input.nodeId !== 'macbook-air.local') throw new Error('WRONG_STATE_ROOT_OR_NODE');
  // Validate the file exists before NodeTaskStore's missing-file empty-store fallback.
  await safeRead(root, 'tasks/store.json');
  const tasks = (await new NodeTaskStore(root).list()).filter(t => !TERMINAL_TASK_STATES.includes(t.state));
  if (tasks.some(t => t.nodeId !== input.nodeId)) throw new Error('WRONG_TASK_NODE');
  let complete = true;
  async function read(relative: string): Promise<any> {
    try { return JSON.parse((await safeRead(root, relative)).toString()); } catch { complete = false; return null; }
  }
  const activityDoc = await read('activity/processes.json');
  const activities: Row[] = Array.isArray(activityDoc) ? activityDoc : [];
  if (!Array.isArray(activityDoc)) complete = false;
  async function claims(name: string): Promise<Row[]> {
    try {
      await realDirectory(path.join(root, 'coordinator', name));
      return await Promise.all((await fs.readdir(path.join(root, 'coordinator', name))).map(async f => await read(`coordinator/${name}/${f}`))).then(xs => xs.filter(Boolean));
    } catch { complete = false; return []; }
  }
  const leases = await claims('leases'), tickets = await claims('queue');
  let events: Row[] = [], receipts: Row[] = [];
  try { events = (await safeRead(root, 'tasks/events.jsonl')).toString().split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch { complete = false; }
  try { receipts = (await safeRead(root, `receipts/${input.nodeId}.jsonl`)).toString().split('\n').filter(Boolean).slice(-100).map(l => JSON.parse(l)); } catch { complete = false; }
  const verifiedReceipts = receipts.filter(r => verifyReceipt(r as any));
  const results = new ResultStore(64 * 1024, 30 * 60 * 1000, root), now = input.now ?? Date.now();
  const reports: TaskInspection[] = [];
  for (const task of tasks) {
    const matches = (row: Row) => row.taskId === task.taskId && row.attempt === task.attemptNumber;
    const activity = activities.filter(matches).find(a => a.state === 'running');
    const freshClaim = (row: Row) => { const age = now - Date.parse(row.heartbeatAt); return Number.isFinite(age) && age >= 0 && age < 150_000; };
    const lease = leases.filter(matches).find(freshClaim);
    const ticket = tickets.filter(matches).find(freshClaim);
    const process = activity && input.processMatches ? await input.processMatches(activity.pid, activity.startedAt) : 'unknown';
    let result: Evidence['result'] = task.resultRef || task.resultHash ? 'invalid-or-expired' : 'missing';
    if (task.resultRef && task.resultHash) {
      try { await safeRead(root, 'results/manifest.json'); await safeRead(root, `results/${task.resultRef}.json`); await results.readValueForTask(task.resultRef, task.taskId, task.resultHash); result = 'verified'; } catch { /* Absence/corruption is never negative execution proof. */ }
    }
    const last = events.filter(e => e.taskId === task.taskId).at(-1);
    const e: Evidence = { result, activity: !!activity, lease: !!lease, ticket: !!ticket, process, sharedProcess: !!activity && activities.filter(a => a.state === 'running' && a.pid === activity.pid && a.taskId !== task.taskId).length > 0, stale: !Number.isFinite(Date.parse(task.updatedAtUtc)) || now - Date.parse(task.updatedAtUtc) > 180_000, complete: complete && !!last, eventState: last?.state ?? last?.toState };
    reports.push({ taskId: task.taskId, rootTaskId: task.rootTaskId, parentTaskId: task.parentTaskId, nodeId: task.nodeId, actorId: task.actorId, state: task.state, updatedAt: task.updatedAtUtc, classification: classifyTask(task, e), evidence: e, receiptCandidates: verifiedReceipts.filter(r => r.nodeId === task.nodeId && r.operation === task.operation).length, sections: describeTaskEvidence(task, e, verifiedReceipts.filter(r => r.nodeId === task.nodeId && r.operation === task.operation) as any), replayAuthorized: false });
  }
  return reports;
}
export function publicTaskReport(rows: TaskInspection[]) {
  return { mode: 'READ_ONLY', replayAuthorized: false, total: rows.length, counts: Object.fromEntries([...new Set(rows.map(r => r.classification))].map(c => [c, rows.filter(r => r.classification === c).length])), records: rows.map((r, index) => ({ index, state: r.state, classification: r.classification, evidence: r.evidence, sections: r.sections, receiptLinkage: 'operation-node-candidate-only' })) };
}
