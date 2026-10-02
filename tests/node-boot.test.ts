import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { startLivePair, type LivePair } from '../scripts/lib/live-reach.js';
import { coordinatorSocketPath } from '../src/shared/work-coordinator.js';
import { readRuntimeStatus } from '../src/node/runtime-status.js';
import { defaultAccessState, saveAccessState } from '../src/shared/access.js';

test('node hello and local heartbeat survive unavailable optional coordinator telemetry', { timeout: 60_000 }, async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'dex-node-boot-'));
  const dir = path.join(workspace, 'state');
  await fs.mkdir(dir);
  const prior = process.env.DEX_REACH_STATE_DIR;
  process.env.DEX_REACH_STATE_DIR = dir;
  const socket = coordinatorSocketPath();
  if (prior === undefined) delete process.env.DEX_REACH_STATE_DIR; else process.env.DEX_REACH_STATE_DIR = prior;
  const server = net.createServer(client => {
    client.on('error', () => undefined);
    client.once('data', () => client.end(JSON.stringify({ ok: false, error: 'fixture coordinator unavailable' }) + '\n'));
  });
  await new Promise<void>(resolve => server.listen(socket, resolve));
  let pair: LivePair | undefined;
  try {
    pair = await startLivePair({ repoRoot: process.cwd(), workspace, nodeIds: ['boot-node'], profile: 'full-local', timeoutMs: 30_000 });
    await saveAccessState('boot-node', { ...defaultAccessState(), mode: 'on' }, dir);
    const deadline = Date.now() + 6000;
    let runtime;
    while (Date.now() < deadline) {
      runtime = await readRuntimeStatus('boot-node', dir);
      if (runtime?.connected && runtime.access.effectiveMode === 'on') break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.equal(runtime?.connected, true, 'coordinator failure must not suppress the local heartbeat');
    assert.equal(runtime?.profile, 'full-local');
    assert.equal(runtime?.access.effectiveMode, 'on');
    assert.equal(pair.nodes.get('boot-node')?.child.exitCode, null);
    const listed = await pair.call('reach_list_nodes', {});
    assert.equal(listed.ok, true);
    assert.match(listed.text, /full-local/);
    assert.equal(JSON.parse(listed.text)[0].aiAccess.mode, 'on');
  } finally {
    await pair?.stop();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await fs.rm(socket, { force: true });
    await fs.rm(workspace, { recursive: true, force: true });
  }
});
