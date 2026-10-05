import type { TaskState } from '../node/task-store.js';

export type StallClass =
  | 'quiet-but-alive'
  | 'waiting-external'
  | 'cpu-active'
  | 'transport-lost'
  | 'process-gone'
  | 'no-progress';

export type StallSignals = {
  state: TaskState;
  nowMs?: number;
  taskHeartbeatAt?: string;
  stateTransitionAt?: string;
  processAlive: boolean;
  transportConnected: boolean;
  waitingExternal: boolean;
  cpuActive: boolean;
  lastActivityAt?: string;
  lastStdoutAt?: string;
  lastResourceAt?: string;
  quietAfterMs?: number;
  noProgressAfterMs?: number;
};

function ageMs(value: string | undefined, now: number): number {
  if (!value) return Number.POSITIVE_INFINITY;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? Math.max(0, now - parsed) : Number.POSITIVE_INFINITY;
}

/** Classify a stalled task from independent liveness signals without deciding whether to replay it. */
export function classifyStall(input: StallSignals): StallClass {
  const now = input.nowMs ?? Date.now();
  if (!input.processAlive) return 'process-gone';
  if (!input.transportConnected) return 'transport-lost';
  if (input.waitingExternal) return 'waiting-external';
  if (input.cpuActive) return 'cpu-active';
  const lastSignal = Math.min(
    ageMs(input.taskHeartbeatAt, now),
    ageMs(input.stateTransitionAt, now),
    ageMs(input.lastActivityAt, now),
    ageMs(input.lastStdoutAt, now),
    ageMs(input.lastResourceAt, now)
  );
  if (lastSignal <= (input.quietAfterMs ?? 90_000)) return 'quiet-but-alive';
  if (ageMs(input.taskHeartbeatAt, now) > (input.noProgressAfterMs ?? 180_000)) return 'no-progress';
  return 'quiet-but-alive';
}

export type BootRecoveryEvidence = {
  state: TaskState;
  safetyClass: string;
  hasDurableResult: boolean;
  hasMatchingLiveActivity: boolean;
  hasMatchingLease: boolean;
  hasMatchingQueueTicket: boolean;
  processAlive: boolean;
  transportConnected: boolean;
  contradictoryEvidence: boolean;
};

export type BootRecoveryDecision = {
  kind: 'FINISH_FROM_DURABLE_EVIDENCE' | 'REATTACH' | 'RETRY_SAFE' | 'INPUT_REQUIRED' | 'AMBIGUOUS' | 'DEGRADED';
  reason: string;
};

/** Choose a conservative boot action; this function never deletes leases, tickets, or task records. */
export function decideBootRecovery(evidence: BootRecoveryEvidence): BootRecoveryDecision {
  if (evidence.contradictoryEvidence) {
    return { kind: 'DEGRADED', reason: 'TaskStore, coordinator, and process evidence disagree; contradictory state was preserved for explicit reconciliation.' };
  }
  if (evidence.hasDurableResult) {
    return { kind: 'FINISH_FROM_DURABLE_EVIDENCE', reason: 'A persisted result reference and verified result body are available.' };
  }
  if (evidence.hasMatchingLease && evidence.processAlive && evidence.transportConnected &&
      (evidence.hasMatchingLiveActivity || evidence.safetyClass !== 'PROCESS_UNKNOWN_EFFECT')) {
    return { kind: 'REATTACH', reason: evidence.hasMatchingLiveActivity
      ? 'The matching task activity and coordinator lease are live; execution was not replayed.'
      : 'The coordinator lease is live for this task; execution was not replayed.' };
  }
  if (evidence.hasMatchingQueueTicket && evidence.transportConnected && (evidence.state === 'ACCEPTED' || evidence.state === 'PREPARING')) {
    return { kind: 'REATTACH', reason: 'The coordinator queue ticket still names this task and attempt; its FIFO position was preserved.' };
  }
  if (evidence.state === 'ACCEPTED' || evidence.state === 'PREPARING') {
    return { kind: 'RETRY_SAFE', reason: 'The task had not reached execution and no live execution evidence remains.' };
  }
  if (evidence.state === 'RUNNING' && evidence.safetyClass === 'PURE_READ_IDEMPOTENT' && !evidence.hasMatchingLiveActivity && !evidence.hasMatchingLease) {
    return { kind: 'RETRY_SAFE', reason: 'The interrupted operation is a pure read with no remaining execution evidence.' };
  }
  if (evidence.state === 'RUNNING' && (!evidence.processAlive || !evidence.transportConnected)) {
    return { kind: 'AMBIGUOUS', reason: 'A running task lost process or transport evidence before a durable result was recorded; replay is forbidden.' };
  }
  return { kind: 'INPUT_REQUIRED', reason: 'Execution state cannot be resolved from durable evidence; owner reconciliation is required.' };
}
