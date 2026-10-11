import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { NodeTaskStore } from '../src/node/task-store.js';
import { ResultStore } from '../src/node/result-store.js';
import { TaskEventLog } from '../src/shared/task-events.js';
import {
  acquireWork,
  cancelTicket,
  readWorkEvents,
  recordWorkEvent,
  releaseWork,
  type CapacitySnapshot
} from '../src/shared/work-coordinator.js';

type Sample = { ms: number };
type Summary = { count: number; medianMs: number; p95Ms: number; minMs: number; maxMs: number };
type Measurement = { samples: Sample[]; summary: Summary };

const WARMUP = 3;
const ITERATIONS = 15;
const TASK_SIZES = [16, 64, 128];
const EVENT_SIZES = [0, 64, 256, 512];
const RESULT_SIZES = [256, 4096, 65536];
const GIB = 1024 ** 3;
const nodeId = 'c14-benchmark-node';
const actorId = 'c14-benchmark-actor';
const payloadHash = 'a'.repeat(64);

function nowMs(): number { return performance.now(); }

function measure<T>(operation: () => Promise<T>): Promise<{ value: T; ms: number }> {
  const started = nowMs();
  return operation().then(value => ({ value, ms: nowMs() - started }));
}

function summarize(samples: Sample[]): Summary {
  const values = samples.map(sample => sample.ms).sort((a, b) => a - b);
  const percentile = (fraction: number) => values[Math.min(values.length - 1, Math.max(0, Math.ceil(values.length * fraction) - 1))] ?? 0;
  return {
    count: values.length,
    medianMs: percentile(0.5),
    p95Ms: percentile(0.95),
    minMs: values[0] ?? 0,
    maxMs: values[values.length - 1] ?? 0
  };
}

async function measured<T>(operation: () => Promise<T>, iterations = ITERATIONS): Promise<Measurement> {
  for (let index = 0; index < WARMUP; index += 1) await operation();
  const samples: Sample[] = [];
  for (let index = 0; index < iterations; index += 1) samples.push({ ms: (await measure(operation)).ms });
  return { samples, summary: summarize(samples) };
}

async function measuredAfterSetup<T>(setup: () => Promise<() => Promise<T>>, iterations = ITERATIONS): Promise<Measurement> {
  for (let index = 0; index < WARMUP; index += 1) await (await setup())();
  const samples: Sample[] = [];
  for (let index = 0; index < iterations; index += 1) samples.push({ ms: (await measure(await setup())).ms });
  return { samples, summary: summarize(samples) };
}

function taskId(index: number): string {
  return `rtsk_${(index + 1).toString(16).padStart(11, '0')}_${index.toString(16).padStart(16, '0')}`;
}

function taskInput(index: number) {
  return {
    taskId: taskId(index), actorId, nodeId, operation: 'c14.benchmark',
    idempotencyKey: `c14-benchmark-${index}`, payloadSha256: payloadHash
  };
}

async function seedTasks(store: NodeTaskStore, count: number, offset = 0): Promise<void> {
  for (let index = 0; index < count; index += 1) await store.create(taskInput(offset + index));
}

async function withState<T>(fn: (state: string) => Promise<T>): Promise<T> {
  const state = await fs.mkdtemp(path.join(os.tmpdir(), 'dex-c14-performance-'));
  const previous = process.env.DEX_REACH_STATE_DIR;
  process.env.DEX_REACH_STATE_DIR = state;
  try { return await fn(state); }
  finally {
    if (previous === undefined) delete process.env.DEX_REACH_STATE_DIR;
    else process.env.DEX_REACH_STATE_DIR = previous;
    await fs.rm(state, { recursive: true, force: true });
  }
}

