import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { coordinatorSocketPath } from '../src/shared/work-coordinator.js';
import { coordinatedStatus } from '../src/coordinator/client.js';

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
  for (let attempt = 0; attempt < 100; attempt += 1) {
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
    const malformed = await socketCall(socketPath, '{not-json') as { ok: boolean; error?: string };
    assert.equal(malformed.ok, false);
    assert.match(malformed.error || '', /JSON|request/);
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
