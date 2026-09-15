import test from 'node:test';
import assert from 'node:assert/strict';
import { ResultStore } from '../src/node/result-store.js';

test('large results become bounded continuation handles', () => {
  const store = new ResultStore(64, 60000);
  const bounded = store.bound({ value: 'x'.repeat(500) }) as { truncated: boolean; handle: string };
  assert.equal(bounded.truncated, true);
  const first = store.read(bounded.handle, 0, 80);
  assert.equal(typeof first.text, 'string');
  assert.ok(Number(first.totalCharacters) > 80);
  assert.equal(typeof first.nextOffset, 'number');
});
