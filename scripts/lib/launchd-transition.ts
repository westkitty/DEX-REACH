export type LaunchctlResult = { stdout: string; stderr: string };
export type LaunchctlRunner = (args: string[]) => Promise<LaunchctlResult>;
export type Sleep = (ms: number) => Promise<void>;

const defaultSleep: Sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export async function waitForLaunchdUnload(
  domain: string,
  label: string,
  launchctl: LaunchctlRunner,
  options: { timeoutMs?: number; pollMs?: number; sleep?: Sleep } = {}
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const pollMs = options.pollMs ?? 100;
  const sleep = options.sleep ?? defaultSleep;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      await launchctl(['print', `${domain}/${label}`]);
    } catch {
      return;
    }
    await sleep(pollMs);
  }

  throw new Error(`${label} did not fully unload within ${timeoutMs}ms`);
}

export async function bootstrapLaunchdWithRetry(
  domain: string,
  label: string,
  plist: string,
  launchctl: LaunchctlRunner,
  options: { attempts?: number; retryDelayMs?: number; sleep?: Sleep } = {}
): Promise<void> {
  const attempts = options.attempts ?? 5;
  const retryDelayMs = options.retryDelayMs ?? 250;
  const sleep = options.sleep ?? defaultSleep;
  let lastError: unknown;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await launchctl(['bootstrap', domain, plist]);
      return;
    } catch (error) {
      lastError = error;

      // launchctl may report an error after launchd has already registered the job. Treat an
      // observable registered label as success and let later running/PID verification decide.
      try {
        await launchctl(['print', `${domain}/${label}`]);
        return;
      } catch {
        // Still absent: this is a real bootstrap miss, so retry after a bounded delay.
      }

      if (attempt + 1 < attempts) await sleep(retryDelayMs * (attempt + 1));
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}
