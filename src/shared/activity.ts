import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { machineStateDir } from './local-env.js';
import { atomicWriteFile, withFileLock } from './state-io.js';
import { collectExcludedPids, dexServiceLabel, isDexServiceCommand, looksHeavy, parseProcessTable, type ProcessRow } from './machine-capacity.js';
import { assertIdentityBindingUnchanged, captureProcessIdentity, parseProcessIdentity, verifyProcessIdentity, type ProcessIdentity } from './process-identity.js';

const execFileAsync = promisify(execFile);
const MAX_ACTIVITY_RECORDS = 200;

/**
 * `starting` is the pre-execution barrier: a durable intent row written before the child is spawned, with no pid yet.
 * It means a process MAY have started. Readers never treat it as ended, and it never proves the process is gone.
 */
export const PROCESS_ACTIVITY_STATES = ['starting', 'running', 'completed', 'failed', 'timed-out', 'terminated', 'exited'] as const;
export type ProcessActivityState = (typeof PROCESS_ACTIVITY_STATES)[number];
export type ProcessActivityKind = 'native-process' | 'compat-process';

export type ProcessExecutionContext = {
  taskId?: string;
  attempt?: number;
  phase?: string;
};

const TASK_ID_PATTERN = /^rtsk_[0-9a-f]{11,13}_[0-9a-f]{16,32}$/;

export function validateProcessExecutionContext(value: unknown): ProcessExecutionContext {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('execution context must be an object');
  const source = value as Record<string, unknown>;
  if (source.taskId !== undefined && (typeof source.taskId !== 'string' || !TASK_ID_PATTERN.test(source.taskId))) throw new Error('execution context taskId is invalid');
  if (source.attempt !== undefined && (!Number.isInteger(source.attempt) || Number(source.attempt) < 1 || Number(source.attempt) > 100)) throw new Error('execution context attempt is invalid');
  if (source.phase !== undefined && (typeof source.phase !== 'string' || source.phase.length === 0 || source.phase.length > 64 || !/^[A-Za-z0-9._:-]+$/.test(source.phase))) throw new Error('execution context phase is invalid');
  return {
    ...(source.taskId ? { taskId: source.taskId } : {}),
    ...(source.attempt !== undefined ? { attempt: Number(source.attempt) } : {}),
    ...(source.phase ? { phase: source.phase } : {})
  };
}

export type ProcessActivity = {
  id: string;
  kind: ProcessActivityKind;
  state: ProcessActivityState;
  pid: number;
  operation: string;
  processLabel: string;
  taskId?: string;
  attempt?: number;
  phase?: string;
  cwd?: string;
  externalId?: string;
  startedAt: string;
  updatedAt: string;
  lastStdoutAt?: string;
  lastResourceAt?: string;
  finishedAt?: string;
  /** Present only when the child ended by a signal. The exit code is then absent, never invented. */
  exitCode?: number;
  signal?: string;
  /** Platform start identity captured at spawn. Absent on legacy records, which are never strong proof of life. */
  identity?: ProcessIdentity;
};

export type ProcessObservation = {
  pid: number;
  ppid: number;
  cpu: number;
  mem: number;
  processLabel: string;
};

export function activityDir(): string { return path.join(machineStateDir(), 'activity'); }
export function activityFile(): string { return path.join(activityDir(), 'processes.json'); }
/** Additive sidecar: retained C13 readers keep their original positive-PID activity schema. */
export function processIntentFile(): string { return path.join(activityDir(), 'launch-intents.json'); }
export function activityLockFile(): string { return path.join(activityDir(), 'processes.lock'); }

function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export function safeProcessLabel(command: string): string {
  const trimmed = command.trim();
  const quoted = /^(?:"([^"]+)"|'([^']+)')/.exec(trimmed);
  const token = quoted ? (quoted[1] ?? quoted[2] ?? '') : (trimmed.match(/^([^\s]+)/)?.[1] ?? '');
  const base = path.basename(token);
  return /^[A-Za-z0-9._+:-]{1,48}$/.test(base) ? base : 'process';
}

