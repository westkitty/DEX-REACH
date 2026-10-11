import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { canonicalJson, hashValue } from '../src/shared/hash.js';

// Every persisted digest (policy hash, receipt hash, manifest digest, idempotency key) is produced by
// hashValue. Its output must stay byte-identical across any change to how SHA-256 is invoked.
test('hashValue is the hex SHA-256 of the canonical JSON, independent of key order', () => {
  const value = { b: [1, { z: null, a: 'x' }], a: 'A' };
  const expected = crypto.createHash('sha256').update(canonicalJson(value)).digest('hex');
  assert.equal(hashValue(value), expected);
  assert.equal(hashValue({ a: 'A', b: [1, { a: 'x', z: null }] }), expected);
  assert.match(hashValue(value), /^[0-9a-f]{64}$/);
});

test('hashValue has the published SHA-256 value for a known input', () => {
  // SHA-256 of the three bytes "{}" , a fixed vector independent of this module.
  assert.equal(hashValue({}), '44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a');
  assert.equal(hashValue(null), crypto.createHash('sha256').update('null').digest('hex'));
});
