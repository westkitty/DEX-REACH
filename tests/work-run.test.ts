import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readCoordinatorState } from '../src/shared/work-coordinator.js';
import { runWithWorkLease } from '../src/shared/work-run.js';

const GIB = 1024 ** 3;
const snapshot = { physicalMemoryBytes: 64 * GIB, logicalCpuCount: 16, loadAverage1m: 0, memory: 'healthy' as const, thermal: 'healthy' as const, observed: { uncoordinatedHeavy: 0, dexServices: 0 } };

async function withStateDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dex-work-run-'));
  const previous = process.env.DEX_REACH_STATE_DIR;
  process.env.DEX_REACH_STATE_DIR = dir;
  try { return await fn(dir); }
  finally {
    if (previous === undefined) delete process.env.DEX_REACH_STATE_DIR; else process.env.DEX_REACH_STATE_DIR = previous;
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test('work-run releases its lease after the wrapped command exits', async () => {
  await withStateDir(async dir => {
    const repo = path.join(dir, 'repo');
    await fs.mkdir(repo);
    const result = await runWithWorkLease({ executor: 'codex', access: 'mutate', workload: 'medium', repositoryRoot: repo, snapshot }, process.execPath, ['-e', 'process.exit(0)']);
    assert.equal(result.status, 'completed');
    if (result.status === 'completed') assert.equal(result.exitCode, 0);
    assert.equal((await readCoordinatorState()).leases.length, 0);
  });
});
