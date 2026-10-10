import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { stableNodeBin } from '../scripts/lib/service.js';

async function homebrew(version: string) {
  const prefix = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'dex-brew-')));
  const cellar = path.join(prefix, 'Cellar', 'node', version, 'bin'); await fs.mkdir(cellar, { recursive: true });
  await fs.writeFile(path.join(cellar, 'node'), '#!/bin/sh\n', { mode: 0o755 });
  await fs.mkdir(path.join(prefix, 'opt'), { recursive: true });
  await fs.symlink(`../Cellar/node/${version}`, path.join(prefix, 'opt', 'node'));
  return { prefix, cellarNode: path.join(cellar, 'node'), optNode: path.join(prefix, 'opt', 'node', 'bin', 'node') };
}

test('a Homebrew Cellar interpreter is pinned through the stable opt link that survives patch upgrades', async () => {
  const b = await homebrew('26.11.0'); try {
    assert.equal(await stableNodeBin(b.cellarNode), b.optNode);
  } finally { await fs.rm(b.prefix, { recursive: true, force: true }); }
});

test('the opt link is used only when it resolves to the exact interpreter running the install', async () => {
  const b = await homebrew('26.11.0'); try {
    // opt points at a different keg version than the running interpreter: keep the exact path.
    await fs.unlink(path.join(b.prefix, 'opt', 'node'));
    await fs.mkdir(path.join(b.prefix, 'Cellar', 'node', '25.0.0', 'bin'), { recursive: true });
    await fs.writeFile(path.join(b.prefix, 'Cellar', 'node', '25.0.0', 'bin', 'node'), '#!/bin/sh\n', { mode: 0o755 });
    await fs.symlink('../Cellar/node/25.0.0', path.join(b.prefix, 'opt', 'node'));
    assert.equal(await stableNodeBin(b.cellarNode), b.cellarNode);
    // Missing opt link: keep the exact path.
    await fs.unlink(path.join(b.prefix, 'opt', 'node'));
    assert.equal(await stableNodeBin(b.cellarNode), b.cellarNode);
  } finally { await fs.rm(b.prefix, { recursive: true, force: true }); }
});

test('non-Homebrew interpreters are unchanged', async () => {
  assert.equal(await stableNodeBin('/usr/local/bin/node'), '/usr/local/bin/node');
  assert.equal(await stableNodeBin('/Users/someone/.nvm/versions/node/v26.11.0/bin/node'), '/Users/someone/.nvm/versions/node/v26.11.0/bin/node');
});
