export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export type RetryOptions = {
  shouldStop: () => boolean;
  onError?: (error: unknown, nextDelayMs: number) => void;
  initialDelayMs?: number;
  maxDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
};

/**
 * Own a recoverable async failure instead of allowing it to become an unhandled rejection.
 */
export async function retryUntilStopped(action: () => Promise<void>, options: RetryOptions): Promise<void> {
  const sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  let delay = options.initialDelayMs ?? 1000;
  const max = options.maxDelayMs ?? 30_000;
  while (!options.shouldStop()) {
    try {
      await action();
      return;
    } catch (error) {
      options.onError?.(error, delay);
      if (options.shouldStop()) return;
      await sleep(delay);
      delay = Math.min(delay * 2, max);
    }
  }
}

/** EventEmitter callbacks do not await returned promises; every async callback needs an owner. */
export function runDetached(
  label: string,
  task: () => Promise<void>,
  onError: (error: unknown) => void = error => console.error(`${label}:`, errorText(error))
): void {
  void task().catch(onError);
}

/**
 * WebSocket liveness based on actual unanswered heartbeat opportunities rather than elapsed wall
 * time. Event-loop starvation may delay a timer, but one delayed callback counts as one missed
 * opportunity, not many seconds of imaginary missed pongs.
 */
export class HeartbeatWatchdog {
  private unanswered = 0;

  constructor(private readonly maxUnanswered = 3) {
    if (!Number.isInteger(maxUnanswered) || maxUnanswered < 1 || maxUnanswered > 12) {
      throw new Error('heartbeat unanswered limit must be between 1 and 12');
    }
  }

  observedActivity(): void {
    this.unanswered = 0;
  }

  /** Returns false only after maxUnanswered prior heartbeat opportunities produced no activity. */
  nextHeartbeat(): boolean {
    if (this.unanswered >= this.maxUnanswered) return false;
    this.unanswered += 1;
    return true;
  }

  pending(): number {
    return this.unanswered;
  }
}

