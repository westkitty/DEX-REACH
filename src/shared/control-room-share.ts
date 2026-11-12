/**
 * Share-safe, explicitly allowlisted snapshot. NEVER stringify upstream task/trace objects:
 * they may contain argv, paths, credentials, opaque payloads, or actor IDs.
 * The caller has already resolved the owner-local node identity.
 */
const TASK_ID = /^rtsk_[0-9a-f]{11,13}_[0-9a-f]{16,32}$/;
const NODE_ID = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const TASK_STATES = new Set([
  'ACCEPTED', 'PREPARING', 'RUNNING', 'INPUT_REQUIRED', 'AMBIGUOUS',
  'COMPLETED', 'FAILED', 'CANCELLED', 'RECONCILED'
]);
const OPERATION = /^(?:dex\.(?:process\.run|fingerprint|trustReport|repoInfo|adbDevices|file\.read|file\.write|result\.read|receipts\.list|checkpoint|plan|commitPlan)|dc\.call)$/;
const ACCESS = new Set(['on', 'off', 'read-only']);
const GATEWAY = new Set(['connected', 'disconnected', 'unavailable']);
const COORDINATOR = new Set(['available', 'degraded', 'unavailable']);
const WORKER = new Set(['observed', 'not observed']);
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}
function fixed(value: unknown, allowed: ReadonlySet<string>): string {
  return typeof value === 'string' && allowed.has(value) ? value : 'not verified';
}
function id(value: unknown, pattern: RegExp): string {
  return typeof value === 'string' && pattern.test(value) ? value : 'withheld';
}
function count(value: unknown): string {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 100000
    ? String(value) : 'not inspected';
}
function stamp(value: unknown): string {
  if (typeof value !== 'string' || !ISO_UTC.test(value)) return 'not verified';
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : 'not verified';
}
function operation(value: unknown): string {
  return typeof value === 'string' && OPERATION.test(value) ? value : 'withheld';
}

export function formatControlRoomShareReport(snapshot: unknown, capturedAt = new Date()): string {
  const root = record(snapshot);
  const machine = record(root.machine);
  const tasks = record(root.tasks);
  const project = record(root.project);
  const connector = record(root.connector);
  const records = Array.isArray(tasks.recent) ? tasks.recent.slice(0, 8) : [];
  const localNode = id(machine.nodeId, NODE_ID);
  const lines = [
    'STINKY WEASEL CONTROL — SHARE-SAFE DIAGNOSTIC REPORT',
    'Format: 1 | Source: DEX//REACH owner-local Control Room | Read-only',
    'Captured (UTC): ' + capturedAt.toISOString(),
    'Overview generated (UTC): ' + stamp(root.generatedAt),
    'Machine node: ' + id(machine.nodeId, NODE_ID),
    'Node runtime identity: ' + id(machine.runtimeVersion, /^\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?$/),
    'Local node heartbeat: ' + stamp(machine.runtimeUpdatedAt),
    '',
    'LIVE OBSERVATIONS (not proof of task effects)',
    'Local node: ' + (machine.online === true ? 'reported online' : machine.online === false ? 'not confirmed online' : 'not verified'),
    'Gateway: ' + fixed(machine.gateway, GATEWAY),
    'Coordinator: ' + fixed(machine.coordinator, COORDINATOR),
    'Worker: ' + fixed(machine.worker, WORKER),
    'AI access mode: ' + fixed(machine.accessMode, ACCESS),
    'Active durable tasks: ' + count(tasks.active),
    'Coordinator queue depth: ' + count(machine.queueDepth),
    'Active coordinator leases: ' + count(machine.activeLeases),
    'Work admission: not independently verified in this report',
    'CPU pressure: not measured by this UI',
    'Memory pressure: not measured by this UI',
    '',
    'RECENT DURABLE TASK STATES (at most 8, no task arguments or results)'
  ];
  if (!records.length) lines.push('- No recent task records returned; this is not proof that none exist.');
  for (const value of records) {
    const row = record(value);
    if (localNode === 'withheld' || row.nodeId !== localNode) {
      lines.push('- Task record withheld: node identity does not match the selected local machine.');
      continue;
    }
    lines.push('- ' + stamp(row.updatedAtUtc) + ' | ' +
      id(row.taskId, TASK_ID) + ' | ' +
      operation(row.operation) + ' | ' +
      fixed(row.state, TASK_STATES));
  }
  lines.push(
    '',
    'SOURCE AND CONNECTOR PROVENANCE',
    'Source repository: westkitty/DEX-REACH',
    'Source revision: ' + id(project.head, /^[0-9a-f]{40}$/),
    'Public MCP and ChatGPT exposure: not independently measured by this UI',
    'Build, test, push, deploy and installed identity: not verified by this export',
    '',
    'INTERPRETATION LIMITS',
    'Service liveness is not job completion. COMPLETED is a recorded durable state; external effects require separate receipts.',
    'AMBIGUOUS and INPUT_REQUIRED records must not be blindly replayed.',
    'The report contains allowlisted state only, never raw task payloads, process args, PIDs, private paths, credentials, trace contents or result bodies.'
  );
  return lines.join('\n') + '\n';
}
