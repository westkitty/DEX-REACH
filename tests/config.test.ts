import test from 'node:test';
import assert from 'node:assert/strict';
import { loadNodeConfig } from '../src/node/config.js';

test('node config rejects missing token', () => {
  const before = process.env.DEX_REACH_NODE_TOKEN;
  delete process.env.DEX_REACH_NODE_TOKEN;
  assert.throws(() => loadNodeConfig(), /DEX_REACH_NODE_TOKEN/);
  if (before === undefined) delete process.env.DEX_REACH_NODE_TOKEN;
  else process.env.DEX_REACH_NODE_TOKEN = before;
});
