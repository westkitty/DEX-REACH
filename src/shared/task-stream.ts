import type { TaskEventLog } from './task-events.js';
import type { TaskState } from '../node/task-store.js';

export type TaskStreamPage = {
  taskId: string; nodeId: string; state: TaskState; terminal: boolean;
  gap: boolean; cursor: string | null;
  events: Array<{ eventId: string; taskId: string; at: string; kind: string; state: TaskState; summary: string }>;
};
const states = new Set(['ACCEPTED', 'PREPARING', 'RUNNING', 'INPUT_REQUIRED', 'AMBIGUOUS', 'COMPLETED', 'FAILED', 'CANCELLED', 'RECONCILED']);
/** Only fixed lifecycle text crosses the public boundary; persisted free text remains owner-local. */
export async function taskStreamPage(log: TaskEventLog, taskId: string, nodeId: string, state: TaskState, cursor?: string): Promise<TaskStreamPage> {
  if (cursor !== undefined && !/^tev_[0-9a-f]{24}$/.test(cursor)) throw new Error('invalid event cursor');
  const history = await log.list(taskId, 2000, true);
  const index = cursor ? history.findIndex(e => e.eventId === cursor) : -1;
  const gap = cursor ? index < 0 : history[0]?.kind !== 'accepted';
  const selected = history.slice(index + 1, index + 101);
  const events = selected.map(e => {
    const eventState = e.toState ?? e.state;
    if (!eventState) throw new Error('persisted lifecycle event has no state');
    if (!states.has(eventState)) throw new Error('invalid persisted event state');
    return { eventId: e.eventId, taskId, at: e.at, kind: e.kind, state: eventState, summary: `Task state: ${eventState}.` };
  });
  return { taskId, nodeId, state, terminal: ['COMPLETED', 'FAILED', 'CANCELLED', 'RECONCILED'].includes(state) && selected.length < 100 && (events.at(-1)?.state ?? (index >= 0 ? history[index]?.state : undefined)) === state,
    gap, cursor: events.at(-1)?.eventId ?? cursor ?? null, events };
}
