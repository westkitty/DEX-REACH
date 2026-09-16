import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { authorizeOperation, classifyClient, createGrant, defaultAccessState, loadAccessState, modeForActor, parseDuration, reserveOperation, resolveMode, saveAccessState, updateAccessState, type AccessState } from '../src/shared/access.js';
import { nativeCall } from '../src/node/native.js';
import type { RequestActor } from '../src/shared/protocol.js';

const chatgpt: RequestActor = { kind: 'chatgpt', clientId: 'c1', clientName: 'ChatGPT' };
const claude: RequestActor = { kind: 'claude', clientId: 'c2', clientName: 'Claude Code (dex-reach)' };
const base = (mode: AccessState['mode'], extra: Partial<AccessState> = {}): AccessState => ({ version: 3, revision: 0, mode, until: null, revertTo: null, clients: {}, grantRequired: {}, grants: [], updatedAt: new Date(0).toISOString(), ...extra });

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
      /read-only profile permits only .*inspection commands/
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

test('capability grants constrain enabled clients by operation, root, expiry, and use count', async () => {
  const { createGrant, consumeGrant } = await import('../src/shared/access.js');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dex-reach-grant-'));
  const previousStateDir = process.env.DEX_REACH_STATE_DIR;
  try {
    process.env.DEX_REACH_STATE_DIR = path.join(root, 'state');
    const resource = path.join(root, 'project');
    await fs.mkdir(resource);
    let state = createGrant(base('on'), 'chatgpt', ['file.write'], [resource], 60_000, 1);
    const allowed = authorizeOperation(state, chatgpt, 'dex.file.write', 'development', Date.now(), { path: path.join(resource, 'x.txt') });
    assert.equal(allowed.allowed, true);
    if (!allowed.allowed) return;
    assert.ok(allowed.grantId);
    assert.equal(authorizeOperation(state, chatgpt, 'dex.process.run', 'development', Date.now(), { cwd: resource, command: 'pwd' }).allowed, false);
    assert.equal(authorizeOperation(state, chatgpt, 'dex.file.write', 'development', Date.now(), { path: '/etc/nope' }).allowed, false);
    await saveAccessState('g', state);
    await consumeGrant('g', allowed.grantId);
    state = await loadAccessState('g');
    assert.equal(authorizeOperation(state, chatgpt, 'dex.file.write', 'development', Date.now(), { path: path.join(resource, 'again.txt') }).allowed, false);
    assert.equal(authorizeOperation({ ...state, mode: 'off' }, chatgpt, 'dex.file.write', 'development', Date.now(), { path: path.join(resource, 'x.txt') }).allowed, false);
  } finally {
    if (previousStateDir === undefined) delete process.env.DEX_REACH_STATE_DIR; else process.env.DEX_REACH_STATE_DIR = previousStateDir;
    await fs.rm(root, { recursive: true, force: true });
  }
});


test('max-use grants cannot be double-spent by concurrent reservations', async () => {
  const { createGrant, consumeGrant } = await import('../src/shared/access.js');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dex-reach-grant-race-'));
  const previousStateDir = process.env.DEX_REACH_STATE_DIR;
  try {
    process.env.DEX_REACH_STATE_DIR = root;
    const resource = path.join(root, 'project');
    const state = createGrant(base('on'), 'chatgpt', ['file.write'], [resource], 60_000, 1);
    await saveAccessState('race', state);
    const id = state.grants[0]!.id;
    const settled = await Promise.allSettled([consumeGrant('race', id), consumeGrant('race', id)]);
    assert.equal(settled.filter(r => r.status === 'fulfilled').length, 1);
    assert.equal(settled.filter(r => r.status === 'rejected').length, 1);
    assert.equal((await loadAccessState('race')).grants[0]!.uses, 1);
  } finally {
    if (previousStateDir === undefined) delete process.env.DEX_REACH_STATE_DIR; else process.env.DEX_REACH_STATE_DIR = previousStateDir;
    await fs.rm(root, { recursive: true, force: true });
  }
});


test('stale policy writers cannot overwrite a newer local owner decision', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dex-reach-policy-cas-'));
  try {
    await saveAccessState('n', base('on'), dir);
    const stale = await loadAccessState('n', dir);
    await updateAccessState('n', current => ({ ...current, mode: 'off' }), dir);
    await assert.rejects(saveAccessState('n', { ...stale, grants: [...stale.grants] }, dir), /changed since it was loaded/);
    assert.equal((await loadAccessState('n', dir)).mode, 'off');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('final authorization reservation honors the latest owner policy and atomically consumes a grant', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dex-reach-reserve-'));
  try {
    const resource = path.join(dir, 'project');
    await fs.mkdir(resource);
    await saveAccessState('n', base('on'), dir);
    await updateAccessState('n', current => createGrant(current, 'chatgpt', ['file.write'], [resource], 60_000, 1), dir);
    const reserved = await reserveOperation('n', chatgpt, 'dex.file.write', 'development', { path: path.join(resource, 'x.txt') }, { dir });
    assert.equal(reserved.decision.allowed, true);
    assert.equal((await loadAccessState('n', dir)).grants[0]!.uses, 1);
    await updateAccessState('n', current => ({ ...current, mode: 'off' }), dir);
    await assert.rejects(
      reserveOperation('n', chatgpt, 'dex.file.read', 'development', { path: path.join(resource, 'x.txt') }, { dir }),
      /NODE OWNER has disabled/
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
