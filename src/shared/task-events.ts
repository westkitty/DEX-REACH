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
    ...(input.traceId ? { traceId: safe(input.traceId, 64) } : {})
  };
}

function validEvent(value: unknown): value is TaskEvent {
  if (!value || typeof value !== 'object') return false;
  const event = value as Partial<TaskEvent>;
  return typeof event.eventId === 'string' && typeof event.at === 'string' && Number.isFinite(Date.parse(event.at))
    && typeof event.taskId === 'string' && typeof event.kind === 'string';
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
      lines.push(JSON.stringify(event));
      await atomicWriteFile(taskEventFile(this.dir), lines.slice(-2000).join('\n') + '\n', 0o600);
    });
    return event;
  }

  async list(taskId?: string, limit = 200): Promise<TaskEvent[]> {
    let raw: string;
    try { raw = await fs.readFile(taskEventFile(this.dir), 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
    const events = raw.split('\n').filter(Boolean).flatMap(line => {
      try {
        const value = JSON.parse(line) as unknown;
        return validEvent(value) && (!taskId || value.taskId === taskId) ? [value] : [];
      } catch { return []; }
    });
    return events.slice(-Math.max(1, Math.min(limit, 2000)));
  }
}
