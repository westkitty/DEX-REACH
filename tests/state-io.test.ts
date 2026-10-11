import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { withFileLock } from '../src/shared/state-io.js';

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

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

test('a recovery guard abandoned by a crashed recoverer does not block the lock forever', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dex-guard-')); try {
    const lock = path.join(dir, 'x.lock');
    // A dead owner's lock plus the guard a killed recoverer left behind, both long past staleMs.
    const { spawnSync } = await import('node:child_process'); const dead = spawnSync(process.execPath, ['-e', '']).pid!;
    await fs.writeFile(lock, JSON.stringify({ pid: dead, createdAt: Date.now() - 120_000, token: 't' }));
    await fs.writeFile(`${lock}.recovery`, ''); const old = new Date(Date.now() - 120_000); await fs.utimes(`${lock}.recovery`, old, old);
    assert.equal(await withFileLock(lock, async () => 'acquired', { timeoutMs: 2_000, staleMs: 60_000 }), 'acquired');
    await assert.rejects(fs.stat(`${lock}.recovery`), /ENOENT/);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('a live recovery guard is waited on only until the timeout, never forever', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dex-guard-')); try {
    const lock = path.join(dir, 'x.lock');
    await fs.writeFile(`${lock}.recovery`, '');
    const started = Date.now();
    await assert.rejects(withFileLock(lock, async () => 'acquired', { timeoutMs: 300, staleMs: 60_000 }), /timed out waiting for DEX state lock/);
    assert.ok(Date.now() - started < 2_000);
    await fs.stat(`${lock}.recovery`); // A fresh guard is not removed.
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
