import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  HISTORY_LIMIT,
  LEASE_STALE_MS,
  LEGACY_PID_REUSE_TOLERANCE_MS,
  LIFECYCLE_HISTORY_LIMIT,
  TICKET_STALE_MS,
  type CapacitySnapshot,
  type CoordinationOwnerProbe,
  type WorkEvent,
  type WorkLease,
  type WorkQueueTicket,
  acquireWork,
  coordinationOwnerState,
  leaseIsReclaimable,
  leasesDir,
  queueDir,
  readCoordinatorState,
  readWorkEvents,
  recordWorkEvent,
  retainBoundedHistory,
  ticketIsStale,
  workStatus
} from '../src/shared/work-coordinator.js';
import { observeProcessStartSync, parseDarwinStartObservation } from '../src/shared/process-identity.js';

const GIB = 1024 ** 3;
const HOST: CapacitySnapshot = {
  physicalMemoryBytes: 64 * GIB, logicalCpuCount: 16, loadAverage1m: 0.5, memory: 'healthy', thermal: 'healthy',
  observed: { uncoordinatedHeavy: 0, dexServices: 0 }
};
const NOW = Date.parse('2026-11-09T12:00:00.000Z');
const iso = (ms: number) => new Date(ms).toISOString();
const STALE_BEAT = iso(NOW - TICKET_STALE_MS - 60_000);
const FRESH_BEAT = iso(NOW - 1_000);
const TASK = 'rtsk_1a1be7d960c_7f4d6c63cbd7b4d7dd42f99168b70b47';

async function withStateDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dex-reach-pid-reuse-'));
  const previous = process.env.DEX_REACH_STATE_DIR;
  process.env.DEX_REACH_STATE_DIR = dir;
  try { return await fn(dir); } finally {
    if (previous === undefined) delete process.env.DEX_REACH_STATE_DIR; else process.env.DEX_REACH_STATE_DIR = previous;
    await fs.rm(dir, { recursive: true, force: true });
  }
}

/** A PID table with fixed contents: pid -> { token, age in seconds } or null for unreadable identity. */
function probe(table: Record<number, { token: string; ageSeconds?: number } | null>): CoordinationOwnerProbe & { observed: number[] } {
  const observed: number[] = [];
  return {
    observed,
    exists: pid => pid in table,
    observe: pid => {
      observed.push(pid);
      const row = table[pid];
      if (!row) return null;
      return row.ageSeconds === undefined ? { startToken: row.token } : { startToken: row.token, elapsedSeconds: row.ageSeconds };
    }
  };
}

function ticket(overrides: Partial<WorkQueueTicket> = {}): WorkQueueTicket {
  return {
    id: 'ticket-7fa3ee07-89b6-4078-88ca-3cd037e13c28', taskId: TASK, attempt: 1, pid: 997, pidIsWorkload: false,
    executor: 'other', access: 'mutate', workload: 'medium', enqueuedAt: iso(NOW - 6 * 3600_000), heartbeatAt: STALE_BEAT, ...overrides
  };
}
function lease(overrides: Partial<WorkLease> = {}): WorkLease {
  return {
    id: 'lease-under-test', pid: 4242, executor: 'codex', access: 'mutate', workload: 'medium',
    createdAt: iso(NOW - 3600_000), heartbeatAt: iso(NOW - LEASE_STALE_MS - 60_000), ...overrides
  };
}

// --- Owner identity decision ----------------------------------------------------------------------

test('a recorded start token decides SAME versus REUSED exactly', () => {
  const recorded = { pid: 997, ownerStart: 'lstart:Sun Nov  8 18:00:00 2026' };
  assert.equal(coordinationOwnerState(recorded, ticket().enqueuedAt, NOW, probe({ 997: { token: 'lstart:Sun Nov  8 18:00:00 2026', ageSeconds: 99_999 } })), 'SAME');
  // The same PID, now held by a process with a different birth: the recorded owner is not running.
  assert.equal(coordinationOwnerState(recorded, ticket().enqueuedAt, NOW, probe({ 997: { token: 'lstart:Sun Nov  8 23:26:02 2026', ageSeconds: 99_999 } })), 'REUSED');
  assert.equal(coordinationOwnerState(recorded, ticket().enqueuedAt, NOW, probe({})), 'GONE');
});

