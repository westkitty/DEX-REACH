import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import {
  scrubWorkspaceWorkerEnvironment,
  workspaceWorkerConfigFile,
  workspaceWorkerExecute,
  workspaceWorkerRootsHash,
  workspaceWorkerSocketPath
} from '../src/shared/workspace-worker.js';

async function waitForSocket(socketPath: string, stderr: () => string): Promise<void> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try { if ((await fs.lstat(socketPath)).isSocket()) return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`workspace worker socket did not appear: ${stderr()}`);
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
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'dex-workspace-worker-test-'));
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
    await waitForSocket(workspaceWorkerSocketPath(), () => stderr);
    const stat = await fs.lstat(workspaceWorkerSocketPath());
    assert.equal(stat.mode & 0o777, 0o600);

    const read = await workspaceWorkerExecute('worker-test-node', 'dex.file.read', { path: file }, rootsHash) as { text?: string };
    assert.equal(read.text, 'hello worker\n');

    const fingerprint = await workspaceWorkerExecute('worker-test-node', 'dex.fingerprint', { cwd: work }, rootsHash) as { nodeId?: string; cwd?: string };
    assert.equal(fingerprint.nodeId, 'worker-test-node');
    assert.equal(fingerprint.cwd, await fs.realpath(work));

    assert.equal(await workspaceWorkerExecute('worker-test-node', 'dex.file.read', { path: file }, '0'.repeat(64)), null);
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
    await waitForSocket(workspaceWorkerSocketPath(), () => stderr);
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
