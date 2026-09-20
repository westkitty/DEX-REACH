import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { authorizeOperation, createGrant, loadAccessState, reserveOperation, saveAccessState, updateAccessState, type AccessState } from '../src/shared/access.js';
import { hashValue } from '../src/shared/hash.js';
import { requestedAuthorityCost } from '../src/shared/operations.js';
import { workspaceSafeOperationRefusal } from '../src/shared/profiles.js';
import { clearBudgetRule, inspectBudgetPolicy, makeBudgetRule, policyRestricts, upsertBudgetRule } from '../src/shared/budget-policy.js';
import { BudgetUsageCorruptError, loadBudgetUsage, releaseBudgetConcurrency, reserveBudgetUsage, usedInWindow } from '../src/shared/budget-usage.js';
import type { RequestActor } from '../src/shared/protocol.js';

const chatgpt: RequestActor = { kind: 'chatgpt', clientId: 'c1', clientName: 'ChatGPT' };
const claude: RequestActor = { kind: 'claude', clientId: 'c2', clientName: 'Claude Code (dex-reach)' };
const base = (mode: AccessState['mode'], extra: Partial<AccessState> = {}): AccessState => ({
  version: 3, revision: 0, mode, until: null, revertTo: null, clients: {}, grantRequired: {}, grants: [],
  updatedAt: new Date(0).toISOString(), ...extra
});

async function isolated(): Promise<{ dir: string; node: string; restore: () => Promise<void> }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dex-reach-budget-'));
  const previous = process.env.DEX_REACH_STATE_DIR;
  process.env.DEX_REACH_STATE_DIR = dir;
  return {
    dir,
    node: 'n',
    restore: async () => {
      if (previous === undefined) delete process.env.DEX_REACH_STATE_DIR;
      else process.env.DEX_REACH_STATE_DIR = previous;
      await fs.rm(dir, { recursive: true, force: true });
    }
  };
}

const opCost = requestedAuthorityCost('dex.file.read', { path: '/tmp/x' });
const writeCost = requestedAuthorityCost('dex.file.write', { path: '/tmp/x', text: 'hello' });
const shellCost = requestedAuthorityCost('dex.process.run', { command: 'ls', timeoutMs: 15000 });

test('no configured budget preserves pre-budget authorization and reservation behavior', async () => {
  const ctx = await isolated();
  try {
    await saveAccessState(ctx.node, base('on'), ctx.dir);
    const before = hashValue(await loadAccessState(ctx.node, ctx.dir));
    const allowed = authorizeOperation(base('on'), chatgpt, 'dex.file.write', 'development');
    assert.equal(allowed.allowed, true);
    const reserved = await reserveOperation(ctx.node, chatgpt, 'dex.file.write', 'development', { path: '/tmp/x', text: 'hello' }, { dir: ctx.dir });
    assert.equal(reserved.decision.allowed, true);
    assert.equal(reserved.budgetReservationId, undefined);
    assert.equal(hashValue(await loadAccessState(ctx.node, ctx.dir)), before);
    const inspection = await inspectBudgetPolicy(ctx.node, ctx.dir);
    assert.equal(inspection.unrestricted, true);
    assert.equal(inspection.exists, false);
  } finally {
    await ctx.restore();
  }
});

test('budget never grants authority: OFF still wins over a huge budget', async () => {
  const ctx = await isolated();
  try {
    await saveAccessState(ctx.node, base('off'), ctx.dir);
    await upsertBudgetRule(ctx.node, 'shared', makeBudgetRule('shared', 3_600_000, { maxOperations: 1_000_000 }), ctx.dir);
    await assert.rejects(
      reserveOperation(ctx.node, chatgpt, 'dex.fingerprint', 'development', {}, { dir: ctx.dir }),
      /NODE OWNER has disabled remote AI execution/
    );
    const usage = await loadBudgetUsage(ctx.node, ctx.dir);
    assert.equal(usage.samples.length, 0);
    assert.equal(usage.inflight.length, 0);
  } finally {
    await ctx.restore();
  }
});

