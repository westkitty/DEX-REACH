import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { appendReceipt, listReceipts } from '../src/shared/receipts.js';
import { consumePlan, createPlan, hashValue } from '../src/shared/plans.js';

const actor = { kind: 'chatgpt' as const, clientId: 'c1', clientName: 'ChatGPT' };

function canonical(value: unknown): string {
  const normalize = (input: unknown): unknown => Array.isArray(input) ? input.map(normalize) : input && typeof input === 'object' ? Object.fromEntries(Object.entries(input as Record<string, unknown>).sort(([a],[b]) => a.localeCompare(b)).map(([k,v]) => [k, normalize(v)])) : input;
  return JSON.stringify(normalize(value));
}

test('execution plans are exact, expiring, and one-use', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dex-reach-plan-'));
  const previous = process.env.DEX_REACH_STATE_DIR;
  try {
    process.env.DEX_REACH_STATE_DIR = root;
    const policyHash = hashValue({ mode: 'on' });
    const plan = await createPlan({ nodeId: 'n', actor, operation: 'dex.file.write', args: { path: '/tmp/x', text: 'x' }, policyHash, checkpointId: 'cp1' }, 60_000);
    assert.equal(plan.requestHash, hashValue({ operation: 'dex.file.write', args: { path: '/tmp/x', text: 'x' } }));
    const used = await consumePlan(plan.id);
    assert.equal(used.used, true);
    await assert.rejects(consumePlan(plan.id), /already used/);
  } finally {
    if (previous === undefined) delete process.env.DEX_REACH_STATE_DIR; else process.env.DEX_REACH_STATE_DIR = previous;
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('node receipts form a signed hash chain without embedding request contents', async () => {
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
    const { signature, receiptHash: _hash, ...base } = first;
    const payload = canonical(base);
    assert.equal(crypto.verify(null, Buffer.from(payload), first.publicKey, Buffer.from(signature, 'base64')), true);
    const tampered = { ...base, actor: { ...actor, clientName: 'Impostor' } };
    assert.equal(crypto.verify(null, Buffer.from(canonical(tampered)), first.publicKey, Buffer.from(signature, 'base64')), false);
  } finally {
    if (previous === undefined) delete process.env.DEX_REACH_STATE_DIR; else process.env.DEX_REACH_STATE_DIR = previous;
    await fs.rm(root, { recursive: true, force: true });
  }
});
