import { hashValue } from './hash.js';

export const FAILURE_CLASSES = [
  'TRANSIENT_TRANSPORT', 'TRANSIENT_RESOURCE', 'DEPENDENCY_WAIT', 'INPUT_REQUIRED',
  'AUTHORITY_REFUSAL', 'POLICY_CHANGED', 'TARGET_CHANGED', 'INVALID_INPUT',
  'EXECUTION_FAILED', 'DEADLINE_EXCEEDED', 'AMBIGUOUS_EFFECT', 'USER_CANCELLED',
  'SYSTEM_CANCELLED', 'CORRUPT_STATE'
] as const;
export type FailureClass = (typeof FAILURE_CLASSES)[number];

export const SAFETY_CLASSES = [
  'PURE_READ_IDEMPOTENT', 'SIDE_EFFECTING_IDEMPOTENT', 'PLAN_COMMIT',
  'PROCESS_UNKNOWN_EFFECT', 'DESTRUCTIVE'
] as const;
export type SafetyClass = (typeof SAFETY_CLASSES)[number];

export function classifyOperationSafety(operation: string): SafetyClass {
  if (['dex.fingerprint', 'dex.trustReport', 'dex.repoInfo', 'dex.adbDevices', 'dex.file.read', 'dex.result.read', 'dex.receipts.list'].includes(operation)) return 'PURE_READ_IDEMPOTENT';
  if (operation === 'dex.commitPlan') return 'PLAN_COMMIT';
  if (operation === 'dex.process.run' || operation === 'dc.call') return 'PROCESS_UNKNOWN_EFFECT';
  if (operation === 'dex.file.write' || operation === 'dex.checkpoint') return 'SIDE_EFFECTING_IDEMPOTENT';
  return 'DESTRUCTIVE';
}

export function defaultAttemptBudget(safety: SafetyClass): number {
  return safety === 'PURE_READ_IDEMPOTENT' ? 3 : safety === 'SIDE_EFFECTING_IDEMPOTENT' ? 2 : 1;
}

export function deriveIdempotencyKey(input: {
  actorId: string;
  nodeId: string;
  operation: string;
  args: Record<string, unknown>;
  policyHash: string;
  requestedKey?: string;
  requestId?: string;
}): { key: string; payloadHash: string } {
  const payloadHash = hashValue({ operation: input.operation, args: input.args });
  // A client key and a one-use plan identity survive transport retries. The current policy is
  // stored on the task and compared on lookup; it is deliberately not part of the lookup key, so
  // a policy change reports a binding collision instead of accidentally creating a second attempt.
  const stableIdentity = input.requestedKey
    ?? (input.operation === 'dex.commitPlan' && typeof input.args.planId === 'string' ? `plan:${input.args.planId}` : input.requestId ?? null);
  const key = `idem_${hashValue({ actorId: input.actorId, nodeId: input.nodeId, operation: input.operation, payloadHash: input.requestedKey || (input.operation === 'dex.commitPlan' && typeof input.args.planId === 'string') ? null : payloadHash, identity: stableIdentity })}`;
  return { key, payloadHash };
}

export function classifyFailure(input: {
  error?: unknown;
  safety: SafetyClass;
  transportTimedOut?: boolean;
  executionTimedOut?: boolean;
  policyRefused?: boolean;
  targetChanged?: boolean;
  corruptState?: boolean;
}): FailureClass {
  if (input.corruptState) return 'CORRUPT_STATE';
  if (input.policyRefused) return 'AUTHORITY_REFUSAL';
  if (input.targetChanged) return 'TARGET_CHANGED';
  if (input.transportTimedOut) return input.safety === 'PURE_READ_IDEMPOTENT' ? 'TRANSIENT_TRANSPORT' : 'AMBIGUOUS_EFFECT';
  if (input.executionTimedOut) return input.safety === 'PURE_READ_IDEMPOTENT' ? 'DEADLINE_EXCEEDED' : 'AMBIGUOUS_EFFECT';
  const message = input.error instanceof Error ? input.error.message.toLowerCase() : String(input.error ?? '').toLowerCase();
  if (/cancel|sigint|sigterm/.test(message)) return 'SYSTEM_CANCELLED';
  if (/invalid|malformed|requires|must be|unknown operation/.test(message)) return 'INVALID_INPUT';
  if (/policy|owner|read-only|disabled|refused|grant/.test(message)) return 'AUTHORITY_REFUSAL';
  if (/deadline|timed out|timeout/.test(message)) return input.safety === 'PURE_READ_IDEMPOTENT' ? 'DEADLINE_EXCEEDED' : 'AMBIGUOUS_EFFECT';
  return 'EXECUTION_FAILED';
}

export function retryAllowed(safety: SafetyClass, failure: FailureClass): boolean {
  if (['AUTHORITY_REFUSAL', 'POLICY_CHANGED', 'TARGET_CHANGED', 'INVALID_INPUT', 'INPUT_REQUIRED', 'AMBIGUOUS_EFFECT', 'CORRUPT_STATE', 'USER_CANCELLED', 'SYSTEM_CANCELLED'].includes(failure)) return false;
  if (safety === 'PLAN_COMMIT' || safety === 'PROCESS_UNKNOWN_EFFECT' || safety === 'DESTRUCTIVE') return false;
  return safety === 'PURE_READ_IDEMPOTENT' || safety === 'SIDE_EFFECTING_IDEMPOTENT';
}

export function retryDelayMs(attemptNumber: number, failure: FailureClass, random = 0): number | null {
  if (!Number.isInteger(attemptNumber) || attemptNumber < 1 || !retryAllowed('PURE_READ_IDEMPOTENT', failure)) return null;
  const jitter = Math.max(0, Math.min(1, random));
  return Math.min(30_000, 250 * (2 ** Math.min(attemptNumber - 1, 7)) + Math.floor(100 * jitter));
}

export type ReconciliationEvidence = {
  processAlive?: boolean;
  activitySeen?: boolean;
  receiptVerified?: boolean;
  resultAvailable?: boolean;
  externalJobId?: string | null;
  policyStillAllows?: boolean;
};

export type ReconciliationDecision = 'REATTACH' | 'FINISH_FROM_DURABLE_EVIDENCE' | 'RETRY_SAFE' | 'INPUT_REQUIRED' | 'AMBIGUOUS';

export function reconcile(evidence: ReconciliationEvidence, safety: SafetyClass): ReconciliationDecision {
  if (evidence.receiptVerified || evidence.resultAvailable) return 'FINISH_FROM_DURABLE_EVIDENCE';
  if (evidence.processAlive || evidence.activitySeen || evidence.externalJobId) return 'REATTACH';
  if (evidence.policyStillAllows === false) return 'INPUT_REQUIRED';
  return safety === 'PURE_READ_IDEMPOTENT' && !evidence.externalJobId ? 'RETRY_SAFE' : 'AMBIGUOUS';
}
