import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { NodeAuthStore } from '../src/gateway/node-auth.js';
import { NodeRegistry } from '../src/gateway/registry.js';
import { createCoordinatorHandler, handleCoordinatorSocket } from '../src/coordinator/main.js';
import { coordinatorSocketPath, type CapacitySnapshot } from '../src/shared/work-coordinator.js';
import { classifyObservedWorkloads, parseProcessTable } from '../src/shared/machine-capacity.js';
import { createGrant, updateAccessState } from '../src/shared/access.js';
import { NodeTaskStore } from '../src/node/task-store.js';

// Nested process exit through the real plan-commit path: dex.plan creates a plan, dex.commitPlan commits it
// as a durable task, and the committed dex.process.run child exits with a numeric status. Runs against a real
// node process with synthetic roots. The effect oracle is a file each execution appends to, never a sleep.

const actor = { kind: 'other' as const, clientId: 'commitplan-fixture', clientName: 'fixture' };
const NODE = 'commitplan-fixture';
const repo = path.resolve(import.meta.dirname, '..');

async function until(fn: () => Promise<boolean>, ms = 30000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn()) return; await new Promise(r => setTimeout(r, 50)); }
  throw new Error('fixture condition timed out');
}
type Exit = { code: number | null; signal: NodeJS.Signals | null };
function exited(child: ChildProcess): Promise<Exit> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve({ code: child.exitCode, signal: child.signalCode as NodeJS.Signals | null });
  return new Promise(r => child.once('exit', (code, signal) => r({ code, signal })));
}
async function stopGraceful(child: ChildProcess): Promise<Exit> { const done = exited(child); try { process.kill(-child.pid!, 'SIGTERM'); } catch { /* already gone */ } return done; }

test('a nested nonzero exit under dex.commitPlan is FAILED, never COMPLETED; the effect runs once; an identical retry cannot re-run it', { timeout: 120000 }, async () => {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'dex-commitplan-')));
  const stateDir = path.join(dir, 'state'); await fs.mkdir(stateDir);
  const previous = process.env.DEX_REACH_STATE_DIR; process.env.DEX_REACH_STATE_DIR = stateDir;
  const roots = path.join(dir, 'roots'); await fs.mkdir(roots);
  const auth = new NodeAuthStore(stateDir); await auth.initialize(); const token = await auth.enroll(NODE);
  const registry = new NodeRegistry(auth, stateDir); await registry.initialize();
  const server = http.createServer(); registry.attach(server);
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as net.AddressInfo).port;
  const sample = async (): Promise<CapacitySnapshot> => ({ physicalMemoryBytes: 8 * 1024 ** 3, logicalCpuCount: 8, loadAverage1m: 0.5, memory: 'healthy', thermal: 'healthy', observed: classifyObservedWorkloads(parseProcessTable('PID PPID %CPU %MEM ELAPSED COMMAND\n'), { selfPid: 9999 }) });
  const coordinator = net.createServer(socket => handleCoordinatorSocket(socket, createCoordinatorHandler(sample)));
  const socketPath = coordinatorSocketPath(); await new Promise<void>(r => coordinator.listen(socketPath, r)); await fs.chmod(socketPath, 0o600);
  await updateAccessState(NODE, s => ({ ...s, mode: 'on' }), stateDir);
  // Same authority shape as the scheduler fixture: process.shell on this run's synthetic roots only, unlimited uses.
  await updateAccessState(NODE, s => createGrant(s, 'other', ['process.shell'], [roots], 120_000, null), stateDir);
  let lastNodeLog = '';
  const launch = () => {
    lastNodeLog = '';
    const spawned = spawn(process.execPath, ['--import', 'tsx', 'src/node/main.ts'], { cwd: repo, detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, DEX_REACH_STATE_DIR: stateDir, DEX_REACH_ENV_FILE: path.join(dir, 'absent.env'), DEX_WORKSPACE_WORKER_DIR: path.join(dir, 'worker'), DEX_REACH_NODE_ID: NODE, DEX_REACH_NODE_TOKEN: token, DEX_REACH_ALLOWED_ROOTS: roots, DEX_REACH_GATEWAY_WS: `ws://127.0.0.1:${port}/node`, DEX_REACH_CONCURRENCY: '1' } });
    const capture = (data: Buffer) => { lastNodeLog = (lastNodeLog + data.toString()).slice(-20000); };
    spawned.stdout!.on('data', capture); spawned.stderr!.on('data', capture);
    return spawned;
  };
  const child = launch();
  const store = new NodeTaskStore(stateDir);
  const ready = async () => { if (child.exitCode !== null || child.signalCode !== null) throw new Error(`node fixture stopped: ${lastNodeLog}`); return registry.listNodes().length === 1 && registry.supportsDurableTasks(NODE); };
  const effectFile = path.join(roots, 'effect.txt');
  const effectRuns = async () => (await fs.readFile(effectFile, 'utf8').catch(() => '')).split('\n').filter(Boolean).length;
  const plan = (command: string) => registry.requestWithTrace(NODE, 'dex.plan', { operation: 'dex.process.run', arguments: { command, cwd: roots } }, actor, undefined, 5000);
  const commit = (key: string, planId: string) => registry.requestWithTrace(NODE, 'dex.task', {}, actor, undefined, 5000, { action: 'start', operation: 'dex.commitPlan', args: { planId, idempotencyKey: key } });
  const settled = async (taskId: string) => { let state = ''; await until(async () => { state = (await store.read(taskId))?.state ?? ''; return ['COMPLETED', 'FAILED', 'AMBIGUOUS', 'CANCELLED'].includes(state); }); return (await store.read(taskId))!; };
  try {
    await until(ready);
    // Positive control first: an exit-0 committed plan completes, so the gate is shown to distinguish outcomes.
    const okPlan = (await plan(`echo effect >> effect.txt; exit 0`)).result as { id: string };
    const okTask = (await commit('commit-ok', okPlan.id)).result as { taskId: string };
    const ok = await settled(okTask.taskId);
    assert.equal(ok.state, 'COMPLETED', 'exit 0 is a success');
    assert.equal(await effectRuns(), 1);

    // The case under test: the committed child exits 3. The commit must not be COMPLETED.
    const badPlan = (await plan(`echo effect >> effect.txt; exit 3`)).result as { id: string };
    const badTask = (await commit('commit-exit3', badPlan.id)).result as { taskId: string };
    const bad = await settled(badTask.taskId);
    assert.notEqual(bad.state, 'COMPLETED', 'a nonzero nested exit can never produce a COMPLETED task');
    assert.equal(bad.state, 'FAILED');
    assert.equal(bad.failureClass, 'EXECUTION_FAILED');
    assert.match(bad.summary.status, /exited with status 3/, 'the real numeric status is preserved in the task outcome');
    assert.equal(await effectRuns(), 2, 'the committed effect ran exactly once');

    // An identical retry after FAILED is refused by the durable record: no second execution, no plan consumption.
    await commit('commit-exit3', badPlan.id).catch(() => undefined);
    assert.equal(await effectRuns(), 2, 'an identical retry must not re-run the failed effect');
    assert.equal((await store.read(badTask.taskId))?.state, 'FAILED');
  } finally {
    await stopGraceful(child); registry.shutdown();
    await new Promise<void>(r => server.close(() => r())); await new Promise<void>(r => coordinator.close(() => r()));
    await fs.rm(socketPath, { force: true });
    if (previous === undefined) delete process.env.DEX_REACH_STATE_DIR; else process.env.DEX_REACH_STATE_DIR = previous;
    await fs.rm(dir, { recursive: true, force: true });
  }
});
