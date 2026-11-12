import test from 'node:test';
import assert from 'node:assert/strict';
import { panicWorkProjection, panicTaskProjection } from '../src/shared/panic-projection.js';
import type { WorkStatus } from '../src/shared/work-coordinator.js';
import type { ReachTaskRecord } from '../src/node/task-store.js';

function sampleWork(): WorkStatus {
  return {
    observed: {
      uncoordinatedHeavy: 2,
      processObservation: 'observed',
      uncoordinatedDetails: [
        { pid: 775, pids: [775, 776], cpu: 92.1, mem: 3.1, processLabel: 'swift', matchedBy: 'cpu' },
        { pid: 800, pids: [800], cpu: 4.1, mem: 8.2, processLabel: 'python', matchedBy: 'memory' }
      ]
    },
    capacity: {
      livePressure: { memory: 'warning', cpu: 'saturated', thermal: 'unknown' },
      canAdmit: false
    },
    leases: [{ pid: 1234, credentials: 'sk-proj-SECRET' }],
    tickets: [{ args: '/Users/andrew/private' }]
  } as unknown as WorkStatus;
}

test('panic workload projection exposes only grouped, bounded attributes', () => {
  const projection = panicWorkProjection(sampleWork());
  const json = JSON.stringify(projection);
  const observed = projection.observed as Record<string, unknown>;
  const groups = observed.uncoordinatedDetails as Array<Record<string, unknown>>;
  assert.equal(projection.schemaVersion, 1);
  assert.equal(observed.uncoordinatedHeavy, 2);
  assert.equal(observed.detailsComplete, true);
  assert.equal(groups.length, 2);
  assert.equal(groups[0]!.members, 2);
  assert.equal(groups[0]!.processLabel, 'swift');
  assert.equal((projection.capacity as Record<string, unknown>).cpu, 'saturated');
  for (const secret of ['775', '776', '800', '1234', 'sk-proj', '/Users/', 'credentials', 'args', 'tickets', 'leases']) {
    assert.equal(json.includes(secret), false, 'leaked ' + secret);
  }
});

test('panic workload projection withholds suspicious process name and partial groups', () => {
  const work = sampleWork();
  work.observed.uncoordinatedDetails![0]!.processLabel = 'tokenSecret';
  const projection = panicWorkProjection(work);
  assert.equal((projection.observed as any).uncoordinatedDetails[0].processLabel, 'withheld');
  work.observed.uncoordinatedHeavy = 3;
  const partial = panicWorkProjection(work);
  assert.equal((partial.observed as any).detailsComplete, false);
  assert.deepEqual((partial.observed as any).uncoordinatedDetails, []);
});

test('panic workload projection refuses to claim groups under unknown process observation', () => {
  const work = sampleWork();
  work.observed.processObservation = 'unknown';
  const result = panicWorkProjection(work);
  assert.equal((result.observed as any).detailsComplete, false);
  assert.deepEqual((result.observed as any).uncoordinatedDetails, []);
});

test('panic tasks projection excludes raw state, payloads, actor identities and other nodes', () => {
  const task = {
    taskId: 'rtsk_aaaaaaaaaaa_bbbbbbbbbbbbbbbb',
    nodeId: 'bigmac',
    operation: 'dex.process.run',
    state: 'AMBIGUOUS',
    updatedAtUtc: '2026-11-12T19:00:00.000Z',
    resultRef: 'secrets/inaccessible', resultHash: 'A'.repeat(64),
    idempotencyKey: 'private-key', actorId: 'private-actor', payloadSha256: 'B'.repeat(64),
    repoContext: { repoPath: '/Users/bigmac/secrets' }
  } as unknown as ReachTaskRecord;
  const another = { ...task, nodeId: 'macbook-air.local', taskId: 'rtsk_ccccccccccc_dddddddddddddddd' };
  const output = panicTaskProjection([task, another], 'bigmac');
  assert.equal(output.complete, true);
  const rows = output.tasks as Array<Record<string, unknown>>;
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.state, 'AMBIGUOUS');
  assert.equal(rows[0]!.resultRecorded, true);
  const json = JSON.stringify(output);
  for (const secret of ['private-key', 'private-actor', '/Users/', 'repoPath', 'secrets/inaccessible', 'payloadSha256']) {
    assert.equal(json.includes(secret), false, 'leaked ' + secret);
  }
  assert.throws(() => panicTaskProjection([task], 'unverified'), /fixed node/);
});

test('invalid task identity or state cannot be projected as a successful list', () => {
  const task = {
    taskId: 'malformed', nodeId: 'bigmac', operation: 'shell',
    state: 'RUNNING', updatedAtUtc: '2026-11-12T19:00:00Z'
  } as unknown as ReachTaskRecord;
  const output = panicTaskProjection([task], 'bigmac');
  assert.equal(output.complete, false);
  assert.deepEqual(output.tasks, []);
});
