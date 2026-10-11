import { readQuarantine } from '../shared/task-quarantine.js';
import { listProcessActivities, type ProcessActivity } from '../shared/activity.js';
import { coordinatedHeartbeat, coordinatedRelease, coordinatedStatus } from '../coordinator/client.js';
import { decideBootRecovery, type BootRecoveryDecision } from '../shared/task-recovery.js';
import { verifyProcessIdentity, type ProcessIdentityVerdict } from '../shared/process-identity.js';
import type { WorkStatus } from '../shared/work-coordinator.js';
import { ResultStore } from './result-store.js';
import { NodeTaskStore, type ReachTaskRecord } from './task-store.js';

export type BootRecoveryReport = {
  taskId: string;
  decision: BootRecoveryDecision;
};

/**
 * Injection points. The defaults are the real coordinator, activity store and process table. Tests
 * supply synthetic evidence; production code never does.
 */
export type BootRecoveryOptions = {
  coordinator?: WorkStatus | null;
  transportConnected?: boolean;
  /** `null` means the activity evidence could not be read, which is itself contradictory for RUNNING tasks. */
  activities?: ProcessActivity[] | null;
  verify?: (activity: ProcessActivity) => Promise<ProcessIdentityVerdict>;
  heartbeatLease?: (leaseId: string) => Promise<boolean>;
  /** Releases the lease of an orphan that identity has proven ended. Never used while the orphan may still run. */
  releaseLease?: (leaseId: string) => Promise<{ released: boolean }>;
};

function matchingActivity(task: ReachTaskRecord, records: readonly ProcessActivity[]): ProcessActivity | undefined {
  return records.find(record => record.taskId === task.taskId && (record.attempt === undefined || record.attempt === task.attemptNumber));
}

function matchingLease(task: ReachTaskRecord, status: WorkStatus | null) {
  return status?.leases.find(lease => lease.taskId === task.taskId && (lease.attempt === undefined || lease.attempt === task.attemptNumber));
}

function matchingTicket(task: ReachTaskRecord, status: WorkStatus | null) {
  return status?.tickets.find(ticket => ticket.taskId === task.taskId && (ticket.attempt === undefined || ticket.attempt === task.attemptNumber));
}

async function hasVerifiedResult(task: ReachTaskRecord, results: ResultStore): Promise<boolean> {
  if (!task.resultRef || !task.resultHash) return false;
  try { await results.readValueForTask(task.resultRef, task.taskId, task.resultHash); return true; } catch { return false; }
}

async function loadCoordinator(options: BootRecoveryOptions): Promise<{ coordinator: WorkStatus | null; transportConnected: boolean }> {
  if (options.coordinator !== undefined) return { coordinator: options.coordinator, transportConnected: options.transportConnected ?? true };
  try { return { coordinator: await coordinatedStatus(), transportConnected: true }; }
  catch { return { coordinator: null, transportConnected: false }; }
}

async function loadActivities(options: BootRecoveryOptions): Promise<ProcessActivity[] | null> {
  if (options.activities !== undefined) return options.activities;
  // A 5 s wait killed the node at boot under fsync contention; launchd then crash-looped it.
  try { return await listProcessActivities({ includeFinished: true, limit: 500, timeoutMs: 30_000 }); }
  catch { return null; }
}

/** Keeps a lease fresh while its orphan is verified, so the coordinator does not reclaim capacity an effect may still use. */
async function keepLeaseWhileOrphanRuns(leaseId: string | undefined, options: BootRecoveryOptions): Promise<void> {
  if (!leaseId) return;
  await (options.heartbeatLease ?? coordinatedHeartbeat)(leaseId).catch(() => false);
}

/**
 * A graceful stop can exit the node before an in-flight request reaches its release, so the lease outlives its
 * holder. Once the recorded process is verified ended, nothing can still run under that lease: release it now,
 * rather than waiting for the coordinator's stale-heartbeat reclaim.
 */
async function releaseEndedOrphanLease(leaseId: string | undefined, options: BootRecoveryOptions): Promise<void> {
  if (!leaseId) return;
  await (options.releaseLease ?? coordinatedRelease)(leaseId).catch(() => undefined);
}

async function verdictFor(activity: ProcessActivity | undefined, options: BootRecoveryOptions): Promise<ProcessIdentityVerdict | null> {
  if (!activity) return null;
  if (activity.state === 'starting') return 'UNVERIFIABLE';
  if (activity.state !== 'running') return 'GONE';
  return (options.verify ?? (record => verifyProcessIdentity(record.identity, record.pid)))(activity);
}

