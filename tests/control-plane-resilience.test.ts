import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { execFileDeadline } from '../scripts/lib/process-deadline.js';
import { restorePlist, snapshotPlist } from '../scripts/lib/plist-rollback.js';
import { acquireInstallLock, claimInstallLock, releaseInstallLock } from '../scripts/lib/install-lock.js';
import { runIndependentRollback } from '../scripts/lib/rollback-sequence.js';
import { NodeRegistry } from '../src/gateway/registry.js';
import { NodeAuthStore } from '../src/gateway/node-auth.js';
import { readRuntimeStatus, writeRuntimeStatus } from '../src/node/runtime-status.js';
import { HeartbeatWatchdog, retryUntilStopped } from '../src/node/resilience.js';
import { REACH_PROTOCOL_VERSION, type AccessSnapshot, type GatewayRequest, type NodeHello } from '../src/shared/protocol.js';

const access: AccessSnapshot = {
  mode: 'on', effectiveMode: 'on', until: null, revertTo: null, clients: {}
};

class FakeSocket extends EventEmitter {
  readyState: number = WebSocket.OPEN;
  sent: unknown[] = [];
  closed: { code: number; reason: string } | null = null;
  send(data: string, cb?: (error?: Error) => void): void {
    this.sent.push(JSON.parse(data) as unknown);
    cb?.();
  }
  close(code: number, reason: string): void {
    this.closed = { code, reason };
    this.readyState = WebSocket.CLOSED;
    this.emit('close');
  }
  terminate(): void {
    this.readyState = WebSocket.CLOSED;
    this.emit('close');
  }
}

function hello(nodeId: string): NodeHello {
  return {
    type: 'hello',
    protocolVersion: REACH_PROTOCOL_VERSION,
    nodeId,
    profile: 'development',
    fingerprint: {
      nodeId, hostname: nodeId, platform: 'test', arch: 'test', user: 'u', home: '/',
      cwd: '/', repositoryRoot: null, branch: null, remote: null, nodeVersion: 'v0', pythonVersion: null
    },
    tools: [],
    allowedRoots: ['/'],
    agentVersion: 'test',
    access
  };
}


