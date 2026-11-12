import test from 'node:test';
import assert from 'node:assert/strict';
import { formatControlRoomShareReport } from '../src/shared/control-room-share.js';

const secret = 'sk-proj-MUST-NOT-LEAK';
const privatePath = '/Users/andrew/Secrets/my-worktree';
function snapshot() {
  return {
    generatedAt: '2026-11-12T21:00:00.000Z',
    machine: {
      hostname: 'MacBook-Air.local', nodeId: 'macbook-air.local',
      runtimeVersion: '0.4.0', runtimeUpdatedAt: '2026-11-12T20:59:59.000Z',
      online: true, gateway: 'connected', coordinator: 'degraded',
      worker: 'observed', accessMode: 'on', queueDepth: 3,
      activeLeases: 1, cpu: 'secret-metric'
    },
    tasks: {
      active: 2,
      recent: [
        { taskId: 'rtsk_1a1d16c616a_82aace52a933fe85390c0ea9a98a01b1',
          nodeId: 'macbook-air.local', operation: 'dex.process.run',
          state: 'AMBIGUOUS', updatedAtUtc: '2026-11-12T20:58:59Z',
          summary: { status: secret }, actorId: secret,
          payload: { cwd: privatePath, command: secret }, resultRef: privatePath },
        { taskId: 'rtsk_1a1d16f9bc6_231115ffb86b90cb824148e59105247c',
          nodeId: 'macbook-air.local', operation: 'dex.fingerprint', state: 'COMPLETED',
          updatedAtUtc: '2026-11-12T20:55:00.123Z' }
      ]
    },
    activity: [{ processLabel: secret, argv: privatePath, result: secret }],
    project: {
      repository: 'a different repo', branch: secret,
      head: '9c9b22cd1f4306fbce31023c542f491adc6f8154',
      dirty: true, tested: secret, deployed: secret
    },
    connector: { credentials: secret, publicMcp: 'not measured', chatGptExposure: secret }
  };
}

test('share report is readable, factual, and reports ambiguity without claiming effects', () => {
  const text = formatControlRoomShareReport(snapshot(), new Date('2026-11-12T21:01:00Z'));
  assert.match(text, /STINKY WEASEL CONTROL — SHARE-SAFE DIAGNOSTIC REPORT/);
  assert.match(text, /Captured \(UTC\): 2026-11-12T21:01:00.000Z/);
  assert.match(text, /Machine node: macbook-air\.local/);
  assert.match(text, /Gateway: connected/);
  assert.match(text, /Coordinator: degraded/);
  assert.match(text, /Active durable tasks: 2/);
  assert.match(text, /rtsk_1a1d16c616a_82aace52a933fe85390c0ea9a98a01b1 \| dex\.process\.run \| AMBIGUOUS/);
  assert.match(text, /COMPLETED is a recorded durable state/);
  assert.match(text, /external effects require separate receipts/);
  assert.match(text, /Source revision: 9c9b22cd1f4306fbce31023c542f491adc6f8154/);
});

test('report never leaks credential-shaped contents, paths, payloads, trace or free text', () => {
  const text = formatControlRoomShareReport(snapshot());
  for (const forbidden of [
    secret, privatePath, 'my-worktree', 'actorId', 'summary', 'resultRef',
    'payload: {', 'argv', 'Secrets', 'a different repo', 'secret-metric',
    'processLabel'
  ]) {
    assert.equal(text.includes(forbidden), false, 'unexpected sensitive content: ' + forbidden);
  }
});

test('untrusted operation names, task identity and source revision are withheld', () => {
  const data = snapshot();
  data.tasks.recent[0]!.operation = 'dex.process.run; ' + secret;
  data.tasks.recent[0]!.taskId = privatePath;
  data.tasks.recent[0]!.state = secret;
  data.project.head = secret;
  data.machine.nodeId = privatePath;
  const text = formatControlRoomShareReport(data);
  assert.match(text, /Task record withheld: node identity does not match the selected local machine/);
  assert.match(text, /Machine node: withheld/);
  assert.match(text, /Source revision: withheld/);
  assert.equal(text.includes(secret), false);
  assert.equal(text.includes(privatePath), false);
});

test('malformed or absent data remains explicitly unverified', () => {
  const text = formatControlRoomShareReport({ machine: { gateway: 'running' }, tasks: { active: -1, recent: null }});
  assert.match(text, /Overview generated \(UTC\): not verified/);
  assert.match(text, /Gateway: not verified/);
  assert.match(text, /Active durable tasks: not inspected/);
  assert.match(text, /No recent task records returned; this is not proof that none exist/);
});

test('record count is capped at eight, not unbounded task-store contents', () => {
  const data = snapshot();
  data.tasks.recent = Array.from({ length: 40 }, (_, i) => ({
    taskId: 'rtsk_' + (i + 1).toString(16).padStart(11, '0') + '_1234567890abcdef',
    nodeId: 'macbook-air.local', operation: 'dex.fingerprint', state: 'COMPLETED',
    updatedAtUtc: '2026-11-12T20:55:00Z'
  }));
  const text = formatControlRoomShareReport(data);
  assert.equal((text.match(/ \| dex\.fingerprint \| COMPLETED/g) ?? []).length, 8);
  assert.ok(text.length < 8000);
});

test('share report refuses cross-node task rows even if their IDs are otherwise well-formed', () => {
  const data = snapshot();
  data.tasks.recent[1]!.nodeId = 'bigmac';
  const text = formatControlRoomShareReport(data);
  assert.match(text, /Task record withheld: node identity does not match the selected local machine/);
  assert.equal(text.includes('rtsk_1a1d16f9bc6_231115ffb86b90cb824148e59105247c'), false);
});