async function setStatusIfChanged(task: ReachTaskRecord, status: string, taskStore: NodeTaskStore): Promise<void> {
  if (task.summary.status !== status) await taskStore.update(task.taskId, { status });
}

/** Supervision of a recorded AMBIGUOUS task. Never transitions state and never replays: it only observes and keeps the lease honest. */
async function superviseAmbiguous(
  task: ReachTaskRecord,
  activity: ProcessActivity | undefined,
  verdict: ProcessIdentityVerdict | null,
  lease: { id: string } | undefined,
  taskStore: NodeTaskStore,
  options: BootRecoveryOptions
): Promise<BootRecoveryDecision> {
  // Owner reconciliation is required whenever no live orphan remains (the pre-existing INPUT_REQUIRED meaning).
  const ownerReconciliation = 'Execution state cannot be resolved from durable evidence; owner reconciliation is required.';
  if (!activity) return { kind: 'INPUT_REQUIRED', reason: ownerReconciliation };
  if ((activity.state !== 'running' && activity.state !== 'starting') || verdict === 'GONE' || verdict === 'REUSED') {
    // The recorded process has ended on any evidence. Its effect is still unobservable, so the task is not completed.
    const reason = 'The recorded process has ended; its final effect is not observable. The task stays AMBIGUOUS and is not replayed.';
    await releaseEndedOrphanLease(lease?.id, options);
    await setStatusIfChanged(task, reason, taskStore);
    return { kind: 'INPUT_REQUIRED', reason };
  }
  if (verdict === 'SAME') {
    const reason = `Orphan process ${activity.pid} is running with verified identity; its effect is not observable here. The task stays AMBIGUOUS and is not replayed.`;
    await keepLeaseWhileOrphanRuns(lease?.id, options);
    await setStatusIfChanged(task, reason, taskStore);
    return { kind: 'MONITOR_ORPHAN', reason };
  }
  // UNVERIFIABLE: identity cannot be proven, so the process may still run. Fail closed: keep the lease.
  const reason = 'Orphan process identity cannot be verified; the task stays AMBIGUOUS, the lease is kept, and replay is forbidden.';
  await keepLeaseWhileOrphanRuns(lease?.id, options);
  await setStatusIfChanged(task, reason, taskStore);
  return { kind: 'DEGRADED', reason };
}

/**
 * Supervises AMBIGUOUS tasks with orphan evidence. Safe to run at any time: it never transitions a
 * task, never replays, and only refreshes the lease of an orphan that identity cannot rule out.
 */
export async function superviseAmbiguousTasks(taskStore: NodeTaskStore, options: BootRecoveryOptions = {}): Promise<BootRecoveryReport[]> {
  const tasks = (await taskStore.loadActiveTasks()).filter(task => task.state === 'AMBIGUOUS');
  if (!tasks.length) return [];
  const activities = await loadActivities(options);
  const { coordinator } = await loadCoordinator(options);
  const reports: BootRecoveryReport[] = [];
  for (const task of tasks) {
    if (!activities) { reports.push({ taskId: task.taskId, decision: { kind: 'AMBIGUOUS', reason: 'Activity evidence is unavailable; the task stays AMBIGUOUS and replay is forbidden.' } }); continue; }
    const activity = matchingActivity(task, activities);
    const verdict = await verdictFor(activity, options);
    reports.push({ taskId: task.taskId, decision: await superviseAmbiguous(task, activity, verdict, matchingLease(task, coordinator), taskStore, options) });
  }
  return reports;
}

/**
 * Boot reconciliation of tasks that were active when the node stopped. Runs once, before the node
 * advertises readiness, and never on a live node's in-flight work.
 */
