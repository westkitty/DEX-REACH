import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { WRITER_OWNERSHIP } from '../scripts/lib/recovery-checkpoint.js';
import { withFileLock } from '../src/shared/state-io.js';

// A pid that certainly belonged to a process which has exited.
const deadPid = () => spawnSync(process.execPath, ['-e', '']).pid!;

async function isolated<T>(fn: (state: string) => Promise<T>): Promise<T> {
  const state = await fs.mkdtemp(path.join(os.tmpdir(), 'dex-coord-fence-')), previous = process.env.DEX_REACH_STATE_DIR;
  process.env.DEX_REACH_STATE_DIR = state;
  try { return await fn(state); } finally {
    if (previous === undefined) delete process.env.DEX_REACH_STATE_DIR; else process.env.DEX_REACH_STATE_DIR = previous;
    await fs.rm(state, { recursive: true, force: true });
  }
}

test('the coordinator fence includes the capacity profile lock that serializes capacity health writes', async () => {
  await isolated(async state => {
    const { capacityProfileLockFile } = await import('../src/shared/capacity-profile.js');
    const coordinator = WRITER_OWNERSHIP.find(m => m.group === 'coordinator')!;
    assert.ok(coordinator.locks(state, 'macbook-air.local').includes(capacityProfileLockFile()));
  });
});

test('a capacity health write cannot land while the coordinator fence is held', async () => {
  await isolated(async state => {
    const { recordCapacityHealth } = await import('../src/shared/capacity-profile.js');
    const coordinator = WRITER_OWNERSHIP.find(m => m.group === 'coordinator')!, health = path.join(state, 'coordinator', 'capacity-health.json');
    await fs.mkdir(path.join(state, 'coordinator'), { recursive: true, mode: 0o700 });
    let release!: () => void; const held = new Promise<void>(r => { release = r; }); let fenced!: () => void; const ready = new Promise<void>(r => { fenced = r; });
    const lock = coordinator.locks(state, 'macbook-air.local').find(l => l.endsWith('capacity-profile.lock'))!;
    const holder = withFileLock(lock, async () => { fenced(); await held; });
    await ready;
    const write = recordCapacityHealth({ memory: 'healthy', cpu: 'healthy', thermal: 'healthy', observedUncoordinatedHeavy: 0 });
    await new Promise(r => setTimeout(r, 300));
    await assert.rejects(fs.stat(health), /ENOENT/);
    release(); await holder; await write;
    await fs.stat(health);
  });
});

test('workStatus reclaims expired leases only under the coordinator lock', async () => {
  await isolated(async state => {
    const work = await import('../src/shared/work-coordinator.js');
    const leases = work.leasesDir(); await fs.mkdir(leases, { recursive: true, mode: 0o700 });
    await fs.mkdir(path.dirname(work.historyLockFile()), { recursive: true, mode: 0o700 });
    const old = '2020-01-01T00:00:00.000Z', file = path.join(leases, 'stale.json');
    await fs.writeFile(file, JSON.stringify({ id: 'stale', pid: deadPid(), executor: 'codex', access: 'read', workload: 'light', createdAt: old, heartbeatAt: old }), { mode: 0o600 });
    const snapshot = await work.snapshotCapacity();
    let release!: () => void; const held = new Promise<void>(r => { release = r; }); let fenced!: () => void; const ready = new Promise<void>(r => { fenced = r; });
    const holder = withFileLock(work.coordinatorLockFile(), async () => { fenced(); await held; });
    await ready;
    let settled = false; const status = work.workStatus({ snapshot }).finally(() => { settled = true; });
    await new Promise(r => setTimeout(r, 300));
    // While another holder owns the coordinator lock, a status read must not mutate coordinator state.
    await fs.stat(file); assert.equal(settled, false);
    release(); await holder;
    const result = await status;
    await assert.rejects(fs.stat(file), /ENOENT/);
    assert.equal(result.leases.length, 0);
  });
});

test('install and rollback serialize on the same install lock the checkpoint fence holds', async () => {
  const { installLockFile } = await import('../scripts/lib/runtime-release.js');
  const installer = WRITER_OWNERSHIP.find(m => m.group === 'runtime-installer')!;
  assert.deepEqual(installer.locks('/synthetic/state', 'macbook-air.local'), [installLockFile('/synthetic/state')]);
  assert.ok(installer.processAbsence, 'unlocked helpers still require proven process absence');
  for (const script of ['scripts/install-macos.ts', 'scripts/rollback-macos.ts']) {
    const source = await fs.readFile(script, 'utf8');
    assert.match(source, /await withFileLock\(installLockFile\(localStateDir\), (install|rollback), \{ timeoutMs: 1000 \}\);/, script);
    assert.ok(!source.includes("'install.lock'"), `${script} must not spell its own lock path`);
  }
  // A maintenance run attempted while the fence holds the lock is refused before it does anything.
  await isolated(async state => {
    await fs.mkdir(path.join(state, 'runtime'), { recursive: true, mode: 0o700 });
    let release!: () => void; const held = new Promise<void>(r => { release = r; }); let fenced!: () => void; const ready = new Promise<void>(r => { fenced = r; });
    const holder = withFileLock(installLockFile(state), async () => { fenced(); await held; });
    await ready;
    let ran = false;
    await assert.rejects(withFileLock(installLockFile(state), async () => { ran = true; }, { timeoutMs: 1000 }));
    assert.equal(ran, false);
    release(); await holder;
  });
});
