import { spawn } from 'node:child_process';
import { HEARTBEAT_INTERVAL_MS, acquireWork, heartbeat, releaseWork, type AdmissionResult, type WorkRequest } from './work-coordinator.js';

export type WorkRunResult =
  | Extract<AdmissionResult, { status: 'queued' }>
  | { status: 'completed'; leaseId: string; exitCode: number | null; signal: NodeJS.Signals | null };

/**
 * Own a lease for exactly one local child lifecycle. This is coordination only: the caller still
 * chooses and executes a local command, and no DEX authorization is widened by the wrapper.
 */
export async function runWithWorkLease(request: WorkRequest, executable: string, args: readonly string[]): Promise<WorkRunResult> {
  const admission = await acquireWork(request);
  if (admission.status === 'queued') return admission;

  const child = spawn(executable, [...args], { stdio: 'inherit' });
  const timer = setInterval(() => { void heartbeat(admission.lease.id); }, HEARTBEAT_INTERVAL_MS);
  try {
    const outcome = await new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (exitCode, signal) => resolve({ exitCode, signal }));
    });
    return { status: 'completed', leaseId: admission.lease.id, ...outcome };
  } finally {
    clearInterval(timer);
    await releaseWork(admission.lease.id).catch(() => undefined);
  }
}
