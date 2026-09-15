import test from 'node:test';
import assert from 'node:assert/strict';
import { commandGuard, pathAllowed, redact, timingSafeEqualText, toolGuard } from '../src/shared/security.js';

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