function validRecord(raw: unknown): ProcessActivity | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Record<string, unknown>;
  if (typeof value.id !== 'string' || !value.id.startsWith('activity-')) return null;
  if (value.kind !== 'native-process' && value.kind !== 'compat-process') return null;
  if (!PROCESS_ACTIVITY_STATES.includes(value.state as ProcessActivityState)) return null;
  // An intent row has no pid (0) and no identity; every other row names its process.
  if (typeof value.pid !== 'number' || !Number.isInteger(value.pid) || (value.state === 'starting' ? value.pid !== 0 || value.identity !== undefined : value.pid <= 0)) return null;
  if (typeof value.operation !== 'string' || typeof value.processLabel !== 'string') return null;
  if (typeof value.startedAt !== 'string' || typeof value.updatedAt !== 'string') return null;
  if (value.taskId !== undefined && (typeof value.taskId !== 'string' || !/^rtsk_[0-9a-f]{11,13}_[0-9a-f]{16,32}$/.test(value.taskId))) return null;
  if (value.attempt !== undefined && (!Number.isInteger(value.attempt) || Number(value.attempt) < 1 || Number(value.attempt) > 100)) return null;
  if (value.phase !== undefined && (typeof value.phase !== 'string' || value.phase.length > 64)) return null;
  if (value.exitCode !== undefined && (typeof value.exitCode !== 'number' || !Number.isInteger(value.exitCode))) return null;
  if (value.signal !== undefined && (typeof value.signal !== 'string' || !/^SIG[A-Z0-9]{1,16}$/.test(value.signal))) return null;
  // An identity of an unknown version or shape is refused, never ignored or silently upgraded.
  const identity = parseProcessIdentity(value.identity);
  if (identity === null) return null;
  if (identity && identity.pid !== value.pid) return null;
  for (const [timestamp, label] of [[value.lastStdoutAt, 'lastStdoutAt'], [value.lastResourceAt, 'lastResourceAt']] as const) {
    if (timestamp !== undefined && (typeof timestamp !== 'string' || !Number.isFinite(Date.parse(timestamp)))) return null;
  }
  return value as ProcessActivity;
}

