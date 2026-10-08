import test from 'node:test';
import assert from 'node:assert/strict';
import { retryReadOnlyCheck } from '../scripts/lib/retry-read-only-check.js';

test('retries a transient failed read-only check and returns the exact successful response', async () => {
  let calls = 0;
  const result = await retryReadOnlyCheck(async () => {
    calls += 1;
    return calls < 3 ? undefined : { nodeId: 'macbook-air.local' };
  }, { failureMessage: 'fingerprint_failed', attempts: 4, intervalMs: 0, delay: async () => undefined });
  assert.deepEqual(result, { nodeId: 'macbook-air.local' });
  assert.equal(calls, 3);
});

test('read-only retries have a fixed attempt bound and report a safe failure label', async () => {
  let calls = 0;
  await assert.rejects(retryReadOnlyCheck(async () => {
    calls += 1;
    return undefined;
  }, { failureMessage: 'fingerprint_failed', attempts: 3, intervalMs: 0, delay: async () => undefined }), /fingerprint_failed/);
  assert.equal(calls, 3);
});
