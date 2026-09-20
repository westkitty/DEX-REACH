import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SUSTAINED_HEALTH_MS, loadCapacityProfile, recordCapacityHealth, setCapacityProfile } from '../src/shared/capacity-profile.js';

async function withStateDir<T>(fn: () => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dex-capacity-profile-'));
  const previous = process.env.DEX_REACH_STATE_DIR;
  process.env.DEX_REACH_STATE_DIR = dir;
  try { return await fn(); }
  finally {
    if (previous === undefined) delete process.env.DEX_REACH_STATE_DIR; else process.env.DEX_REACH_STATE_DIR = previous;
    await fs.rm(dir, { recursive: true, force: true });
  }
}

const healthy = { memory: 'healthy' as const, cpu: 'healthy' as const, thermal: 'unknown' as const, observedUncoordinatedHeavy: 0 };

test('interactive profile requires sustained healthy samples and resets on pressure or profile changes', async () => {
  await withStateDir(async () => {
    assert.equal(await loadCapacityProfile(), 'conservative');
    await setCapacityProfile('interactive');
    const start = 1_000_000;
    assert.equal((await recordCapacityHealth({ ...healthy, now: start })).interactiveReady, false);
    assert.equal((await recordCapacityHealth({ ...healthy, now: start + SUSTAINED_HEALTH_MS - 1 })).interactiveReady, false);
    assert.equal((await recordCapacityHealth({ ...healthy, now: start + SUSTAINED_HEALTH_MS })).interactiveReady, true);
    assert.equal((await recordCapacityHealth({ ...healthy, memory: 'warning', now: start + SUSTAINED_HEALTH_MS + 1 })).interactiveReady, false);
    assert.equal((await recordCapacityHealth({ ...healthy, now: start + SUSTAINED_HEALTH_MS + 2 })).interactiveReady, false);
    await setCapacityProfile('conservative');
    assert.equal(await loadCapacityProfile(), 'conservative');
  });
});
