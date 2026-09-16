import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { authorizeOperation, classifyClient, defaultAccessState, loadAccessState, modeForActor, parseDuration, resolveMode, saveAccessState, type AccessState } from '../src/shared/access.js';
import { nativeCall } from '../src/node/native.js';
import type { RequestActor } from '../src/shared/protocol.js';

const chatgpt: RequestActor = { kind: 'chatgpt', clientId: 'c1', clientName: 'ChatGPT' };
const claude: RequestActor = { kind: 'claude', clientId: 'c2', clientName: 'Claude Code (dex-reach)' };
const base = (mode: AccessState['mode'], extra: Partial<AccessState> = {}): AccessState => ({ version: 1, mode, until: null, revertTo: null, clients: {}, updatedAt: new Date(0).toISOString(), ...extra });

test('disabled mode refuses every operation with an owner-attributed reason', () => {
  for (const op of ['dex.fingerprint', 'dex.file.read', 'dex.file.write', 'dex.process.run', 'dc.call', 'dex.checkpoint']) {
    const decision = authorizeOperation(base('off'), chatgpt, op, 'development');
    assert.equal(decision.allowed, false);
    if (!decision.allowed) assert.match(decision.reason, /NODE OWNER has disabled remote AI execution/);
    if (!decision.allowed) assert.match(decision.reason, /ChatGPT \(chatgpt\)/);
  }
});

test('read-only mode allows inspection, forces the read-only profile, and refuses mutations', () => {
  const read = authorizeOperation(base('read-only'), chatgpt, 'dex.file.read', 'full-local');
  assert.deepEqual(read, { allowed: true, effectiveProfile: 'read-only' });
  const write = authorizeOperation(base('read-only'), chatgpt, 'dex.file.write', 'full-local');
  assert.equal(write.allowed, false);
  if (!write.allowed) assert.match(write.reason, /read-only .*mutation/);
  const checkpoint = authorizeOperation(base('read-only'), chatgpt, 'dex.checkpoint', 'full-local');
  assert.equal(checkpoint.allowed, false);
  // Process runs reach the read-only profile guard, which admits only inspection commands.
  const run = authorizeOperation(base('read-only'), chatgpt, 'dex.process.run', 'full-local');
  assert.deepEqual(run, { allowed: true, effectiveProfile: 'read-only' });
});

test('enabled mode applies the configured profile unchanged', () => {
  assert.deepEqual(authorizeOperation(base('on'), chatgpt, 'dex.file.write', 'development'), { allowed: true, effectiveProfile: 'development' });
  assert.deepEqual(authorizeOperation(base('on'), undefined, 'dex.process.run', 'full-local'), { allowed: true, effectiveProfile: 'full-local' });
});

