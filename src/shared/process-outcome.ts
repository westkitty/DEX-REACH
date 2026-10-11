/**
 * Process exit outcome for durable tasks (ADR-0001 lifecycle matrix).
 *
 * A child that exits on its own with a numeric status is a deterministic outcome: exit 0 is
 * COMPLETED (after the result is persisted), any other status is FAILED. A child that ends by a
 * signal or the time limit never reaches this module; it is ProcessSignalTerminationError and maps
 * to AMBIGUOUS_EFFECT in durable-execution.ts.
 *
 * Recognition is operation-aware and strict. Only `dex.process.run` values are process results. A
 * value from any other operation that happens to carry an `exitCode` property is never treated as a
 * process outcome (no duck typing). A process value whose exit status is not a valid integer status
 * is refused rather than recorded as success.
 */

export const PROCESS_OPERATIONS = ['dex.process.run'] as const;

/** A child's own exit status. POSIX exit statuses are 0-255; anything else is not a real status. */
export const MAX_PROCESS_EXIT_STATUS = 255;

/**
 * Thrown when a process outcome is a real, numeric, nonzero exit. It carries the exact status and the
 * task-bound outcome body (stdout, stderr, exit status) so the task layer can persist the evidence.
 */
export class ProcessExitError extends Error {
  readonly exitCode: number;
  readonly outcome: Record<string, unknown>;
  constructor(exitCode: number, outcome: Record<string, unknown>) {
    super(`process exited with status ${exitCode}`);
    this.name = 'ProcessExitError';
    this.exitCode = exitCode;
    this.outcome = outcome;
  }
}

export function isProcessOperation(operation: string): boolean {
  return (PROCESS_OPERATIONS as readonly string[]).includes(operation);
}

/**
 * Returns the child's exit status for a process operation, `null` for an operation that is not a
 * process operation. Throws for a process operation whose value does not carry a valid status, so a
 * malformed process result can never be recorded as a completed success.
 */
export function processExitCode(operation: string, value: unknown): number | null {
  if (!isProcessOperation(operation)) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('process result is malformed; completion refused');
  const record = value as Record<string, unknown>;
  const code = record.exitCode;
  if (typeof code !== 'number' || !Number.isInteger(code) || code < 0 || code > MAX_PROCESS_EXIT_STATUS) {
    throw new Error('process result has no valid exit status; completion refused');
  }
  if (typeof record.stdout !== 'string' || typeof record.stderr !== 'string') {
    throw new Error('process result has no valid stdout/stderr evidence; completion refused');
  }
  return code;
}

/** Throws ProcessExitError for a nonzero status; returns normally for exit 0 or a non-process operation. */
export function assertProcessSucceeded(operation: string, value: unknown): void {
  const code = processExitCode(operation, value);
  if (code !== null && code !== 0) throw new ProcessExitError(code, value as Record<string, unknown>);
}
