import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { coordinatorSocketPath } from '../src/shared/work-coordinator.js';
import { bindCoordinatorCaller, coordinatedEvents, coordinatedRelease, coordinatedStatus } from '../src/coordinator/client.js';

async function socketCall(socketPath: string, request: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ path: socketPath });
    let response = '';
    socket.setEncoding('utf8');
    socket.once('error', reject);
    socket.on('data', chunk => { response += chunk; });
    socket.once('end', () => {
      try { resolve(JSON.parse(response)); } catch (error) { reject(error); }
    });
    socket.once('connect', () => socket.write(request + '\n'));
  });
}

async function waitForSocket(socketPath: string, stderr: () => string): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    try { if ((await fs.lstat(socketPath)).isSocket()) return; } catch { /* startup */ }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`coordinator daemon socket did not appear: ${stderr()}`);
}

test('coordinator daemon owns an account-private socket and rejects malformed frames', async () => {
  const state = await fs.mkdtemp(path.join(os.tmpdir(), 'dex-coordinator-daemon-'));
  const previous = process.env.DEX_REACH_STATE_DIR;
  process.env.DEX_REACH_STATE_DIR = state;
  const { NODE_OPTIONS: _testRunnerOptions, ...childEnv } = process.env;
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/coordinator/main.ts'], {
    cwd: process.cwd(), env: { ...childEnv, DEX_REACH_STATE_DIR: state }, stdio: ['ignore', 'ignore', 'pipe']
  });
  let stderr = '';
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', chunk => { stderr += chunk; });
  try {
    const socketPath = coordinatorSocketPath();
    await waitForSocket(socketPath, () => stderr);
    const stat = await fs.lstat(socketPath);
    assert.equal(stat.isSocket(), true);
    assert.equal(stat.mode & 0o777, 0o600);

    const status = await coordinatedStatus();
    assert.equal(Array.isArray(status.leases), true);
    assert.ok(status.eventWindow.cursor > 0);
    assert.ok(status.observationCache && status.observationCache.misses >= 1);
    const firstWindow = await coordinatedEvents(0, 100);
    assert.ok(firstWindow.cursor >= status.eventWindow.cursor);
    const nextStatus = await coordinatedStatus();
    const resumed = await coordinatedEvents(firstWindow.cursor, 100);
    assert.ok(nextStatus.eventWindow.cursor >= firstWindow.cursor);
    assert.ok(resumed.events.every(event => event.cursor > firstWindow.cursor));
    const malformed = await socketCall(socketPath, '{not-json') as { ok: boolean; error?: string };
    assert.equal(malformed.ok, false);
    assert.match(malformed.error || '', /JSON|request/);

    // Exercise the actual routed path: a short-lived caller acquires through the daemon,
    // queues behind a conflicting repository lease, then exits. The ticket must retain that
    // caller PID so stale-ticket recovery can observe its death instead of the daemon PID.
    const { acquireWork, cancelTicket, readCoordinatorState, releaseWork } = await import('../src/shared/work-coordinator.js');
    // Actual daemon socket release must carry the living requester's PID, not the daemon's.
    const completedLease = await acquireWork({ executor: 'other', access: 'read', workload: 'light', snapshot: host() });
    assert.equal(completedLease.status, 'acquired');
    if (completedLease.status === 'acquired') {
      assert.equal(completedLease.lease.pid, process.pid);
      const wrongCaller = await coordinatedRelease(completedLease.lease.id, { pid: process.pid + 1 });
      assert.equal(wrongCaller.released, false);
      const released = await coordinatedRelease(completedLease.lease.id);
      assert.equal(released.released, true);
      assert.equal((await readCoordinatorState()).leases.some(lease => lease.id === completedLease.lease.id), false);
    }
    const repositoryRoot = path.join(state, 'repo');
    await fs.mkdir(repositoryRoot, { recursive: true });
    const held = await acquireWork({ executor: 'human', access: 'mutate', workload: 'medium', repositoryRoot, snapshot: host() });
    assert.equal(held.status, 'acquired');
    if (held.status === 'acquired') {
      const taskId = `rtsk_${Date.now().toString(16)}_${'a'.repeat(32)}`;
      const source = `import { coordinatedAcquire } from './src/coordinator/client.ts'; const result = await coordinatedAcquire({ executor: 'chatgpt', access: 'mutate', workload: 'medium', repositoryRoot: ${JSON.stringify(repositoryRoot)}, taskId: ${JSON.stringify(taskId)} }); console.log(JSON.stringify({ pid: process.pid, result }));`;
      const caller = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', source], {
        cwd: process.cwd(), env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe']
      });
      let callerStdout = '';
      let callerStderr = '';
      caller.stdout?.setEncoding('utf8');
      caller.stderr?.setEncoding('utf8');
      caller.stdout?.on('data', chunk => { callerStdout += chunk; });
      caller.stderr?.on('data', chunk => { callerStderr += chunk; });
      const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
        caller.once('error', reject);
        caller.once('exit', (code, signal) => resolve({ code, signal }));
      });
      try {
        assert.equal(exit.code, 0, callerStderr);
        const returned = JSON.parse(callerStdout) as { pid: number; result: { status: string } };
        assert.equal(returned.result.status, 'queued');
        const ticket = (await readCoordinatorState()).tickets.find(item => item.taskId === taskId);
        assert.ok(ticket);
        assert.equal(ticket?.pid, returned.pid);
        assert.notEqual(ticket?.pid, child.pid);
        assert.equal(ticket?.pidIsWorkload, false);
      } finally {
        const ticket = (await readCoordinatorState()).tickets.find(item => item.taskId === taskId);
        if (ticket) await cancelTicket(ticket.id);
        await releaseWork(held.lease.id, { force: true });
      }
    }
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
      child.kill('SIGTERM');
      await exited;
    }
    if (previous === undefined) delete process.env.DEX_REACH_STATE_DIR; else process.env.DEX_REACH_STATE_DIR = previous;
    await fs.rm(state, { recursive: true, force: true });
  }
});

