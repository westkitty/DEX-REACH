import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { machineStateDir } from './local-env.js';
import { atomicWriteFile, withFileLock } from './state-io.js';
import {
  type AccessClass,
  type MachineCapacity,
  type ObservedWorkloads,
  type WorkloadClass,
  classifyCpuPressure,
  classifyObservedWorkloads,
  evaluateCapacity,
  isSubstantive,
  observeProcessRows,
  probeHost
} from './machine-capacity.js';
import { recordCapacityHealth, type CapacityProfile } from './capacity-profile.js';
import { bundleBudget, isWorkBundle, legacyWorkBundle, normalizeWorkBundle, type WorkBundle } from './work-bundle.js';

export const WORK_EXECUTORS = ['claude-code', 'chatgpt', 'codex', 'grok', 'human', 'other'] as const;
export type WorkExecutor = (typeof WORK_EXECUTORS)[number];

export const WORK_ACCESS_CLASSES: readonly AccessClass[] = ['read', 'mutate', 'exclusive'];
export const WORK_WORKLOAD_CLASSES: readonly WorkloadClass[] = ['light', 'medium', 'heavy'];

/** Publish a heartbeat about this often. */
export const HEARTBEAT_INTERVAL_MS = 30_000;
/** A lease is only a reclaim candidate after several missed heartbeats, never after one late one. */
export const LEASE_STALE_MS = 5 * HEARTBEAT_INTERVAL_MS;
export const TICKET_STALE_MS = 5 * HEARTBEAT_INTERVAL_MS;
/** Bounded history so coordination state cannot grow without limit. */
export const HISTORY_LIMIT = 200;
export const EVENT_PAGE_LIMIT = 100;

export const WORK_EVENT_KINDS = [
  'ticket-enqueued', 'lease-acquired', 'lease-released', 'lease-reclaimed',
  'ticket-expired', 'ticket-cancelled', 'heartbeat', 'phase-progress',
  'cache-hit', 'cache-miss', 'classifier-result', 'request-rejected'
] as const;
export type WorkEventKind = (typeof WORK_EVENT_KINDS)[number];

export type WorkEvent = {
  cursor: number;
  at: string;
  event: WorkEventKind;
  id?: string;
  executor?: WorkExecutor;
  access?: AccessClass;
  workload?: WorkloadClass;
  phase?: string | null;
  reason?: string;
  forced?: boolean;
  observedUncoordinatedHeavy?: number;
  dexServices?: number;
};

export type WorkEventWindow = {
  cursor: number;
  startCursor: number;
  events: WorkEvent[];
  hasMore: boolean;
};

export type ObservationCacheMetrics = {
  hits: number;
  misses: number;
  hitRate: number;
};

const MAX_LABEL_LENGTH = 64;

/**
 * Coordination metadata only. There is deliberately no capability, grant, root, token, mode or
 * profile field here: holding a lease answers "can this run now?" and never "is this allowed?"
 * (DEX-INV-022).
 */
export type WorkLease = {
  id: string;
  pid: number;
  parentPid?: number;
  pidIsWorkload?: boolean;
  executor: WorkExecutor;
  repositoryRoot?: string;
  branch?: string;
  access: AccessClass;
  workload: WorkloadClass;
  bundle?: WorkBundle;
  phase?: string;
  createdAt: string;
  heartbeatAt: string;
};

export type WorkQueueTicket = {
  id: string;
  pid: number;
  pidIsWorkload?: boolean;
  executor: WorkExecutor;
  repositoryRoot?: string;
  access: AccessClass;
  workload: WorkloadClass;
  bundle?: WorkBundle;
  phase?: string;
  enqueuedAt: string;
  heartbeatAt: string;
};

/** Exact persisted key sets. Anything else is dropped on write and ignored on read. */
export const LEASE_FIELDS: readonly (keyof WorkLease)[] = [
  'id', 'pid', 'parentPid', 'pidIsWorkload', 'executor', 'repositoryRoot', 'branch', 'access', 'workload', 'bundle', 'phase', 'createdAt', 'heartbeatAt'
];
export const TICKET_FIELDS: readonly (keyof WorkQueueTicket)[] = [
  'id', 'pid', 'pidIsWorkload', 'executor', 'repositoryRoot', 'access', 'workload', 'bundle', 'phase', 'enqueuedAt', 'heartbeatAt'
];

