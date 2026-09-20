import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { machineStateDir } from './local-env.js';
import { atomicWriteFile, withFileLock } from './state-io.js';
import { collectExcludedPids, dexServiceLabel, isDexServiceCommand, looksHeavy, parseProcessTable, type ProcessRow } from './machine-capacity.js';

const execFileAsync = promisify(execFile);
const MAX_ACTIVITY_RECORDS = 200;

export const PROCESS_ACTIVITY_STATES = ['running', 'completed', 'failed', 'timed-out', 'terminated', 'exited'] as const;
export type ProcessActivityState = (typeof PROCESS_ACTIVITY_STATES)[number];
export type ProcessActivityKind = 'native-process' | 'compat-process';

export type ProcessActivity = {
  id: string;
  kind: ProcessActivityKind;
  state: ProcessActivityState;
  pid: number;
  operation: string;
  processLabel: string;
  cwd?: string;
  externalId?: string;
  startedAt: string;
  updatedAt: string;
  finishedAt?: string;
  exitCode?: number;
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
  if (typeof value.pid !== 'number' || !Number.isInteger(value.pid) || value.pid <= 0) return null;
  if (typeof value.operation !== 'string' || typeof value.processLabel !== 'string') return null;
  if (typeof value.startedAt !== 'string' || typeof value.updatedAt !== 'string') return null;
  return value as ProcessActivity;
}

async function readRecordsUnlocked(): Promise<ProcessActivity[]> {
  try {
    const parsed = JSON.parse(await fs.readFile(activityFile(), 'utf8')) as unknown;
    if (!Array.isArray(parsed)) throw new Error('activity store must contain an array');
    const records = parsed.map(validRecord);
    if (records.some(record => record === null)) throw new Error('activity store contains a malformed record');
    return records as ProcessActivity[];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

async function writeRecordsUnlocked(records: ProcessActivity[]): Promise<void> {
  const bounded = records
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt))
    .slice(-MAX_ACTIVITY_RECORDS);
  await atomicWriteFile(activityFile(), JSON.stringify(bounded, null, 2) + '\n');
}

async function mutateRecords<T>(fn: (records: ProcessActivity[]) => Promise<T> | T): Promise<T> {
  return withFileLock(activityLockFile(), async () => {
    const records = await readRecordsUnlocked();
    const result = await fn(records);
    await writeRecordsUnlocked(records);
    return result;
  });
}

export async function startProcessActivity(input: {
  kind: ProcessActivityKind;
  pid: number;
  operation: string;
  command: string;
  cwd?: string;
  externalId?: string;
}): Promise<ProcessActivity> {
  const now = new Date().toISOString();
  const record: ProcessActivity = {
    id: `activity-${crypto.randomUUID()}`,
    kind: input.kind,
    state: 'running',
    pid: input.pid,
    operation: input.operation,
    processLabel: safeProcessLabel(input.command),
    ...(input.cwd ? { cwd: input.cwd } : {}),
    ...(input.externalId ? { externalId: input.externalId } : {}),
    startedAt: now,
    updatedAt: now
  };
  await mutateRecords(records => { records.push(record); });
  return record;
}

export async function updateProcessActivity(
  id: string,
  patch: Partial<Pick<ProcessActivity, 'state' | 'updatedAt' | 'finishedAt' | 'exitCode' | 'externalId'>>
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
  patch: Partial<Pick<ProcessActivity, 'state' | 'updatedAt' | 'finishedAt' | 'exitCode'>>
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
  state: Exclude<ProcessActivityState, 'running'>,
  exitCode?: number
): Promise<boolean> {
  const now = new Date().toISOString();
  return updateProcessActivity(id, { state, finishedAt: now, updatedAt: now, ...(exitCode !== undefined ? { exitCode } : {}) });
}

export async function finishProcessActivityByPid(
  pid: number,
  state: Exclude<ProcessActivityState, 'running'>,
  exitCode?: number
): Promise<boolean> {
  const now = new Date().toISOString();
  return updateProcessActivityByPid(pid, { state, finishedAt: now, updatedAt: now, ...(exitCode !== undefined ? { exitCode } : {}) });
}

export async function touchProcessActivityByPid(pid: number): Promise<boolean> {
  return updateProcessActivityByPid(pid, { updatedAt: new Date().toISOString() });
}

async function reconcileRunning(records: ProcessActivity[]): Promise<boolean> {
  let changed = false;
  const now = new Date().toISOString();
  for (const record of records) {
    if (record.state !== 'running') continue;
    if (processAlive(record.pid)) continue;
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
} = {}): Promise<ProcessActivity[]> {
  const records = await withFileLock(activityLockFile(), async () => {
    const current = await readRecordsUnlocked();
    if (await reconcileRunning(current)) await writeRecordsUnlocked(current);
    return current;
  });
  const includeFinished = options.includeFinished ?? false;
  const limit = Math.max(1, Math.min(options.limit ?? 50, MAX_ACTIVITY_RECORDS));
  return records
    .filter(record => includeFinished || record.state === 'running')
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
    ...(record.finishedAt ? { finishedAt: record.finishedAt } : {}),
    ...(record.exitCode !== undefined ? { exitCode: record.exitCode } : {})
  }));
}
