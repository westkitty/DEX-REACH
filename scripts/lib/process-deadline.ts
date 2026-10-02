import { execFile } from 'node:child_process';

export type ExecDeadlineResult = { stdout: string; stderr: string };

export async function execFileDeadline(
  command: string,
  args: string[],
  timeoutMs = 10_000
): Promise<ExecDeadlineResult> {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 25 || timeoutMs > 120_000) {
    throw new Error(`invalid command timeout: ${timeoutMs}`);
  }
  return new Promise((resolve, reject) => {
    execFile(command, args, {
      timeout: timeoutMs,
      killSignal: 'SIGKILL',
      maxBuffer: 1024 * 1024
    }, (error, stdout, stderr) => {
      if (error) {
        reject(error);
        return;
      }
      resolve({ stdout: String(stdout), stderr: String(stderr) });
    });
  });
}
