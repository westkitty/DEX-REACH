import test from 'node:test';
import assert from 'node:assert/strict';
import { validateCompatibilityArguments } from '../src/node/adapters/desktop-commander.js';

test('compatibility argument validator accepts bounded JSON objects', () => {
  assert.doesNotThrow(() => validateCompatibilityArguments({ path: '/tmp/a b.txt', nested: [1, 'é', null] }));
  assert.doesNotThrow(() => validateCompatibilityArguments({}));
});

test('compatibility argument validator rejects oversized strings before adapter schema validation', () => {
  const boundedOversize = 'x'.repeat(256 * 1024 + 1);
  assert.throws(() => validateCompatibilityArguments({ content: boundedOversize }), /256 KiB/);
});

test('compatibility argument validator rejects oversized arrays and objects', () => {
  assert.throws(() => validateCompatibilityArguments({ paths: Array.from({ length: 257 }, (_, i) => `/tmp/${i}`) }), /collection exceeds 256/);
  const wide = Object.fromEntries(Array.from({ length: 257 }, (_, i) => [`k${i}`, true]));
  assert.throws(() => validateCompatibilityArguments(wide), /256 properties/);
});

test('compatibility argument validator rejects deep and structurally broad values', () => {
  let deep: unknown = 'leaf';
  for (let i = 0; i < 25; i++) deep = [deep];
  assert.throws(() => validateCompatibilityArguments({ deep }), /nesting limit/);
  let broad: unknown = 'leaf';
  for (let i = 0; i < 6; i++) broad = Array.from({ length: 256 }, () => broad);
  assert.throws(() => validateCompatibilityArguments({ broad }), /structural item limit/);
});

 test('compatibility arguments must be objects', () => {
  assert.throws(() => validateCompatibilityArguments(null), /JSON object/);
  assert.throws(() => validateCompatibilityArguments([]), /JSON object/);
});
