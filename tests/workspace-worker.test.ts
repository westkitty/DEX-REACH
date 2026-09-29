import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import {
  WORKSPACE_WORKER_OPERATIONS,
  scrubWorkspaceWorkerEnvironment,
  workspaceWorkerConfigFile,
  workspaceWorkerExecute,
  workspaceWorkerRootsHash,
  workspaceWorkerSocketPath
} from '../src/shared/workspace-worker.js';
import { requireOperation } from '../src/shared/operations.js';

const socketTmpRoot = process.platform === 'darwin' ? '/tmp' : os.tmpdir();

async function waitForSocket(
  socketPath: string,
  child: ReturnType<typeof spawn>,
  stderr: () => string,
  timeoutMs = 10_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { if ((await fs.lstat(socketPath)).isSocket()) return; } catch {}
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`workspace worker exited before its socket appeared (exit=${child.exitCode}, signal=${child.signalCode}): ${stderr()}`);
    }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`workspace worker socket did not appear within ${timeoutMs}ms: ${stderr()}`);
}

async function rawCall(socketPath: string, request: unknown): Promise<{ ok: boolean; error?: string; code?: string }> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ path: socketPath });
    let out = '';
    socket.setEncoding('utf8');
    socket.once('error', reject);
    socket.on('data', chunk => { out += chunk; });
    socket.once('end', () => resolve(JSON.parse(out)));
    socket.once('connect', () => socket.write(JSON.stringify(request) + '\n'));
  });
}

test('workspace worker transport failure falls back while unsafe socket metadata still fails visibly', async () => {
  const temp = await fs.mkdtemp(path.join(socketTmpRoot, 'dex-ww-transport-'));
  const workerDir = path.join(temp, 'worker');
  await fs.mkdir(workerDir, { recursive: true, mode: 0o700 });
  await fs.chmod(workerDir, 0o700);
  const previous = process.env.DEX_WORKSPACE_WORKER_DIR;
  process.env.DEX_WORKSPACE_WORKER_DIR = workerDir;
  const socketPath = workspaceWorkerSocketPath();

  const accepted = new Set<net.Socket>();
  const server = net.createServer(socket => {
    accepted.add(socket);
    socket.once('close', () => accepted.delete(socket));
    // Intentionally accept without responding so the client exercises its transport timeout path.
  });
  const closeServer = async () => {
    for (const socket of accepted) socket.destroy();
    await closeServer();
  };

  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, resolve);
    });
    await fs.chmod(socketPath, 0o600);

    const unavailable = await workspaceWorkerExecute(
      'worker-test-node',
      'dex.file.read',
      { path: path.join(temp, 'unused.txt') },
      '0'.repeat(64),
      50
    );
    assert.equal(unavailable, null, 'transport unavailability must degrade to normal node execution');

    await closeServer();
    await fs.rm(socketPath, { force: true });
    await fs.writeFile(socketPath, 'not a socket', { mode: 0o600 });

    await assert.rejects(
      workspaceWorkerExecute(
        'worker-test-node',
        'dex.file.read',
        { path: path.join(temp, 'unused.txt') },
        '0'.repeat(64),
        50
      ),
      /not a socket/
    );
  } finally {
    if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
    if (previous === undefined) delete process.env.DEX_WORKSPACE_WORKER_DIR;
    else process.env.DEX_WORKSPACE_WORKER_DIR = previous;
    await fs.rm(temp, { recursive: true, force: true });
  }
});