test('routed acquisition binds liveness to the caller without claiming its PID is a workload', () => {
  const callerPid = 12_345;
  const bound = bindCoordinatorCaller({ executor: 'chatgpt', access: 'read', workload: 'light' }, callerPid);
  assert.equal(bound.pid, callerPid);
  assert.equal(bound.pidIsWorkload, false);

  const workload = bindCoordinatorCaller({ executor: 'chatgpt', access: 'read', workload: 'light', pid: 54_321 }, callerPid);
  assert.equal(workload.pid, 54_321);
  assert.equal(workload.pidIsWorkload, true);
});

test('a coordinator socket owned by another account is refused rather than trusted or bypassed', async () => {
  const state = await fs.mkdtemp(path.join(os.tmpdir(), 'dex-coordinator-foreign-'));
  const previous = process.env.DEX_REACH_STATE_DIR;
  process.env.DEX_REACH_STATE_DIR = state;
  const socketPath = coordinatorSocketPath();
  // A real socket this account owns, standing in for one a hostile local account created first at
  // the same deterministic path. The uid is what distinguishes them, so the check is exercised by
  // reporting a different uid rather than by trying to create a file as another user.
  const server = net.createServer(socket => socket.end('{"ok":true,"value":{"leases":[],"tickets":[]}}\n'));
  const realGetuid = process.getuid;
  try {
    await new Promise<void>((resolve, reject) => server.once('error', reject).listen({ path: socketPath }, resolve));
    (process as { getuid?: () => number }).getuid = () => (realGetuid ? realGetuid() + 1 : 12345);
    // Not a silent fall back to direct mode: a foreign socket means another scheduler may be running,
    // and coordinating beside one we cannot see is what oversubscribes the machine.
    await assert.rejects(coordinatedStatus(), /owned by another account/);
  } finally {
    (process as { getuid?: () => number }).getuid = realGetuid;
    await new Promise<void>(resolve => server.close(() => resolve()));
    if (previous === undefined) delete process.env.DEX_REACH_STATE_DIR; else process.env.DEX_REACH_STATE_DIR = previous;
    await fs.rm(state, { recursive: true, force: true });
  }
});

// Direct handler injection keeps pressure deterministic while retaining real lease/event storage.
async function withHandlerState(fn: () => Promise<void>): Promise<void> {
  const state = await fs.mkdtemp(path.join(os.tmpdir(), 'dex-observation-'));
  const previous = process.env.DEX_REACH_STATE_DIR;
  process.env.DEX_REACH_STATE_DIR = state;
  try { await fn(); } finally {
    if (previous === undefined) delete process.env.DEX_REACH_STATE_DIR; else process.env.DEX_REACH_STATE_DIR = previous;
    await fs.rm(state, { recursive: true, force: true });
  }
}
const host = (memory: 'healthy' | 'warning' | 'critical' | 'unknown' = 'healthy'): import('../src/shared/work-coordinator.js').CapacitySnapshot => ({
  physicalMemoryBytes: 64 * 1024 ** 3, logicalCpuCount: 16, loadAverage1m: 0.5,
  memory, thermal: 'healthy', observed: { uncoordinatedHeavy: 0, dexServices: 0 }
});
const statusRequest = { version: 1, command: 'status' as const };

