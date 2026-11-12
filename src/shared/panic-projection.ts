import type { WorkStatus } from './work-coordinator.js';
import type { ReachTaskRecord } from '../node/task-store.js';

/**
 * DEX//PANIC v1 read-only owner projection. This is a WHITELIST, not a redacted dump.
 * No PIDs, commands, paths, environment, actor IDs, task payloads, secret values,
 * root/branch, trace contents, tickets, or raw work-status output leave this boundary.
 */
const SAFE_LABEL = /^[A-Za-z0-9._+-]{1,48}$/;
const SUSPECT = /token|secret|password|apikey|api_key|credential|sk-proj/i;
const TASK_ID = /^rtsk_[0-9a-f]{11,13}_[0-9a-f]{16,32}$/;
const TASK_STATES = new Set([
  'ACCEPTED', 'PREPARING', 'RUNNING', 'INPUT_REQUIRED', 'AMBIGUOUS',
  'COMPLETED', 'FAILED', 'CANCELLED', 'RECONCILED'
]);
const NODE_IDS = new Set(['macbook-air.local', 'bigmac']);
const memStates = new Set(['healthy', 'warning', 'critical', 'unknown']);
const cpuStates = new Set(['healthy', 'busy', 'saturated', 'unknown']);
const thermalStates = new Set(['healthy', 'limited', 'unknown']);
const bounded = (value: unknown, max: number): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= max ? value : null;
const name = (value: unknown): string | null =>
  typeof value === 'string' && SAFE_LABEL.test(value) && !SUSPECT.test(value) ? value : null;

export function panicWorkProjection(status: WorkStatus): Record<string, unknown> {
  const reported = bounded(status.observed.uncoordinatedHeavy, 999);
  const details = status.observed.uncoordinatedDetails;
  const rows = Array.isArray(details) ? details : [];
  const groups = rows.length <= 24 ? rows.map((entry, index) => {
    const cpu = bounded(entry.cpu, 3200);
    const mem = bounded(entry.mem, 100);
    const members = Array.isArray(entry.pids) ? bounded(entry.pids.length, 64) : null;
    if (cpu === null || mem === null || members === null || members < 1 ||
        !['cpu', 'memory'].includes(entry.matchedBy)) return null;
    return {
      group: index + 1,
      processLabel: name(entry.processLabel) ?? 'withheld',
      cpu, mem, members,
      matchedBy: entry.matchedBy
    };
  }) : [];
  const complete = reported !== null && rows.length === reported && rows.length <= 24 &&
    groups.every(group => group !== null) && status.observed.processObservation !== 'unknown';
  const memory = status.capacity.livePressure.memory;
  const cpu = status.capacity.livePressure.cpu;
  const thermal = status.capacity.livePressure.thermal;
  return {
    schemaVersion: 1,
    observedAtUtc: new Date().toISOString(),
    observed: {
      processObservation: status.observed.processObservation === 'unknown' ? 'unknown' : 'observed',
      uncoordinatedHeavy: reported,
      detailsComplete: complete,
      uncoordinatedDetails: complete ? groups : []
    },
    capacity: {
      canAdmit: status.capacity.canAdmit === true,
      memory: memStates.has(memory) ? memory : 'unknown',
      cpu: cpuStates.has(cpu) ? cpu : 'unknown',
      thermal: thermalStates.has(thermal) ? thermal : 'unknown'
    }
  };
}

export function panicTaskProjection(tasks: readonly ReachTaskRecord[], nodeID: string): Record<string, unknown> {
  if (!NODE_IDS.has(nodeID)) throw new Error('panic task projection requires a fixed node id');
  const selected = tasks.filter(task => task.nodeId === nodeID).slice(0, 8);
  const rows = selected.map(task => {
    if (!TASK_ID.test(task.taskId) || !TASK_STATES.has(task.state) ||
        !Number.isFinite(Date.parse(task.updatedAtUtc))) return null;
    return {
      taskId: task.taskId,
      nodeId: nodeID,
      operation: name(task.operation) ?? 'withheld',
      state: task.state,
      updatedAtUtc: task.updatedAtUtc,
      resultRecorded: typeof task.resultRef === 'string' && typeof task.resultHash === 'string'
    };
  });
  return {
    schemaVersion: 1,
    nodeId: nodeID,
    observedAtUtc: new Date().toISOString(),
    complete: rows.every(row => row !== null),
    tasks: rows.every(row => row !== null) ? rows : []
  };
}
