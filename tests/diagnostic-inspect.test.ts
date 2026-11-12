import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyOperationSafety } from '../src/shared/durable-execution.js';
import { describeOperation } from '../src/shared/operations.js';
import { nativeCall } from '../src/node/native.js';
import { parseCloudServiceFlags } from '../src/node/diagnostics.js';

test('mac diagnostics are classified as bounded passive inspections', () => {
  assert.equal(classifyOperationSafety('dex.diagnostic.inspect'), 'PURE_READ_IDEMPOTENT');
  assert.deepEqual(
    (({ capability, risk, mutation, readOnlyAllowed, workspaceSafeAllowed }) =>
      ({ capability, risk, mutation, readOnlyAllowed, workspaceSafeAllowed }))(describeOperation('dex.diagnostic.inspect')!),
    { capability: 'inspect', risk: 'inspect', mutation: false, readOnlyAllowed: true, workspaceSafeAllowed: true }
  );
});

test('cloud document flags are parsed without returning raw account preferences', () => {
  const raw = '{ Accounts = ({ Services = ({ Name = CLOUDDESKTOP; status = active; }, { Enabled = 1; Name = "MOBILE_DOCUMENTS"; AccountID = "secret@example.com"; }); }); }';
  assert.deepEqual(parseCloudServiceFlags(raw), { mobileDocumentsEnabled: true, cloudDesktopActive: true });
  assert.deepEqual(parseCloudServiceFlags('{ Accounts = (); }'), { mobileDocumentsEnabled: null, cloudDesktopActive: null });
});

test('diagnostics reject unknown kinds and arbitrary shell arguments before execution', async () => {
  const call = (args: Record<string, unknown>) =>
    nativeCall('test-node', 'dex.diagnostic.inspect', args, ['/tmp'], 'read-only');
  await assert.rejects(call({ kind: 'sh -c rm -rf /tmp' }), /unsupported diagnostic kind/);
  await assert.rejects(call({ kind: 'icloud-settings', command: 'touch /tmp/x' }), /exactly one kind/);
  await assert.rejects(call({ kind: 'spotlight-status', path: '/etc/passwd' }), /exactly one kind/);
  await assert.rejects(call({}), /exactly one kind/);
});
