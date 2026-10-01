import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { readMacConfig } from '../scripts/lib/macos-config.js';
import { assessMacHealth, parseServiceHealth } from '../scripts/lib/macos-health.js';
import type { RuntimeStatus } from '../src/node/runtime-status.js';

const expected = { profile: 'full-local' as const, mode: 'on' as const, gatewayWs: 'ws://127.0.0.1:8787/node' };
const gateway = { running: true, pid: 100, runs: 1 };
const node = { running: true, pid: 200, runs: 1 };
const runtime: RuntimeStatus = {
  pid: 200, connected: true, gateway: 'ws://127.0.0.1:8787', profile: 'full-local',
  access: { mode: 'on', effectiveMode: 'on', until: null, revertTo: null, clients: {} },
  updatedAt: new Date().toISOString()
};
const body = { ok: true, onlineNodes: 1 };

test('health needs a live matching node, one online node, and AI ON/full-local', () => {
  assert.equal(assessMacHealth(gateway, node, runtime, body, expected).ok, true);
  assert.match(assessMacHealth(gateway, { running: false }, runtime, body, expected).reason, /node down/);
  assert.match(assessMacHealth({ running: false }, { running: false }, null, null, expected).reason, /gateway and node down/);
  assert.equal(assessMacHealth(gateway, node, { ...runtime, pid: 999 }, body, expected).ok, false);
  assert.equal(assessMacHealth(gateway, node, { ...runtime, updatedAt: 'invalid' }, body, expected).ok, false);
  assert.equal(assessMacHealth(gateway, node, { ...runtime, updatedAt: new Date(Date.now() - 20_000).toISOString() }, body, expected).ok, false);
  assert.match(assessMacHealth(gateway, node, { ...runtime, connected: false }, body, expected).reason, /reconnect pending/);
  assert.equal(assessMacHealth(gateway, node, runtime, { ok: true, onlineNodes: 0 }, expected).ok, false);
  assert.equal(assessMacHealth(gateway, node, runtime, { ok: true, onlineNodes: 2 }, expected).ok, false);
  assert.equal(assessMacHealth(gateway, node, runtime, { ok: false, onlineNodes: 1 }, expected).ok, false);
  assert.match(assessMacHealth(gateway, node, { ...runtime, access: { ...runtime.access, effectiveMode: 'off' } }, body, expected).reason, /AI mode/);
  assert.match(assessMacHealth(gateway, node, { ...runtime, profile: 'development' }, body, expected).reason, /profile/);
  assert.equal(assessMacHealth(gateway, { ...node, lastExit: 78 }, runtime, body, expected).ok, false);
});

test('launchd parsing does not confuse nested active state with a running process', () => {
  assert.deepEqual(parseServiceHealth('state = waiting\n\tpid = 200\n\truns = 3\n\tlast exit code = 78\n nested {\n state = active\n }'), {
    running: false, pid: 200, runs: 3, lastExit: 78, root: undefined
  });
});

test('installer preflight uses canonical files, handles quotes, and fails safely on missing keys', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dex-macos-config-'));
  const owner = path.join(dir, 'secrets.env');
  const nodeFile = path.join(dir, 'nodes', 'test-node.env');
  try {
    await fs.mkdir(path.dirname(nodeFile));
    await fs.writeFile(owner, `DEX_REACH_NODE_ID=test-node\nDEX_REACH_OWNER_PASSWORD="${'x'.repeat(24)}"\n`);
    await fs.writeFile(nodeFile, `DEX_REACH_NODE_ID=test-node\nDEX_REACH_NODE_TOKEN="${'y'.repeat(32)}"\nDEX_REACH_PROFILE=full-local\n`);
    const config = await readMacConfig(dir);
    assert.equal(config.node.profile, 'full-local');
    assert.equal(config.gateway.stateDir, dir);
    assert.equal(config.nodeFile, nodeFile);
    await fs.writeFile(nodeFile, 'DEX_REACH_NODE_ID=test-node\n');
    await assert.rejects(readMacConfig(dir), /test-node.env: DEX_REACH_NODE_TOKEN must contain at least 24/);
    await fs.writeFile(owner, 'DEX_REACH_NODE_ID=test-node\n');
    await assert.rejects(readMacConfig(dir), /secrets.env: DEX_REACH_OWNER_PASSWORD/);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('invalid copied configuration exits EX_CONFIG with a key-specific error and no secret dump', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dex-macos-bad-config-'));
  try {
    const file = path.join(dir, 'node.env');
    const secret = 'fixture-secret-never-log';
    await fs.writeFile(file, `DEX_REACH_NODE_ID=test-node\nUNRELATED_SECRET=${secret}\n`);
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('DEX_REACH_')));
    const result = spawnSync(process.execPath, ['--import', 'tsx', 'src/node/main.ts'], {
      env: { ...env, DEX_REACH_STATE_DIR: dir, DEX_REACH_ENV_FILE: file }, encoding: 'utf8', timeout: 20_000
    });
    assert.equal(result.status, 78);
    assert.match(result.stderr, /DEX configuration error.*node.env.*DEX_REACH_NODE_TOKEN/);
    assert.doesNotMatch(result.stderr, new RegExp(secret));
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
