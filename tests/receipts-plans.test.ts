import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { appendReceipt, listReceipts, verifyReceipt, verifyReceiptChain } from '../src/shared/receipts.js';
import { consumePlan, createPlan, hashValue, sweepExpiredPlans } from '../src/shared/plans.js';

const actor = { kind: 'chatgpt' as const, clientId: 'c1', clientName: 'ChatGPT' };

test('execution plans are exact, expiring, one-use, and scrub raw args after claim', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dex-reach-plan-'));
  const previous = process.env.DEX_REACH_STATE_DIR;
  try {
    process.env.DEX_REACH_STATE_DIR = root;
    const policyHash = hashValue({ mode: 'on' });
    const plan = await createPlan({ nodeId: 'n', actor, operation: 'dex.file.write', args: { path: '/tmp/x', text: 'one-use-secret' }, policyHash, checkpointId: 'cp1' }, 60_000);
    assert.equal(plan.requestHash, hashValue({ operation: 'dex.file.write', args: { path: '/tmp/x', text: 'one-use-secret' } }));
    const used = await consumePlan(plan.id);
    assert.equal(used.used, true);
    assert.equal(used.args.text, 'one-use-secret');
    const stored = await fs.readFile(path.join(root, 'plans', `${plan.id}.json`), 'utf8');
    assert.doesNotMatch(stored, /one-use-secret/);
    assert.match(stored, /redacted/);
    await assert.rejects(consumePlan(plan.id), /already used|claimed/);
  } finally {
    if (previous === undefined) delete process.env.DEX_REACH_STATE_DIR; else process.env.DEX_REACH_STATE_DIR = previous;
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('abandoned expired plans are scrubbed without execution', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dex-reach-plan-expiry-'));
  const previous = process.env.DEX_REACH_STATE_DIR;
  try {
    process.env.DEX_REACH_STATE_DIR = root;
    const plan = await createPlan({ nodeId: 'n', actor, operation: 'dex.file.write', args: { path: '/tmp/x', text: 'abandoned-secret' }, policyHash: 'p', checkpointId: null }, 5);
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(await sweepExpiredPlans(), 1);
    const stored = await fs.readFile(path.join(root, 'plans', `${plan.id}.json`), 'utf8');
    assert.doesNotMatch(stored, /abandoned-secret/);
    await assert.rejects(consumePlan(plan.id), /already used|claimed/);
  } finally {
    if (previous === undefined) delete process.env.DEX_REACH_STATE_DIR; else process.env.DEX_REACH_STATE_DIR = previous;
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('concurrent plan claims allow exactly one execution claimant', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dex-reach-plan-race-'));
  const previous = process.env.DEX_REACH_STATE_DIR;
  try {
    process.env.DEX_REACH_STATE_DIR = root;
    const plan = await createPlan({ nodeId: 'n', actor, operation: 'dex.file.write', args: { path: '/tmp/x', text: 'race-secret' }, policyHash: 'p', checkpointId: null }, 60_000);
    const settled = await Promise.allSettled([consumePlan(plan.id), consumePlan(plan.id)]);
    assert.equal(settled.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(settled.filter(result => result.status === 'rejected').length, 1);
    assert.doesNotMatch(await fs.readFile(path.join(root, 'plans', `${plan.id}.json`), 'utf8'), /race-secret/);
  } finally {
    if (previous === undefined) delete process.env.DEX_REACH_STATE_DIR; else process.env.DEX_REACH_STATE_DIR = previous;
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('node receipts form a verified signed chain without embedding request contents', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dex-reach-receipt-'));
  const previous = process.env.DEX_REACH_STATE_DIR;
  try {
    process.env.DEX_REACH_STATE_DIR = root;
    const first = await appendReceipt({ nodeId: 'n', actor, operation: 'dex.file.write', args: { path: '/tmp/x', text: 'TOP SECRET CONTENT' }, ok: true, result: { bytes: 18 }, durationMs: 2, policy: { mode: 'on' } });
    const second = await appendReceipt({ nodeId: 'n', actor, operation: 'dex.repoInfo', args: { cwd: '/tmp' }, ok: true, result: { branch: 'main' }, durationMs: 1, policy: { mode: 'on' } });
    assert.equal(second.previousHash, first.receiptHash);
    const receipts = await listReceipts('n', 10);
    assert.equal(receipts.length, 2);
    assert.equal(JSON.stringify(receipts).includes('TOP SECRET CONTENT'), false);
    assert.equal(verifyReceipt(first), true);
    assert.equal(verifyReceiptChain(receipts), true);
    const tampered = { ...first, actor: { ...actor, clientName: 'Impostor' } };
    assert.equal(verifyReceipt(tampered), false);
  } finally {
    if (previous === undefined) delete process.env.DEX_REACH_STATE_DIR; else process.env.DEX_REACH_STATE_DIR = previous;
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('concurrent receipts remain one linear verified chain', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dex-reach-receipt-race-'));
  const previous = process.env.DEX_REACH_STATE_DIR;
  try {
    process.env.DEX_REACH_STATE_DIR = root;
    await Promise.all(Array.from({ length: 12 }, (_, i) => appendReceipt({ nodeId: 'n', actor, operation: `op-${i}`, args: { i }, ok: true, result: { i }, durationMs: 1, policy: { mode: 'on' } })));
    const receipts = await listReceipts('n', 20);
    assert.equal(receipts.length, 12);
    assert.equal(verifyReceiptChain(receipts), true);
  } finally {
    if (previous === undefined) delete process.env.DEX_REACH_STATE_DIR; else process.env.DEX_REACH_STATE_DIR = previous;
    await fs.rm(root, { recursive: true, force: true });
  }
});
