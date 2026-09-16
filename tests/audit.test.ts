import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AuditLog, summarizeContent } from '../src/shared/audit.js';
import { redact } from '../src/shared/security.js';
import { launchdPlist, systemdUnit } from '../scripts/lib/service.js';

test('audit records attribute the client and omit file contents and credentials', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dex-reach-audit-'));
  try {
    const log = new AuditLog(path.join(dir, 'audit.jsonl'));
    await log.append({
      at: '2026-09-16T00:00:00Z', nodeId: 'n', operation: 'dex.file.write', ok: true,
      actor: { kind: 'chatgpt', clientId: 'abc', clientName: 'ChatGPT' },
      args: { path: '/tmp/x', text: 'SECRET DOCUMENT BODY', token: 'tok_123', nested: { authorization: 'Bearer abc.def', content: 'more body' }, note: 'Bearer zzz.yyy' }
    });
    const raw = await fs.readFile(path.join(dir, 'audit.jsonl'), 'utf8');
    assert.doesNotMatch(raw, /SECRET DOCUMENT BODY|tok_123|abc\.def|zzz\.yyy|more body/);
    assert.match(raw, /"text":"\[20 bytes omitted\]"/);
    assert.match(raw, /"kind":"chatgpt"/);
    const [event] = await log.tail(5);
    assert.equal(event?.actor?.clientName, 'ChatGPT');
    assert.equal((await log.tail(5)).length, 1);
    assert.deepEqual(summarizeContent({ input: 'abc', other: 1 }), { input: '[3 bytes omitted]', other: 1 });
    assert.deepEqual(redact({ password: 'p', ok: 'v' }), { password: '[REDACTED]', ok: 'v' });
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('service templates reference the env file, state dir, and entry point without secrets', () => {
  const spec = { label: 'com.stinkyweasel.dex-reach.node', entry: 'dist/src/node/main.js', envFile: '/home/b/.dex-reach/nodes/b.env', stateDir: '/home/b/.dex-reach', root: '/opt/dex', nodeBin: '/usr/bin/node', logsDir: '/home/b/.dex-reach/logs' };
  const plist = launchdPlist(spec);
  assert.match(plist, /DEX_REACH_ENV_FILE<\/key><string>\/home\/b\/\.dex-reach\/nodes\/b\.env/);
  assert.match(plist, /<string>\/opt\/dex\/dist\/src\/node\/main\.js<\/string>/);
  assert.match(plist, /KeepAlive/);
  const unit = systemdUnit(spec);
  assert.match(unit, /ExecStart=\/usr\/bin\/node \/opt\/dex\/dist\/src\/node\/main\.js/);
  assert.match(unit, /Environment=DEX_REACH_ENV_FILE=\/home\/b\/\.dex-reach\/nodes\/b\.env/);
  assert.match(unit, /Environment=DEX_REACH_STATE_DIR=\/home\/b\/\.dex-reach/);
  assert.doesNotMatch(unit, /TOKEN=/);
});
