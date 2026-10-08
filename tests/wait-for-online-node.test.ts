import test from 'node:test';
import assert from 'node:assert/strict';
import { waitForOnlineNode } from '../scripts/lib/wait-for-online-node.js';

test('waits for the exact configured node and never accepts another online node', async () => {
  let calls = 0;
  let time = 0;
  await waitForOnlineNode('macbook-air.local', async () => {
    calls += 1;
    if (calls < 3) return [{ nodeId: 'bigmac', online: true }];
    return [{ nodeId: 'macbook-air.local', online: true }];
  }, { timeoutMs: 4, intervalMs: 1, now: () => time, delay: async ms => { time += ms; } });
  assert.equal(calls, 3);
});

test('fails within the configured bound while the exact node remains offline', async () => {
  let calls = 0;
  let time = 0;
  await assert.rejects(waitForOnlineNode('macbook-air.local', async () => {
    calls += 1;
    return [{ nodeId: 'bigmac', online: true }];
  }, { timeoutMs: 3, intervalMs: 1, now: () => time, delay: async ms => { time += ms; } }), /target_node_offline/);
  assert.equal(calls, 3);
});