test('workspace worker environment is credential-free by construction', () => {
  const clean = scrubWorkspaceWorkerEnvironment({
    PATH: '/bin',
    HOME: '/Users/test',
    USER: 'test',
    LANG: 'en_US.UTF-8',
    DEX_WORKSPACE_WORKER_DIR: '/tmp/worker',
    DEX_REACH_STATE_DIR: '/private/state',
    DEX_REACH_NODE_TOKEN: 'node-secret',
    ANTHROPIC_API_KEY: 'anthropic-secret',
    OPENAI_API_KEY: 'openai-secret',
    GITHUB_TOKEN: 'github-secret',
    SSH_AUTH_SOCK: '/tmp/ssh-agent'
  });
  assert.equal(clean.PATH, '/bin');
  assert.equal(clean.HOME, '/Users/test');
  assert.equal(clean.DEX_WORKSPACE_WORKER_DIR, '/tmp/worker');
  for (const forbidden of ['DEX_REACH_STATE_DIR', 'DEX_REACH_NODE_TOKEN', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GITHUB_TOKEN', 'SSH_AUTH_SOCK']) {
    assert.equal(clean[forbidden], undefined, `${forbidden} leaked into workspace worker environment`);
  }
});

test('workspace worker serves only bounded read operations, falls back on root mismatch, and recovers its socket after restart', async () => {
  const temp = await fs.mkdtemp(path.join(socketTmpRoot, 'dex-ww-test-'));
  const work = path.join(temp, 'workspace');
  const workerDir = path.join(temp, 'worker');
  await fs.mkdir(work, { recursive: true });
  await fs.mkdir(workerDir, { recursive: true, mode: 0o700 });
  await fs.chmod(workerDir, 0o700);
  const file = path.join(work, 'hello.txt');
  await fs.writeFile(file, 'hello worker\n');
  const roots = [work];
  const rootsHash = workspaceWorkerRootsHash(roots);
  const previous = process.env.DEX_WORKSPACE_WORKER_DIR;
  process.env.DEX_WORKSPACE_WORKER_DIR = workerDir;
  await fs.writeFile(workspaceWorkerConfigFile(), JSON.stringify({
    version: 1, nodeId: 'worker-test-node', allowedRoots: roots, rootsHash
  }, null, 2) + '\n', { mode: 0o600 });

  const { NODE_OPTIONS: _nodeOptions, ...baseEnv } = process.env;
  let child = spawn(process.execPath, ['--import', 'tsx', 'src/worker/main.ts'], {
    cwd: process.cwd(),
    env: {
      ...baseEnv,
      DEX_WORKSPACE_WORKER_DIR: workerDir,
      DEX_REACH_STATE_DIR: path.join(temp, 'must-not-leak'),
      DEX_REACH_NODE_TOKEN: 'must-not-leak',
      OPENAI_API_KEY: 'must-not-leak',
      SSH_AUTH_SOCK: '/tmp/must-not-leak'
    },
    stdio: ['ignore', 'ignore', 'pipe']
  });
  let stderr = '';
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', chunk => { stderr += chunk; });

  try {
    await waitForSocket(workspaceWorkerSocketPath(), child, () => stderr);
    const stat = await fs.lstat(workspaceWorkerSocketPath());
    assert.equal(stat.mode & 0o777, 0o600);

    const read = await workspaceWorkerExecute('worker-test-node', 'dex.file.read', { path: file }, rootsHash) as { text?: string };
    assert.equal(read.text, 'hello worker\n');

    const fingerprint = await workspaceWorkerExecute('worker-test-node', 'dex.fingerprint', { cwd: work }, rootsHash) as { nodeId?: string; cwd?: string };
    assert.equal(fingerprint.nodeId, 'worker-test-node');
    assert.equal(fingerprint.cwd, await fs.realpath(work));

    assert.equal(await workspaceWorkerExecute('worker-test-node', 'dex.file.read', { path: file }, '0'.repeat(64)), null);
    assert.equal(await workspaceWorkerExecute('different-node', 'dex.file.read', { path: file }, rootsHash), null);
    assert.equal(await workspaceWorkerExecute('worker-test-node', 'dex.process.run', { command: 'pwd' }, rootsHash), null);

    const refused = await rawCall(workspaceWorkerSocketPath(), {
      version: 1,
      command: 'execute',
      payload: { nodeId: 'worker-test-node', operation: 'dex.process.run', args: { command: 'pwd' }, expectedRootsHash: rootsHash }
    });
    assert.equal(refused.ok, false);
    assert.equal(refused.code, 'refused');
    assert.match(refused.error || '', /allowlist/);

    const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
    child.kill('SIGTERM');
    await exited;
    child = spawn(process.execPath, ['--import', 'tsx', 'src/worker/main.ts'], {
      cwd: process.cwd(),
      env: {
        ...baseEnv,
        DEX_WORKSPACE_WORKER_DIR: workerDir,
        DEX_REACH_STATE_DIR: path.join(temp, 'must-not-leak'),
        DEX_REACH_NODE_TOKEN: 'must-not-leak',
        OPENAI_API_KEY: 'must-not-leak',
        SSH_AUTH_SOCK: '/tmp/must-not-leak'
      },
      stdio: ['ignore', 'ignore', 'pipe']
    });
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', chunk => { stderr += chunk; });
    await waitForSocket(workspaceWorkerSocketPath(), child, () => stderr);
    const afterRestart = await workspaceWorkerExecute('worker-test-node', 'dex.file.read', { path: file }, rootsHash) as { text?: string };
    assert.equal(afterRestart.text, 'hello worker\n');
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
      child.kill('SIGTERM');
      await exited;
    }
    if (previous === undefined) delete process.env.DEX_WORKSPACE_WORKER_DIR;
    else process.env.DEX_WORKSPACE_WORKER_DIR = previous;
    await fs.rm(temp, { recursive: true, force: true });
  }
});


test('every delegated operation is admitted under the narrowest profile the node can hold', () => {
  // The worker executes with a fixed `workspace-safe` profile rather than the effective profile the
  // node's authorization produced, so delegation may only ever carry operations that both profiles
  // admit. Today all three do. Adding one that `read-only` refuses would let the worker run, under
  // owner READ-ONLY, something the node itself would refuse: a narrowing must never widen, so the
  // allowlist is pinned here rather than left to be noticed later.
  for (const operation of WORKSPACE_WORKER_OPERATIONS) {
    const descriptor = requireOperation(operation);
    assert.equal(descriptor.readOnlyAllowed, true, `${operation} is delegated but refused under read-only`);
    assert.equal(descriptor.workspaceSafeAllowed, true, `${operation} is delegated but refused under workspace-safe`);
    assert.equal(descriptor.mutation, false, `${operation} is delegated but mutates`);
  }
});
