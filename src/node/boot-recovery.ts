import { listProcessActivities, type ProcessActivity } from '../shared/activity.js';
import { coordinatedStatus } from '../coordinator/client.js';
import { decideBootRecovery, type BootRecoveryDecision } from '../shared/task-recovery.js';
import type { WorkStatus } from '../shared/work-coordinator.js';
import { ResultStore } from './result-store.js';
import { NodeTaskStore, type ReachTaskRecord } from './task-store.js';

export type BootRecoveryReport = {
  taskId: string;
  decision: BootRecoveryDecision;
};

function processAlive(pid: number | undefined): boolean {
  if (!pid || !Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

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

export async function reconcileBootTasks(taskStore: NodeTaskStore, results: ResultStore): Promise<BootRecoveryReport[]> {
  const tasks = await taskStore.loadActiveTasks();
  if (!tasks.length) return [];
  const activities = await listProcessActivities({ includeFinished: true, limit: 500 });
  let coordinator: WorkStatus | null = null;
  let transportConnected = true;
  try { coordinator = await coordinatedStatus(); }
  catch { transportConnected = false; }

  const reports: BootRecoveryReport[] = [];
  for (const task of tasks) {
    const activity = matchingActivity(task, activities);
    const lease = matchingLease(task, coordinator);
    const ticket = matchingTicket(task, coordinator);
    const liveActivity = activity?.state === 'running';
    const liveLease = Boolean(lease);
    const result = await hasVerifiedResult(task, results);
    const contradictory = task.state === 'RUNNING' && ((Boolean(activity) && !liveLease) || (task.safetyClass === 'PROCESS_UNKNOWN_EFFECT' && liveLease && !liveActivity));
    const decision = decideBootRecovery({
      state: task.state,
      safetyClass: task.safetyClass ?? 'PROCESS_UNKNOWN_EFFECT',
      hasDurableResult: result,
      hasMatchingLiveActivity: liveActivity,
      hasMatchingLease: liveLease,
      hasMatchingQueueTicket: Boolean(ticket),
      processAlive: processAlive(activity?.pid ?? lease?.pid),
      transportConnected,
      contradictoryEvidence: contradictory
    });
    reports.push({ taskId: task.taskId, decision });
    if (decision.kind === 'FINISH_FROM_DURABLE_EVIDENCE') {
      if (!['COMPLETED', 'FAILED', 'CANCELLED', 'RECONCILED'].includes(task.state)) {
        await taskStore.transition(task.taskId, 'COMPLETED', `Boot reconciliation completed the task from verified durable result evidence.`);
      }
    } else if (decision.kind === 'AMBIGUOUS' || decision.kind === 'DEGRADED') {
      if (task.state === 'RUNNING') {
        if (decision.kind === 'AMBIGUOUS') await taskStore.update(task.taskId, { failureClass: 'AMBIGUOUS_EFFECT' });
        await taskStore.transition(task.taskId, 'AMBIGUOUS', decision.reason);
      }
      else if (task.summary.status !== decision.reason) await taskStore.update(task.taskId, { status: decision.reason });
    } else if (decision.kind === 'INPUT_REQUIRED') {
      if (task.state === 'RUNNING') await taskStore.transition(task.taskId, 'INPUT_REQUIRED', decision.reason);
      else if (task.summary.status !== decision.reason) await taskStore.update(task.taskId, { status: decision.reason });
    } else {
      await taskStore.update(task.taskId, { status: decision.reason });
    }
  }
  return reports;
}
