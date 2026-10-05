import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ResultStore } from '../src/node/result-store.js';

test('large results become bounded continuation handles and survive restart', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dex-reach-result-store-'));
  try {
  const store = new ResultStore(64, 60000, root);
  const bounded = await store.bound({ value: 'x'.repeat(500) }) as { truncated: boolean; handle: string };
  assert.equal(bounded.truncated, true);
  const first = await store.read(bounded.handle, 0, 80);
  assert.equal(typeof first.text, 'string');
  assert.ok(Number(first.totalCharacters) > 80);
  assert.equal(typeof first.nextOffset, 'number');
  assert.equal(await new ResultStore(64, 60000, root).readValue(bounded.handle) instanceof Object, true);
  await fs.writeFile(path.join(root, 'results', `${bounded.handle}.json`), '{}');
  await assert.rejects(() => new ResultStore(64, 60000, root).read(bounded.handle), /hash mismatch/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('result manifest corruption fails closed', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dex-reach-result-corrupt-'));
  try {
    await fs.mkdir(path.join(root, 'results'), { recursive: true });
    await fs.writeFile(path.join(root, 'results', 'manifest.json'), '{not-json');
    await assert.rejects(() => new ResultStore(64, 60000, root).bound({ value: 'x' }), /corrupt/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