export type WorkRequest = {
  executor: WorkExecutor;
  access: AccessClass;
  workload: WorkloadClass;
  bundle?: WorkBundle;
  repositoryRoot?: string;
  branch?: string;
  phase?: string;
  /** Present when re-attempting an existing queue position. */
  ticketId?: string;
  pid?: number;
  parentPid?: number;
  /**
   * Host measurement to decide against. Callers normally omit this and the host is measured here;
   * supplying it lets a caller reuse one measurement across a poll loop, and lets tests exercise
   * admission policy against a fixed host rather than whatever the runner happens to be doing.
   */
  snapshot?: CapacitySnapshot;
};

export type CoordinatorState = {
  leases: WorkLease[];
  tickets: WorkQueueTicket[];
  /** True when any coordination file was unreadable or malformed. Forces conservative admission. */
  degraded: boolean;
  degradedReasons: string[];
};

export type AdmissionResult =
  | { status: 'acquired'; lease: WorkLease; capacity: MachineCapacity }
  | { status: 'queued'; ticket: WorkQueueTicket; position: number; capacity: MachineCapacity; reasons: string[] };

export type WorkStatus = {
  capacity: MachineCapacity;
  leases: WorkLease[];
  tickets: WorkQueueTicket[];
  observed: ObservedWorkloads;
  degraded: boolean;
  degradedReasons: string[];
  eventWindow: WorkEventWindow;
  observationCache?: ObservationCacheMetrics;
};

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

export function coordinatorDir(): string { return path.join(machineStateDir(), 'coordinator'); }
/**
 * Local-user-only daemon transport. Unix socket names have a small platform limit, so the durable
 * state path is represented by a stable non-secret digest beneath the system temporary directory.
 * The daemon still verifies account ownership and applies 0600 permissions before serving it.
 */
export function coordinatorSocketPath(): string {
  const identity = crypto.createHash('sha256').update(machineStateDir()).digest('hex').slice(0, 20);
  return path.join(os.tmpdir(), `dex-reach-coord-${identity}.sock`);
}
export function leasesDir(): string { return path.join(coordinatorDir(), 'leases'); }
export function queueDir(): string { return path.join(coordinatorDir(), 'queue'); }
export function historyFile(): string { return path.join(coordinatorDir(), 'history', 'events.jsonl'); }
export function coordinatorLockFile(): string { return path.join(coordinatorDir(), 'coordinator.lock'); }
export function historyLockFile(): string { return path.join(coordinatorDir(), 'history', 'events.lock'); }

async function ensureLayout(): Promise<void> {
  for (const dir of [coordinatorDir(), leasesDir(), queueDir(), path.dirname(historyFile())]) {
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  }
}

// ---------------------------------------------------------------------------
// Input validation. Coordination metadata is coordination metadata: no prompt
// bodies, no transcripts, no credentials (DEX-INV-026).
// ---------------------------------------------------------------------------

const SAFE_LABEL = /^[A-Za-z0-9._\-/ ]+$/;

/**
 * Reject values that look like credential material. A label is a short human word such as
 * "phase-0a" or "verify"; a long mixed-case alphanumeric run is a token, not a label.
 */
export function looksLikeSecretMaterial(value: string): boolean {
  for (const token of value.split(/[^A-Za-z0-9]+/)) {
    if (token.length < 20) continue;
    if (/[a-z]/.test(token) && /[A-Z]/.test(token) && /\d/.test(token)) return true;
  }
  return false;
}

export function sanitizeLabel(value: string | undefined, field: string): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (trimmed.length > MAX_LABEL_LENGTH) throw new Error(`${field} must be at most ${MAX_LABEL_LENGTH} characters; it is a short label, not free text`);
  if (!SAFE_LABEL.test(trimmed)) throw new Error(`${field} may contain only letters, digits, spaces and . _ - /`);
  if (looksLikeSecretMaterial(trimmed)) throw new Error(`${field} looks like credential material; coordination state stores labels only`);
  return trimmed;
}

/** Canonical absolute repository path so two spellings of the same repo cannot both hold it. */
export async function canonicalRepositoryRoot(value: string | undefined): Promise<string | undefined> {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const resolved = path.resolve(trimmed);
  try {
    return await fs.realpath(resolved);
  } catch {
    return resolved;
  }
}

function assertMember<T extends string>(value: string, allowed: readonly T[], field: string): T {
  if (!(allowed as readonly string[]).includes(value)) throw new Error(`${field} must be one of: ${allowed.join(', ')}`);
  return value as T;
}

// ---------------------------------------------------------------------------
// Reading and writing coordination state
// ---------------------------------------------------------------------------

function pick<T extends object>(source: Record<string, unknown>, fields: readonly (keyof T)[]): T {
  const out: Record<string, unknown> = {};
  for (const field of fields) {
    const value = source[field as string];
    if (value !== undefined) out[field as string] = value;
  }
  return out as T;
}

