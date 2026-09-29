import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_STATE_LOCK_TIMEOUT_MS, withFileLock } from '../src/shared/state-io.js';

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

test('default state-lock wait tolerates loaded-host contention without becoming unbounded', () => {
  assert.equal(DEFAULT_STATE_LOCK_TIMEOUT_MS, 15_000);
});

test('stale-lock recovery cannot fork replacement lock ownership', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dex-reach-lock-race-'));
  const lock = path.join(root, 'state.lock');
  try {
    await fs.writeFile(lock, JSON.stringify({ pid: 2_147_483_647, createdAt: Date.now() - 120_000, token: 'stale' }) + '\n');
    let active = 0;
    let maxActive = 0;
    let completed = 0;

    await Promise.all(Array.from({ length: 40 }, (_, index) => withFileLock(lock, async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await sleep((index % 4) + 1);
      completed += 1;
      active -= 1;
    }, { timeoutMs: 10_000, staleMs: 1 })));

    assert.equal(completed, 40);
    assert.equal(maxActive, 1);
    await assert.rejects(fs.stat(`${lock}.recovery`), /ENOENT/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
