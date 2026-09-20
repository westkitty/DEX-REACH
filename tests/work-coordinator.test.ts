import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { authorizeOperation, defaultAccessState } from '../src/shared/access.js';
import {
  HEARTBEAT_INTERVAL_MS,
  LEASE_FIELDS,
  LEASE_STALE_MS,
  TICKET_FIELDS,
  type CapacitySnapshot,
  type CoordinatorState,
  type WorkLease,
  acquireWork,
  cancelTicket,
  coordinatorDir,
  decideAdmission,
  heartbeat,
  leaseIsReclaimable,
  leasesDir,
  looksLikeSecretMaterial,
  queueDir,
  readCoordinatorState,
  readWorkEvents,
  recordWorkEvent,
  redactWorkStatusForShare,
  releaseWork,
  sanitizeLabel,
  workStatus
} from '../src/shared/work-coordinator.js';

const GIB = 1024 ** 3;

/** Every test gets its own DEX private state root so nothing touches the real machine's state. */
async function withStateDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dex-reach-coord-'));
  const previous = process.env.DEX_REACH_STATE_DIR;
  process.env.DEX_REACH_STATE_DIR = dir;
  try {
    return await fn(dir);
  } finally {
    if (previous === undefined) delete process.env.DEX_REACH_STATE_DIR;
    else process.env.DEX_REACH_STATE_DIR = previous;
    await fs.rm(dir, { recursive: true, force: true });
  }
}

function snapshot(overrides: Partial<CapacitySnapshot> = {}): CapacitySnapshot {
  return {
    physicalMemoryBytes: 64 * GIB,
    logicalCpuCount: 16,
    loadAverage1m: 0.5,
    memory: 'healthy',
    thermal: 'healthy',
    observed: { uncoordinatedHeavy: 0, dexServices: 0 },
    ...overrides
  };
}

/** A roomy, quiet host. Filesystem tests prove coordination rules, not the runner's own load. */
const HOST = snapshot();

test('coordinator state stays machine-wide when HOME is virtualized', () => {
  const previousHome = process.env.HOME;
  const previousState = process.env.DEX_REACH_STATE_DIR;
  const virtualHome = path.join(os.tmpdir(), 'dex-virtual-home');
  try {
    process.env.HOME = virtualHome;
    delete process.env.DEX_REACH_STATE_DIR;
    assert.equal(coordinatorDir(), path.join(os.userInfo().homedir, '.dex-reach', 'coordinator'));
    assert.notEqual(coordinatorDir(), path.join(virtualHome, '.dex-reach', 'coordinator'));
  } finally {
    if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
    if (previousState === undefined) delete process.env.DEX_REACH_STATE_DIR; else process.env.DEX_REACH_STATE_DIR = previousState;
  }
});

function emptyState(overrides: Partial<CoordinatorState> = {}): CoordinatorState {
  return { leases: [], tickets: [], degraded: false, degradedReasons: [], ...overrides };
}

function lease(overrides: Partial<WorkLease> = {}): WorkLease {
  const now = new Date().toISOString();
  return {
    id: `lease-${Math.random().toString(16).slice(2)}`,
    pid: process.pid,
    executor: 'codex',
    access: 'mutate',
    workload: 'medium',
    createdAt: now,
    heartbeatAt: now,
    ...overrides
  };
}

// 1 --------------------------------------------------------------------------
test('one mutation lease blocks a second mutation lease on the same repository', async () => {
  await withStateDir(async dir => {
    const repo = path.join(dir, 'repo-a');
    await fs.mkdir(repo, { recursive: true });

    const first = await acquireWork({ snapshot: HOST, executor: 'claude-code', access: 'mutate', workload: 'medium', repositoryRoot: repo });
    assert.equal(first.status, 'acquired');

    const second = await acquireWork({ snapshot: HOST, executor: 'codex', access: 'mutate', workload: 'light', repositoryRoot: repo });
    assert.equal(second.status, 'queued');
    assert.match(second.reasons.join(' '), /is held for mutate/);

    // A read may still proceed beside the mutating owner.
    const reader = await acquireWork({ snapshot: HOST, executor: 'human', access: 'read', workload: 'light', repositoryRoot: repo });
    assert.equal(reader.status, 'acquired');

    // A different spelling of the same root cannot become a second mutating owner.
    const aliased = await acquireWork({ snapshot: HOST, executor: 'grok', access: 'mutate', workload: 'light', repositoryRoot: path.join(repo, '..', 'repo-a') });
    assert.equal(aliased.status, 'queued');
  });
});

