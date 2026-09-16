import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadLocalSecrets, loadOwnerSecrets } from '../src/shared/local-env.js';

test('owner tools load gateway secrets even when invoked beneath a node environment', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dex-reach-env-'));
  const ownerFile = path.join(dir, 'secrets.env');
  const nodeFile = path.join(dir, 'node.env');
  const key = 'DEX_REACH_TEST_OWNER_CONTEXT';
  const previous = {
    state: process.env.DEX_REACH_STATE_DIR,
    envFile: process.env.DEX_REACH_ENV_FILE,
    value: process.env[key]
  };

  try {
    await fs.writeFile(ownerFile, `${key}=owner\n`);
    await fs.writeFile(nodeFile, `${key}=node\n`);
    process.env.DEX_REACH_STATE_DIR = dir;
    process.env.DEX_REACH_ENV_FILE = nodeFile;

    delete process.env[key];
    assert.equal(loadLocalSecrets(), nodeFile);
    assert.equal(process.env[key], 'node');

    delete process.env[key];
    assert.equal(loadOwnerSecrets(), ownerFile);
    assert.equal(process.env[key], 'owner');
  } finally {
    if (previous.state === undefined) delete process.env.DEX_REACH_STATE_DIR; else process.env.DEX_REACH_STATE_DIR = previous.state;
    if (previous.envFile === undefined) delete process.env.DEX_REACH_ENV_FILE; else process.env.DEX_REACH_ENV_FILE = previous.envFile;
    if (previous.value === undefined) delete process.env[key]; else process.env[key] = previous.value;
    await fs.rm(dir, { recursive: true, force: true });
  }
});