test('READ-ONLY still wins: a budget cannot admit a typed write', async () => {
  const ctx = await isolated();
  try {
    await saveAccessState(ctx.node, base('read-only'), ctx.dir);
    await upsertBudgetRule(ctx.node, 'shared', makeBudgetRule('shared', 3_600_000, { maxOperations: 100, maxMutations: 100 }), ctx.dir);
    await assert.rejects(
      reserveOperation(ctx.node, chatgpt, 'dex.file.write', 'full-local', { path: '/tmp/x', text: 'x' }, { dir: ctx.dir }),
      /read-only .*mutation/
    );
    assert.equal((await loadBudgetUsage(ctx.node, ctx.dir)).samples.length, 0);
  } finally {
    await ctx.restore();
  }
});

test('workspace-safe still wins: a budget cannot re-admit arbitrary shell', async () => {
  const ctx = await isolated();
  try {
    await saveAccessState(ctx.node, base('on'), ctx.dir);
    await upsertBudgetRule(ctx.node, 'shared', makeBudgetRule('shared', 3_600_000, { maxShellCalls: 100 }), ctx.dir);
    const reserved = await reserveOperation(ctx.node, claude, 'dex.process.run', 'workspace-safe', { command: 'ls' }, { dir: ctx.dir });
    assert.equal(reserved.decision.allowed, true);
    const refusal = workspaceSafeOperationRefusal('workspace-safe', 'dex.process.run');
    assert.ok(refusal);
    assert.match(refusal!, /does not permit dex.process.run/);
    if (reserved.budgetReservationId) await releaseBudgetConcurrency(ctx.node, reserved.budgetReservationId, ctx.dir);
  } finally {
    await ctx.restore();
  }
});

test('client ceilings still narrow under a generous budget', async () => {
  const ctx = await isolated();
  try {
    await saveAccessState(ctx.node, base('on', { clients: { chatgpt: 'read-only' } }), ctx.dir);
    await upsertBudgetRule(ctx.node, 'chatgpt', makeBudgetRule('chatgpt', 3_600_000, { maxMutations: 50 }), ctx.dir);
    await assert.rejects(
      reserveOperation(ctx.node, chatgpt, 'dex.file.write', 'development', { text: 'x' }, { dir: ctx.dir }),
      /read-only .*mutation/
    );
    const claudeWrite = await reserveOperation(ctx.node, claude, 'dex.file.write', 'development', { text: 'x' }, { dir: ctx.dir });
    assert.equal(claudeWrite.decision.allowed, true);
    if (claudeWrite.budgetReservationId) await releaseBudgetConcurrency(ctx.node, claudeWrite.budgetReservationId, ctx.dir);
  } finally {
    await ctx.restore();
  }
});

test('capability grants still narrow under a generous budget', async () => {
  const ctx = await isolated();
  try {
    const resource = path.join(ctx.dir, 'project');
    await fs.mkdir(resource);
    const granted = createGrant(base('on'), 'chatgpt', ['file.read'], [resource], 60_000, 5);
    await saveAccessState(ctx.node, granted, ctx.dir);
    await upsertBudgetRule(ctx.node, 'chatgpt', makeBudgetRule('chatgpt', 3_600_000, { maxOperations: 100, maxMutations: 100 }), ctx.dir);
    await assert.rejects(
      reserveOperation(ctx.node, chatgpt, 'dex.file.write', 'development', { path: path.join(resource, 'x.txt'), text: 'x' }, { dir: ctx.dir }),
      /requires an active capability grant/
    );
    assert.equal((await loadBudgetUsage(ctx.node, ctx.dir)).samples.length, 0);
  } finally {
    await ctx.restore();
  }
});

test('rolling-window expiration restores capacity', async () => {
  const ctx = await isolated();
  try {
    await upsertBudgetRule(ctx.node, 'shared', makeBudgetRule('shared', 60_000, { maxOperations: 1 }), ctx.dir);
    const t0 = 1_700_000_000_000;
    const first = await reserveBudgetUsage(ctx.node, 'chatgpt', opCost, { dir: ctx.dir, now: t0 });
    assert.equal(first.allowed, true);
    const denied = await reserveBudgetUsage(ctx.node, 'chatgpt', opCost, { dir: ctx.dir, now: t0 + 10_000 });
    assert.equal(denied.allowed, false);
    const restored = await reserveBudgetUsage(ctx.node, 'chatgpt', opCost, { dir: ctx.dir, now: t0 + 60_000 });
    assert.equal(restored.allowed, true);
  } finally {
    await ctx.restore();
  }
});

