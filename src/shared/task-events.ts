import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { redactSensitiveText } from './security.js';
import { atomicWriteFile, withFileLock } from './state-io.js';
import type { TaskState } from '../node/task-store.js';

/**
 * Content-free lifecycle evidence for one durable task. This is deliberately separate from the
 * task snapshot: a repaired or archived snapshot must not erase the history an owner needs to
 * understand how it reached its current state.
 */
export type TaskEvent = {
  eventId: string;
  at: string;
  taskId: string;
  kind: 'accepted' | 'updated' | 'transition' | 'archived' | 'control';
  state?: TaskState;
  fromState?: TaskState;
  toState?: TaskState;
  actorId?: string;
  nodeId?: string;
  operation?: string;
  attempt?: number;
  summary?: string;
  control?: string;
  evidenceRef?: string;
  traceId?: string;
  failureClass?: string;
  /** Some earlier detail was evicted; retained transitions do not imply complete history. */
  historyGap?: boolean;
};

export type TaskEventInput = Omit<TaskEvent, 'eventId' | 'at'> & { at?: string };

export function taskEventFile(dir: string): string { return path.join(dir, 'tasks', 'events.jsonl'); }
export function taskEventLockFile(dir: string): string { return `${taskEventFile(dir)}.lock`; }

function safe(value: string | undefined, limit = 240): string | undefined {
  if (value === undefined) return undefined;
  return redactSensitiveText(value).slice(0, limit);
}

function sanitize(input: TaskEventInput): TaskEvent {
  return {
    eventId: `tev_${crypto.randomBytes(12).toString('hex')}`,
    at: input.at ?? new Date().toISOString(),
    taskId: safe(input.taskId, 96)!,
    kind: input.kind,
    ...(input.state ? { state: input.state } : {}),
    ...(input.fromState ? { fromState: input.fromState } : {}),
    ...(input.toState ? { toState: input.toState } : {}),
    ...(input.actorId ? { actorId: safe(input.actorId, 128) } : {}),
    ...(input.nodeId ? { nodeId: safe(input.nodeId, 128) } : {}),
    ...(input.operation ? { operation: safe(input.operation, 128) } : {}),
    ...(input.attempt !== undefined ? { attempt: input.attempt } : {}),
    ...(input.summary ? { summary: safe(input.summary) } : {}),
    ...(input.control ? { control: safe(input.control, 128) } : {}),
    ...(input.evidenceRef ? { evidenceRef: safe(input.evidenceRef, 160) } : {}),
    ...(input.traceId ? { traceId: safe(input.traceId, 64) } : {}),
    ...(input.failureClass ? { failureClass: safe(input.failureClass, 64) } : {})
  };
}

function validEvent(value: unknown): value is TaskEvent {
  if (!value || typeof value !== 'object') return false;
  const event = value as Partial<TaskEvent>;
  return typeof event.eventId === 'string' && typeof event.at === 'string' && Number.isFinite(Date.parse(event.at))
    && typeof event.taskId === 'string' && typeof event.kind === 'string';
}

export const TASK_EVENT_LIMIT = 2000;
export const TASK_EVENT_BYTE_LIMIT = 2 * 1024 * 1024;
/** Compatible bounded journal: reserve 1500 entries for causal evidence, fill with recent detail.
 * IDs/order survive compaction. No new file family or historical-event invention is required. */
export function retainTaskEvents(events: readonly TaskEvent[]): TaskEvent[] {
  if (new Set(events.map(e => e.eventId)).size !== events.length) throw new Error('event history is corrupt: duplicate event ID');
  const decisive = events.filter(e => e.kind !== 'updated' || e.evidenceRef || e.failureClass).slice(-1500);
  const selected = new Set(decisive.map(e => e.eventId));
  for (let i = events.length - 1; i >= 0 && selected.size < TASK_EVENT_LIMIT; i--) selected.add(events[i]!.eventId);
  const gaps = new Set(events.filter(e => !selected.has(e.eventId) || e.historyGap).map(e => e.taskId));
  let kept = events.filter(e => selected.has(e.eventId)).map(e => ({...e}));
  // Hard byte ceiling covers imported historical records too. Gaps persist even if their marker ages out.
  let bytes = kept.reduce((n,e) => n + Buffer.byteLength(JSON.stringify(e)) + 1, 0);
  while (kept.length && bytes > TASK_EVENT_BYTE_LIMIT - TASK_EVENT_LIMIT * 24) {
    const removed = kept.shift()!; gaps.add(removed.taskId);
    bytes -= Buffer.byteLength(JSON.stringify(removed)) + 1;
  }
  const marked = new Set<string>();
  for (const event of kept) {
    if (gaps.has(event.taskId) && !marked.has(event.taskId)) { event.historyGap = true; marked.add(event.taskId); }
  }
  return kept;
}

export class TaskEventLog {
  constructor(private readonly dir: string) {}

  async append(input: TaskEventInput): Promise<TaskEvent> {
    const event = sanitize(input);
    await fs.mkdir(path.dirname(taskEventFile(this.dir)), { recursive: true, mode: 0o700 });
    await withFileLock(taskEventLockFile(this.dir), async () => {
      let lines: string[] = [];
      try { lines = (await fs.readFile(taskEventFile(this.dir), 'utf8')).split('\n').filter(Boolean); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      const events = lines.map(line => {
        let value: unknown;
        try { value = JSON.parse(line); } catch { throw new Error('event history is corrupt'); }
        if (!validEvent(value)) throw new Error('event history is corrupt');
        return value;
      });
      events.push(event);
      await atomicWriteFile(taskEventFile(this.dir), retainTaskEvents(events).map(e => JSON.stringify(e)).join('\n') + '\n', 0o600);
    });
    return event;
  }

  async list(taskId?: string, limit = 200, strict = false): Promise<TaskEvent[]> {
    let raw: string;
    try { raw = await fs.readFile(taskEventFile(this.dir), 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
    const seen = new Set<string>();
    const events = raw.split('\n').filter(Boolean).flatMap(line => {
      try {
        const value = JSON.parse(line) as unknown;
        if (!validEvent(value)) { if (strict) throw new Error('event history is corrupt'); return []; }
        if (seen.has(value.eventId)) { if (strict) throw new Error('event history is corrupt: duplicate event ID'); return []; }
        seen.add(value.eventId);
        return !taskId || value.taskId === taskId ? [value] : [];
      } catch { if (strict) throw new Error('event history is corrupt'); return []; }
    });
    return events.slice(-Math.max(1, Math.min(limit, 2000)));
  }
}
