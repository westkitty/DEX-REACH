import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { saveAccessState, type AccessState } from '../src/shared/access.js';
import { collectDoctorReport } from '../src/shared/doctor.js';
import { hashValue } from '../src/shared/hash.js';
import { loadAccessState } from '../src/shared/access.js';

test('doctor is read-only and --share omits local repository paths', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dex-reach-doctor-'));
  const previous = process.env.DEX_REACH_STATE_DIR;
  try {
    process.env.DEX_REACH_STATE_DIR = dir;
    const state: AccessState = {
      version: 3, revision: 0, mode: 'off', until: null, revertTo: null, clients: {}, grantRequired: {}, grants: [],
      updatedAt: new Date(0).toISOString()
    };
    await saveAccessState('n', state, dir);
    const before = hashValue(await loadAccessState('n', dir));
    const full = await collectDoctorReport({ repoRoot: process.cwd(), nodeId: 'n', dir });
    const share = await collectDoctorReport({ repoRoot: process.cwd(), nodeId: 'n', dir, share: true });
    assert.equal(hashValue(await loadAccessState('n', dir)), before);
    assert.equal(full.readOnly, true);
    const source = full.source as { repoRoot: string };
    assert.ok(typeof source.repoRoot === 'string' && source.repoRoot.length > 0);
    const sharedSource = share.source as { repoRoot?: string; upstream?: string };
    assert.equal(sharedSource.repoRoot, undefined);
    assert.equal(sharedSource.upstream, undefined);
    assert.equal(share.hostname, 'redacted');
    assert.ok(JSON.stringify(share).includes('16'));
  } finally {
    if (previous === undefined) delete process.env.DEX_REACH_STATE_DIR;
    else process.env.DEX_REACH_STATE_DIR = previous;
    await fs.rm(dir, { recursive: true, force: true });
  }
});
