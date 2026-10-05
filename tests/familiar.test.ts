import test from 'node:test';
import assert from 'node:assert/strict';
import { familiarForNode, familiarForOperation } from '../src/shared/familiar.js';

test('node Familiar state is derived from connectivity and owner access without granting authority', () => {
  const baseAccess = { mode: 'on' as const, effectiveMode: 'on' as const, until: null, revertTo: null, clients: {} };

  assert.deepEqual(
    familiarForNode({ nodeId: 'macbook', online: true, access: baseAccess, sequence: 1, now: 1000 }),
    {
      entityId: 'macbook',
      source: 'dex-reach.node',
      attention: 'focused',
      reaction: 'neutral',
      intensity: 0.5,
      trigger: 'system',
      priority: 20,
      timestamp: 1000,
      sequence: 1
    }
  );

  const off = familiarForNode({
    nodeId: 'macbook',
    online: true,
    access: { ...baseAccess, mode: 'off', effectiveMode: 'off' },
    sequence: 2,
    now: 2000
  });
  assert.equal(off.reaction, 'warning');
  assert.equal(off.attention, 'aware');

  const offline = familiarForNode({ nodeId: 'macbook', online: false, access: baseAccess, sequence: 3, now: 3000 });
  assert.equal(offline.reaction, 'error');
  assert.equal(offline.attention, 'interrupted');
});

test('operation Familiar state is presentation-only and distinguishes authorization gates', () => {
  assert.equal(familiarForOperation({ nodeId: 'n', phase: 'requesting', sequence: 1, now: 1 }).attention, 'focused');
  assert.equal(familiarForOperation({ nodeId: 'n', phase: 'awaiting-authorization', sequence: 2, now: 2 }).reaction, 'warning');
  assert.equal(familiarForOperation({ nodeId: 'n', phase: 'success', sequence: 3, now: 3 }).reaction, 'pleased');
  assert.equal(familiarForOperation({ nodeId: 'n', phase: 'failure', sequence: 4, now: 4 }).reaction, 'error');
});