test('status reuses warning, critical and unknown observations, expires monotonically and recomputes leases', async () => {
  const { createCoordinatorHandler } = await import('../src/coordinator/main.js');
  const { acquireWork, releaseWork, cancelTicket } = await import('../src/shared/work-coordinator.js');
  await withHandlerState(async () => {
    for (const pressure of ['warning', 'critical', 'unknown'] as const) {
      let calls = 0; let now = 0;
      const execute = createCoordinatorHandler(async () => { calls += 1; return host(pressure); }, () => now);
      for (let i = 0; i < 5; i += 1) await execute(statusRequest);
      assert.equal(calls, 1);
      const lease = await acquireWork({ executor: 'codex', access: 'read', workload: 'light', snapshot: host() });
      assert.equal(lease.status, 'acquired');
      const status = await execute(statusRequest) as import('../src/shared/work-coordinator.js').WorkStatus;
      assert.equal(status.leases.length, 1);
      assert.equal(status.observationCache?.ageMs, 0);
      assert.ok(status.observationCache?.sampledAt);
      if (lease.status === 'acquired') await releaseWork(lease.lease.id);
      const queued = await acquireWork({ executor: 'codex', access: 'read', workload: 'heavy', snapshot: host('warning') });
      assert.equal(queued.status, 'queued');
      assert.equal((await execute(statusRequest) as import('../src/shared/work-coordinator.js').WorkStatus).tickets.length, 1);
      if (queued.status === 'queued') await cancelTicket(queued.ticket.id);
      assert.equal((await execute(statusRequest) as import('../src/shared/work-coordinator.js').WorkStatus).tickets.length, 0);
      assert.equal(calls, 1, 'lease and ticket mutations still use the cached host observation');
      now = 2000;
      const expired = await execute(statusRequest) as import('../src/shared/work-coordinator.js').WorkStatus;
      assert.equal(expired.leases.length, 0); assert.equal(calls, 2);
      console.log(`Repeated status ${pressure}: baseline samples=5 candidate samples=1 (five requests within 2000ms)`);
    }
  });
});

test('concurrent status coalesces and sampling errors recover without cached success', async () => {
  const { createCoordinatorHandler } = await import('../src/coordinator/main.js');
  await withHandlerState(async () => {
    let calls = 0;
    let finish!: (value: ReturnType<typeof host>) => void;
    const pending = new Promise<ReturnType<typeof host>>(resolve => { finish = resolve; });
    const execute = createCoordinatorHandler(async () => { calls += 1; return pending; });
    const requests = [execute(statusRequest), execute(statusRequest), execute(statusRequest)];
    finish(host('unknown')); await Promise.all(requests); assert.equal(calls, 1);
    let errors = 0;
    const recovering = createCoordinatorHandler(async () => { if (++errors === 1) throw new Error('sampler failed'); return host(); });
    await assert.rejects(recovering(statusRequest), /sampler failed/);
    await recovering(statusRequest); await recovering(statusRequest); assert.equal(errors, 2);
  });
});

test('acquisition never reuses healthy status and queue state remains fresh', async () => {
  const { createCoordinatorHandler } = await import('../src/coordinator/main.js');
  await withHandlerState(async () => {
    let calls = 0;
    const execute = createCoordinatorHandler(async () => host(++calls === 1 ? 'healthy' : 'warning'));
    await execute(statusRequest);
    const acquired = await execute({ version: 1, command: 'acquire', payload: { request: { executor: 'codex', access: 'read', workload: 'heavy' } } }) as { status: string; ticket: { id: string } };
    assert.equal(calls, 2); assert.equal(acquired.status, 'queued');
    const status = await execute(statusRequest) as import('../src/shared/work-coordinator.js').WorkStatus;
    assert.equal(status.tickets.length, 1);
    await execute({ version: 1, command: 'cancel', payload: { id: acquired.ticket.id } });
    assert.equal((await execute(statusRequest) as import('../src/shared/work-coordinator.js').WorkStatus).tickets.length, 0);
  });
});

test('invalidation fences a pending sample and acquisition does not join it', async () => {
  const { createCoordinatorHandler } = await import('../src/coordinator/main.js');
  await withHandlerState(async () => {
    let calls = 0; let started!: () => void; let finish!: (value: ReturnType<typeof host>) => void;
    const begun = new Promise<void>(resolve => { started = resolve; });
    const pending = new Promise<ReturnType<typeof host>>(resolve => { finish = resolve; });
    const execute = createCoordinatorHandler(async () => { calls += 1; if (calls === 1) { started(); return pending; } return host('warning'); });
    const status = execute(statusRequest); await begun;
    const admission = await execute({ version: 1, command: 'acquire', payload: { request: { executor: 'codex', access: 'read', workload: 'heavy' } } }) as { status: string };
    assert.equal(admission.status, 'queued'); assert.equal(calls, 2);
    finish(host()); await status;
    const next = await execute(statusRequest) as import('../src/shared/work-coordinator.js').WorkStatus;
    assert.equal(calls, 3); assert.equal(next.capacity.livePressure.memory, 'warning');
  });
});