test('shared and per-client limits intersect by minimum; a larger client ceiling cannot widen shared', async () => {
  const ctx = await isolated();
  try {
    await upsertBudgetRule(ctx.node, 'shared', makeBudgetRule('shared', 3_600_000, { maxOperations: 2 }), ctx.dir);
    await upsertBudgetRule(ctx.node, 'chatgpt', makeBudgetRule('chatgpt', 3_600_000, { maxOperations: 50 }), ctx.dir);
    assert.equal((await reserveBudgetUsage(ctx.node, 'chatgpt', opCost, { dir: ctx.dir })).allowed, true);
    assert.equal((await reserveBudgetUsage(ctx.node, 'chatgpt', opCost, { dir: ctx.dir })).allowed, true);
    const third = await reserveBudgetUsage(ctx.node, 'chatgpt', opCost, { dir: ctx.dir });
    assert.equal(third.allowed, false);
    if (!third.allowed) assert.match(third.reason, /this node/);
    const claudeOp = await reserveBudgetUsage(ctx.node, 'claude', opCost, { dir: ctx.dir });
    assert.equal(claudeOp.allowed, false);
  } finally {
    await ctx.restore();
  }
});

test('file-write bytes and process timeout charge deterministically', async () => {
  const ctx = await isolated();
  try {
    await saveAccessState(ctx.node, base('on'), ctx.dir);
    await upsertBudgetRule(ctx.node, 'shared', makeBudgetRule('shared', 3_600_000, {
      maxRequestedWriteBytes: 5,
      maxRequestedProcessMs: 15000
    }), ctx.dir);
    const write = await reserveOperation(ctx.node, chatgpt, 'dex.file.write', 'development', { text: 'hello' }, { dir: ctx.dir });
    assert.equal(write.decision.allowed, true);
    await assert.rejects(
      reserveOperation(ctx.node, chatgpt, 'dex.file.write', 'development', { text: 'hello!' }, { dir: ctx.dir }),
      /requested write bytes/
    );
    const run = await reserveOperation(ctx.node, chatgpt, 'dex.process.run', 'development', { command: 'ls', timeoutMs: 15000 }, { dir: ctx.dir });
    assert.equal(run.decision.allowed, true);
    await assert.rejects(
      reserveOperation(ctx.node, chatgpt, 'dex.process.run', 'development', { command: 'ls', timeoutMs: 15001 }, { dir: ctx.dir }),
      /requested process ms/
    );
    if (write.budgetReservationId) await releaseBudgetConcurrency(ctx.node, write.budgetReservationId, ctx.dir);
    if (run.budgetReservationId) await releaseBudgetConcurrency(ctx.node, run.budgetReservationId, ctx.dir);
    assert.equal(writeCost.requestedWriteBytes, 5);
    assert.equal(shellCost.requestedProcessMs, 15000);
  } finally {
    await ctx.restore();
  }
});

test('failed preauthorization consumes nothing; reserved execution stays charged after failure', async () => {
  const ctx = await isolated();
  try {
    await saveAccessState(ctx.node, base('on'), ctx.dir);
    await upsertBudgetRule(ctx.node, 'shared', makeBudgetRule('shared', 3_600_000, { maxOperations: 1, maxConcurrent: 1 }), ctx.dir);
    await assert.rejects(
      reserveOperation(ctx.node, chatgpt, 'dex.file.write', 'development', { text: 'x' }, { dir: ctx.dir, expectedPolicyHash: 'not-the-hash' }),
      /node policy changed after planning/
    );
    assert.equal((await loadBudgetUsage(ctx.node, ctx.dir)).samples.length, 0);

    const reserved = await reserveOperation(ctx.node, chatgpt, 'dex.file.read', 'development', { path: '/tmp/x' }, { dir: ctx.dir });
    assert.ok(reserved.budgetReservationId);
    await assert.rejects(
      reserveOperation(ctx.node, chatgpt, 'dex.file.read', 'development', { path: '/tmp/y' }, { dir: ctx.dir }),
      /operations per rolling window/
    );
    await releaseBudgetConcurrency(ctx.node, reserved.budgetReservationId, ctx.dir);
    const usage = await loadBudgetUsage(ctx.node, ctx.dir);
    assert.equal(usage.samples.length, 1);
    assert.equal(usage.inflight.length, 0);
    assert.equal(usedInWindow(usage, 'shared', 3_600_000).operations, 1);
    await assert.rejects(
      reserveOperation(ctx.node, chatgpt, 'dex.file.read', 'development', { path: '/tmp/z' }, { dir: ctx.dir }),
      /operations/
    );
  } finally {
    await ctx.restore();
  }
});