export async function reconcileBootTasks(taskStore: NodeTaskStore, results: ResultStore, options: BootRecoveryOptions = {}): Promise<BootRecoveryReport[]> {
  const tasks = await taskStore.loadActiveTasks();
  if (!tasks.length) return [];
  const activities = await loadActivities(options);
  const { coordinator, transportConnected } = await loadCoordinator(options);

  const reports: BootRecoveryReport[] = [];
  const quarantined = await readQuarantine(taskStore.rootDir);
  for (const task of tasks) {
    // Owner-quarantined: preserved byte-for-byte. No status note, no transition, no replay.
    if (quarantined.has(task.taskId)) { reports.push({ taskId: task.taskId, decision: { kind: 'INPUT_REQUIRED', reason: 'Owner-quarantined historical task: effect unknown, replay forbidden, record preserved unchanged.' } }); continue; }
    // AMBIGUOUS is non-terminal, so it reaches boot again. Its record is supervised, never re-decided.
    if (task.state === 'AMBIGUOUS') {
      const activity = activities ? matchingActivity(task, activities) : undefined;
      const verdict = await verdictFor(activity, options);
      reports.push({ taskId: task.taskId, decision: await superviseAmbiguous(task, activity, verdict, matchingLease(task, coordinator), taskStore, options) });
      continue;
    }
    const activity = activities ? matchingActivity(task, activities) : undefined;
    const lease = matchingLease(task, coordinator);
    const ticket = matchingTicket(task, coordinator);
    const verdict = await verdictFor(activity, options);
    const liveActivity = verdict === 'SAME';
    const liveLease = Boolean(lease);
    const result = await hasVerifiedResult(task, results);
    // No activity evidence for a RUNNING task means its execution cannot be bounded: fail closed.
    const evidenceUnavailable = task.state === 'RUNNING' && activities === null;
    const unverifiable = task.state === 'RUNNING' && verdict === 'UNVERIFIABLE';
    const contradictory = evidenceUnavailable || unverifiable ||
      (task.state === 'RUNNING' && ((Boolean(activity) && !liveLease) || (task.safetyClass === 'PROCESS_UNKNOWN_EFFECT' && liveLease && !liveActivity)));
    const decision = decideBootRecovery({
      state: task.state,
      safetyClass: task.safetyClass ?? 'PROCESS_UNKNOWN_EFFECT',
      hasDurableResult: result,
      hasMatchingLiveActivity: liveActivity,
      hasMatchingLease: liveLease,
      hasMatchingQueueTicket: Boolean(ticket),
      processAlive: liveActivity,
      transportConnected,
      contradictoryEvidence: contradictory
    });
    reports.push({ taskId: task.taskId, decision });
    if (decision.kind === 'FINISH_FROM_DURABLE_EVIDENCE') {
      if (!['COMPLETED', 'FAILED', 'CANCELLED', 'RECONCILED'].includes(task.state)) {
        await taskStore.transition(task.taskId, 'COMPLETED', `Boot reconciliation completed the task from verified durable result evidence.`);
      }
    } else if (decision.kind === 'MONITOR_ORPHAN') {
      // RUNNING -> AMBIGUOUS. The orphan is monitored through its identity; the task is never completed or replayed.
      await taskStore.update(task.taskId, { failureClass: 'AMBIGUOUS_EFFECT' });
      await taskStore.transition(task.taskId, 'AMBIGUOUS', decision.reason);
      await keepLeaseWhileOrphanRuns(lease?.id, options);
    } else if (decision.kind === 'AMBIGUOUS' || decision.kind === 'DEGRADED') {
      if (task.state === 'RUNNING') {
        // DEGRADED (contradictory or unverifiable evidence) leaves the effect just as unknown as AMBIGUOUS does.
        await taskStore.update(task.taskId, { failureClass: 'AMBIGUOUS_EFFECT' });
        await taskStore.transition(task.taskId, 'AMBIGUOUS', decision.reason);
      }
      else if (task.summary.status !== decision.reason) await taskStore.update(task.taskId, { status: decision.reason });
    } else if (decision.kind === 'INPUT_REQUIRED') {
      if (task.state === 'RUNNING') await taskStore.transition(task.taskId, 'INPUT_REQUIRED', decision.reason);
      else if (task.summary.status !== decision.reason) await taskStore.update(task.taskId, { status: decision.reason });
    } else if (decision.kind === 'RETRY_SAFE' && task.state === 'RUNNING') {
      // A pure read with no execution evidence cannot have had an effect. Leaving it RUNNING would strand it:
      // it is recorded FAILED as a retryable transient outcome, and a retry is a new request.
      await taskStore.transition(task.taskId, 'FAILED', 'Boot found no execution evidence for an interrupted pure read; it may be retried under a new request.');
      await taskStore.update(task.taskId, { failureClass: 'TRANSIENT_TRANSPORT' });
    } else {
      await taskStore.update(task.taskId, { status: decision.reason });
    }
  }
  return reports;
}