// 2 --------------------------------------------------------------------------
test('different repositories coexist only within machine capacity', async () => {
  const repoA = '/tmp/dex-test-a';
  const repoB = '/tmp/dex-test-b';
  const roomy = decideAdmission(
    emptyState({ leases: [lease({ repositoryRoot: repoA })] }),
    snapshot({ physicalMemoryBytes: 64 * GIB, logicalCpuCount: 16 }),
    { access: 'mutate', workload: 'medium', repositoryRoot: repoB }
  );
  assert.equal(roomy.admit, true);

  // The same two repositories on a 12 GiB host: the second job queues despite being a different repo.
  const constrained = decideAdmission(
    emptyState({ leases: [lease({ repositoryRoot: repoA })] }),
    snapshot({ physicalMemoryBytes: 12 * GIB, logicalCpuCount: 8 }),
    { access: 'mutate', workload: 'medium', repositoryRoot: repoB }
  );
  assert.equal(constrained.admit, false);
  assert.match(constrained.reasons.join(' '), /substantive slots exhausted/);
});

// 3 --------------------------------------------------------------------------
test('heavy slots are enforced independently of substantive slots', () => {
  const state = emptyState({ leases: [lease({ workload: 'heavy', repositoryRoot: '/tmp/dex-heavy' })] });
  const host = snapshot({ physicalMemoryBytes: 48 * GIB, logicalCpuCount: 16 });

  // 48 GiB allows 3 substantive and 2 heavy: a second medium job fits.
  assert.equal(decideAdmission(state, host, { access: 'mutate', workload: 'medium', repositoryRoot: '/tmp/dex-other' }).admit, true);

  const twoHeavy = emptyState({ leases: [lease({ workload: 'heavy', repositoryRoot: '/a' }), lease({ workload: 'heavy', repositoryRoot: '/b' })] });
  const third = decideAdmission(twoHeavy, host, { access: 'mutate', workload: 'heavy', repositoryRoot: '/c' });
  assert.equal(third.admit, false);
  assert.match(third.reasons.join(' '), /heavy slots exhausted/);
});

test('resource-aware work bundles persist and reject an exhausted vector budget', async () => {
  const host = snapshot({ physicalMemoryBytes: 64 * GIB, logicalCpuCount: 16 });
  const oversized = { cpuUnits: 2, memoryMiB: 30_000, io: 'normal' as const, network: 'light' as const, repositoryWrite: true, machineExclusive: false };
  const first = decideAdmission(emptyState({ leases: [lease({ bundle: oversized })] }), host, { access: 'mutate', workload: 'medium', repositoryRoot: '/a', bundle: oversized });
  assert.equal(first.admit, false);
  assert.match(first.reasons.join(' '), /memory bundle budget exhausted/);

  await withStateDir(async dir => {
    const repo = path.join(dir, 'repo'); await fs.mkdir(repo);
    const result = await acquireWork({ snapshot: host, executor: 'codex', access: 'mutate', workload: 'medium', repositoryRoot: repo });
    assert.equal(result.status, 'acquired');
    if (result.status === 'acquired') assert.deepEqual(result.lease.bundle, { cpuUnits: 2, memoryMiB: 2048, io: 'normal', network: 'light', repositoryWrite: true, machineExclusive: false });
  });
});

// 4 --------------------------------------------------------------------------
test('a host at or under 12 GiB yields exactly one substantive slot', () => {
  const host = snapshot({ physicalMemoryBytes: 12 * GIB, logicalCpuCount: 8 });
  const idle = decideAdmission(emptyState(), host, { access: 'mutate', workload: 'medium', repositoryRoot: '/a' });
  assert.equal(idle.admit, true);
  assert.equal(idle.capacity.substantiveSlots, 1);
  assert.equal(idle.capacity.heavySlots, 1);

  const busy = decideAdmission(emptyState({ leases: [lease({ repositoryRoot: '/a' })] }), host, { access: 'mutate', workload: 'medium', repositoryRoot: '/b' });
  assert.equal(busy.admit, false);

  // Passive light inspection remains possible beside the one substantive job.
  assert.equal(decideAdmission(emptyState({ leases: [lease({ repositoryRoot: '/a' })] }), host, { access: 'read', workload: 'light' }).admit, true);
});