test('macOS install ownership collapses concurrent retries and survives helper handoff', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dex-install-lock-'));
  try {
    const first = await acquireInstallLock(dir);
    await assert.rejects(acquireInstallLock(dir), /already active/);

    await first.handoff();
    await assert.rejects(acquireInstallLock(dir), /already active/);

    await claimInstallLock(first.path);
    await assert.rejects(acquireInstallLock(dir), /already active/);

    await releaseInstallLock(first.path);
    const second = await acquireInstallLock(dir);
    await second.release();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('rollback continues after one service restore fails and prioritizes gateway recovery', async () => {
  const attempted: string[] = [];
  const services = [
    { label: 'com.stinkyweasel.dex-reach.node' },
    { label: 'com.stinkyweasel.dex-reach.worker' },
    { label: 'com.stinkyweasel.dex-reach.gateway' },
    { label: 'com.stinkyweasel.dex-reach.coordinator' }
  ];

  const result = await runIndependentRollback(services, async service => {
    attempted.push(service.label);
    if (service.label.endsWith('.node')) throw new Error('node restore failed');
    return service.label;
  });

  assert.deepEqual(attempted, [
    'com.stinkyweasel.dex-reach.gateway',
    'com.stinkyweasel.dex-reach.coordinator',
    'com.stinkyweasel.dex-reach.worker',
    'com.stinkyweasel.dex-reach.node'
  ]);
  assert.equal(result.results.length, 3);
  assert.deepEqual(result.failures, [
    { label: 'com.stinkyweasel.dex-reach.node', error: 'node restore failed' }
  ]);
});

test('external command deadline turns a hung child into a rejection', async () => {
  const started = Date.now();
  await assert.rejects(
    execFileDeadline(process.execPath, ['-e', 'setTimeout(() => {}, 10000)'], 50)
  );
  assert.ok(Date.now() - started < 2000, 'deadline must not wait for the child to finish naturally');
});

test('plist snapshots restore a partial replacement and remove a candidate with no predecessor', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dex-plist-rollback-'));
  try {
    const first = path.join(dir, 'first.plist');
    const firstBackup = path.join(dir, 'backup', 'first.plist');
    const second = path.join(dir, 'second.plist');

    await fs.writeFile(first, 'old-first');
    assert.equal(await snapshotPlist(first, firstBackup), true);
    assert.equal(await snapshotPlist(second, path.join(dir, 'backup', 'second.plist')), false);

    await fs.writeFile(first, 'new-first');
    await fs.writeFile(second, 'new-second');

    assert.equal(await restorePlist(first, firstBackup), 'restored');
    assert.equal(await restorePlist(second), 'removed');
    assert.equal(await fs.readFile(first, 'utf8'), 'old-first');
    await assert.rejects(fs.stat(second), /ENOENT/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('heartbeat liveness ignores wall-clock stalls and requires consecutive unanswered opportunities', () => {
  const watchdog = new HeartbeatWatchdog(3);

  assert.equal(watchdog.nextHeartbeat(), true);
  assert.equal(watchdog.pending(), 1);

  // A long scheduler/event-loop stall cannot increase this counter because no heartbeat opportunity
  // actually ran. Any observed gateway traffic resets the liveness debt.
  watchdog.observedActivity();
  assert.equal(watchdog.pending(), 0);

  assert.equal(watchdog.nextHeartbeat(), true);
  assert.equal(watchdog.nextHeartbeat(), true);
  assert.equal(watchdog.nextHeartbeat(), true);
  assert.equal(watchdog.nextHeartbeat(), false);

  watchdog.observedActivity();
  assert.equal(watchdog.nextHeartbeat(), true);
});

test('REQUEST_TIMEOUT-equivalent backend failure is owned and retried instead of escaping', async () => {
  let attempts = 0;
  const errors: string[] = [];

  await retryUntilStopped(async () => {
    attempts += 1;
    if (attempts === 1) {
      throw Object.assign(new Error('Request timed out'), { code: 'REQUEST_TIMEOUT' });
    }
  }, {
    shouldStop: () => false,
    initialDelayMs: 1,
    maxDelayMs: 1,
    sleep: async () => undefined,
    onError: error => errors.push(error instanceof Error ? error.message : String(error))
  });

  assert.equal(attempts, 2);
  assert.deepEqual(errors, ['Request timed out']);
});

test('runtime status requires both freshness and a live PID oracle', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dex-runtime-status-'));
  try {
    await writeRuntimeStatus('n', {
      pid: 12345,
      connected: false,
      socketConnected: true,
      gatewayRegistered: false,
      compatibilityReady: false,
      startedAt: new Date().toISOString(),
      gateway: 'ws://127.0.0.1:8787',
      access,
      updatedAt: new Date().toISOString()
    }, dir);

    assert.equal(await readRuntimeStatus('n', dir, 15_000, () => false), null);

    const live = await readRuntimeStatus('n', dir, 15_000, () => true);
    assert.equal(live?.socketConnected, true);
    assert.equal(live?.gatewayRegistered, false);
    assert.equal(live?.compatibilityReady, false);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('gateway acknowledgement exists only after a valid hello is registered', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dex-registration-'));
  try {
    const auth = new NodeAuthStore(dir);
    await auth.initialize();
    const registry = new NodeRegistry(auth, dir);
    await registry.initialize();

    const socket = new FakeSocket();
    registry.acceptForTest(socket as unknown as WebSocket, 'primary');

    assert.equal(registry.listNodes().length, 0, 'socket open is not registration');

    socket.emit('message', Buffer.from(JSON.stringify(hello('primary'))));

    assert.equal(registry.listNodes().length, 1);
    assert.deepEqual(socket.sent[0], {
      type: 'registered',
      nodeId: 'primary',
      protocolVersion: REACH_PROTOCOL_VERSION
    });

    const bad = new FakeSocket();
    registry.acceptForTest(bad as unknown as WebSocket, 'expected');
    bad.emit('message', Buffer.from(JSON.stringify(hello('wrong'))));

    assert.equal(bad.closed?.code, 1008);
    assert.ok(!registry.listNodes().some(node => node.nodeId === 'wrong'));

    registry.shutdown();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('degraded compatibility stays online and upgrades its tool surface in place', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dex-degraded-compat-'));
  try {
    const auth = new NodeAuthStore(dir);
    await auth.initialize();
    const registry = new NodeRegistry(auth, dir);
    await registry.initialize();

    const socket = new FakeSocket();
    registry.acceptForTest(socket as unknown as WebSocket, 'primary');
    const degraded = hello('primary');
    degraded.tools = [{ name: 'read_file' }];
    degraded.compatibilityReady = false;
    socket.emit('message', Buffer.from(JSON.stringify(degraded)));

    const before = registry.listNodes()[0] as { online: boolean; compatibilityReady: boolean; toolCount: number };
    assert.equal(before.online, true);
    assert.equal(before.compatibilityReady, false);
    assert.equal(before.toolCount, 1);

    socket.emit('message', Buffer.from(JSON.stringify({
      type: 'status',
      access,
      tools: [{ name: 'read_file', description: 'live schema' }, { name: 'write_file' }],
      compatibilityReady: true
    })));

    const after = registry.listNodes()[0] as { online: boolean; compatibilityReady: boolean; toolCount: number };
    assert.equal(after.online, true);
    assert.equal(after.compatibilityReady, true);
    assert.equal(after.toolCount, 2);
    assert.equal((registry.listTools('primary')[0] as { description?: string }).description, 'live schema');
    assert.equal(socket.readyState, WebSocket.OPEN, 'backend recovery must not require a node reconnect');
    registry.shutdown();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('installer source contract includes bounded helper commands and rollback evidence', async () => {
  const installer = await fs.readFile(path.resolve('scripts/install-macos.ts'), 'utf8');
  const helper = await fs.readFile(path.resolve('scripts/reload-launchagents.ts'), 'utf8');
  const runtimeRelease = await fs.readFile(path.resolve('scripts/lib/runtime-release.ts'), 'utf8');
  assert.match(installer, /snapshotPlist/);
  assert.match(installer, /acquireInstallLock/);
  assert.match(installer, /--install-lock/);
  assert.match(helper, /claimInstallLock/);
  assert.match(installer, /--command-timeout-ms/);
  assert.match(installer, /--canary-timeout-ms/);
  assert.match(installer, /180000/);
  assert.match(helper, /canaryTimeoutMs/);
  assert.match(helper, /execFileDeadline/);
  assert.match(runtimeRelease, /execFileDeadline/);
  assert.match(runtimeRelease, /120_000/);
  assert.match(helper, /candidateTarget/);
  assert.match(helper, /Commit the candidate definitions only after the entire live replacement contract passes/);
  assert.doesNotMatch(installer, /atomicWriteFile\(service\.target, await fs\.readFile\(service\.candidateTarget\)/);
  assert.match(helper, /rollback/);
  assert.doesNotMatch(helper, /promisify\(execFile\)/);
});