async function taskMeasurements(): Promise<Record<string, unknown>> {
  const bySize: Record<string, unknown> = {};
  for (const size of TASK_SIZES) {
    bySize[size] = await withState(async state => {
      const store = new NodeTaskStore(state);
      await seedTasks(store, size);
      let nextIndex = size + 1;
      const create = await measured(() => store.create(taskInput(nextIndex++)));
      const lookup = await measured(() => store.read(taskId(Math.floor(size / 2))));
      const list = await measured(() => store.list({ nodeId }));

      const transitionStore = new NodeTaskStore(await fs.mkdtemp(path.join(os.tmpdir(), 'dex-c14-transition-')));
      let transitionIndex = size + 1000;
      const transition = await measuredAfterSetup(async () => {
        const transitionTask = await transitionStore.create(taskInput(transitionIndex++));
        return () => transitionStore.transition(transitionTask.taskId, 'PREPARING');
      });
      await fs.rm(transitionStore.rootDir, { recursive: true, force: true });

      const archiveStore = new NodeTaskStore(await fs.mkdtemp(path.join(os.tmpdir(), 'dex-c14-archive-')));
      let archiveIndex = size + 2000;
      const archive = await measuredAfterSetup(async () => {
        const archiveTask = await archiveStore.create(taskInput(archiveIndex++));
        await archiveStore.transition(archiveTask.taskId, 'PREPARING');
        await archiveStore.transition(archiveTask.taskId, 'RUNNING');
        await archiveStore.transition(archiveTask.taskId, 'COMPLETED');
        return () => archiveStore.archive(archiveTask.taskId);
      });
      await fs.rm(archiveStore.rootDir, { recursive: true, force: true });

      return { fixtureRecords: size, create, lookup, list, transition, archive };
    });
  }
  return bySize;
}

async function eventMeasurements(): Promise<Record<string, unknown>> {
  const bySize: Record<string, unknown> = {};
  for (const size of EVENT_SIZES) {
    bySize[size] = await withState(async state => {
      const file = path.join(state, 'tasks', 'events.jsonl');
      await fs.mkdir(path.dirname(file), { recursive: true });
      const seed = Array.from({ length: size }, (_, index) => JSON.stringify({
        eventId: `tev_${index.toString(16).padStart(24, '0')}`, at: new Date(0).toISOString(),
        taskId: taskId(index), kind: 'accepted', state: 'ACCEPTED', actorId, nodeId, operation: 'c14.benchmark', attempt: 1
      })).join('\n');
      if (seed) await fs.writeFile(file, `${seed}\n`);
      const log = new TaskEventLog(state);
      const append = await measured(() => log.append({ taskId: taskId(size + 1), kind: 'control', control: 'benchmark' }));
      return { preExistingEvents: size, append, retainedEvents: (await log.list(undefined, 500)).length };
    });
  }
  return bySize;
}

async function resultMeasurements(): Promise<Record<string, unknown>> {
  const bySize: Record<string, unknown> = {};
  for (const size of RESULT_SIZES) {
    bySize[size] = await withState(async state => {
      const store = new ResultStore(64 * 1024, 60_000, state);
      const value = { payload: 'x'.repeat(size) };
      const write = await measured(() => store.boundWithReference(value, taskId(size + 3000)));
      const stored = await store.boundWithReference(value, taskId(size + 4000));
      const read = await measured(() => store.readValue(stored.metadata.handle));
      return { payloadBytes: size, write, read };
    });
  }
  return bySize;
}

function snapshot(): CapacitySnapshot {
  return {
    physicalMemoryBytes: 8 * GIB, logicalCpuCount: 4, loadAverage1m: 0,
    memory: 'healthy', thermal: 'healthy', observed: { uncoordinatedHeavy: 0, dexServices: 0 },
    profile: 'conservative', interactiveReady: false, healthyForMs: 0
  };
}

