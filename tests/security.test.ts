import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import { commandGuard, pathAllowed, redact, timingSafeEqualText, toolGuard } from '../src/shared/security.js';
import { stateDir } from '../src/shared/local-env.js';
import { requestPaths } from '../src/shared/capabilities.js';

test('REACH Guard blocks destructive shell classes', () => {
  assert.ok(commandGuard('git reset --hard', 'development'));
  assert.ok(commandGuard('sudo whoami', 'full-local'));
  assert.ok(commandGuard('rm -rf /tmp/example', 'full-local'));
  assert.equal(commandGuard('git status --short', 'read-only'), null);
});

test('REACH Scope enforces absolute path roots', () => {
  assert.equal(pathAllowed('/tmp/dex-scope-root/project/file.txt', ['/tmp/dex-scope-root']), true);
  assert.equal(pathAllowed('/etc/passwd', ['/tmp/dex-scope-root']), false);
  assert.equal(toolGuard('read_file', { path: '/etc/passwd' }, 'development', ['/tmp/dex-scope-root']), 'path outside allowed roots: /etc/passwd');
});

test('secrets are redacted and comparisons are constant-shape', () => {
  assert.equal(timingSafeEqualText('same', 'same'), true);
  assert.equal(timingSafeEqualText('same', 'other'), false);
  assert.deepEqual(
    redact({ token: 'secret', nested: { password: 'pw', ok: 'yes' } }),
    { token: '[REDACTED]', nested: { password: '[REDACTED]', ok: 'yes' } }
  );
});

test('read-only process grammar rejects shell composition and root escapes', () => {
  const roots = ['/tmp/allowed'];
  assert.match(commandGuard('pwd ; touch nope', 'read-only', roots) || '', /shell-free/);
  assert.match(commandGuard('cat /etc/hosts', 'read-only', roots) || '', /shell-free/);
  assert.match(commandGuard('cat $(echo /etc/hosts)', 'read-only', roots) || '', /shell-free/);
  assert.match(commandGuard('git status && whoami', 'read-only', roots) || '', /shell-free/);
  assert.equal(commandGuard('git status --short', 'read-only', roots), null);
});

test('read-only compatibility policy is allowlist-based and rejects relative traversal', () => {
  assert.equal(toolGuard('read_file', { path: '/tmp/dex-scope-root/x' }, 'read-only', ['/tmp/dex-scope-root']), null);
  assert.match(toolGuard('mystery_tool', {}, 'read-only', ['/tmp/dex-scope-root']) || '', /allowlist/);
  assert.match(toolGuard('interact_with_process', {}, 'read-only', ['/tmp/dex-scope-root']) || '', /allowlist/);
  assert.equal(pathAllowed('../escape.txt', ['/tmp/dex-scope-root']), false);
  assert.equal(pathAllowed(path.join(stateDir(), 'secrets.env'), [path.dirname(stateDir())]), false);
});


test('REACH Scope blocks symlink escapes and plural compatibility path arrays', async () => {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'dex-reach-scope-'));
  try {
    const root = path.join(dir, 'root');
    const outside = path.join(dir, 'outside');
    await fsPromises.mkdir(root);
    await fsPromises.mkdir(outside);
    await fsPromises.writeFile(path.join(outside, 'proof.txt'), 'outside');
    await fsPromises.symlink(outside, path.join(root, 'link'));
    assert.equal(pathAllowed(path.join(root, 'link', 'proof.txt'), [root]), false);
    assert.match(toolGuard('read_multiple_files', { paths: [path.join(root, 'ok.txt'), '/etc/passwd'] }, 'development', [root]) || '', /outside allowed roots/);
    assert.deepEqual(requestPaths({ paths: [path.join(root, 'ok.txt'), '/etc/passwd'] }), [path.join(root, 'ok.txt'), '/etc/passwd']);
  } finally {
    await fsPromises.rm(dir, { recursive: true, force: true });
  }
});

test('redaction removes credential assignments embedded inside shell strings', () => {
  const value = String(redact('DEX_REACH_NODE_TOKEN=supersecret curl https://x.invalid/?token=abc'));
  assert.doesNotMatch(value, /supersecret|token=abc/);
  assert.match(value, /REDACTED/);
});

test('compatibility configuration is node-owned and camelCase path fields remain scoped', () => {
  const config = toolGuard('set_config_value', { key: 'allowedDirectories', value: [] }, 'full-local', ['/tmp']);
  const output = toolGuard('write_pdf', { path: '/tmp/in.pdf', outputPath: '/etc/out.pdf' }, 'full-local', ['/tmp']);
  const source = toolGuard('write_pdf', { path: '/tmp/in.pdf', content: [{ type: 'insert', pageIndex: 0, sourcePdfPath: '/etc/source.pdf' }] }, 'full-local', ['/tmp']);
  assert.ok(config); assert.match(config, /cannot be invoked remotely/);
  assert.ok(output); assert.match(output, /outside allowed roots/);
  assert.ok(source); assert.match(source, /outside allowed roots/);
});


test('compatibility history/vendor tools and URL proxy reads are never remotely exposed', () => {
  for (const tool of ['get_recent_tool_calls', 'give_feedback_to_desktop_commander', 'get_prompts']) {
    const blocked = toolGuard(tool, {}, 'full-local', ['/tmp']);
    assert.ok(blocked); assert.match(blocked, /cannot be invoked remotely/);
  }
  const urlRead = toolGuard('read_file', { path: 'http://127.0.0.1:9999/private', isUrl: true }, 'read-only', ['/tmp']);
  assert.ok(urlRead); assert.match(urlRead, /URL reads are disabled/);
});


test('process guard blocks direct DEX private-state and credential requests', () => {
  assert.match(commandGuard(`cat ${path.join(stateDir(), 'secrets.env')}`, 'full-local', ['/tmp']) || '', /private state/);
  assert.match(commandGuard('printenv DEX_REACH_NODE_TOKEN', 'full-local', ['/tmp']) || '', /credential state/);
});
