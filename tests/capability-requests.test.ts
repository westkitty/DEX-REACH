import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { authorizeOperation, loadAccessState, saveAccessState, type AccessState } from '../src/shared/access.js';
import { hashValue } from '../src/shared/hash.js';
import {
  approveCapabilityRequest,
  assertNarrowing,
  createCapabilityRequest,
  denyCapabilityRequest,
  listCapabilityRequests
} from '../src/shared/capability-requests.js';
import type { RequestActor } from '../src/shared/protocol.js';

const chatgpt: RequestActor = { kind: 'chatgpt', clientId: 'c1', clientName: 'ChatGPT' };
const base = (mode: AccessState['mode'] = 'on'): AccessState => ({
  version: 3, revision: 0, mode, until: null, revertTo: null, clients: {}, grantRequired: {}, grants: [],
  updatedAt: new Date(0).toISOString()
});

async function isolated(): Promise<{ dir: string; node: string; root: string; restore: () => Promise<void> }> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'dex-reach-request-'));
  const dir = path.join(home, 'state');
  const root = path.join(home, 'project');
  await fs.mkdir(root);
  const previous = process.env.DEX_REACH_STATE_DIR;
  process.env.DEX_REACH_STATE_DIR = dir;
  return {
    dir, node: 'n', root,
    restore: async () => {
      if (previous === undefined) delete process.env.DEX_REACH_STATE_DIR;
      else process.env.DEX_REACH_STATE_DIR = previous;
      await fs.rm(home, { recursive: true, force: true });
    }
  };
}

test('creating a request does not create a grant or change owner policy hash', async () => {
  const ctx = await isolated();
  try {
    await saveAccessState(ctx.node, base('on'), ctx.dir);
    const before = hashValue(await loadAccessState(ctx.node, ctx.dir));
    const request = await createCapabilityRequest(ctx.node, {
      client: 'chatgpt',
      capabilities: ['file.write'],
      roots: [ctx.root],
      durationMs: 60_000,
      maxUses: 1,
      justification: 'edit one project file',
      operation: 'dex.file.write',
      args: { path: path.join(ctx.root, 'x.txt'), text: 'hello', token: 'super-secret-value' }
    }, ctx.dir);
    assert.equal(request.status, 'pending');
    assert.equal(request.grantId, null);
    assert.equal(JSON.stringify(request).includes('super-secret-value'), false);
    assert.ok(request.requestHash);
    const state = await loadAccessState(ctx.node, ctx.dir);
    assert.equal(state.grants.length, 0);
    assert.equal(hashValue(state), before);
    assert.equal(authorizeOperation(state, chatgpt, 'dex.file.write', 'development', Date.now(), { path: path.join(ctx.root, 'x.txt') }).allowed, true);
  } finally {
    await ctx.restore();
  }
});

test('owner approval creates an ordinary grant; deny and expiry create none', async () => {
  const ctx = await isolated();
  try {
    await saveAccessState(ctx.node, base('on'), ctx.dir);
    const pending = await createCapabilityRequest(ctx.node, {
      client: 'chatgpt', capabilities: ['file.write'], roots: [ctx.root],
      durationMs: 60_000, maxUses: 1, justification: 'one typed write'
    }, ctx.dir);
    const approved = await approveCapabilityRequest(ctx.node, pending.id, {}, ctx.dir);
    const state = await loadAccessState(ctx.node, ctx.dir);
    assert.equal(state.grants.length, 1);
    assert.equal(state.grants[0]!.id, pending.id);
    assert.equal(state.grantRequired.chatgpt, true);
    assert.equal(approved.request.status, 'approved');
    const allowed = authorizeOperation(state, chatgpt, 'dex.file.write', 'development', Date.now(), { path: path.join(ctx.root, 'x.txt') });
    assert.equal(allowed.allowed, true);

    const denied = await createCapabilityRequest(ctx.node, {
      client: 'chatgpt', capabilities: ['process.shell'], roots: [ctx.root],
      durationMs: 60_000, maxUses: 1, justification: 'please give me a shell'
    }, ctx.dir);
    await denyCapabilityRequest(ctx.node, denied.id, ctx.dir);
    assert.equal((await loadAccessState(ctx.node, ctx.dir)).grants.length, 1);
    await assert.rejects(approveCapabilityRequest(ctx.node, denied.id, {}, ctx.dir), /already denied/);

    const expired = await createCapabilityRequest(ctx.node, {
      client: 'chatgpt', capabilities: ['file.read'], roots: [ctx.root],
      durationMs: 1000, maxUses: 1, justification: 'soon gone'
    }, ctx.dir);
    const file = path.join(ctx.dir, 'nodes', `${ctx.node}.capability-requests.json`);
    const parsed = JSON.parse(await fs.readFile(file, 'utf8')) as { requests: Array<{ id: string; expiresAt: string }> };
    const target = parsed.requests.find(entry => entry.id === expired.id)!;
    target.expiresAt = new Date(Date.now() - 1000).toISOString();
    await fs.writeFile(file, JSON.stringify(parsed));
    await assert.rejects(approveCapabilityRequest(ctx.node, expired.id, {}, ctx.dir), /expired/);
    assert.equal((await listCapabilityRequests(ctx.node, ctx.dir)).find(entry => entry.id === expired.id)?.status, 'expired');
    assert.equal((await loadAccessState(ctx.node, ctx.dir)).grants.length, 1);
  } finally {
    await ctx.restore();
  }
});

