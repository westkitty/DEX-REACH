import type { NodeTaskStore } from './task-store.js';
import { classifyFailure, unstartedFailureOutcome, type SafetyClass } from '../shared/durable-execution.js';
/** Canonical legal transitions only. Persistence errors propagate as uncertainty, never success. */
export async function persistTaskFailure(store: NodeTaskStore, taskId: string, safety: SafetyClass, error: unknown, executionStarted: boolean) {
 const before = await store.read(taskId);
 if (!before) throw new Error('task failure evidence unavailable');
 if (['COMPLETED','FAILED','CANCELLED','RECONCILED','AMBIGUOUS'].includes(before.state)) return before;
 const unstarted = unstartedFailureOutcome({error,safety,persistedState:before.state,executionStarted});
 let failureClass = unstarted?.failureClass ?? classifyFailure({error,safety});
 // An exception after entering execution cannot prove a mutation had no effect, including a lost result write.
 if (!unstarted && safety !== 'PURE_READ_IDEMPOTENT') failureClass = 'AMBIGUOUS_EFFECT';
 const next = unstarted?.next ?? (failureClass === 'AMBIGUOUS_EFFECT' ? 'AMBIGUOUS' : 'FAILED');
 // Persist the state and failure classification together, avoiding an illegal or half-written outcome.
 return store.update(taskId,{state:next,failureClass,status:`Task stopped${unstarted ? ' before execution' : ''}: ${failureClass}.`});
}
