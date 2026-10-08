export async function retryReadOnlyCheck<T>(
  check: () => Promise<T | undefined>,
  options: {
    failureMessage: string;
    attempts?: number;
    intervalMs?: number;
    delay?: (ms: number) => Promise<void>;
  }
): Promise<T> {
  const attempts = options.attempts ?? 5;
  const intervalMs = options.intervalMs ?? 1_500;
  const delay = options.delay ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const result = await check();
      if (result !== undefined) return result;
    } catch {
      // The caller supplies a privacy-safe failure label after the bounded read-only retry window.
    }
    if (attempt + 1 < attempts) await delay(intervalMs);
  }
  throw new Error(options.failureMessage);
}
