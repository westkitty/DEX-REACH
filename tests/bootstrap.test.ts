import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    if (!line || !line.includes('=')) continue;
    const [key, ...rest] = line.split('=');
    if (key) out[key] = rest.join('=');
  }
  return out;
}

test('concurrent bootstrap preserves one coherent credential set', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dex-reach-bootstrap-'));
  try {
    const env = { ...process.env, DEX_REACH_STATE_DIR: dir };
    const args = ['--import', 'tsx', 'scripts/bootstrap.ts', '--public-url', 'http://127.0.0.1:8787'];
    const results = await Promise.all([
      execFileAsync(process.execPath, args, { cwd: process.cwd(), env }),
      execFileAsync(process.execPath, args, { cwd: process.cwd(), env })
    ]);
    assert.equal(results.filter(result => result.stdout.includes('secrets created')).length, 1);
    assert.equal(results.filter(result => result.stdout.includes('existing credentials preserved')).length, 1);

    const owner = parseEnv(await fs.readFile(path.join(dir, 'secrets.env'), 'utf8'));
    const nodeId = owner.DEX_REACH_NODE_ID;
    assert.ok(nodeId);
    const node = parseEnv(await fs.readFile(path.join(dir, 'nodes', `${nodeId}.env`), 'utf8'));
    assert.equal(node.DEX_REACH_NODE_ID, nodeId);
    assert.equal(node.DEX_REACH_NODE_TOKEN, owner.DEX_REACH_NODE_TOKEN);
    assert.ok((owner.DEX_REACH_OWNER_PASSWORD || '').length >= 16);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
