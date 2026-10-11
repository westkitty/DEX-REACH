import fs from 'node:fs/promises';
import path from 'node:path';
import { hashValue } from './hash.js';
import { withFileLock } from './state-io.js';

/**
 * Owner-acknowledged quarantine of historical tasks whose effect cannot be established.
 *
 * Quarantine is a disposition, not a resolution: the task record and its history stay exactly as they
 * are, the effect stays UNKNOWN, replay stays forbidden, and the task store refuses every later
 * transition or update of a quarantined task. The log is append-only and hash-chained; each entry binds
 * the task's stable identity and the state it was observed in, so a changed record no longer matches.
 */
export const QUARANTINE_VERSION = 1;
export type QuarantineAuthority = Readonly<{ kind: 'owner-authorization'; grantedAt: string; scope: string }>;
export type QuarantineEntry = Readonly<{
  version: 1; sequence: number; taskId: string; nodeId: string; identity: string; observedState: string; classification: string;
  disposition: 'QUARANTINED_OWNER_ACKNOWLEDGED'; effect: 'UNKNOWN'; replayAuthorized: false;
  authority: QuarantineAuthority; at: string; previous: string | null; digest: string;
}>;
/** The fields that define which task this is and what it was asked to do. Volatile status text is excluded. */
export type QuarantinedTaskIdentity = { taskId: string; rootTaskId: string; parentTaskId: string | null; actorId: string; nodeId: string; operation: string; idempotencyKey: string; payloadSha256: string; policyHash?: string; safetyClass?: string; mutationLevel?: string; createdAtUtc: string; attemptNumber: number; state: string };

export function quarantineFile(stateDir: string): string { return path.join(stateDir, 'recovery', 'task-quarantine.jsonl'); }
export function quarantineLockFile(stateDir: string): string { return `${quarantineFile(stateDir)}.lock`; }
export function taskIdentityDigest(task: QuarantinedTaskIdentity): string {
  return hashValue({ taskId: task.taskId, rootTaskId: task.rootTaskId, parentTaskId: task.parentTaskId ?? null, actorId: task.actorId, nodeId: task.nodeId, operation: task.operation, idempotencyKey: task.idempotencyKey, payloadSha256: task.payloadSha256, policyHash: task.policyHash ?? null, safetyClass: task.safetyClass ?? null, mutationLevel: task.mutationLevel ?? null, createdAtUtc: task.createdAtUtc, attemptNumber: task.attemptNumber, state: task.state });
}

/**
 * Full chain validation. A final line without its newline is an append still being written and is not
 * yet part of the log; anything else malformed refuses, because a damaged quarantine must never
 * silently release a task.
 */
export async function readQuarantine(stateDir: string): Promise<Map<string, QuarantineEntry>> {
  let raw: string;
  try { raw = await fs.readFile(quarantineFile(stateDir), 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new Map(); throw error; }
  const lines = raw.split('\n'); lines.pop();
  const entries = new Map<string, QuarantineEntry>();
  let previous: string | null = null;
  for (const [index, line] of lines.entries()) {
    let entry: QuarantineEntry;
    try { entry = JSON.parse(line) as QuarantineEntry; } catch { throw new Error('QUARANTINE_LOG_CORRUPT'); }
    const { digest, ...body } = entry;
    if (entry.version !== 1 || entry.sequence !== index || entry.previous !== previous || hashValue(body) !== digest || entry.effect !== 'UNKNOWN' || entry.replayAuthorized !== false
      || entry.disposition !== 'QUARANTINED_OWNER_ACKNOWLEDGED' || entry.authority?.kind !== 'owner-authorization' || entries.has(entry.taskId)) throw new Error('QUARANTINE_LOG_CORRUPT');
    entries.set(entry.taskId, entry); previous = digest;
  }
  return entries;
}
export async function isQuarantined(stateDir: string, taskId: string): Promise<boolean> {
  return (await readQuarantine(stateDir)).has(taskId);
}
/** Refuse any state change to a quarantined task. Used by the task store and by owner controls. */
export async function assertNotQuarantined(stateDir: string, taskId: string): Promise<void> {
  if (await isQuarantined(stateDir, taskId)) throw new Error(`TASK_QUARANTINED: ${taskId} is owner-quarantined; its effect is unknown and it cannot be changed, resumed or replayed`);
}

/** Append quarantine entries. Already-quarantined tasks are refused rather than re-recorded. */
export async function appendQuarantine(stateDir: string, tasks: Array<{ task: QuarantinedTaskIdentity; classification: string }>, authority: QuarantineAuthority, at = new Date().toISOString()): Promise<QuarantineEntry[]> {
  if (!authority.scope.trim() || !Number.isFinite(Date.parse(authority.grantedAt))) throw new Error('QUARANTINE_AUTHORITY_INVALID');
  const file = quarantineFile(stateDir);
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  return withFileLock(quarantineLockFile(stateDir), async () => {
    const existing = await readQuarantine(stateDir);
    let previous = [...existing.values()].at(-1)?.digest ?? null, sequence = existing.size;
    const written: QuarantineEntry[] = [];
    let text = '';
    for (const { task, classification } of tasks) {
      if (existing.has(task.taskId) || written.some(w => w.taskId === task.taskId)) throw new Error(`QUARANTINE_DUPLICATE: ${task.taskId}`);
      const body = { version: 1 as const, sequence, taskId: task.taskId, nodeId: task.nodeId, identity: taskIdentityDigest(task), observedState: task.state, classification, disposition: 'QUARANTINED_OWNER_ACKNOWLEDGED' as const, effect: 'UNKNOWN' as const, replayAuthorized: false as const, authority, at, previous };
      const entry: QuarantineEntry = Object.freeze({ ...body, digest: hashValue(body) });
      written.push(entry); text += JSON.stringify(entry) + '\n'; previous = entry.digest; sequence++;
    }
    if (!text) return [];
    // Append-only: one write of whole lines, then fsync. Earlier lines are never rewritten.
    const handle = await fs.open(file, 'a', 0o600);
    try { await handle.writeFile(text); await handle.sync(); } finally { await handle.close(); }
    const directory = await fs.open(path.dirname(file), 'r'); try { await directory.sync(); } finally { await directory.close(); }
    return written;
  }, { timeoutMs: 5_000 });
}

/** A quarantine entry still describes the live record only if identity and observed state are unchanged. */
export function quarantineMatches(entry: QuarantineEntry, task: QuarantinedTaskIdentity): boolean {
  return entry.taskId === task.taskId && entry.nodeId === task.nodeId && entry.identity === taskIdentityDigest(task) && entry.observedState === task.state;
}