function validLease(raw: unknown): WorkLease | null {
  if (!raw || typeof raw !== 'object') return null;
  const record = raw as Record<string, unknown>;
  if (typeof record.id !== 'string' || !record.id) return null;
  if (typeof record.pid !== 'number' || !Number.isInteger(record.pid) || record.pid <= 0) return null;
  if (typeof record.createdAt !== 'string' || typeof record.heartbeatAt !== 'string') return null;
  if (!WORK_EXECUTORS.includes(record.executor as WorkExecutor)) return null;
  if (!WORK_ACCESS_CLASSES.includes(record.access as AccessClass)) return null;
  if (!WORK_WORKLOAD_CLASSES.includes(record.workload as WorkloadClass)) return null;
  if (record.bundle !== undefined && !isWorkBundle(record.bundle)) return null;
  return pick<WorkLease>(record, LEASE_FIELDS);
}

function validTicket(raw: unknown): WorkQueueTicket | null {
  if (!raw || typeof raw !== 'object') return null;
  const record = raw as Record<string, unknown>;
  if (typeof record.id !== 'string' || !record.id) return null;
  if (typeof record.pid !== 'number' || !Number.isInteger(record.pid) || record.pid <= 0) return null;
  if (typeof record.enqueuedAt !== 'string' || typeof record.heartbeatAt !== 'string') return null;
  if (!WORK_EXECUTORS.includes(record.executor as WorkExecutor)) return null;
  if (!WORK_ACCESS_CLASSES.includes(record.access as AccessClass)) return null;
  if (!WORK_WORKLOAD_CLASSES.includes(record.workload as WorkloadClass)) return null;
  if (record.bundle !== undefined && !isWorkBundle(record.bundle)) return null;
  return pick<WorkQueueTicket>(record, TICKET_FIELDS);
}

