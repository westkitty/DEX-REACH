import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { consumeGrant, createGrant, restorePolicyRevision, saveAccessState, updateAccessState, type AccessState } from '../src/shared/access.js';
import { addPolicyAssertion, listPolicyHistory } from '../src/shared/policy-assertions.js';

const base = (mode: AccessState['mode'] = 'on'): AccessState => ({
  version: 3, revision: 0, mode, until: null, revertTo: null, clients: {}, grantRequired: {}, grants: [],
  updatedAt: new Date(0).toISOString()
});

async function isolated(): Promise<{ dir: string; node: string; restore: () => Promise<void> }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dex-reach-assert-'));
  const previous = process.env.DEX_REACH_STATE_DIR;
  process.env.DEX_REACH_STATE_DIR = dir;
  return {
    dir, node: 'n',
    restore: async () => {
      if (previous === undefined) delete process.env.DEX_REACH_STATE_DIR;
      else process.env.DEX_REACH_STATE_DIR = previous;
      await fs.rm(dir, { recursive: true, force: true });
    }
  };
}

test('custom assertions block owner policy writes that would grant forbidden authority', async () => {
  const ctx = await isolated();
  try {
    await saveAccessState(ctx.node, base('off'), ctx.dir);
    await addPolicyAssertion(ctx.node, {
      client: 'chatgpt',
      forbidCapabilities: ['process.shell'],
      note: 'ChatGPT must never have shell authority'
    }, ctx.dir);
    await assert.rejects(
      updateAccessState(ctx.node, current => ({ ...current, mode: 'on' }), ctx.dir),
      /unrestricted shell authority/
    );
    await updateAccessState(ctx.node, current => ({ ...current, clients: { chatgpt: 'read-only' }, mode: 'on' }), ctx.dir);
    const root = path.join(ctx.dir, 'project');
    await fs.mkdir(root);
    await assert.rejects(
      updateAccessState(ctx.node, current => createGrant(current, 'chatgpt', ['process.shell'], [root], 60_000, 1), ctx.dir),
      /must not hold process.shell/
    );
  } finally {
    await ctx.restore();
  }
});

test('owner policy history is append-only and restore creates a new revision', async () => {
  const ctx = await isolated();
  try {
    await saveAccessState(ctx.node, base('off'), ctx.dir);
    await updateAccessState(ctx.node, current => ({ ...current, mode: 'read-only' }), ctx.dir);
    const first = await listPolicyHistory(ctx.node, 20, ctx.dir);
    assert.ok(first.length >= 2);
    const offRevision = first[0]!.revision;
    const restored = await restorePolicyRevision(ctx.node, offRevision, ctx.dir);
    assert.ok(restored.revision > offRevision);
    assert.equal(restored.mode, 'off');
    const history = await listPolicyHistory(ctx.node, 20, ctx.dir);
    assert.ok(history.some(entry => entry.revision === offRevision));
    assert.equal(history.at(-1)?.restoredFrom, offRevision);
    assert.equal(history.at(-1)?.revision, restored.revision);
  } finally {
    await ctx.restore();
  }
});

test('grant use counters do not append policy history', async () => {
  const ctx = await isolated();
  try {
    const root = path.join(ctx.dir, 'project');
    await fs.mkdir(root);
    const granted = createGrant(base('on'), 'chatgpt', ['file.write'], [root], 60_000, 2);
    await saveAccessState(ctx.node, granted, ctx.dir);
    const before = (await listPolicyHistory(ctx.node, 20, ctx.dir)).length;
    await consumeGrant(ctx.node, granted.grants[0]!.id, ctx.dir);
    const after = await listPolicyHistory(ctx.node, 20, ctx.dir);
    assert.equal(after.length, before);
  } finally {
    await ctx.restore();
  }
});
