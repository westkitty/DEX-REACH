import test from 'node:test';
import assert from 'node:assert/strict';
import { waitForGatewayHealth } from '../scripts/lib/wait-for-gateway-health.js';

test('gateway startup probe tolerates transient unavailability within its bounded window', async () => {
  let time = 0;
  let attempts = 0;
  await waitForGatewayHealth(async () => {
    attempts += 1;
    if (attempts < 4) throw new Error('fetch failed');
    return { ready: true };
  }, { timeoutMs: 5_000, intervalMs: 500, now: () => time, delay: async ms => { time += ms; } });
  assert.equal(attempts, 4);
});

test('gateway health failure remains bounded and reports the last probe evidence', async () => {
  let time = 0;
  let attempts = 0;
  await assert.rejects(waitForGatewayHealth(async () => {
    attempts += 1;
    return { ready: false, detail: 'onlineNodes=0' };
  }, { timeoutMs: 1_000, intervalMs: 500, now: () => time, delay: async ms => { time += ms; } }), /DEX health verification failed: onlineNodes=0/);
  assert.equal(attempts, 2);
  assert.equal(time, 1_000);
});
