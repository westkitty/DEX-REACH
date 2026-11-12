import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const installer = 'scripts/install-control-room-macos.sh';

test('MacBook installer is syntactically sound and emits a persistent loopback-only login agent', () => {
  execFileSync('/bin/bash', ['-n', installer], { timeout: 3000 });
  const xml = execFileSync('/bin/bash', [installer, '--print-plist'], {
    encoding: 'utf8', timeout: 3000
  });
  for (const required of [
    '<string>com.stinkyweasel.dex-control-room</string>',
    '<key>RunAtLoad</key><true/>',
    '<key>KeepAlive</key><true/>',
    '<key>ThrottleInterval</key><integer>10</integer>',
    '<string>4177</string>',
    '/scripts/control-room.ts',
    '<string>--import</string>',
    '<string>tsx</string>',
    '<key>DEX_REACH_STATE_DIR</key>'
  ]) assert.ok(xml.includes(required), 'missing launch condition: ' + required);
  assert.doesNotMatch(xml, /0\.0\.0\.0|--host[ =]0|:8096|--inspect/);
});

test('installer rejects mismatched identities, repositories, port conflicts and incomplete bundles', () => {
  const code = readFileSync(installer, 'utf8');
  for (const requirement of [
    '/bin/hostname -s', '/usr/bin/id -un', 'MacBook-Air',
    'westkitty/DEX-REACH.git', 'node_modules/tsx/package.json',
    'control-room-share.ts', '/usr/bin/cmp',
    '/bin/launchctl bootout', '/bin/launchctl bootstrap',
    'port 4177 occupied', 'launch agent bootstrap failed',
    'next-login behavior requires a future real logout/login'
  ]) assert.ok(code.includes(requirement), 'missing safety check: ' + requirement);
  assert.ok(!code.includes('sudo '));
  assert.ok(!code.includes('git reset'));
  assert.ok(!code.includes('killall'));
  assert.ok(!code.includes('com.stinkyweasel.dex-reach.gateway'));
  assert.ok(!code.includes('com.stinkyweasel.dex-reach.node'));
});