test('owner may narrow a request and cannot widen it', async () => {
  const ctx = await isolated();
  try {
    const nested = path.join(ctx.root, 'src');
    await fs.mkdir(nested);
    const request = await createCapabilityRequest(ctx.node, {
      client: 'claude',
      capabilities: ['file.read', 'file.write'],
      roots: [ctx.root],
      durationMs: 120_000,
      maxUses: 4,
      justification: 'project edits'
    }, ctx.dir);
    assert.equal(assertNarrowing(request, { capabilities: ['file.write'], roots: [nested], durationMs: 30_000, maxUses: 1 }).narrowed, true);
    assert.throws(() => assertNarrowing(request, { capabilities: ['process.shell'] }), /cannot add capabilities/);
    assert.throws(() => assertNarrowing(request, { roots: ['/etc'] }), /cannot widen filesystem roots/);
    assert.throws(() => assertNarrowing(request, { durationMs: 240_000 }), /cannot extend/);
    assert.throws(() => assertNarrowing(request, { maxUses: 8 }), /cannot raise max-uses/);
    assert.throws(() => assertNarrowing(request, { maxUses: null }), /cannot remove a max-uses cap/);
  } finally {
    await ctx.restore();
  }
});

test('an approved grant still cannot override OFF', async () => {
  const ctx = await isolated();
  try {
    await saveAccessState(ctx.node, base('off'), ctx.dir);
    const request = await createCapabilityRequest(ctx.node, {
      client: 'chatgpt', capabilities: ['file.write'], roots: [ctx.root],
      durationMs: 60_000, maxUses: 1, justification: 'write while off'
    }, ctx.dir);
    await approveCapabilityRequest(ctx.node, request.id, {}, ctx.dir);
    const state = await loadAccessState(ctx.node, ctx.dir);
    assert.equal(state.grants.length, 1);
    assert.equal(authorizeOperation(state, chatgpt, 'dex.file.write', 'development', Date.now(), { path: path.join(ctx.root, 'x.txt') }).allowed, false);
  } finally {
    await ctx.restore();
  }
});

test('justification cannot carry credential-shaped material', async () => {
  const ctx = await isolated();
  try {
    await assert.rejects(createCapabilityRequest(ctx.node, {
      client: 'chatgpt', capabilities: ['file.read'], roots: [ctx.root],
      durationMs: 60_000, maxUses: 1,
      justification: 'token Abcdefghij1234567890KLmnop'
    }, ctx.dir), /credential material/);
  } finally {
    await ctx.restore();
  }
});

test('retried approval does not mint a second grant', async () => {
  const ctx = await isolated();
  try {
    await saveAccessState(ctx.node, base('on'), ctx.dir);
    const request = await createCapabilityRequest(ctx.node, {
      client: 'chatgpt', capabilities: ['file.read'], roots: [ctx.root],
      durationMs: 60_000, maxUses: 1, justification: 'read once'
    }, ctx.dir);
    await approveCapabilityRequest(ctx.node, request.id, {}, ctx.dir);
    await assert.rejects(approveCapabilityRequest(ctx.node, request.id, {}, ctx.dir), /already approved/);
    assert.equal((await loadAccessState(ctx.node, ctx.dir)).grants.length, 1);
  } finally {
    await ctx.restore();
  }
});
