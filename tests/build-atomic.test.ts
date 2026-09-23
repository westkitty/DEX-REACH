import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { replaceBuiltDirectory } from '../scripts/build-atomic.js';

test('atomic build replacement removes stale artifacts only after staged output exists', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dex-atomic-build-'));
  const finalDir = path.join(root, 'dist');
  const stagedDir = path.join(root, '.dist-build-test');
  const backupDir = path.join(root, '.dist-previous-test');

  try {
    await fs.mkdir(finalDir);
    await fs.writeFile(path.join(finalDir, 'live.js'), 'old');
    await fs.writeFile(path.join(finalDir, 'stale.js'), 'stale');
    await fs.mkdir(stagedDir);
    await fs.writeFile(path.join(stagedDir, 'live.js'), 'new');

    await replaceBuiltDirectory(root, stagedDir, finalDir, backupDir);

    assert.equal(await fs.readFile(path.join(finalDir, 'live.js'), 'utf8'), 'new');
    await assert.rejects(fs.access(path.join(finalDir, 'stale.js')));
    await assert.rejects(fs.access(backupDir));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});


test('failed staged replacement restores the previous live dist tree', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dex-atomic-build-rollback-'));
  const finalDir = path.join(root, 'dist');
  const stagedDir = path.join(root, '.dist-build-missing');
  const backupDir = path.join(root, '.dist-previous-test');

  try {
    await fs.mkdir(finalDir);
    await fs.writeFile(path.join(finalDir, 'live.js'), 'old');

    await assert.rejects(replaceBuiltDirectory(root, stagedDir, finalDir, backupDir));

    assert.equal(await fs.readFile(path.join(finalDir, 'live.js'), 'utf8'), 'old');
    await assert.rejects(fs.access(backupDir));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