test('read-only access actually blocks non-inspection commands at the executor', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dex-reach-access-'));
  try {
    const decision = authorizeOperation(base('read-only'), chatgpt, 'dex.process.run', 'full-local');
    assert.equal(decision.allowed, true);
    const profile = decision.allowed ? decision.effectiveProfile : 'read-only';
    const ok = await nativeCall('n', 'dex.process.run', { command: 'pwd', cwd: root }, [root], profile) as { exitCode: number };
    assert.equal(ok.exitCode, 0);
    await assert.rejects(
      nativeCall('n', 'dex.process.run', { command: 'touch created.txt', cwd: root }, [root], profile),
      /read-only profile permits only recognized inspection commands/
    );
    assert.equal(await fs.stat(path.join(root, 'created.txt')).catch(() => null), null);
    await assert.rejects(nativeCall('n', 'dex.file.write', { path: path.join(root, 'w.txt'), text: 'x' }, [root], profile), /read-only profile/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('timed enable expires deterministically and reverts to the prior mode', () => {
  const t0 = Date.parse('2026-09-16T00:00:00Z');
  const state = base('on', { until: new Date(t0 + 30 * 60_000).toISOString(), revertTo: 'off' });
  assert.equal(resolveMode(state, t0), 'on');
  assert.equal(resolveMode(state, t0 + 29 * 60_000), 'on');
  assert.equal(resolveMode(state, t0 + 30 * 60_000), 'off');
  assert.equal(authorizeOperation(state, chatgpt, 'dex.file.read', 'development', t0 + 31 * 60_000).allowed, false);
  assert.equal(authorizeOperation(state, chatgpt, 'dex.file.read', 'development', t0 + 10 * 60_000).allowed, true);
  const readOnlyWindow = base('read-only', { until: new Date(t0 + 60_000).toISOString(), revertTo: 'off' });
  assert.equal(resolveMode(readOnlyWindow, t0 + 61_000), 'off');
  assert.equal(parseDuration('30m'), 30 * 60_000);
  assert.equal(parseDuration('2h'), 2 * 3_600_000);
  assert.throws(() => parseDuration('forever'), /invalid duration/);
  assert.throws(() => parseDuration('30d'), /between/);
});

test('per-client ceilings distrust one client while another stays allowed', () => {
  const state = base('on', { clients: { chatgpt: 'read-only' } });
  assert.equal(modeForActor(state, chatgpt), 'read-only');
  assert.equal(modeForActor(state, claude), 'on');
  assert.equal(authorizeOperation(state, chatgpt, 'dex.file.write', 'development').allowed, false);
  assert.equal(authorizeOperation(state, claude, 'dex.file.write', 'development').allowed, true);
  const blocked = base('on', { clients: { chatgpt: 'off' } });
  const decision = authorizeOperation(blocked, chatgpt, 'dex.fingerprint', 'development');
  assert.equal(decision.allowed, false);
  if (!decision.allowed) assert.match(decision.reason, /for chatgpt clients/);
  // A ceiling can only lower access, never raise it above the node mode.
  assert.equal(modeForActor(base('off', { clients: { claude: 'on' } }), claude), 'off');
  // Unattributed requests fall under the `other` ceiling.
  assert.equal(modeForActor(base('on', { clients: { other: 'off' } }), undefined), 'off');
});

test('policy persists to disk, absent policy fails closed, corrupt policy fails closed', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dex-reach-policy-'));
  const previous = process.env.DEX_REACH_INITIAL_ACCESS;
  try {
    delete process.env.DEX_REACH_INITIAL_ACCESS;
    assert.equal((await loadAccessState('fresh', dir)).mode, 'off');
    process.env.DEX_REACH_INITIAL_ACCESS = 'on';
    assert.equal(defaultAccessState().mode, 'on');
    delete process.env.DEX_REACH_INITIAL_ACCESS;
    await saveAccessState('n1', base('read-only', { clients: { chatgpt: 'off' } }), dir);
    const loaded = await loadAccessState('n1', dir);
    assert.equal(loaded.mode, 'read-only');
    assert.deepEqual(loaded.clients, { chatgpt: 'off' });
    const stat = await fs.stat(path.join(dir, 'nodes', 'n1.access.json'));
    assert.equal(stat.mode & 0o777, 0o600);
    await fs.writeFile(path.join(dir, 'nodes', 'n2.access.json'), '{not json');
    assert.equal((await loadAccessState('n2', dir)).mode, 'off');
    await fs.writeFile(path.join(dir, 'nodes', 'n3.access.json'), JSON.stringify({ version: 1, mode: 'god' }));
    assert.equal((await loadAccessState('n3', dir)).mode, 'off');
  } finally {
    if (previous === undefined) delete process.env.DEX_REACH_INITIAL_ACCESS; else process.env.DEX_REACH_INITIAL_ACCESS = previous;
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('client attribution is derived from registration names', () => {
  assert.equal(classifyClient('ChatGPT'), 'chatgpt');
  assert.equal(classifyClient('Claude Code (dex-reach)'), 'claude');
  assert.equal(classifyClient('DEX REACH Smoke'), 'smoke');
  assert.equal(classifyClient('Some MCP Inspector'), 'other');
  assert.equal(classifyClient(undefined), 'other');
});
