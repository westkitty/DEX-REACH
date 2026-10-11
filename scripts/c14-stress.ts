import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { NodeTaskStore, taskStoreFile } from '../src/node/task-store.js';
import { ResultStore } from '../src/node/result-store.js';
import { reconcileBootTasks } from '../src/node/boot-recovery.js';
import { decideExistingTask, type ExistingTaskBinding } from '../src/shared/durable-execution.js';
import { machineStateDir, stateDir } from '../src/shared/local-env.js';
import { TaskEventLog, taskEventFile } from '../src/shared/task-events.js';
import {
  acquireWork, cancelTicket, coordinatorDir, coordinatorSocketPath, historyFile, leasesDir, queueDir,
  readCoordinatorState, readWorkEvents, releaseWork, type CapacitySnapshot
} from '../src/shared/work-coordinator.js';

type Op = { count: number; failures: number; samples: number[] };
type Interval = {
  elapsedMs: number; completedCycles: number; failedCycles: number;
  operations: Record<string, { count: number; failures: number; medianMs: number; p95Ms: number }>;
  rssBytes: number; heapUsedBytes: number; externalBytes: number;
  cpuUserMicros: number; cpuSystemMicros: number;
  activeLeases: number; queuedTickets: number; nonterminalTasks: number; ambiguousTasks: number;
  taskStoreBytes: number; resultStoreBytes: number; eventLogBytes: number;
  coordinatorHistoryBytes: number; eventWindowCount: number;
};

const GIB = 1024 ** 3;
const MIB = 1024 ** 2;
const NODE_ID = 'c14-stress-node';
const ACTOR_ID = 'c14-stress-actor';
const POLICY_HASH = 'e'.repeat(64);
const SAMPLE_INTERVAL_MS = 5_000;
const RESULT_TTL_MS = 60_000;