async function coordinatorMeasurements(): Promise<Record<string, unknown>> {
  return withState(async state => {
    const repo = path.join(state, 'repo');
    await fs.mkdir(repo, { recursive: true });
    const acquire = await measured(async () => {
      const result = await acquireWork({ executor: 'codex', access: 'mutate', workload: 'medium', repositoryRoot: repo, snapshot: snapshot() });
      if (result.status !== 'acquired') throw new Error('isolated coordinator admission unexpectedly queued');
      await releaseWork(result.lease.id);
      return result;
    });

    const holder = await acquireWork({ executor: 'codex', access: 'mutate', workload: 'medium', repositoryRoot: repo, snapshot: snapshot() });
    if (holder.status !== 'acquired') throw new Error('isolated coordinator holder was not admitted');
    const queued = await measured(async () => {
      const result = await acquireWork({ executor: 'other', access: 'mutate', workload: 'medium', repositoryRoot: repo, snapshot: snapshot() });
      if (result.status !== 'queued') throw new Error('isolated coordinator queue fixture was not queued');
      await cancelTicket(result.ticket.id);
      return result;
    });
    const release = await measured(() => releaseWork(holder.lease.id));
    const events = await readWorkEvents(0, 100);
    return { acquireAndRelease: acquire, queuedAndCancelled: queued, release, finalEventPage: { count: events.events.length, bytes: Buffer.byteLength(JSON.stringify(events)), hasMore: events.hasMore } };
  });
}

async function paginationMeasurements(): Promise<Record<string, unknown>> {
  return withState(async state => {
    for (let index = 0; index < 180; index += 1) await recordWorkEvent({ event: 'phase-progress', id: `lease-${index}`, taskId: taskId(index), executor: 'codex', phase: 'benchmark' });
    const page = await measured(() => readWorkEvents(0, 25));
    return { pageSize: 25, page, responseBytes: Buffer.byteLength(JSON.stringify(await readWorkEvents(0, 25))) };
  });
}

async function main(): Promise<void> {
  const output = process.argv[2] ?? path.join('docs', 'c14-performance', 'latest.json');
  const startedAt = new Date().toISOString();
  const memoryBefore = process.memoryUsage();
  const cpuBefore = process.cpuUsage();
  const measurements = {
    durableTaskAcknowledgement: await withState(async state => {
      const store = new NodeTaskStore(state);
      let index = 0;
      return { fixtureRecords: 0, acknowledgement: await measured(() => store.create(taskInput(index++))) };
    }),
    taskStore: await taskMeasurements(),
    eventAppend: await eventMeasurements(),
    resultStore: await resultMeasurements(),
    coordinator: await coordinatorMeasurements(),
    logEventPagination: await paginationMeasurements(),
    dashboardDeltaRefresh: { status: 'NOT MEASURED', reason: 'No callable production dashboard delta-refresh implementation exists in this source.' }
  };
  const memoryAfter = process.memoryUsage();
  const cpuAfter = process.cpuUsage(cpuBefore);
  const report = {
    schemaVersion: 1,
    kind: 'C14-D performance baseline',
    generatedAtUtc: startedAt,
    source: { branch: process.env.GIT_BRANCH ?? 'c14-chaos-recovery', commit: process.env.GIT_COMMIT ?? 'unknown' },
    environment: { platform: process.platform, arch: process.arch, node: process.version, cpuCount: os.cpus().length, totalMemoryBytes: os.totalmem(), stateIsolation: 'temporary DEX_REACH_STATE_DIR per fixture; removed after each fixture' },
    methodology: { warmupIterations: WARMUP, measuredIterations: ITERATIONS, timing: 'performance.now monotonic wall-clock milliseconds', percentile: 'nearest-rank median/p95', fixtures: { taskRecords: TASK_SIZES, preExistingEvents: EVENT_SIZES, resultPayloadBytes: RESULT_SIZES }, note: 'Baseline uses production store/event/coordinator/result paths against synthetic temporary state. No credentials or owner runtime state accessed.' },
    measurements,
    resources: { processMemoryBefore: memoryBefore, processMemoryAfter: memoryAfter, rssDeltaBytes: memoryAfter.rss - memoryBefore.rss, cpuUserMicros: cpuAfter.user, cpuSystemMicros: cpuAfter.system, note: 'Harness-process observations only; not idle installed-service cost.' },
    limitations: ['Dashboard delta refresh is not implemented/callable in the inspected source.', 'Idle installed-service CPU/memory cost was not measured.', 'This is a source-bound isolated baseline, not installed-runtime or physical-client proof.']
  };
  await fs.mkdir(path.dirname(output), { recursive: true });
  await fs.writeFile(output, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  console.log(JSON.stringify({ output, source: report.source, measurements: Object.keys(measurements), rssDeltaBytes: report.resources.rssDeltaBytes }));
}

await main();
