import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { commandGuard, pathAllowed, redact, timingSafeEqualText, toolGuard } from '../src/shared/security.js';
import { stateDir } from '../src/shared/local-env.js';

test('REACH Guard blocks destructive shell classes', () => {
  assert.ok(commandGuard('git reset --hard', 'development'));
  assert.ok(commandGuard('sudo whoami', 'full-local'));
  assert.ok(commandGuard('rm -rf /tmp/example', 'full-local'));
  assert.equal(commandGuard('git status --short', 'read-only'), null);
});

test('REACH Scope enforces absolute path roots', () => {
  assert.equal(pathAllowed('/Users/andrew/project/file.txt', ['/Users/andrew']), true);
  assert.equal(pathAllowed('/etc/passwd', ['/Users/andrew']), false);
  assert.equal(toolGuard('read_file', { path: '/etc/passwd' }, 'development', ['/Users/andrew']), 'path outside allowed roots: /etc/passwd');
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
  assert.equal(toolGuard('read_file', { path: '/Users/andrew/x' }, 'read-only', ['/Users/andrew']), null);
  assert.match(toolGuard('mystery_tool', {}, 'read-only', ['/Users/andrew']) || '', /allowlist/);
  assert.match(toolGuard('interact_with_process', {}, 'read-only', ['/Users/andrew']) || '', /allowlist/);
  assert.equal(pathAllowed('../escape.txt', ['/Users/andrew']), false);
  assert.equal(pathAllowed(path.join(stateDir(), 'secrets.env'), [path.dirname(stateDir())]), false);
});
