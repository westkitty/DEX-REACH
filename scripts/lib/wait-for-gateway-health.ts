export type GatewayHealthProbe = () => Promise<{ ready: boolean; detail?: string }>;

export async function waitForGatewayHealth(
  probe: GatewayHealthProbe,
  options: {
    timeoutMs?: number;
    intervalMs?: number;
    now?: () => number;
    delay?: (ms: number) => Promise<void>;
  } = {}
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 90_000;
  const intervalMs = options.intervalMs ?? 500;
  const now = options.now ?? (() => performance.now());
  const delay = options.delay ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const deadline = now() + timeoutMs;
  let last = 'gateway health endpoint not ready';

  while (now() < deadline) {
    try {
      const result = await probe();
      if (result.ready) return;
      last = result.detail ?? last;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    const remaining = deadline - now();
    if (remaining > 0) await delay(Math.min(intervalMs, remaining));
  }

  throw new Error(`DEX health verification failed: ${last.slice(0, 300)}`);
}
