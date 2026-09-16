import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { NodeAuthStore } from '../src/gateway/node-auth.js';

test('node credentials are isolated, rotatable, and revocable', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dex-reach-node-auth-'));
  try {
    const store = new NodeAuthStore(dir);
    await store.initialize();
    const tokenA = await store.enroll('node-a');
    const tokenB = await store.enroll('node-b');
    assert.equal(await store.authenticate('node-a', tokenA), true);
    assert.equal(await store.authenticate('node-b', tokenA), false);
    assert.equal(await store.authenticate('node-b', tokenB), true);
    const rotatedA = await store.rotate('node-a', 60_000);
    assert.equal(await store.authenticate('node-a', rotatedA), true);
    assert.equal(await store.authenticate('node-a', tokenA), true);
    assert.equal(await store.authenticate('node-b', rotatedA), false);
    assert.equal(await store.revoke('node-a'), true);
    assert.equal(await store.authenticate('node-a', rotatedA), false);
    assert.equal(await store.authenticate('node-a', tokenA), false);
    assert.equal(await store.authenticate('node-b', tokenB), true);
    await assert.rejects(store.forget('node-b'), /revoke it first/);
    assert.equal(await store.forget('node-a'), true);
    assert.equal(store.list().map(n => n.nodeId).join(','), 'node-b');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