async function readRecordsUnlocked(): Promise<ProcessActivity[]> {
  async function read(file: string): Promise<unknown | undefined> {
    try { return JSON.parse(await fs.readFile(file, 'utf8')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
  }
  const parsed = await read(activityFile());
  if (parsed !== undefined && !Array.isArray(parsed)) throw new Error('activity store must contain an array');
  const legacy = (parsed ?? []) as unknown[];
  const sidecar = await read(processIntentFile()) as { version?: number; records?: unknown[] } | undefined;
  if (sidecar !== undefined && (!sidecar || sidecar.version !== 1 || !Array.isArray(sidecar.records))) throw new Error('process intent store is malformed');
  const records = legacy.map(validRecord);
  const intents = (sidecar?.records ?? []).map(validRecord);
  if (records.some(r => !r || r.state === 'starting') || intents.some(r => !r || r.state !== 'starting')) throw new Error('activity store contains a malformed record');
  const combined = records as ProcessActivity[];
  for (const intent of intents as ProcessActivity[]) {
    const bound = combined.find(r => r.id === intent.id);
    if (bound) {
      if (bound.taskId !== intent.taskId || bound.attempt !== intent.attempt || bound.startedAt !== intent.startedAt) throw new Error('process intent binding mismatch');
      // A crash after committing the bound row but before removing its intent is safe: prefer the bound row.
    } else combined.push(intent);
  }
  if (new Set(combined.map(r => r.id)).size !== combined.length) throw new Error('duplicate activity identity');
  return combined;
}

async function writeRecordsUnlocked(records: ProcessActivity[]): Promise<void> {
  const active = records.filter(record => record.state === 'starting' || record.state === 'running');
  if (active.length > MAX_ACTIVITY_RECORDS) throw new Error('PROCESS_ACTIVITY_CAPACITY');
  const finished = records.filter(record => record.state !== 'starting' && record.state !== 'running')
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  const bounded = [...finished.slice(-(MAX_ACTIVITY_RECORDS - active.length) || finished.length), ...active];
  await atomicWriteFile(activityFile(), JSON.stringify(bounded.filter(r => r.state !== 'starting'), null, 2) + '\n');
  await atomicWriteFile(processIntentFile(), JSON.stringify({ version: 1, records: bounded.filter(r => r.state === 'starting') }) + '\n');
}

/** The bindings a record may never change after creation: process identity, PID, task and attempt. */
function bindingSnapshot(records: readonly ProcessActivity[]): Map<string, ProcessActivity> {
  return new Map(records.map(record => [record.id, { ...record }]));
}

function assertBindingsUnchanged(before: Map<string, ProcessActivity>, after: readonly ProcessActivity[]): void {
  for (const record of after) {
    const prior = before.get(record.id);
    if (!prior) continue;
    // The only permitted pid change is the single bind of a pre-execution intent row to its spawned process.
    const bind = prior.state === 'starting' && prior.pid === 0 && record.state === 'running' && record.pid > 0;
    if ((!bind && prior.pid !== record.pid) || prior.taskId !== record.taskId || prior.attempt !== record.attempt) throw new Error('process activity binding is immutable');
    if (record.state === 'starting' && prior.state !== 'starting') throw new Error('process activity cannot return to starting');
    assertIdentityBindingUnchanged(prior.identity, record.identity);
  }
}

async function mutateRecords<T>(fn: (records: ProcessActivity[]) => Promise<T> | T): Promise<T> {
  return withFileLock(activityLockFile(), async () => {
    const records = await readRecordsUnlocked();
    const before = bindingSnapshot(records);
    const result = await fn(records);
    assertBindingsUnchanged(before, records);
    await writeRecordsUnlocked(records);
    return result;
  });
}

/**
 * Pre-execution barrier. Writes a durable `starting` row for this task BEFORE the child is spawned. If this write
 * fails for any reason, the caller must not spawn: no untracked process can then exist.
 */
export async function recordProcessIntent(input: {
  kind: ProcessActivityKind;
  operation: string;
  command: string;
  taskId?: string;
  attempt?: number;
  phase?: string;
  cwd?: string;
}): Promise<ProcessActivity> {
  const context = validateProcessExecutionContext({ taskId: input.taskId, attempt: input.attempt, phase: input.phase });
  const now = new Date().toISOString();
  const record: ProcessActivity = {
    id: `activity-${crypto.randomUUID()}`, kind: input.kind, state: 'starting', pid: 0, operation: input.operation,
    processLabel: safeProcessLabel(input.command),
    ...(context.taskId ? { taskId: context.taskId } : {}),
    ...(context.attempt !== undefined ? { attempt: context.attempt } : {}),
    ...(context.phase ? { phase: context.phase } : {}),
    ...(input.cwd ? { cwd: input.cwd } : {}),
    startedAt: now, updatedAt: now
  };
  await mutateRecords(records => { records.push(record); });
  return record;
}

/** Binds the spawned pid and its platform identity to an intent row, making it `running`. Only a `starting` row binds. */
export async function bindProcessIntent(id: string, pid: number): Promise<ProcessActivity> {
  if (!Number.isInteger(pid) || pid <= 0) throw new Error('process intent requires a real pid');
  const identity = await captureProcessIdentity(pid);
  if (!identity) throw new Error('PROCESS_INTENT_IDENTITY_UNVERIFIABLE');
  return mutateRecords(records => {
    const record = records.find(entry => entry.id === id);
    if (!record || record.state !== 'starting') throw new Error('PROCESS_INTENT_NOT_BINDABLE');
    Object.assign(record, { state: 'running' as const, pid, updatedAt: new Date().toISOString(), ...(identity ? { identity } : {}) });
    return { ...record };
  });
}

export async function startProcessActivity(input: {
  kind: ProcessActivityKind;
  pid: number;
  operation: string;
  command: string;
  taskId?: string;
  attempt?: number;
  phase?: string;
  cwd?: string;
  externalId?: string;
}): Promise<ProcessActivity> {
  const context = validateProcessExecutionContext({ taskId: input.taskId, attempt: input.attempt, phase: input.phase });
  const now = new Date().toISOString();
  // Captured immediately after spawn. When the platform cannot prove identity, the record stays legacy-weak.
  const identity = await captureProcessIdentity(input.pid).catch(() => null);
  const record: ProcessActivity = {
    id: `activity-${crypto.randomUUID()}`,
    kind: input.kind,
    state: 'running',
    pid: input.pid,
    operation: input.operation,
    processLabel: safeProcessLabel(input.command),
    ...(context.taskId ? { taskId: context.taskId } : {}),
    ...(context.attempt !== undefined ? { attempt: context.attempt } : {}),
    ...(context.phase ? { phase: context.phase } : {}),
    ...(input.cwd ? { cwd: input.cwd } : {}),
    ...(input.externalId ? { externalId: input.externalId } : {}),
    startedAt: now,
    updatedAt: now,
    ...(identity ? { identity } : {})
  };
  await mutateRecords(records => { records.push(record); });
  return record;
}

export async function updateProcessActivity(
  id: string,
  patch: Partial<Pick<ProcessActivity, 'state' | 'updatedAt' | 'finishedAt' | 'exitCode' | 'signal' | 'externalId' | 'lastStdoutAt' | 'lastResourceAt'>>
): Promise<boolean> {
  return mutateRecords(records => {
    const record = records.find(entry => entry.id === id);
    if (!record) return false;
    Object.assign(record, patch, { updatedAt: patch.updatedAt ?? new Date().toISOString() });
    return true;
  });
}

export async function updateProcessActivityByPid(
  pid: number,
  patch: Partial<Pick<ProcessActivity, 'state' | 'updatedAt' | 'finishedAt' | 'exitCode' | 'lastStdoutAt' | 'lastResourceAt'>>
): Promise<boolean> {
  return mutateRecords(records => {
    const record = [...records].reverse().find(entry => entry.pid === pid && entry.state === 'running');
    if (!record) return false;
    Object.assign(record, patch, { updatedAt: patch.updatedAt ?? new Date().toISOString() });
    return true;
  });
}

export async function finishProcessActivity(
  id: string,
  state: Exclude<ProcessActivityState, 'running' | 'starting'>,
  exitCode?: number,
  signal?: string
): Promise<boolean> {
  const now = new Date().toISOString();
  return updateProcessActivity(id, {
    state,
    finishedAt: now,
    updatedAt: now,
    ...(exitCode !== undefined ? { exitCode } : {}),
    ...(signal !== undefined ? { signal } : {})
  });
}

export async function finishProcessActivityByPid(
  pid: number,
  state: Exclude<ProcessActivityState, 'running' | 'starting'>,
  exitCode?: number
): Promise<boolean> {
  const now = new Date().toISOString();
  return updateProcessActivityByPid(pid, { state, finishedAt: now, updatedAt: now, ...(exitCode !== undefined ? { exitCode } : {}) });
}

export async function touchProcessActivityByPid(pid: number, signal: 'stdout' | 'resource' | 'activity' = 'activity'): Promise<boolean> {
  const now = new Date().toISOString();
  return updateProcessActivityByPid(pid, {
    updatedAt: now,
    ...(signal === 'stdout' ? { lastStdoutAt: now } : {}),
    ...(signal === 'resource' ? { lastResourceAt: now } : {})
  });
}

async function reconcileRunning(records: ProcessActivity[]): Promise<boolean> {
  let changed = false;
  const now = new Date().toISOString();
  for (const record of records) {
    if (record.state !== 'running') continue;
    // Identity, not a bare PID: a live SAME or unverifiable record is kept running; GONE or REUSED has ended.
    const verdict = await verifyProcessIdentity(record.identity, record.pid);
    if (verdict === 'SAME' || verdict === 'UNVERIFIABLE') continue;
    record.state = 'exited';
    record.finishedAt = now;
    record.updatedAt = now;
    changed = true;
  }
  return changed;
}

export async function listProcessActivities(options: {
  includeFinished?: boolean;
  limit?: number;
  /** Lock wait bound. Boot recovery is not latency-sensitive and must not die on brief I/O contention. */
  timeoutMs?: number;
} = {}): Promise<ProcessActivity[]> {
  const records = await withFileLock(activityLockFile(), async () => {
    const current = await readRecordsUnlocked();
    if (await reconcileRunning(current)) await writeRecordsUnlocked(current);
    return current;
  }, { timeoutMs: options.timeoutMs ?? 5000 });
  const includeFinished = options.includeFinished ?? false;
  const limit = Math.max(1, Math.min(options.limit ?? 50, MAX_ACTIVITY_RECORDS));
  return records
    .filter(record => includeFinished || record.state === 'running' || record.state === 'starting')
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
    .slice(0, limit);
}

/** Bounded owner read with no stale-process reconciliation or state write. */
export async function readProcessActivities(options: {
  includeFinished?: boolean;
  limit?: number;
} = {}): Promise<ProcessActivity[]> {
  const records = await withFileLock(activityLockFile(), readRecordsUnlocked);
  const includeFinished = options.includeFinished ?? false;
  const limit = Math.max(1, Math.min(options.limit ?? 50, MAX_ACTIVITY_RECORDS));
  return records
    .filter(record => includeFinished || record.state === 'running' || record.state === 'starting')
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
    .slice(0, limit);
}

function observation(row: ProcessRow): ProcessObservation {
  return { pid: row.pid, ppid: row.ppid, cpu: row.cpu, mem: row.mem, processLabel: safeProcessLabel(row.command) };
}

export async function observeActivityProcesses(trackedPids: readonly number[] = []): Promise<{
  dexServices: ProcessObservation[];
  uncoordinatedHeavy: ProcessObservation[];
}> {
  const args = process.platform === 'darwin'
    ? ['-axo', 'pid,ppid,%cpu,%mem,etime,command']
    : ['-eo', 'pid,ppid,%cpu,%mem,etime,args'];
  try {
    const { stdout } = await execFileAsync('ps', args, { timeout: 3000, maxBuffer: 2 * 1024 * 1024 });
    const rows = parseProcessTable(stdout);
    const excluded = collectExcludedPids(rows, { leasedPids: trackedPids });
    return {
      dexServices: rows.filter(row => isDexServiceCommand(row.command)).map(row => ({
        ...observation(row),
        processLabel: dexServiceLabel(row.command)
      })),
      uncoordinatedHeavy: rows.filter(row => !excluded.has(row.pid) && !isDexServiceCommand(row.command) && looksHeavy(row)).map(observation)
    };
  } catch {
    return { dexServices: [], uncoordinatedHeavy: [] };
  }
}

export function shareSafeActivity(records: readonly ProcessActivity[]): Array<Record<string, unknown>> {
  return records.map(record => ({
    id: record.id,
    kind: record.kind,
    state: record.state,
    operation: record.operation,
    processLabel: record.processLabel,
    startedAt: record.startedAt,
    updatedAt: record.updatedAt,
    ...(record.taskId ? { taskId: record.taskId } : {}),
    ...(record.attempt !== undefined ? { attempt: record.attempt } : {}),
    ...(record.phase ? { phase: record.phase } : {}),
    ...(record.lastStdoutAt ? { lastStdoutAt: record.lastStdoutAt } : {}),
    ...(record.lastResourceAt ? { lastResourceAt: record.lastResourceAt } : {}),
    ...(record.finishedAt ? { finishedAt: record.finishedAt } : {}),
    ...(record.exitCode !== undefined ? { exitCode: record.exitCode } : {}),
    ...(record.signal !== undefined ? { signal: record.signal } : {})
  }));
}
