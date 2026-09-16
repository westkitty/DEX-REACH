import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { nativeCall, safeChildEnvironment } from '../src/node/native.js';

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
    assert.equal(fp.cwd, await fs.realpath(root));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('native filesystem scope resolves symlinks before allowing reads or writes', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dex-reach-native-symlink-'));
  try {
    const root = path.join(dir, 'root');
    const outside = path.join(dir, 'outside');
    await fs.mkdir(root);
    await fs.mkdir(outside);
    await fs.writeFile(path.join(outside, 'secret.txt'), 'outside');
    await fs.symlink(outside, path.join(root, 'escape'));
    await assert.rejects(
      nativeCall('n', 'dex.file.read', { path: path.join(root, 'escape', 'secret.txt') }, [root], 'development'),
      /outside allowed roots/
    );
    await assert.rejects(
      nativeCall('n', 'dex.file.write', { path: path.join(root, 'escape', 'new.txt'), text: 'x' }, [root], 'development'),
      /outside allowed roots/
    );
    assert.equal(await fs.stat(path.join(outside, 'new.txt')).catch(() => null), null);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});


test('native process children do not inherit DEX or secret-like environment values', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dex-reach-child-env-'));
  const previousToken = process.env.DEX_REACH_NODE_TOKEN;
  const previousApi = process.env.DEX_REACH_TEST_API_KEY;
  const previousState = process.env.DEX_REACH_STATE_DIR;
  try {
    process.env.DEX_REACH_NODE_TOKEN = 'node-token-must-not-leak-1234567890';
    process.env.DEX_REACH_TEST_API_KEY = 'api-key-must-not-leak-1234567890';
    process.env.DEX_REACH_STATE_DIR = path.join(root, 'private-state');
    const env = safeChildEnvironment();
    assert.equal(env.DEX_REACH_NODE_TOKEN, undefined);
    assert.equal(env.DEX_REACH_TEST_API_KEY, undefined);
    assert.equal(env.DEX_REACH_STATE_DIR, path.join(root, 'private-state'));
    const result = await nativeCall('n', 'dex.process.run', { command: 'env', cwd: root }, [root], 'full-local') as { stdout: string };
    assert.doesNotMatch(result.stdout, /node-token-must-not-leak|api-key-must-not-leak|DEX_REACH_NODE_TOKEN|DEX_REACH_TEST_API_KEY/);
  } finally {
    if (previousToken === undefined) delete process.env.DEX_REACH_NODE_TOKEN; else process.env.DEX_REACH_NODE_TOKEN = previousToken;
    if (previousApi === undefined) delete process.env.DEX_REACH_TEST_API_KEY; else process.env.DEX_REACH_TEST_API_KEY = previousApi;
    if (previousState === undefined) delete process.env.DEX_REACH_STATE_DIR; else process.env.DEX_REACH_STATE_DIR = previousState;
    await fs.rm(root, { recursive: true, force: true });
  }
});