// 5 --------------------------------------------------------------------------
test('queue order is FIFO and releasing does not let an agent jump the queue', async () => {
  await withStateDir(async dir => {
    const repo = path.join(dir, 'repo');
    await fs.mkdir(repo, { recursive: true });

    const holder = await acquireWork({ snapshot: HOST, executor: 'claude-code', access: 'mutate', workload: 'medium', repositoryRoot: repo });
    assert.equal(holder.status, 'acquired');

    const waiters: string[] = [];
    for (const executor of ['codex', 'chatgpt', 'grok'] as const) {
      const queued = await acquireWork({ snapshot: HOST, executor, access: 'mutate', workload: 'medium', repositoryRoot: repo });
      assert.equal(queued.status, 'queued');
      waiters.push(queued.ticket.id);
      // Distinct enqueue timestamps keep the FIFO order unambiguous.
      await new Promise(resolve => setTimeout(resolve, 5));
    }

    const state = await readCoordinatorState();
    assert.deepEqual(state.tickets.map(ticket => ticket.id), waiters);

    assert.equal((await releaseWork(holder.status === 'acquired' ? holder.lease.id : '')).released, true);

    // The original holder immediately re-asking goes to the back, not the front.
    const rejoin = await acquireWork({ snapshot: HOST, executor: 'claude-code', access: 'mutate', workload: 'medium', repositoryRoot: repo });
    assert.equal(rejoin.status, 'queued');
    assert.match(rejoin.reasons.join(' '), /queued ahead/);

    // The head of the queue is admitted.
    const head = await acquireWork({ snapshot: HOST, executor: 'codex', access: 'mutate', workload: 'medium', repositoryRoot: repo, ticketId: waiters[0] });
    assert.equal(head.status, 'acquired');
    // Its ticket is consumed, not left behind.
    assert.equal((await readCoordinatorState()).tickets.some(ticket => ticket.id === waiters[0]), false);
  });
});

// 6 and 7 --------------------------------------------------------------------
test('a dead-PID lease is reclaimable but a live PID is never reclaimed from heartbeat delay alone', async () => {
  const longAgo = new Date(Date.now() - LEASE_STALE_MS - 60_000).toISOString();

  // A live process whose heartbeat lapsed keeps its lease: DEX does not evict a slow owner.
  assert.equal(leaseIsReclaimable(lease({ pid: process.pid, heartbeatAt: longAgo })), false);
  // One merely delayed heartbeat is not staleness either.
  assert.equal(leaseIsReclaimable(lease({ pid: process.pid, heartbeatAt: new Date(Date.now() - HEARTBEAT_INTERVAL_MS - 1000).toISOString() })), false);
  // A recorded PID that no longer exists is a reclaimable coordination claim.
  assert.equal(leaseIsReclaimable(lease({ pid: 2_147_483_647, heartbeatAt: longAgo })), true);
  // Expiry alone, with the process still alive, is not enough.
  assert.equal(leaseIsReclaimable(lease({ pid: 2_147_483_647, heartbeatAt: new Date().toISOString() })), false);

  await withStateDir(async dir => {
    const repo = path.join(dir, 'repo');
    await fs.mkdir(repo, { recursive: true });
    const orphan = lease({ pid: 2_147_483_647, repositoryRoot: await fs.realpath(repo), heartbeatAt: longAgo, id: 'lease-orphan' });
    await fs.mkdir(leasesDir(), { recursive: true });
    await fs.writeFile(path.join(leasesDir(), 'lease-orphan.json'), JSON.stringify(orphan));

    const result = await acquireWork({ snapshot: HOST, executor: 'claude-code', access: 'mutate', workload: 'medium', repositoryRoot: repo });
    assert.equal(result.status, 'acquired');
    // Reclaiming removed the expired claim; it did not signal or kill anything.
    assert.equal((await readCoordinatorState()).leases.some(entry => entry.id === 'lease-orphan'), false);

    const history = await fs.readFile(path.join(coordinatorDir(), 'history', 'events.jsonl'), 'utf8');
    assert.match(history, /lease-reclaimed/);
    assert.doesNotMatch(history, /kill|terminate|SIGKILL/i);
  });

  await withStateDir(async dir => {
    const repo = path.join(dir, 'repo');
    await fs.mkdir(repo, { recursive: true });
    const live = lease({ pid: process.pid, repositoryRoot: await fs.realpath(repo), heartbeatAt: longAgo, id: 'lease-live' });
    await fs.mkdir(leasesDir(), { recursive: true });
    await fs.writeFile(path.join(leasesDir(), 'lease-live.json'), JSON.stringify(live));

    const result = await acquireWork({ snapshot: HOST, executor: 'codex', access: 'mutate', workload: 'medium', repositoryRoot: repo });
    assert.equal(result.status, 'queued');
    assert.equal((await readCoordinatorState()).leases.some(entry => entry.id === 'lease-live'), true);
  });
});

