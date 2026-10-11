import type { NodeTaskStore } from './task-store.js';
import { classifyFailure, unstartedFailureOutcome, type SafetyClass } from '../shared/durable-execution.js';
import { ProcessExitError } from '../shared/process-outcome.js';
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

/**
 * A numeric nonzero exit of a process that ran to its own completion is a deterministic failure, not
 * an unknown effect (ADR-0001: RUNNING -> FAILED on exit != 0). The exact status and the stdout and
 * stderr evidence are persisted as a result bound to this task, in the same atomic update that sets
 * the state. Only a RUNNING task may take this transition; any other state is refused so the caller
 * falls back to the conservative failure path.
 */
export async function persistProcessExitFailure(
  store: NodeTaskStore,
  results: { boundWithReference(value: unknown, taskId: string): Promise<{ metadata: { handle: string; resultHash: string } }> },
  taskId: string,
  error: ProcessExitError
) {
  const before = await store.read(taskId);
  if (!before) throw new Error('task failure evidence unavailable');
  if (before.state !== 'RUNNING') throw new Error(`process exit for a task in state ${before.state} is not recorded as a deterministic failure`);
  const stored = await results.boundWithReference(error.outcome, taskId);
  return store.update(taskId, {
    state: 'FAILED',
    failureClass: 'EXECUTION_FAILED',
    resultRef: stored.metadata.handle,
    resultHash: stored.metadata.resultHash,
    status: `Task failed: process exited with status ${error.exitCode}.`
  });
}
