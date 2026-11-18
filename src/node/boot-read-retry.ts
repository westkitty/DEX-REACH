/**
 * Only retry an unavailable coordinator observation. Caller action must not
 * have crossed the durable read's execution/admission boundary.
 */
export class RecoveryCoordinatorUnavailableError extends Error {
  constructor(message = 'coordinator temporarily unavailable') {
    super(message);
    this.name = 'RecoveryCoordinatorUnavailableError';
  }
}

type Delay = (ms: number) => Promise<void>;
const defaultDelay: Delay = ms => new Promise(resolve => setTimeout(resolve, ms));

export async function retryCoordinatorRecovery<T>(
  action: () => Promise<T>,
  delay: Delay = defaultDelay,
  maxAttempts = 8
): Promise<T> {
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 8) {
    throw new Error('recovery probe attempt budget must be between 1 and 8');
  }
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try { return await action(); }
    catch (error) {
      // Never replay an unknown error. This type is thrown exclusively by
      // coordinator-status and old-ticket-cancel probes before read execution.
      if (!(error instanceof RecoveryCoordinatorUnavailableError) || attempt === maxAttempts) throw error;
      await delay(Math.min(8_000, 500 * (2 ** (attempt - 1))));
    }
  }
  throw new Error('unreachable recovery retry state');
}


/** Legal, conservative stop state when no safe boot read was executed. */
export function bootReadStopState(state: string): 'CANCELLED' | 'FAILED' | 'INPUT_REQUIRED' {
  if (state === 'ACCEPTED') return 'CANCELLED';
  if (state === 'PREPARING') return 'FAILED';
  if (state === 'RUNNING') return 'INPUT_REQUIRED';
  throw new Error('boot read is not in an executable recovery state');
}