test('a legacy claim treats its PID as reused only when the holder provably started after the claim', () => {
  const legacy = { pid: 997 };
  const claimedAt = iso(NOW - 6 * 3600_000);
  // Started 30 minutes ago, claim is 6 hours old: an unrelated process took the PID (the ctkahp case).
  assert.equal(coordinationOwnerState(legacy, claimedAt, NOW, probe({ 997: { token: 'lstart:x', ageSeconds: 1800 } })), 'REUSED');
  // Started before the claim: possibly the genuine owner, never declared gone.
  assert.equal(coordinationOwnerState(legacy, claimedAt, NOW, probe({ 997: { token: 'lstart:x', ageSeconds: 7 * 3600 } })), 'UNVERIFIABLE');
  // Inside the clock tolerance: not proof.
  const nearAge = Math.floor((6 * 3600_000 - LEGACY_PID_REUSE_TOLERANCE_MS) / 1000) + 2;
  assert.equal(coordinationOwnerState(legacy, claimedAt, NOW, probe({ 997: { token: 'lstart:x', ageSeconds: nearAge } })), 'UNVERIFIABLE');
  // No age available (e.g. Linux token only) or unreadable claim time: not proof.
  assert.equal(coordinationOwnerState(legacy, claimedAt, NOW, probe({ 997: { token: 'boot:1' } })), 'UNVERIFIABLE');
  assert.equal(coordinationOwnerState(legacy, 'not-a-date', NOW, probe({ 997: { token: 'lstart:x', ageSeconds: 10 } })), 'UNVERIFIABLE');
});

test('unreadable process identity is UNVERIFIABLE and is never treated as gone', () => {
  assert.equal(coordinationOwnerState({ pid: 997, ownerStart: 'lstart:a' }, ticket().enqueuedAt, NOW, probe({ 997: null })), 'UNVERIFIABLE');
  assert.equal(coordinationOwnerState({ pid: 997 }, ticket().enqueuedAt, NOW, probe({ 997: null })), 'UNVERIFIABLE');
  assert.equal(ticketIsStale(ticket(), NOW, probe({ 997: null })), false);
  assert.equal(leaseIsReclaimable(lease(), NOW, probe({ 4242: null })), false);
});

// --- Staleness rules -------------------------------------------------------------------------------

test('a stale ticket whose PID was reused by an unrelated process expires', () => {
  // The incident: the task failed before execution, its node process exited, and PID 997 was later
  // given to a root-owned system helper. PID existence alone kept the ticket alive indefinitely.
  const reused = probe({ 997: { token: 'lstart:Sun Nov  8 23:26:02 2026', ageSeconds: 30 * 60 } });
  assert.equal(ticketIsStale(ticket(), NOW, reused), true);
  assert.equal(ticketIsStale(ticket({ ownerStart: 'lstart:Sun Nov  8 18:00:00 2026' }), NOW, reused), true);
});

test('a genuinely live owner keeps its ticket and lease however late its heartbeat', () => {
  const live = probe({ 997: { token: 'lstart:owner', ageSeconds: 7 * 3600 }, 4242: { token: 'lstart:owner', ageSeconds: 2 * 3600 } });
  assert.equal(ticketIsStale(ticket({ ownerStart: 'lstart:owner' }), NOW, live), false);
  assert.equal(ticketIsStale(ticket(), NOW, live), false);
  assert.equal(leaseIsReclaimable(lease({ ownerStart: 'lstart:owner' }), NOW, live), false);
  assert.equal(leaseIsReclaimable(lease(), NOW, live), false);
});

test('PID reuse alone never expires a claim whose heartbeat is current', () => {
  const reused = probe({ 997: { token: 'lstart:other', ageSeconds: 10 }, 4242: { token: 'lstart:other', ageSeconds: 10 } });
  assert.equal(ticketIsStale(ticket({ heartbeatAt: FRESH_BEAT, ownerStart: 'lstart:owner' }), NOW, reused), false);
  assert.equal(leaseIsReclaimable(lease({ heartbeatAt: FRESH_BEAT, ownerStart: 'lstart:owner' }), NOW, reused), false);
  // The fresh-heartbeat path never even inspects process identity.
  assert.deepEqual(reused.observed, []);
});