// 8 --------------------------------------------------------------------------
test('corrupted coordinator state falls back to conservative mode rather than unlimited admission', async () => {
  await withStateDir(async dir => {
    const repo = path.join(dir, 'repo');
    await fs.mkdir(repo, { recursive: true });
    await fs.mkdir(leasesDir(), { recursive: true });
    await fs.writeFile(path.join(leasesDir(), 'broken.json'), '{ this is not json');

    const state = await readCoordinatorState();
    assert.equal(state.degraded, true);
    assert.equal(state.leases.length, 0);

    // An unreadable entry must never read as "nothing is running".
    const result = await acquireWork({ snapshot: HOST, executor: 'claude-code', access: 'mutate', workload: 'heavy', repositoryRoot: repo });
    assert.equal(result.status, 'queued');
    assert.match(result.reasons.join(' '), /degraded/);
    assert.equal(result.capacity.substantiveSlots, 1);

    // The owner can still see the problem and repair it; the file is not silently deleted.
    const status = await workStatus({ snapshot: HOST });
    assert.equal(status.degraded, true);
    await fs.access(path.join(leasesDir(), 'broken.json'));
  });

  // A lease whose shape is valid JSON but not a lease is equally not a free slot.
  const degraded = decideAdmission(
    emptyState({ degraded: true, degradedReasons: ['lease file x.json is malformed'] }),
    snapshot({ physicalMemoryBytes: 128 * GIB, logicalCpuCount: 64 }),
    { access: 'mutate', workload: 'medium', repositoryRoot: '/a' }
  );
  assert.equal(degraded.admit, false);
  assert.equal(degraded.capacity.substantiveSlots, 1);
});

// 9 --------------------------------------------------------------------------
test('a coordinator lease grants no execution authority', async () => {
  await withStateDir(async dir => {
    const repo = path.join(dir, 'repo');
    await fs.mkdir(repo, { recursive: true });
    const actor = { kind: 'claude' as const, clientId: 'c1', clientName: 'Claude' };
    const off = { ...defaultAccessState(), mode: 'off' as const };

    const before = authorizeOperation(off, actor, 'dex.process.run', 'development');
    const result = await acquireWork({ snapshot: HOST, executor: 'claude-code', access: 'exclusive', workload: 'heavy', repositoryRoot: repo, phase: 'phase-0a' });
    assert.equal(result.status, 'acquired');
    const after = authorizeOperation(off, actor, 'dex.process.run', 'development');

    // Holding the machine changes nothing about whether the operation is allowed.
    assert.deepEqual(after, before);
    assert.equal(after.allowed, false);

    // The persisted lease carries no authority-bearing field.
    const raw = JSON.parse(await fs.readFile(path.join(leasesDir(), `${result.lease.id}.json`), 'utf8')) as Record<string, unknown>;
    assert.deepEqual(Object.keys(raw).sort(), Object.keys(result.lease).sort());
    for (const key of Object.keys(raw)) {
      assert.ok((LEASE_FIELDS as readonly string[]).includes(key), `unexpected lease field ${key}`);
      assert.doesNotMatch(key, /capabilit|grant|token|secret|credential|mode|profile|authority|allowedRoots/i);
    }
  });
});