test('missing or corrupt budget policy is unrestricted; corrupt usage with a real policy fails closed', async () => {
  const ctx = await isolated();
  try {
    const missing = await inspectBudgetPolicy(ctx.node, ctx.dir);
    assert.equal(missing.exists, false);
    assert.equal(missing.unrestricted, true);
    await fs.mkdir(path.join(ctx.dir, 'nodes'), { recursive: true });
    await fs.writeFile(path.join(ctx.dir, 'nodes', `${ctx.node}.budget-policy.json`), '{not json');
    const corruptPolicy = await inspectBudgetPolicy(ctx.node, ctx.dir);
    assert.equal(corruptPolicy.valid, false);
    assert.equal(corruptPolicy.unrestricted, true);
    await saveAccessState(ctx.node, base('on'), ctx.dir);
    const reserved = await reserveOperation(ctx.node, chatgpt, 'dex.file.read', 'development', {}, { dir: ctx.dir });
    assert.equal(reserved.decision.allowed, true);

    await upsertBudgetRule(ctx.node, 'shared', makeBudgetRule('shared', 3_600_000, { maxOperations: 3 }), ctx.dir);
    await fs.writeFile(path.join(ctx.dir, 'nodes', `${ctx.node}.budget-usage.json`), '{broken');
    await assert.rejects(
      reserveOperation(ctx.node, chatgpt, 'dex.file.read', 'development', {}, { dir: ctx.dir }),
      (error: unknown) => error instanceof BudgetUsageCorruptError || (error instanceof Error && /corrupt/.test(error.message))
    );
  } finally {
    await ctx.restore();
  }
});

test('budget usage writes remain parseable JSON under concurrent reservations', async () => {
  const ctx = await isolated();
  try {
    await upsertBudgetRule(ctx.node, 'shared', makeBudgetRule('shared', 3_600_000, { maxOperations: 50, maxConcurrent: 50 }), ctx.dir);
    const writers = await Promise.all(Array.from({ length: 12 }, () => reserveBudgetUsage(ctx.node, 'claude', opCost, { dir: ctx.dir })));
    assert.equal(writers.filter(result => result.allowed).length, 12);
    const raw = await fs.readFile(path.join(ctx.dir, 'nodes', `${ctx.node}.budget-usage.json`), 'utf8');
    const parsed = JSON.parse(raw) as { samples: unknown[]; inflight: unknown[] };
    assert.equal(parsed.samples.length, 12);
    assert.equal(parsed.inflight.length, 12);
  } finally {
    await ctx.restore();
  }
});

test('concurrency cannot overrun the last slot; 20 waiters against capacity 5 admit exactly 5', async () => {
  const ctx = await isolated();
  try {
    await saveAccessState(ctx.node, base('on'), ctx.dir);
    await upsertBudgetRule(ctx.node, 'shared', makeBudgetRule('shared', 3_600_000, { maxConcurrent: 5, maxOperations: 1000 }), ctx.dir);
    const settled = await Promise.allSettled(Array.from({ length: 20 }, (_, index) =>
      reserveOperation(ctx.node, chatgpt, 'dex.file.read', 'development', { path: `/tmp/${index}` }, { dir: ctx.dir })
    ));
    const admitted = settled.filter(result => result.status === 'fulfilled');
    const refused = settled.filter(result => result.status === 'rejected');
    assert.equal(admitted.length, 5);
    assert.equal(refused.length, 15);
    for (const result of refused) {
      if (result.status === 'rejected') assert.match(String(result.reason), /concurrent operations/);
    }
    const usage = await loadBudgetUsage(ctx.node, ctx.dir);
    assert.equal(usage.inflight.length, 5);
    for (const result of admitted) {
      if (result.status === 'fulfilled') await releaseBudgetConcurrency(ctx.node, result.value.budgetReservationId, ctx.dir);
    }
    assert.equal((await loadBudgetUsage(ctx.node, ctx.dir)).inflight.length, 0);
  } finally {
    await ctx.restore();
  }
});