function numberArg(name: string, fallback: number): number {
  const raw = process.argv.find(value => value.startsWith('--' + name + '='));
  const parsed = raw === undefined ? fallback : Number(raw.split('=')[1]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
function flag(name: string): boolean { return process.argv.includes('--' + name); }
function sourceIdentity(): { branch: string; commit: string } {
  const git = (args: string[]) => execFileSync('git', args, { encoding: 'utf8' }).trim();
  return { branch: git(['rev-parse', '--abbrev-ref', 'HEAD']), commit: git(['rev-parse', 'HEAD']) };
}
function taskId(sequence: number): string {
  const hex = sequence.toString(16);
  return 'rtsk_' + hex.padStart(11, '0') + '_' + hex.padStart(16, '0');
}
function payloadHash(value: unknown): string {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
function percentile(values: readonly number[], fraction: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1));
  return sorted[index] ?? 0;
}
function opSummary(value: Op): { count: number; failures: number; medianMs: number; p95Ms: number } {
  return { count: value.count, failures: value.failures, medianMs: percentile(value.samples, 0.5), p95Ms: percentile(value.samples, 0.95) };
}
function capacitySnapshot(): CapacitySnapshot {
  return {
    physicalMemoryBytes: os.totalmem(), logicalCpuCount: Math.max(4, os.cpus().length),
    loadAverage1m: 0, memory: 'healthy', thermal: 'healthy',
    observed: { uncoordinatedHeavy: 0, dexServices: 0 }, profile: 'conservative', interactiveReady: false
  };
}
async function statBytes(file: string): Promise<number> {
  try { return (await fs.stat(file)).size; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0; throw error; }
}
async function treeBytes(root: string): Promise<number> {
  let names: string[];
  try { names = await fs.readdir(root); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0; throw error; }
  let total = 0;
  for (const name of names) {
    const file = path.join(root, name);
    let info;
    try { info = await fs.stat(file); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
    total += info.isDirectory() ? await treeBytes(file) : info.size;
  }
  return total;
}
async function present(file: string): Promise<boolean> {
  try { await fs.access(file); return true; } catch { return false; }
}
function within(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
}
async function fingerprint(file: string): Promise<{ exists: boolean; size: number; sha256: string | null }> {
  try {
    const bytes = await fs.readFile(file);
    return { exists: true, size: bytes.byteLength, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { exists: false, size: 0, sha256: null };
    throw error;
  }
}
function isolationPaths(state: string): { root: string; persistent: string[]; socket: string; ownerRoot: string } {
  return {
    root: path.resolve(state),
    persistent: [
      stateDir(), machineStateDir(), path.join(state, 'fixture-repo'), taskStoreFile(state),
      path.join(state, 'results'), taskEventFile(state), coordinatorDir(), leasesDir(), queueDir(), historyFile()
    ].map(candidate => path.resolve(candidate)),
    socket: coordinatorSocketPath(),
    ownerRoot: path.resolve(os.homedir(), '.dex-reach')
  };
}
async function assertIsolation(state: string): Promise<ReturnType<typeof isolationPaths>> {
  const paths = isolationPaths(state);
  if (paths.persistent.some(candidate => !within(paths.root, candidate))) {
    throw new Error('C14-E isolation preflight failed: persistent path escaped temporary state: ' + JSON.stringify(paths));
  }
  if (paths.persistent.some(candidate => within(paths.ownerRoot, candidate))) {
    throw new Error('C14-E isolation preflight failed: owner state path selected: ' + JSON.stringify(paths));
  }
  if (within(paths.ownerRoot, paths.socket)) {
    throw new Error('C14-E isolation preflight failed: owner socket selected: ' + paths.socket);
  }
  return paths;
}

class StressRun {
  readonly state: string;
  readonly repo: string;
  readonly tasks: NodeTaskStore;
  readonly results: ResultStore;
  readonly events: TaskEventLog;
  readonly startedAt = performance.now();
  readonly startedUtc = new Date().toISOString();
  readonly cpuStart = process.cpuUsage();
  readonly operations = new Map<string, Op>();
  readonly intervals: Interval[] = [];
  readonly effectCounts = new Map<string, number>();
  readonly ambiguous: string[] = [];
  readonly normal: string[] = [];
  readonly failed: string[] = [];
  readonly leases = new Set<string>();
  readonly tickets = new Set<string>();
  readonly durationMs: number;
  readonly maxOperations: number;
  readonly concurrency: number;
  readonly maxRssBytes: number;
  sequence = 0;
  cycles = 0;
  failures = 0;
  stop = false;
  stopReason = 'duration reached';
  unrelatedLease: string | undefined;
  activeCycles = 0;
  recoveryPending = false;
  queueBusy = false;

  constructor(state: string, durationMs: number, maxOperations: number, concurrency: number, maxRssBytes: number) {
    this.state = state;
    this.repo = path.join(state, 'fixture-repo');
    this.tasks = new NodeTaskStore(state);
    this.results = new ResultStore(64 * 1024, RESULT_TTL_MS, state);
    this.events = new TaskEventLog(state);
    this.durationMs = durationMs;
    this.maxOperations = maxOperations;
    this.concurrency = concurrency;
    this.maxRssBytes = maxRssBytes;
  }
  nextId(): string { this.sequence += 1; return taskId(this.sequence); }
  async enterCycle(): Promise<void> {
    while (this.recoveryPending && !this.stop) await new Promise<void>(resolve => setTimeout(resolve, 5));
    this.activeCycles += 1;
  }
  leaveCycle(): void { this.activeCycles = Math.max(0, this.activeCycles - 1); }
  shouldStop(): boolean {
    if (this.stop) return true;
    if (this.cycles >= this.maxOperations) { this.stopReason = 'operation cap reached'; this.stop = true; return true; }
    if (performance.now() - this.startedAt >= this.durationMs) { this.stopReason = 'duration reached'; this.stop = true; return true; }
    if (process.memoryUsage().rss >= this.maxRssBytes) { this.stopReason = 'harness RSS cap reached'; this.stop = true; return true; }
    return false;
  }
  async timed<T>(name: string, fn: () => Promise<T>): Promise<T> {
    const started = performance.now();
    const stats = this.operations.get(name) ?? { count: 0, failures: 0, samples: [] };
    try {
      const result = await fn();
      stats.count += 1;
      if (stats.samples.length < 200) stats.samples.push(performance.now() - started);
      this.operations.set(name, stats);
      return result;
    } catch (error) {
      stats.failures += 1;
      this.operations.set(name, stats);
      throw error;
    }
  }
  async acquire(request: Parameters<typeof acquireWork>[0]): Promise<{ lease: { id: string } }> {
    const result = await this.timed('coordinator.acquire', () => acquireWork({ ...request, snapshot: capacitySnapshot() }));
    if (result.status !== 'acquired') {
      const state = await readCoordinatorState();
      this.tickets.add(result.ticket.id);
      await cancelTicket(result.ticket.id).catch(() => undefined);
      this.tickets.delete(result.ticket.id);
      throw new Error('stress lease unexpectedly queued: ' + result.reasons.join('; ') + ' beforeTickets=' + state.tickets.length + ' beforeLeases=' + state.leases.length);
    }
    this.leases.add(result.lease.id);
    return result;
  }
  async release(id: string): Promise<void> {
    await this.timed('coordinator.release', async () => {
      const result = await releaseWork(id);
      if (!result.released) throw new Error('stress lease release failed: ' + (result.reason ?? 'unknown'));
    });
    this.leases.delete(id);
  }
  async normalCompletion(): Promise<void> {
    const id = this.nextId();
    const args = { path: path.join(this.state, 'normal-' + id + '.txt'), text: 'synthetic c14-e result' };
    const payload = payloadHash({ operation: 'c14.stress.normal', args });
    const task = await this.timed('task.create', () => this.tasks.create({
      taskId: id, actorId: ACTOR_ID, nodeId: NODE_ID, operation: 'c14.stress.normal',
      idempotencyKey: 'normal-' + id, payloadSha256: payload, policyHash: POLICY_HASH,
      safetyClass: 'SIDE_EFFECTING_IDEMPOTENT', mutationLevel: 'STATE_MUTATION'
    }));
    const lease = await this.acquire({ executor: 'codex', access: 'read', workload: 'light', taskId: id, attempt: 1, pid: process.pid, pidIsWorkload: true, phase: 'normal' });
    try {
      await this.timed('task.preparing', () => this.tasks.transition(id, 'PREPARING', 'C14-E normal task admitted.'));
      await this.timed('task.running', () => this.tasks.transition(id, 'RUNNING', 'C14-E normal task running.'));
      const value = { ok: true, taskId: id, executionCount: 1 };
      const stored = await this.timed('result.write', () => this.results.boundWithReference(value, id));
      await this.timed('task.bind-result', () => this.tasks.update(id, { resultRef: stored.metadata.handle, resultHash: stored.metadata.resultHash }));
      await this.timed('task.complete', () => this.tasks.transition(id, 'COMPLETED', 'C14-E normal task completed.'));
      const read = await this.timed('result.read-bound', () => this.results.readValueForTask(stored.metadata.handle, id, stored.metadata.resultHash));
      if (JSON.stringify(read) !== JSON.stringify(value)) throw new Error('bound result changed during stress');
      const existing: ExistingTaskBinding = { ...task, state: 'COMPLETED', resultRef: stored.metadata.handle, resultHash: stored.metadata.resultHash };
      const decision = decideExistingTask({ existing, actorId: ACTOR_ID, nodeId: NODE_ID, operation: task.operation, payloadSha256: payload, policyHash: POLICY_HASH });
      if (decision.kind !== 'RETURN_RESULT') throw new Error('completed duplicate did not return durable result');
      this.normal.push(id);
    } finally {
      await this.release(lease.lease.id);
    }
  }
  async failedTask(): Promise<void> {
    const id = this.nextId();
    const task = await this.timed('task.create-failed', () => this.tasks.create({
      taskId: id, actorId: ACTOR_ID, nodeId: NODE_ID, operation: 'c14.stress.failed',
      idempotencyKey: 'failed-' + id, payloadSha256: payloadHash({ id }), policyHash: POLICY_HASH, safetyClass: 'PURE_READ_IDEMPOTENT'
    }));
    const lease = await this.acquire({ executor: 'codex', access: 'read', workload: 'light', taskId: id, attempt: 1, pid: process.pid, pidIsWorkload: true, phase: 'failed' });
    try {
      await this.timed('task.preparing-failed', () => this.tasks.transition(id, 'PREPARING', 'C14-E controlled failure admitted.'));
      await this.timed('task.running-failed', () => this.tasks.transition(id, 'RUNNING', 'C14-E controlled failure running.'));
      await this.timed('task.failed', () => this.tasks.update(id, { state: 'FAILED', failureClass: 'EXECUTION_FAILED', status: 'C14-E controlled synthetic failure.' }));
      this.failed.push(id);
    } finally { await this.release(lease.lease.id); }
    void task;
  }
  async ambiguousTask(): Promise<void> {
    const id = this.nextId();
    const task = await this.timed('task.create-ambiguous', () => this.tasks.create({
      taskId: id, actorId: ACTOR_ID, nodeId: NODE_ID, operation: 'c14.stress.ambiguous',
      idempotencyKey: 'ambiguous-' + id, payloadSha256: payloadHash({ id }), policyHash: POLICY_HASH,
      safetyClass: 'PROCESS_UNKNOWN_EFFECT', mutationLevel: 'STATE_MUTATION'
    }));
    const lease = await this.acquire({ executor: 'other', access: 'read', workload: 'light', taskId: id, attempt: 1, pid: process.pid, pidIsWorkload: true, phase: 'ambiguous' });
    try {
      await this.timed('task.preparing-ambiguous', () => this.tasks.transition(id, 'PREPARING', 'C14-E uncertain task admitted.'));
      await this.timed('task.running-ambiguous', () => this.tasks.transition(id, 'RUNNING', 'C14-E uncertain task running.'));
      this.effectCounts.set(id, (this.effectCounts.get(id) ?? 0) + 1);
    } finally { await this.release(lease.lease.id); }
    this.recoveryPending = true;
    while (this.activeCycles > 1 && !this.stop) await new Promise<void>(resolve => setTimeout(resolve, 5));
    let reports: Awaited<ReturnType<typeof reconcileBootTasks>>;
    try { reports = await this.timed('boot.reconcile', () => reconcileBootTasks(this.tasks, this.results)); }
    finally { this.recoveryPending = false; }
    if (reports.find(report => report.taskId === id)?.decision.kind !== 'AMBIGUOUS') throw new Error('uncertain task was not preserved as ambiguous');
    const recovered = await this.tasks.read(id);
    if (recovered?.state !== 'AMBIGUOUS' || recovered.failureClass !== 'AMBIGUOUS_EFFECT') throw new Error('ambiguous protection was not persisted');
    const existing: ExistingTaskBinding = { ...recovered, state: 'AMBIGUOUS' };
    const decision = decideExistingTask({ existing, actorId: ACTOR_ID, nodeId: NODE_ID, operation: recovered.operation, payloadSha256: recovered.payloadSha256, policyHash: POLICY_HASH });
    if (decision.kind !== 'REFUSE_AMBIGUOUS') throw new Error('ambiguous duplicate was not refused');
    this.ambiguous.push(id);
  }
  async retrieval(): Promise<void> {
    const id = this.normal.at(-1) ?? this.failed.at(-1);
    if (!id || !(await this.tasks.read(id))) throw new Error('known stress task was lost');
    await this.timed('task.read-indexed', () => this.tasks.read(id));
    await this.timed('task.list', () => this.tasks.list({ nodeId: NODE_ID, includeArchived: true }));
    await this.timed('event.page', async () => {
      const page = await readWorkEvents(0, 50);
      if (page.events.length > 50) throw new Error('event page exceeded bound');
    });
  }
  async queueCycle(): Promise<void> {
    if (this.queueBusy) return;
    this.queueBusy = true;
    this.recoveryPending = true;
    while (this.activeCycles > 1 && !this.stop) await new Promise<void>(resolve => setTimeout(resolve, 5));
    try {
      const holder = await this.acquire({ executor: 'codex', access: 'mutate', workload: 'medium', repositoryRoot: this.repo, phase: 'queue-holder' });
      try {
        const queued = await this.timed('coordinator.queue', () => acquireWork({ executor: 'other', access: 'mutate', workload: 'medium', repositoryRoot: this.repo, phase: 'queue-waiter', snapshot: capacitySnapshot() }));
        if (queued.status !== 'queued') throw new Error('queue scenario was not queued');
        this.tickets.add(queued.ticket.id);
        await this.timed('coordinator.cancel', async () => {
          if (!await cancelTicket(queued.ticket.id)) throw new Error('queued ticket cancellation failed');
        });
        this.tickets.delete(queued.ticket.id);
      } finally { await this.release(holder.lease.id); }
    } finally { this.recoveryPending = false; this.queueBusy = false; }
  }
  async cycle(worker: number): Promise<void> {
    const choice = this.cycles % 10;
    if (choice === 0 && worker === 0) await this.ambiguousTask();
    else if (choice === 1) await this.failedTask();
    else if (choice === 2) await this.retrieval();
    else if (choice % 2 === 0 && (this.normal.length > 0 || this.failed.length > 0)) await this.retrieval();
    else await this.normalCompletion();
    await this.timed('task.event-append', () => this.events.append({ taskId: taskId(Math.max(1, this.sequence)), kind: 'control', control: 'stress-cycle' }));
  }
  async sample(): Promise<void> {
    const memory = process.memoryUsage();
    const cpu = process.cpuUsage(this.cpuStart);
    const state = await readCoordinatorState();
    const active = await this.tasks.loadActiveTasks();
    const events = await readWorkEvents(0, 100);
    const operations: Record<string, { count: number; failures: number; medianMs: number; p95Ms: number }> = {};
    for (const [name, value] of this.operations) operations[name] = opSummary(value);
    this.intervals.push({
      elapsedMs: performance.now() - this.startedAt, completedCycles: this.cycles, failedCycles: this.failures, operations,
      rssBytes: memory.rss, heapUsedBytes: memory.heapUsed, externalBytes: memory.external,
      cpuUserMicros: cpu.user, cpuSystemMicros: cpu.system, activeLeases: state.leases.length, queuedTickets: state.tickets.length,
      nonterminalTasks: active.length, ambiguousTasks: active.filter(task => task.state === 'AMBIGUOUS').length,
      taskStoreBytes: await statBytes(taskStoreFile(this.state)), resultStoreBytes: await treeBytes(path.join(this.state, 'results')),
      eventLogBytes: await statBytes(taskEventFile(this.state)), coordinatorHistoryBytes: await statBytes(historyFile()),
      eventWindowCount: events.events.length
    });
  }
  async verify(): Promise<Record<string, unknown>> {
    await this.timed('boot.reconcile-final', () => reconcileBootTasks(this.tasks, this.results));
    const active = await this.tasks.loadActiveTasks();
    const state = await readCoordinatorState();
    const unexpected = active.filter(task => task.state !== 'AMBIGUOUS');
    if (unexpected.length || state.leases.some(lease => lease.id !== this.unrelatedLease) || state.tickets.length) throw new Error('unexpected task, lease, or ticket remained');
    for (const [id, count] of this.effectCounts) if (count !== 1) throw new Error('ambiguous effect duplicated for ' + id);
    if (this.ambiguous.length !== active.filter(task => task.state === 'AMBIGUOUS').length) throw new Error('ambiguous accounting mismatch');
    if (this.unrelatedLease) await this.release(this.unrelatedLease);
    const released = await readCoordinatorState();
    if (released.leases.length || released.tickets.length) throw new Error('coordinator cleanup failed');
    const sweep = await this.tasks.sweep({ terminalRetentionMs: 0, archiveRetentionMs: 365 * 24 * 60 * 60 * 1000 });
    const resultSweep = await this.results.sweep(Date.now() + RESULT_TTL_MS + 1);
    const finalActive = await this.tasks.loadActiveTasks();
    const cleanup = {
      leases: (await readCoordinatorState()).leases.length, tickets: (await readCoordinatorState()).tickets.length,
      activeTasksAfterSweep: finalActive.length, expectedAmbiguous: this.ambiguous.length,
      ambiguousAfterSweep: finalActive.filter(task => task.state === 'AMBIGUOUS').length,
      archivedTerminal: sweep.archived, deletedArchived: sweep.deleted, expiredResults: resultSweep,
      socketPresent: await present(coordinatorSocketPath())
    };
    if (cleanup.leases || cleanup.tickets || cleanup.activeTasksAfterSweep !== cleanup.expectedAmbiguous || cleanup.ambiguousAfterSweep !== cleanup.expectedAmbiguous) throw new Error('final cleanup invariant failed');
    return cleanup;
  }
}

async function main(): Promise<void> {
  const smoke = flag('smoke');
  const durationSeconds = numberArg('duration-seconds', smoke ? 75 : 600);
  const maxOperations = Math.min(25000, Math.floor(numberArg('max-operations', 25000)));
  const concurrency = Math.min(2, Math.floor(numberArg('concurrency', 2)));
  const output = process.argv.find(value => value.startsWith('--output='))?.split('=')[1] ??
    path.join('docs', 'c14-performance', smoke ? 'c14-e-smoke.json' : 'c14-e-stress-results.json');
  const totalMemory = os.totalmem();
  const maxRssBytes = numberArg('max-rss-mib', Math.max(256, Math.min(512, Math.floor(totalMemory / GIB * 64)))) * MIB;
  const state = await fs.mkdtemp(path.join(os.tmpdir(), 'dex-c14-stress-'));
  const source = sourceIdentity();
  const previousState = process.env.DEX_REACH_STATE_DIR;
  process.env.DEX_REACH_STATE_DIR = state;
  let isolation: ReturnType<typeof isolationPaths>;
  try { isolation = await assertIsolation(state); }
  catch (error) { await fs.rm(state, { recursive: true, force: true }); throw error; }
  const ownerHistoryBefore = await fingerprint(path.join(isolation.ownerRoot, 'coordinator', 'history', 'events.jsonl'));
  await fs.mkdir(path.join(state, 'fixture-repo'), { recursive: true });
  const run = new StressRun(state, durationSeconds * 1000, maxOperations, concurrency, maxRssBytes);
  const initial = { totalMemoryBytes: totalMemory, freeMemoryBytes: os.freemem(), loadAverage: os.loadavg() };
  let errorMessage: string | undefined;
  let cleanup: Record<string, unknown> | undefined;
  const timer = setInterval(() => { void run.sample().catch(error => { errorMessage = String(error); run.stop = true; run.stopReason = 'resource sample failed'; }); }, SAMPLE_INTERVAL_MS);
  try {
    const unrelated = await run.acquire({ executor: 'other', access: 'read', workload: 'light', phase: 'unrelated-stress-fixture' });
    run.unrelatedLease = unrelated.lease.id;
    await run.queueCycle();
    await Promise.all(Array.from({ length: concurrency }, async (_, worker) => {
      while (!run.shouldStop()) {
        await run.enterCycle();
        try { await run.cycle(worker); run.cycles += 1; }
        catch (error) { run.failures += 1; run.stop = true; run.stopReason = 'critical operation failed: ' + String(error); }
        finally { run.leaveCycle(); }
        await new Promise<void>(resolve => setImmediate(resolve));
      }
    }));
    await run.sample();
    if (!run.failures && !errorMessage) cleanup = await run.verify();
  } catch (error) { errorMessage = String(error); }
  clearInterval(timer);
  for (const id of run.tickets) await cancelTicket(id).catch(() => undefined);
  for (const id of run.leases) await releaseWork(id, { force: true }).catch(() => undefined);
  if (!cleanup && run.unrelatedLease) await releaseWork(run.unrelatedLease, { force: true }).catch(() => undefined);
  const memory = process.memoryUsage();
  await fs.rm(state, { recursive: true, force: true });
  const report = {
    schemaVersion: 1, kind: smoke ? 'C14-E bounded stress smoke' : 'C14-E bounded long-session stress',
    status: errorMessage || run.failures ? 'FAILED' : cleanup ? 'PASS' : 'PARTIAL',
    generatedAtUtc: new Date().toISOString(), startedAtUtc: run.startedUtc,
    source,
    isolation: { ...isolation, ownerHistoryBefore, ownerHistoryAfter: await fingerprint(path.join(isolation.ownerRoot, 'coordinator', 'history', 'events.jsonl')) },
    environment: { platform: process.platform, arch: process.arch, node: process.version, cpuCount: os.cpus().length, totalMemoryBytes: totalMemory, initialFreeMemoryBytes: initial.freeMemoryBytes, initialLoadAverage: initial.loadAverage },
    limits: { durationSeconds, maxOperations, concurrency, maxRssBytes, sampleIntervalMs: SAMPLE_INTERVAL_MS, resultTtlMs: RESULT_TTL_MS },
    run: { elapsedMs: performance.now() - run.startedAt, stopReason: errorMessage ?? run.stopReason, completedCycles: run.cycles, failedCycles: run.failures, sequence: run.sequence, normalTasks: run.normal.length, failedTasks: run.failed.length, ambiguousTasks: run.ambiguous.length },
    resources: { finalRssBytes: memory.rss, finalHeapUsedBytes: memory.heapUsed, finalExternalBytes: memory.external, cpu: process.cpuUsage(run.cpuStart) },
    timeSeries: run.intervals, cleanup: { ...(cleanup ?? { verified: false }), temporaryStateRemoved: !(await present(state)) }, error: errorMessage,
    limitations: ['Source-only isolated process; no installed service, gateway, connector, physical device, or human acceptance was exercised.', 'Resource stability is bounded to this duration, workload, fixture size, and host.', 'Ambiguous tasks remain intentionally preserved as protected active history.']
  };
  await fs.mkdir(path.dirname(output), { recursive: true });
  await fs.writeFile(output, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify({ output, status: report.status, durationMs: report.run.elapsedMs, completedCycles: report.run.completedCycles, failedCycles: report.run.failedCycles, removedTemporaryState: report.cleanup.temporaryStateRemoved, stopReason: report.run.stopReason }));
  if (previousState === undefined) delete process.env.DEX_REACH_STATE_DIR;
  else process.env.DEX_REACH_STATE_DIR = previousState;
  if (report.status === 'FAILED') process.exitCode = 1;
}
await main();

