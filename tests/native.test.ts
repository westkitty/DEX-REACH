import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { nativeCall } from '../src/node/native.js';

test('DEX-native file and process paths enforce scope and guardrails', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dex-reach-native-'));
  try {
    const file = path.join(root, 'proof.txt');
    await nativeCall('test-node', 'dex.file.write', { path: file, text: 'native-ok' }, [root], 'development');
    const read = await nativeCall('test-node', 'dex.file.read', { path: file }, [root], 'development') as { text: string };
    assert.equal(read.text, 'native-ok');
    const run = await nativeCall('test-node', 'dex.process.run', { command: 'pwd', cwd: root }, [root], 'development') as { exitCode: number; stdout: string };
    assert.equal(run.exitCode, 0);
    assert.equal(run.stdout.trim(), await fs.realpath(root));
    await assert.rejects(
      nativeCall('test-node', 'dex.file.read', { path: '/etc/hosts' }, [root], 'development'),
      /outside allowed roots/
    );
    await assert.rejects(
      nativeCall('test-node', 'dex.process.run', { command: 'git reset --hard', cwd: root }, [root], 'development'),
      /REACH Guard/
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('node shell selection is platform-aware and overridable', async () => {
  const { nodeShell } = await import('../src/node/native.js');
  const previous = process.env.DEX_REACH_SHELL;
  try {
    delete process.env.DEX_REACH_SHELL;
    if (process.platform === 'win32') assert.throws(() => nodeShell(), /win32/);
    else assert.equal(nodeShell(), process.platform === 'darwin' ? '/bin/zsh' : '/bin/sh');
    process.env.DEX_REACH_SHELL = '/bin/bash';
    assert.equal(nodeShell(), '/bin/bash');
  } finally {
    if (previous === undefined) delete process.env.DEX_REACH_SHELL;
    else process.env.DEX_REACH_SHELL = previous;
  }
});

test('operations without cwd default into the allowed roots, never the process working directory', async () => {
  const { defaultCwd } = await import('../src/node/native.js');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dex-reach-cwd-'));
  try {
    assert.equal(defaultCwd([root]), root);
    assert.equal(defaultCwd([process.cwd()]), process.cwd());
    const fp = await nativeCall('n', 'dex.fingerprint', {}, [root], 'development') as { cwd: string };
    assert.equal(fp.cwd, root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