// 10 -------------------------------------------------------------------------
test('coordination files never carry prompt bodies or credential material', async () => {
  const secret = 'ghpAbc123DEFghi456JKLmno789PQR';
  assert.equal(looksLikeSecretMaterial(secret), true);
  assert.equal(looksLikeSecretMaterial('phase-0a'), false);
  assert.equal(looksLikeSecretMaterial('verify golden'), false);

  assert.throws(() => sanitizeLabel(secret, 'phase'), /credential material/);
  assert.throws(() => sanitizeLabel('a'.repeat(200), 'phase'), /at most 64 characters/);
  assert.throws(() => sanitizeLabel('please run: rm -rf ~ && echo "$TOKEN"', 'phase'), /may contain only/);
  assert.equal(sanitizeLabel('  phase-0a  ', 'phase'), 'phase-0a');

  await withStateDir(async dir => {
    const repo = path.join(dir, 'repo');
    await fs.mkdir(repo, { recursive: true });
    await assert.rejects(
      acquireWork({ snapshot: HOST, executor: 'claude-code', access: 'mutate', workload: 'medium', repositoryRoot: repo, phase: secret }),
      /credential material/
    );

    const accepted = await acquireWork({ snapshot: HOST, executor: 'claude-code', access: 'mutate', workload: 'medium', repositoryRoot: repo, phase: 'phase-0a' });
    assert.equal(accepted.status, 'acquired');

    // Extra fields a caller invents are dropped on write, not persisted.
    const extended = { snapshot: HOST, executor: 'codex', access: 'read', workload: 'light', phase: 'probe', transcript: 'user said hello' } as never;
    await acquireWork(extended);

    let corpus = '';
    for (const sub of [leasesDir(), queueDir(), path.join(coordinatorDir(), 'history')]) {
      for (const name of await fs.readdir(sub).catch(() => [] as string[])) {
        corpus += await fs.readFile(path.join(sub, name), 'utf8');
      }
    }
    assert.doesNotMatch(corpus, new RegExp(secret));
    assert.doesNotMatch(corpus, /transcript|user said hello/);
  });
});

// 11 -------------------------------------------------------------------------
test('concurrent acquire attempts cannot both receive the last slot', async () => {
  await withStateDir(async dir => {
    const repo = path.join(dir, 'repo');
    await fs.mkdir(repo, { recursive: true });

    // Twenty simultaneous mutating requests on one repository: exactly one may own it.
    const results = await Promise.all(
      Array.from({ length: 20 }, () => acquireWork({ snapshot: HOST, executor: 'other', access: 'mutate', workload: 'medium', repositoryRoot: repo }))
    );
    const acquired = results.filter(result => result.status === 'acquired');
    assert.equal(acquired.length, 1);
    assert.equal(results.filter(result => result.status === 'queued').length, 19);

    const state = await readCoordinatorState();
    assert.equal(state.leases.length, 1);
    assert.equal(state.tickets.length, 19);
  });
});

// 12 -------------------------------------------------------------------------
test('queue cancellation removes only the caller ticket', async () => {
  await withStateDir(async dir => {
    const repo = path.join(dir, 'repo');
    await fs.mkdir(repo, { recursive: true });
    await acquireWork({ snapshot: HOST, executor: 'claude-code', access: 'mutate', workload: 'medium', repositoryRoot: repo });

    const ids: string[] = [];
    for (const executor of ['codex', 'chatgpt', 'grok'] as const) {
      const queued = await acquireWork({ snapshot: HOST, executor, access: 'mutate', workload: 'medium', repositoryRoot: repo });
      assert.equal(queued.status, 'queued');
      ids.push(queued.ticket.id);
      await new Promise(resolve => setTimeout(resolve, 5));
    }

    assert.equal(await cancelTicket(ids[1]!), true);
    assert.equal(await cancelTicket(ids[1]!), false);

    const remaining = (await readCoordinatorState()).tickets.map(ticket => ticket.id);
    assert.deepEqual(remaining, [ids[0], ids[2]]);
  });
});