test('policy then budget lock ordering cannot deadlock under mixed contention', async () => {
  const ctx = await isolated();
  try {
    await saveAccessState(ctx.node, base('on'), ctx.dir);
    await upsertBudgetRule(ctx.node, 'shared', makeBudgetRule('shared', 3_600_000, { maxOperations: 500, maxConcurrent: 500 }), ctx.dir);
    const work = [
      ...Array.from({ length: 12 }, (_, index) => reserveOperation(ctx.node, chatgpt, 'dex.file.read', 'development', { path: `/tmp/${index}` }, { dir: ctx.dir })),
      ...Array.from({ length: 8 }, () => updateAccessState(ctx.node, current => ({ ...current, updatedAt: new Date().toISOString() }), ctx.dir)),
      ...Array.from({ length: 8 }, (_, index) => upsertBudgetRule(ctx.node, 'chatgpt', makeBudgetRule('chatgpt', 3_600_000, { maxOperations: 400 + index }), ctx.dir))
    ];
    const settled = await Promise.allSettled(work);
    const failures = settled.filter(result => result.status === 'rejected');
    assert.equal(failures.length, 0, failures.map(result => result.status === 'rejected' ? String(result.reason) : '').join('; '));
    const usage = await loadBudgetUsage(ctx.node, ctx.dir);
    for (const entry of usage.inflight) await releaseBudgetConcurrency(ctx.node, entry.id, ctx.dir);
  } finally {
    await ctx.restore();
  }
});

test('plan/commit cannot launder a higher-risk target past budget classification', async () => {
  const ctx = await isolated();
  try {
    await saveAccessState(ctx.node, base('on'), ctx.dir);
    await upsertBudgetRule(ctx.node, 'shared', makeBudgetRule('shared', 3_600_000, { maxShellCalls: 0, maxOperations: 100 }), ctx.dir);
    const inherited = requestedAuthorityCost('dex.commitPlan', { planId: 'p' }, {
      plannedTarget: 'dex.process.run',
      plannedArgs: { command: 'ls', timeoutMs: 9000 }
    });
    assert.equal(inherited.shellCalls, 1);
    await assert.rejects(
      reserveOperation(ctx.node, chatgpt, 'dex.process.run', 'development', { command: 'ls', timeoutMs: 9000 }, { dir: ctx.dir }),
      /shell calls/
    );
    const wrapper = await reserveOperation(ctx.node, chatgpt, 'dex.commitPlan', 'development', { planId: 'p' }, { dir: ctx.dir });
    assert.equal(wrapper.decision.allowed, true);
    assert.equal(wrapper.budgetReservationId, undefined);
    const inspect = await reserveOperation(ctx.node, chatgpt, 'dex.file.read', 'development', { path: '/tmp/x' }, { dir: ctx.dir });
    assert.equal(inspect.decision.allowed, true);
    if (inspect.budgetReservationId) await releaseBudgetConcurrency(ctx.node, inspect.budgetReservationId, ctx.dir);
  } finally {
    await ctx.restore();
  }
});

test('clearing the last budget restores unrestricted behavior and policyRestricts is honest', async () => {
  const ctx = await isolated();
  try {
    const rule = makeBudgetRule('shared', 3_600_000, { maxOperations: 1 });
    const policy = await upsertBudgetRule(ctx.node, 'shared', rule, ctx.dir);
    assert.equal(policyRestricts(policy), true);
    const cleared = await clearBudgetRule(ctx.node, 'shared', ctx.dir);
    assert.equal(policyRestricts(cleared), false);
    await saveAccessState(ctx.node, base('on'), ctx.dir);
    const reserved = await reserveOperation(ctx.node, chatgpt, 'dex.process.run', 'development', { command: 'ls' }, { dir: ctx.dir });
    assert.equal(reserved.budgetReservationId, undefined);
  } finally {
    await ctx.restore();
  }
});