async function readDirEntries(dir: string): Promise<string[]> {
  try {
    return (await fs.readdir(dir)).filter(name => name.endsWith('.json'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

/**
 * Read all coordination state. A malformed or unreadable file never widens admission: it marks the
 * coordinator degraded, which collapses capacity to a single substantive job (DEX-INV-024).
 */
export async function readCoordinatorState(): Promise<CoordinatorState> {
  const leases: WorkLease[] = [];
  const tickets: WorkQueueTicket[] = [];
  const degradedReasons: string[] = [];

  for (const name of await readDirEntries(leasesDir())) {
    try {
      const lease = validLease(JSON.parse(await fs.readFile(path.join(leasesDir(), name), 'utf8')));
      if (lease) leases.push(lease);
      else degradedReasons.push(`lease file ${name} is malformed`);
    } catch {
      degradedReasons.push(`lease file ${name} is unreadable`);
    }
  }
  for (const name of await readDirEntries(queueDir())) {
    try {
      const ticket = validTicket(JSON.parse(await fs.readFile(path.join(queueDir(), name), 'utf8')));
      if (ticket) tickets.push(ticket);
      else degradedReasons.push(`queue file ${name} is malformed`);
    } catch {
      degradedReasons.push(`queue file ${name} is unreadable`);
    }
  }

  tickets.sort((a, b) => (a.enqueuedAt === b.enqueuedAt ? a.id.localeCompare(b.id) : a.enqueuedAt.localeCompare(b.enqueuedAt)));
  return { leases, tickets, degraded: degradedReasons.length > 0, degradedReasons };
}

export function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to another user.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * A lease is reclaimable only when its heartbeat is well past due AND its recorded process is gone.
 * Reclaiming means the coordination claim expired; it never means terminate that workload
 * (DEX-INV-025).
 */
export function leaseIsReclaimable(lease: WorkLease, now = Date.now()): boolean {
  const age = now - Date.parse(lease.heartbeatAt);
  if (!Number.isFinite(age) || age <= LEASE_STALE_MS) return false;
  return !processAlive(lease.pid);
}

function ticketIsStale(ticket: WorkQueueTicket, now = Date.now()): boolean {
  const age = now - Date.parse(ticket.heartbeatAt);
  if (!Number.isFinite(age)) return true;
  return age > TICKET_STALE_MS && !processAlive(ticket.pid);
}

function safeEventId(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new Error('work event id must be a string');
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 128 || !/^[A-Za-z0-9._:-]+$/.test(trimmed)) throw new Error('work event id is not a bounded identifier');
  return trimmed;
}

function safeEventReason(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new Error('work event reason must be a string');
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 96 || !/^[A-Za-z0-9._: -]+$/.test(trimmed)) throw new Error('work event reason is not a safe label');
  return trimmed;
}

function validWorkEvent(raw: unknown): WorkEvent | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  if (!Number.isInteger(value.cursor) || Number(value.cursor) <= 0) return null;
  if (typeof value.at !== 'string' || !Number.isFinite(Date.parse(value.at))) return null;
  if (!(WORK_EVENT_KINDS as readonly unknown[]).includes(value.event)) return null;
  try {
    const event: WorkEvent = {
      cursor: Number(value.cursor),
      at: value.at,
      event: value.event as WorkEventKind
    };
    const id = safeEventId(value.id); if (id) event.id = id;
    if (value.executor !== undefined) {
      if (!WORK_EXECUTORS.includes(value.executor as WorkExecutor)) return null;
      event.executor = value.executor as WorkExecutor;
    }
    if (value.access !== undefined) {
      if (!WORK_ACCESS_CLASSES.includes(value.access as AccessClass)) return null;
      event.access = value.access as AccessClass;
    }
    if (value.workload !== undefined) {
      if (!WORK_WORKLOAD_CLASSES.includes(value.workload as WorkloadClass)) return null;
      event.workload = value.workload as WorkloadClass;
    }
    if (value.phase === null) event.phase = null;
    else if (value.phase !== undefined) event.phase = sanitizeLabel(String(value.phase), 'phase') ?? null;
    const reason = safeEventReason(value.reason); if (reason) event.reason = reason;
    if (typeof value.forced === 'boolean') event.forced = value.forced;
    if (Number.isInteger(value.observedUncoordinatedHeavy) && Number(value.observedUncoordinatedHeavy) >= 0) event.observedUncoordinatedHeavy = Number(value.observedUncoordinatedHeavy);
    if (Number.isInteger(value.dexServices) && Number(value.dexServices) >= 0) event.dexServices = Number(value.dexServices);
    return event;
  } catch {
    return null;
  }
}

async function storedWorkEvents(): Promise<WorkEvent[]> {
  try {
    return (await fs.readFile(historyFile(), 'utf8')).split('\n').filter(Boolean)
      .map(line => { try { return validWorkEvent(JSON.parse(line)); } catch { return null; } })
      .filter((event): event is WorkEvent => Boolean(event))
      .sort((a, b) => a.cursor - b.cursor);
  } catch {
    return [];
  }
}

export async function recordWorkEvent(input: Omit<Partial<WorkEvent>, 'cursor' | 'at'> & { event: WorkEventKind }): Promise<WorkEvent> {
  await ensureLayout();
  return withFileLock(historyLockFile(), async () => {
    const current = await storedWorkEvents();
    const cursor = (current[current.length - 1]?.cursor ?? 0) + 1;
    const candidate = validWorkEvent({ ...input, cursor, at: new Date().toISOString() });
    if (!candidate) throw new Error('work event failed safe-field validation');
    const next = [...current, candidate].slice(-HISTORY_LIMIT);
    await atomicWriteFile(historyFile(), next.map(event => JSON.stringify(event)).join('\n') + '\n');
    return candidate;
  }, { timeoutMs: 5_000 });
}

export async function readWorkEvents(afterCursor = 0, limit = EVENT_PAGE_LIMIT): Promise<WorkEventWindow> {
  const safeCursor = Number.isInteger(afterCursor) && afterCursor >= 0 ? afterCursor : 0;
  const safeLimit = Number.isInteger(limit) ? Math.max(1, Math.min(limit, EVENT_PAGE_LIMIT)) : EVENT_PAGE_LIMIT;
  const stored = await storedWorkEvents();
  const latest = stored[stored.length - 1]?.cursor ?? 0;
  const eligible = stored.filter(event => event.cursor > safeCursor);
  const events = eligible.slice(0, safeLimit);
  return {
    cursor: latest,
    startCursor: stored[0]?.cursor ?? latest,
    events,
    hasMore: eligible.length > events.length
  };
}

async function writeLease(lease: WorkLease): Promise<void> {
  await atomicWriteFile(path.join(leasesDir(), `${lease.id}.json`), JSON.stringify(pick<WorkLease>(lease as unknown as Record<string, unknown>, LEASE_FIELDS), null, 2) + '\n');
}
async function writeTicket(ticket: WorkQueueTicket): Promise<void> {
  await atomicWriteFile(path.join(queueDir(), `${ticket.id}.json`), JSON.stringify(pick<WorkQueueTicket>(ticket as unknown as Record<string, unknown>, TICKET_FIELDS), null, 2) + '\n');
}
async function removeLeaseFile(id: string): Promise<void> { await fs.rm(path.join(leasesDir(), `${id}.json`), { force: true }); }
async function removeTicketFile(id: string): Promise<void> { await fs.rm(path.join(queueDir(), `${id}.json`), { force: true }); }

/** Drop expired coordination claims. Returns the surviving state. */
async function pruneExpired(state: CoordinatorState, now = Date.now()): Promise<CoordinatorState> {
  const leases: WorkLease[] = [];
  for (const lease of state.leases) {
    if (leaseIsReclaimable(lease, now)) {
      await removeLeaseFile(lease.id);
      await recordWorkEvent({ event: 'lease-reclaimed', id: lease.id, executor: lease.executor, reason: 'heartbeat expired and process absent' });
    } else {
      leases.push(lease);
    }
  }
  const tickets: WorkQueueTicket[] = [];
  for (const ticket of state.tickets) {
    if (ticketIsStale(ticket, now)) {
      await removeTicketFile(ticket.id);
      await recordWorkEvent({ event: 'ticket-expired', id: ticket.id, executor: ticket.executor });
    } else {
      tickets.push(ticket);
    }
  }
  return { ...state, leases, tickets };
}

// ---------------------------------------------------------------------------
// Admission
// ---------------------------------------------------------------------------

export type CapacitySnapshot = {
  physicalMemoryBytes: number;
  logicalCpuCount: number;
  loadAverage1m: number | null;
  memory: MachineCapacity['livePressure']['memory'];
  thermal: MachineCapacity['livePressure']['thermal'];
  observed: ObservedWorkloads;
  profile?: CapacityProfile;
  interactiveReady?: boolean;
  healthyForMs?: number;
};

/**
 * Measure the host outside the coordinator lock. The state lock and the workload lease are not the
 * same thing: the lock is held only long enough to reserve capacity.
 */
export async function snapshotCapacity(): Promise<CapacitySnapshot> {
  const state = await readCoordinatorState().catch(() => ({ leases: [] as WorkLease[] }));
  const [probe, rows] = await Promise.all([probeHost(), observeProcessRows()]);
  const observed = classifyObservedWorkloads(rows, { leasedPids: state.leases.map(lease => lease.pid) });
  const health = await recordCapacityHealth({
    memory: probe.memory,
    cpu: classifyCpuPressure(probe.loadAverage1m, probe.logicalCpuCount),
    thermal: probe.thermal,
    observedUncoordinatedHeavy: observed.uncoordinatedHeavy
  });
  return {
    physicalMemoryBytes: probe.physicalMemoryBytes,
    logicalCpuCount: probe.logicalCpuCount,
    loadAverage1m: probe.loadAverage1m,
    memory: probe.memory,
    thermal: probe.thermal,
    observed,
    ...health
  };
}

/**
 * Pure admission decision over a state and a host snapshot. Kept separate from persistence so the
 * policy is inspectable and testable without touching the filesystem.
 */
export function decideAdmission(
  state: CoordinatorState,
  snapshot: CapacitySnapshot,
  request: { access: AccessClass; workload: WorkloadClass; bundle?: WorkBundle; repositoryRoot?: string; ticketId?: string }
): { admit: boolean; capacity: MachineCapacity; reasons: string[] } {
  const blocking: string[] = [];
  const substantive = isSubstantive(request.workload, request.access);

  // Corrupt or unreadable coordination state collapses to one substantive job (DEX-INV-024).
  const degradedPenalty = state.degraded && substantive ? 1 : 0;
  if (state.degraded && substantive) blocking.push(`coordinator state degraded (${state.degradedReasons.length} unreadable entr${state.degradedReasons.length === 1 ? 'y' : 'ies'}); falling back to single-substantive-job mode`);

  // Repository mutation ownership is exclusive (DEX-INV-023).
  if (request.access !== 'read' && request.repositoryRoot) {
    const holder = state.leases.find(lease => lease.repositoryRoot === request.repositoryRoot && lease.access !== 'read');
    if (holder) blocking.push(`repository ${request.repositoryRoot} is held for ${holder.access} by lease ${holder.id} (${holder.executor})`);
  }

  // Installation/deployment style work is machine-exclusive.
  if (request.access === 'exclusive' && state.leases.length > 0) {
    blocking.push(`exclusive work requires an otherwise idle machine; ${state.leases.length} lease(s) active`);
  }
  const machineExclusive = state.leases.find(lease => lease.access === 'exclusive');
  if (machineExclusive && substantive) {
    blocking.push(`lease ${machineExclusive.id} holds the machine exclusively`);
  }

  // FIFO: a new substantive request goes behind live tickets. Releasing and reacquiring therefore
  // cannot jump the queue. Light read-only inspection is exempt because it takes no slot.
  if (substantive) {
    const ahead = state.tickets.filter(ticket => ticket.id !== request.ticketId);
    const mine = request.ticketId ? state.tickets.findIndex(ticket => ticket.id === request.ticketId) : -1;
    const blockedBy = mine >= 0 ? state.tickets.slice(0, mine) : ahead;
    if (blockedBy.length) blocking.push(`${blockedBy.length} ticket(s) queued ahead`);
  }

  const activeSubstantive = state.leases.filter(lease => isSubstantive(lease.workload, lease.access)).length + degradedPenalty;
  const activeHeavy = state.leases.filter(lease => lease.workload === 'heavy').length + degradedPenalty;
  const requestedBundle = normalizeWorkBundle(request.workload, request.access, request.bundle);
  const usedBundles = state.leases.map(lease => normalizeWorkBundle(lease.workload, lease.access, lease.bundle));
  const budget = bundleBudget(snapshot.physicalMemoryBytes, snapshot.logicalCpuCount);
  const usedCpu = usedBundles.reduce((sum, bundle) => sum + bundle.cpuUnits, 0);
  const usedMemory = usedBundles.reduce((sum, bundle) => sum + bundle.memoryMiB, 0);
  if (usedCpu + requestedBundle.cpuUnits > budget.cpuUnits) blocking.push(`CPU bundle budget exhausted (${usedCpu}/${budget.cpuUnits} units active; request ${requestedBundle.cpuUnits})`);
  if (usedMemory + requestedBundle.memoryMiB > budget.memoryMiB) blocking.push(`memory bundle budget exhausted (${usedMemory}/${budget.memoryMiB} MiB active; request ${requestedBundle.memoryMiB})`);
  if (requestedBundle.io === 'high' && usedBundles.some(bundle => bundle.io === 'high')) blocking.push('high-I/O bundle already active');
  if (requestedBundle.network === 'heavy' && usedBundles.some(bundle => bundle.network === 'heavy')) blocking.push('heavy-network bundle already active');

  const capacity = evaluateCapacity(
    {
      physicalMemoryBytes: state.degraded ? 0 : snapshot.physicalMemoryBytes,
      logicalCpuCount: state.degraded ? 0 : snapshot.logicalCpuCount,
      loadAverage1m: snapshot.loadAverage1m,
      memory: snapshot.memory,
      thermal: snapshot.thermal
    },
    { activeSubstantive, activeHeavy, observedUncoordinatedHeavy: snapshot.observed.uncoordinatedHeavy },
    { workload: request.workload, access: request.access, profile: snapshot.profile, interactiveReady: snapshot.interactiveReady }
  );

  if (!capacity.canAdmit) blocking.push(...capacity.reasons);
  const reasons = blocking.length ? [...new Set(blocking)] : capacity.reasons;
  return { admit: blocking.length === 0, capacity, reasons };
}

/**
 * Reserve capacity, or take a queue position. Admission never grants execution authority: a job may
 * be AUTHORIZED but QUEUED, or admitted here and still refused by DEX policy (DEX-INV-022).
 */
export async function acquireWork(request: WorkRequest): Promise<AdmissionResult> {
  const executor = assertMember(request.executor, WORK_EXECUTORS, 'executor');
  const access = assertMember(request.access, WORK_ACCESS_CLASSES, 'access');
  const workload = assertMember(request.workload, WORK_WORKLOAD_CLASSES, 'workload');
  const bundle = normalizeWorkBundle(workload, access, request.bundle);
  const phase = sanitizeLabel(request.phase, 'phase');
  const branch = sanitizeLabel(request.branch, 'branch');
  const repositoryRoot = await canonicalRepositoryRoot(request.repositoryRoot);
  const pid = request.pid ?? process.pid;
  const parentPid = request.parentPid ?? process.ppid;

  if (access !== 'read' && !repositoryRoot && access === 'mutate') {
    throw new Error('mutating work must name the repository it will mutate (--repo)');
  }

  await ensureLayout();
  const snapshot = request.snapshot ?? (await snapshotCapacity());

  return withFileLock(coordinatorLockFile(), async () => {
    const state = await pruneExpired(await readCoordinatorState());
    const decision = decideAdmission(state, snapshot, { access, workload, bundle, repositoryRoot, ticketId: request.ticketId });
    const now = new Date().toISOString();

    if (decision.admit) {
      const lease: WorkLease = {
        id: `lease-${crypto.randomUUID()}`,
        pid,
        ...(Number.isInteger(parentPid) && parentPid > 0 ? { parentPid } : {}),
        pidIsWorkload: request.pid !== undefined,
        executor,
        ...(repositoryRoot ? { repositoryRoot } : {}),
        ...(branch ? { branch } : {}),
        access,
        workload,
        bundle,
        ...(phase ? { phase } : {}),
        createdAt: now,
        heartbeatAt: now
      };
      await writeLease(lease);
      if (request.ticketId) await removeTicketFile(request.ticketId);
      await recordWorkEvent({ event: 'lease-acquired', id: lease.id, executor, access, workload, phase: phase ?? null });
      return { status: 'acquired', lease, capacity: decision.capacity };
    }

    const existing = request.ticketId ? state.tickets.find(ticket => ticket.id === request.ticketId) : undefined;
    const ticket: WorkQueueTicket = existing
      ? { ...existing, heartbeatAt: now }
      : {
          id: `ticket-${crypto.randomUUID()}`,
          pid,
          pidIsWorkload: request.pid !== undefined,
          executor,
          ...(repositoryRoot ? { repositoryRoot } : {}),
          access,
          workload,
          bundle,
          ...(phase ? { phase } : {}),
          enqueuedAt: now,
          heartbeatAt: now
        };
    await writeTicket(ticket);
    if (!existing) await recordWorkEvent({ event: 'ticket-enqueued', id: ticket.id, executor, access, workload });

    const queue = existing ? state.tickets : [...state.tickets, ticket];
    const position = queue.findIndex(entry => entry.id === ticket.id) + 1;
    return { status: 'queued', ticket, position, capacity: decision.capacity, reasons: decision.reasons };
  }, { timeoutMs: 15_000 });
}

export type ReleaseResult = { released: boolean; reason?: string };

/**
 * Release a lease. By default only the holding process may release its own lease; `force` is a
 * local owner override and is never available to a remote caller.
 */
export async function releaseWork(leaseId: string, options: { pid?: number; force?: boolean } = {}): Promise<ReleaseResult> {
  await ensureLayout();
  return withFileLock(coordinatorLockFile(), async () => {
    const state = await readCoordinatorState();
    const lease = state.leases.find(entry => entry.id === leaseId);
    if (!lease) return { released: false, reason: `no active lease ${leaseId}` };
    const pid = options.pid ?? process.pid;
    if (!options.force && lease.pid !== pid && processAlive(lease.pid)) {
      return { released: false, reason: `lease ${leaseId} belongs to live pid ${lease.pid}; use --force as the local owner to override` };
    }
    await removeLeaseFile(leaseId);
    await recordWorkEvent({ event: 'lease-released', id: leaseId, executor: lease.executor, forced: Boolean(options.force) });
    return { released: true };
  }, { timeoutMs: 15_000 });
}

export async function heartbeat(id: string): Promise<boolean> {
  await ensureLayout();
  return withFileLock(coordinatorLockFile(), async () => {
    const state = await readCoordinatorState();
    const now = new Date().toISOString();
    const lease = state.leases.find(entry => entry.id === id);
    if (lease) {
      await writeLease({ ...lease, heartbeatAt: now });
      await recordWorkEvent({
        event: lease.phase ? 'phase-progress' : 'heartbeat',
        id: lease.id,
        executor: lease.executor,
        access: lease.access,
        workload: lease.workload,
        phase: lease.phase ?? null
      });
      return true;
    }
    const ticket = state.tickets.find(entry => entry.id === id);
    if (ticket) {
      await writeTicket({ ...ticket, heartbeatAt: now });
      await recordWorkEvent({
        event: ticket.phase ? 'phase-progress' : 'heartbeat',
        id: ticket.id,
        executor: ticket.executor,
        access: ticket.access,
        workload: ticket.workload,
        phase: ticket.phase ?? null
      });
      return true;
    }
    return false;
  }, { timeoutMs: 15_000 });
}

/** Cancel exactly one ticket: the caller's. Cancelling never touches another waiter's position. */
export async function cancelTicket(ticketId: string): Promise<boolean> {
  await ensureLayout();
  return withFileLock(coordinatorLockFile(), async () => {
    const state = await readCoordinatorState();
    if (!state.tickets.some(ticket => ticket.id === ticketId)) return false;
    await removeTicketFile(ticketId);
    await recordWorkEvent({ event: 'ticket-cancelled', id: ticketId });
    return true;
  }, { timeoutMs: 15_000 });
}

export async function workStatus(options: { snapshot?: CapacitySnapshot } = {}): Promise<WorkStatus> {
  await ensureLayout();
  const snapshot = options.snapshot ?? (await snapshotCapacity());
  const state = await pruneExpired(await readCoordinatorState());
  const decision = decideAdmission(state, snapshot, { access: 'mutate', workload: 'medium' });
  return {
    capacity: decision.capacity,
    leases: state.leases,
    tickets: state.tickets,
    observed: snapshot.observed,
    degraded: state.degraded,
    degradedReasons: state.degradedReasons,
    eventWindow: await readWorkEvents(0, HISTORY_LIMIT)
  };
}

/**
 * Share-safe projection. Repository paths, branches, PIDs and host memory size are local details
 * and stay out of anything intended to leave the machine (DEX-INV-026).
 */
function aggregateBundles(entries: Array<Pick<WorkLease, 'workload' | 'access' | 'bundle'>>): Record<string, number> {
  const bundles = entries.map(entry => normalizeWorkBundle(entry.workload, entry.access, entry.bundle));
  return {
    cpuUnits: bundles.reduce((sum, bundle) => sum + bundle.cpuUnits, 0),
    memoryMiB: bundles.reduce((sum, bundle) => sum + bundle.memoryMiB, 0),
    highIo: bundles.filter(bundle => bundle.io === 'high').length,
    heavyNetwork: bundles.filter(bundle => bundle.network === 'heavy').length,
    repositoryWrites: bundles.filter(bundle => bundle.repositoryWrite).length,
    machineExclusive: bundles.filter(bundle => bundle.machineExclusive).length
  };
}

export function redactWorkStatusForShare(status: WorkStatus): Record<string, unknown> {
  const waits = status.tickets.map(ticket => Math.max(0, Date.now() - Date.parse(ticket.enqueuedAt))).sort((a, b) => a - b);
  const percentile = (fraction: number) => waits.length ? waits[Math.min(waits.length - 1, Math.floor((waits.length - 1) * fraction))]! : 0;
  const recentEvents = status.eventWindow.events.slice(-32);
  return {
    substantiveSlots: status.capacity.substantiveSlots,
    heavySlots: status.capacity.heavySlots,
    logicalCpuCount: status.capacity.logicalCpuCount,
    livePressure: status.capacity.livePressure,
    activeLeases: status.leases.length,
    activeHeavy: status.capacity.activeHeavy,
    queueDepth: status.tickets.length,
    queueLatencyMs: { oldest: waits[waits.length - 1] ?? 0, p50: percentile(0.5), p95: percentile(0.95) },
    activeBundleTotals: aggregateBundles(status.leases),
    queuedBundleTotals: aggregateBundles(status.tickets),
    eventCursor: status.eventWindow.cursor,
    eventWindowStartCursor: recentEvents[0]?.cursor ?? status.eventWindow.cursor,
    events: recentEvents,
    ...(status.observationCache ? { observationCache: status.observationCache } : {}),
    observedUncoordinatedHeavy: status.observed.uncoordinatedHeavy,
    dexServices: status.observed.dexServices,
    degraded: status.degraded
  };
}

/** One-line human summary for `dex status` and, later, `dex doctor`. */
export function describeWorkStatus(status: WorkStatus): string[] {
  const held = status.leases.map(lease => {
    const where = lease.repositoryRoot ? path.basename(lease.repositoryRoot) : 'machine';
    const process = lease.pidIsWorkload ? ` / pid ${lease.pid}` : '';
    return `  ${lease.id.slice(0, 14)}… ${lease.executor.padEnd(11)} ${where} / ${lease.workload} / ${lease.access}${lease.phase ? ` / ${lease.phase}` : ''}${process}`;
  });
  return [
    `Machine capacity: ${status.capacity.substantiveSlots} substantive slot${status.capacity.substantiveSlots === 1 ? '' : 's'}, ${status.capacity.heavySlots} heavy`,
    `Capacity profile: ${status.capacity.profile}${status.capacity.profile === 'interactive' ? status.capacity.interactiveReady ? ' (ready)' : ' (warming)' : ''}`,
    `Host:             ${(status.capacity.physicalMemoryBytes / 1024 ** 3).toFixed(1)} GiB RAM, ${status.capacity.logicalCpuCount} logical CPUs (${os.hostname()})`,
    `Memory pressure:  ${status.capacity.livePressure.memory}`,
    `CPU pressure:     ${status.capacity.livePressure.cpu}`,
    `Thermal:          ${status.capacity.livePressure.thermal}`,
    `Active leases:    ${status.leases.length}`,
    ...(held.length ? held : ['  (none)']),
    `Queue depth:      ${status.tickets.length}`,
    `Uncoordinated heavy jobs: ${status.observed.uncoordinatedHeavy}`,
    ...(status.observed.uncoordinatedDetails?.map(item => `  pid ${item.pid} ${item.processLabel} (${item.pids.length} process(es), ${item.matchedBy} threshold)`) ?? []),
    `DEX services observed:    ${status.observed.dexServices}`,
    ...(status.degraded ? ['Coordinator:      DEGRADED — conservative single-substantive-job mode', ...status.degradedReasons.map(reason => `  ${reason}`)] : [])
  ];
}
