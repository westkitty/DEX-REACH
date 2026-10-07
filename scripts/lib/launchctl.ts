import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
export const LAUNCHCTL_TIMEOUT_MS = 8_000;
export const LAUNCHCTL_QUERY_TIMEOUT_MS = 2_000;

export type LaunchctlResult = { stdout: string; stderr: string };
export type LaunchctlRunner = (args: string[], timeoutMs?: number) => Promise<LaunchctlResult>;

export const runLaunchctl: LaunchctlRunner = async (args, timeoutMs = LAUNCHCTL_TIMEOUT_MS) => {
  const { stdout, stderr } = await execFileAsync('/bin/launchctl', args, { timeout: timeoutMs, killSignal: 'SIGKILL' });
  return { stdout, stderr };
};

export function isLaunchctlTimeout(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && (error as NodeJS.ErrnoException).code === 'ETIMEDOUT');
}

/** A timeout is an unknown outcome until launchd's own state says otherwise. */
export async function launchctlWithReconciliation(options: {
  args: string[];
  reconcileArgs: string[];
  reconciled: (result: LaunchctlResult) => boolean;
  reconciledError?: (error: unknown) => boolean;
  expectation: string;
  runner?: LaunchctlRunner;
  timeoutMs?: number;
}): Promise<'command-succeeded' | 'reconciled'> {
  const runner = options.runner || runLaunchctl;
  const timeoutMs = options.timeoutMs ?? LAUNCHCTL_TIMEOUT_MS;
  try {
    await runner(options.args, timeoutMs);
    return 'command-succeeded';
  } catch (error) {
    if (!isLaunchctlTimeout(error)) throw error;
    let observed: LaunchctlResult;
    try { observed = await runner(options.reconcileArgs, timeoutMs); }
    catch (reconcileError) {
      if (options.reconciledError?.(reconcileError)) return 'reconciled';
      throw new Error(`${options.args[0]} timed out; outcome ambiguous because reconciliation failed: ${errorText(reconcileError)}`);
    }
    if (options.reconciled(observed)) return 'reconciled';
    throw new Error(`${options.args[0]} timed out; expected ${options.expectation} was not proven by bounded launchctl reconciliation: ${bounded(observed.stdout || observed.stderr)}`);
  }
}

export function launchdIsRunning(output: string): boolean {
  return /\bstate = running\b/.test(output) && /\bpid = \d+\b/.test(output);
}

export function launchdIsAbsent(error: unknown): boolean {
  const text = errorText(error);
  return /could not find (?:service|specified service)|service not found|no such service/i.test(text);
}

export function launchdServiceIsEnabled(output: string, label: string): boolean {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`"${escaped}"\\s*=>\\s*enabled`).test(output);
}

export function errorText(error: unknown): string {
  if (!error || typeof error !== 'object') return String(error);
  const candidate = error as Error & { stderr?: string };
  return bounded(candidate.stderr || candidate.message || String(error));
}

export function failureOutcome(error: unknown): 'failed' | 'ambiguous' {
  return /timed out|outcome ambiguous|was not proven/i.test(errorText(error)) ? 'ambiguous' : 'failed';
}

function bounded(value: string): string { return value.replace(/[\r\n]+/g, ' ').slice(0, 400); }