test('a stale lease whose PID was reused is reclaimable; an exited owner still is', () => {
  assert.equal(leaseIsReclaimable(lease({ ownerStart: 'lstart:owner' }), NOW, probe({ 4242: { token: 'lstart:other', ageSeconds: 60 } })), true);
  assert.equal(leaseIsReclaimable(lease(), NOW, probe({ 4242: { token: 'lstart:other', ageSeconds: 60 } })), true);
  assert.equal(leaseIsReclaimable(lease(), NOW, probe({})), true);
});

// --- Persistence and real process identity ---------------------------------------------------------

test('darwin start observations parse to the same token readStartToken produces', () => {
  assert.deepEqual(parseDarwinStartObservation('   06:01:12 Sun Nov  8 23:26:02 2026\n'), { startToken: 'lstart:Sun Nov  8 23:26:02 2026', elapsedSeconds: 21672 });
  assert.deepEqual(parseDarwinStartObservation('1-02:03:04 Sun Nov  8 23:26:02 2026'), { startToken: 'lstart:Sun Nov  8 23:26:02 2026', elapsedSeconds: 93784 });
  assert.equal(parseDarwinStartObservation(''), null);
});

test('admission binds the owner start token, and a live owner with a lapsed heartbeat is kept', { skip: !['darwin', 'linux'].includes(process.platform) }, async () => {
  await withStateDir(async dir => {
    const repo = path.join(dir, 'repo');
    await fs.mkdir(repo, { recursive: true });
    const held = await acquireWork({ snapshot: HOST, executor: 'codex', access: 'mutate', workload: 'medium', repositoryRoot: repo });
    assert.equal(held.status, 'acquired');
    const queued = await acquireWork({ snapshot: HOST, executor: 'claude-code', access: 'mutate', workload: 'medium', repositoryRoot: repo, taskId: TASK, attempt: 1 });
    assert.equal(queued.status, 'queued');
    if (held.status !== 'acquired' || queued.status !== 'queued') return;
    const own = observeProcessStartSync(process.pid);
    assert.ok(own);
    assert.equal(held.lease.ownerStart, own.startToken);
    assert.equal(queued.ticket.ownerStart, own.startToken);

    // Age the claims: this live process is their genuine owner, so neither is dropped.
    const old = new Date(Date.now() - TICKET_STALE_MS - LEASE_STALE_MS).toISOString();
    await fs.writeFile(path.join(queueDir(), `${queued.ticket.id}.json`), JSON.stringify({ ...queued.ticket, heartbeatAt: old }));
    await fs.writeFile(path.join(leasesDir(), `${held.lease.id}.json`), JSON.stringify({ ...held.lease, heartbeatAt: old }));
    const status = await workStatus({ snapshot: HOST });
    assert.deepEqual(status.tickets.map(t => t.id), [queued.ticket.id]);
    assert.deepEqual(status.leases.map(l => l.id), [held.lease.id]);
  });
});