// 13 -------------------------------------------------------------------------
test('persistent DEX services are not counted as coding leases', async () => {
  await withStateDir(async () => {
    const status = await workStatus({ snapshot: HOST });
    // Services are reported separately and never inflate the coordinated lease count.
    assert.equal(status.leases.length, 0);
    assert.equal(status.capacity.activeCoordinated, 0);
    assert.ok(status.observed.dexServices >= 0);
    assert.ok(Object.keys(status.observed).includes('dexServices'));
  });

  const withServices = decideAdmission(
    emptyState(),
    snapshot({ physicalMemoryBytes: 12 * GIB, logicalCpuCount: 8, observed: { uncoordinatedHeavy: 0, dexServices: 4 } }),
    { access: 'mutate', workload: 'medium', repositoryRoot: '/a' }
  );
  assert.equal(withServices.admit, true);
});

// 14 -------------------------------------------------------------------------
test('an observed anonymous heavy process reduces admission capacity', () => {
  const host = snapshot({ physicalMemoryBytes: 16 * GIB, logicalCpuCount: 8, observed: { uncoordinatedHeavy: 2, dexServices: 1 } });
  const blocked = decideAdmission(emptyState(), host, { access: 'mutate', workload: 'medium', repositoryRoot: '/a' });
  assert.equal(blocked.admit, false);
  assert.match(blocked.reasons.join(' '), /uncoordinated heavy workload/);
  assert.equal(blocked.capacity.observedUncoordinatedHeavy, 2);
});

// 15 -------------------------------------------------------------------------
test('share-mode status omits repository paths and other local detail', async () => {
  await withStateDir(async dir => {
    const repo = path.join(dir, 'secret-project-name');
    await fs.mkdir(repo, { recursive: true });
    await acquireWork({ snapshot: HOST, executor: 'claude-code', access: 'mutate', workload: 'medium', repositoryRoot: repo, branch: 'feature/private-name' });

    const status = await workStatus({ snapshot: HOST });
    assert.equal(status.leases[0]!.repositoryRoot, await fs.realpath(repo));

    const shared = JSON.stringify(redactWorkStatusForShare(status));
    assert.doesNotMatch(shared, /secret-project-name/);
    assert.doesNotMatch(shared, /private-name/);
    assert.doesNotMatch(shared, new RegExp(String(process.pid)));
    assert.doesNotMatch(shared, /physicalMemoryBytes/);
    // It still answers the operational question without exposing local detail.
    assert.match(shared, /"queueDepth":0/);
    assert.match(shared, /"activeLeases":1/);
  });
});

test('progress history uses monotonic cursors and resumes without leaking local paths', async () => {
  await withStateDir(async dir => {
    const repo = path.join(dir, 'secret-repo');
    await fs.mkdir(repo, { recursive: true });
    const first = await recordWorkEvent({ event: 'cache-miss' });
    const second = await recordWorkEvent({ event: 'classifier-result', observedUncoordinatedHeavy: 2, dexServices: 4 });
    assert.equal(second.cursor, first.cursor + 1);

    const page = await readWorkEvents(0, 1);
    assert.equal(page.events.length, 1);
    assert.equal(page.hasMore, true);
    const resumed = await readWorkEvents(page.events[0]!.cursor, 100);
    assert.equal(resumed.events[0]!.cursor, second.cursor);
    assert.equal(resumed.hasMore, false);

    const acquired = await acquireWork({
      snapshot: HOST,
      executor: 'chatgpt',
      access: 'mutate',
      workload: 'medium',
      repositoryRoot: repo,
      phase: 'event-proof'
    });
    assert.equal(acquired.status, 'acquired');
    if (acquired.status === 'acquired') await heartbeat(acquired.lease.id);

    const status = await workStatus({ snapshot: HOST });
    const shared = JSON.stringify(redactWorkStatusForShare(status));
    assert.match(shared, /\"eventCursor\":/);
    assert.match(shared, /phase-progress/);
    assert.doesNotMatch(shared, /secret-repo/);
    assert.doesNotMatch(shared, new RegExp(String(process.pid)));
  });
});

// Machine exclusivity and lifecycle ------------------------------------------
test('exclusive machine work requires an otherwise idle machine', async () => {
  await withStateDir(async dir => {
    const repo = path.join(dir, 'repo');
    await fs.mkdir(repo, { recursive: true });
    const held = await acquireWork({ snapshot: HOST, executor: 'codex', access: 'read', workload: 'light', repositoryRoot: repo });
    assert.equal(held.status, 'acquired');

    const install = await acquireWork({ snapshot: HOST, executor: 'human', access: 'exclusive', workload: 'heavy' });
    assert.equal(install.status, 'queued');
    assert.match(install.reasons.join(' '), /otherwise idle machine/);

    assert.equal((await releaseWork(held.status === 'acquired' ? held.lease.id : '')).released, true);
    const retry = await acquireWork({ snapshot: HOST, executor: 'human', access: 'exclusive', workload: 'heavy', ticketId: install.status === 'queued' ? install.ticket.id : undefined });
    assert.equal(retry.status, 'acquired');

    // While the machine is held exclusively, other substantive work queues.
    const blocked = await acquireWork({ snapshot: HOST, executor: 'claude-code', access: 'mutate', workload: 'medium', repositoryRoot: repo });
    assert.equal(blocked.status, 'queued');
    assert.match(blocked.reasons.join(' '), /exclusively/);
  });
});

test('heartbeats refresh leases and tickets, and stale ticket fields stay bounded', async () => {
  await withStateDir(async dir => {
    const repo = path.join(dir, 'repo');
    await fs.mkdir(repo, { recursive: true });
    const held = await acquireWork({ snapshot: HOST, executor: 'claude-code', access: 'mutate', workload: 'medium', repositoryRoot: repo });
    assert.equal(held.status, 'acquired');
    const id = held.status === 'acquired' ? held.lease.id : '';

    await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(await heartbeat(id), true);
    assert.equal(await heartbeat('lease-does-not-exist'), false);

    const refreshed = (await readCoordinatorState()).leases.find(entry => entry.id === id)!;
    assert.ok(Date.parse(refreshed.heartbeatAt) >= Date.parse(held.status === 'acquired' ? held.lease.heartbeatAt : ''));

    const queued = await acquireWork({ snapshot: HOST, executor: 'codex', access: 'mutate', workload: 'medium', repositoryRoot: repo });
    assert.equal(queued.status, 'queued');
    const ticketId = queued.status === 'queued' ? queued.ticket.id : '';
    assert.equal(await heartbeat(ticketId), true);

    const raw = JSON.parse(await fs.readFile(path.join(queueDir(), `${ticketId}.json`), 'utf8')) as Record<string, unknown>;
    for (const key of Object.keys(raw)) assert.ok((TICKET_FIELDS as readonly string[]).includes(key), `unexpected ticket field ${key}`);
  });
});

test('a lease is released only by its holder unless the local owner forces it', async () => {
  await withStateDir(async dir => {
    const repo = path.join(dir, 'repo');
    await fs.mkdir(repo, { recursive: true });
    const held = await acquireWork({ snapshot: HOST, executor: 'claude-code', access: 'mutate', workload: 'medium', repositoryRoot: repo });
    const id = held.status === 'acquired' ? held.lease.id : '';

    const stranger = await releaseWork(id, { pid: process.pid + 1 });
    assert.equal(stranger.released, false);
    assert.match(stranger.reason!, /live pid/);

    const forced = await releaseWork(id, { pid: process.pid + 1, force: true });
    assert.equal(forced.released, true);
    assert.equal((await readCoordinatorState()).leases.length, 0);
    assert.equal((await releaseWork(id)).released, false);
  });
});

test('coordinator distinguishes an explicit workload pid from the short-lived acquirer pid', async () => {
  await withStateDir(async dir => {
    const repoA = path.join(dir, 'repo-bound');
    const repoB = path.join(dir, 'repo-unbound');
    await fs.mkdir(repoA, { recursive: true });
    await fs.mkdir(repoB, { recursive: true });

    const bound = await acquireWork({ snapshot: HOST, executor: 'chatgpt', access: 'mutate', workload: 'medium', repositoryRoot: repoA, pid: process.pid });
    assert.equal(bound.status, 'acquired');
    if (bound.status === 'acquired') assert.equal(bound.lease.pidIsWorkload, true);

    if (bound.status === 'acquired') await releaseWork(bound.lease.id, { force: true });

    const unbound = await acquireWork({ snapshot: HOST, executor: 'chatgpt', access: 'mutate', workload: 'medium', repositoryRoot: repoB });
    assert.equal(unbound.status, 'acquired');
    if (unbound.status === 'acquired') assert.equal(unbound.lease.pidIsWorkload, false);
  });
});