test('a reused-PID ticket expires on the next pass with a recorded reason, and nothing else is touched', { skip: !['darwin', 'linux'].includes(process.platform) }, async () => {
  await withStateDir(async () => {
    await fs.mkdir(queueDir(), { recursive: true });
    const longAgo = new Date(Date.now() - 24 * 3600_000).toISOString();
    // This test process stands in for the unrelated process that now holds the PID.
    const legacy = ticket({ id: 'ticket-legacy', pid: process.pid, enqueuedAt: '2020-01-01T00:00:00.000Z', heartbeatAt: longAgo });
    const tokened = ticket({ id: 'ticket-tokened', pid: process.pid, ownerStart: 'lstart:Thu Jan  1 00:00:00 1970', enqueuedAt: longAgo, heartbeatAt: longAgo });
    const live = ticket({ id: 'ticket-live', pid: process.pid, enqueuedAt: new Date().toISOString(), heartbeatAt: new Date().toISOString() });
    for (const entry of [legacy, tokened, live]) await fs.writeFile(path.join(queueDir(), `${entry.id}.json`), JSON.stringify(entry));

    // A legacy claim (no recorded token) is provably reused only where the platform reports process
    // age (macOS etime). Elsewhere its owner is UNVERIFIABLE and the claim is conservatively kept.
    const ageObservable = observeProcessStartSync(process.pid)?.elapsedSeconds !== undefined;
    const status = await workStatus({ snapshot: HOST });
    assert.deepEqual(status.tickets.map(t => t.id).sort(), ageObservable ? ['ticket-live'] : ['ticket-legacy', 'ticket-live']);
    assert.equal(status.degraded, false);
    const expired = (await readWorkEvents(0, 100)).events.filter(event => event.event === 'ticket-expired');
    assert.deepEqual(expired.map(event => [event.id, event.reason, event.taskId]).sort(), [
      ...(ageObservable ? [['ticket-legacy', 'heartbeat expired and owner pid reused', TASK]] : []),
      ['ticket-tokened', 'heartbeat expired and owner pid reused', TASK]
    ]);
    // Expiry drops a coordination claim only; it never records or implies a task outcome or signal.
    assert.equal((await readCoordinatorState()).tickets.length, ageObservable ? 1 : 2);
  });
});

test('a malformed owner start token marks state degraded rather than being trusted', async () => {
  await withStateDir(async () => {
    await fs.mkdir(queueDir(), { recursive: true });
    await fs.writeFile(path.join(queueDir(), 'ticket-bad.json'), JSON.stringify({ ...ticket({ id: 'ticket-bad' }), ownerStart: 'x'.repeat(500) }));
    const state = await readCoordinatorState();
    assert.equal(state.degraded, true);
    assert.equal(state.tickets.length, 0);
  });
});

// --- Event history visibility ----------------------------------------------------------------------

test('high-rate telemetry cannot evict lifecycle audit events from the bounded history', async () => {
  await withStateDir(async () => {
    const cancelled = await recordWorkEvent({ event: 'ticket-cancelled', id: 'ticket-7fa3ee07-89b6-4078-88ca-3cd037e13c28', taskId: TASK, attempt: 1, executor: 'other' });
    for (let i = 0; i < HISTORY_LIMIT + 20; i++) await recordWorkEvent({ event: i % 2 ? 'cache-miss' : 'classifier-result', observedUncoordinatedHeavy: 1, dexServices: 4 });
    const stored = (await fs.readFile(path.join(process.env.DEX_REACH_STATE_DIR!, 'coordinator', 'history', 'events.jsonl'), 'utf8')).split('\n').filter(Boolean);
    assert.ok(stored.length <= HISTORY_LIMIT, 'retention stays bounded');
    const first = await readWorkEvents(0, 100);
    assert.equal(first.events[0]?.cursor, cancelled.cursor);
    assert.equal(first.events[0]?.event, 'ticket-cancelled');
    assert.equal(first.hasMore, true);
  });
});

test('retention keeps the newest lifecycle and telemetry events within the shared bound', () => {
  const events: WorkEvent[] = [];
  for (let cursor = 1; cursor <= 600; cursor++) events.push({ cursor, at: iso(NOW), event: cursor % 3 === 0 ? 'lease-acquired' : 'cache-hit' });
  const kept = retainBoundedHistory(events);
  assert.equal(kept.length, HISTORY_LIMIT);
  assert.equal(kept.filter(e => e.event === 'lease-acquired').length, LIFECYCLE_HISTORY_LIMIT);
  assert.equal(kept.at(-1)?.cursor, 600);
  assert.deepEqual(kept.map(e => e.cursor), [...kept.map(e => e.cursor)].sort((a, b) => a - b));
});

test('status reports the newest event page, not the oldest retained page', async () => {
  await withStateDir(async () => {
    for (let i = 0; i < 150; i++) await recordWorkEvent({ event: 'cache-hit' });
    const marker = await recordWorkEvent({ event: 'ticket-cancelled', id: 'ticket-newest' });
    const status = await workStatus({ snapshot: HOST });
    assert.equal(status.eventWindow.cursor, marker.cursor);
    assert.equal(status.eventWindow.events.at(-1)?.id, 'ticket-newest');
    assert.equal(status.eventWindow.hasMore, false);
  });
});
