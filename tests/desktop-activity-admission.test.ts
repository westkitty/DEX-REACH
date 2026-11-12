import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  classifyCpuPressure,
  classifyObservedWorkloads,
  evaluateCapacity,
  isSubstantive,
  observeWorkloadsResult,
  parseProcessTable,
  type CpuPressure
} from '../src/shared/machine-capacity.js';
import { classifyOperationSafety } from '../src/shared/durable-execution.js';

// The MacBook incident host: 8 GiB, 8 logical CPUs, conservative profile -> one substantive slot.
// Synthetic fixtures only; they do not stand in for real-hardware verification.
const GIB = 1024 ** 3;
const HEADER = '  PID  PPID %CPU %MEM     ELAPSED COMMAND\n';
const host = { physicalMemoryBytes: 8 * GIB, logicalCpuCount: 8, loadAverage1m: 2.5, memory: 'healthy' as const, thermal: 'healthy' as const };
const rows = (table: string) => parseProcessTable(HEADER + table);
const cpuOf = (load: number | null): CpuPressure => classifyCpuPressure(load, host.logicalCpuCount);
const mutate = { workload: 'medium' as const, access: 'mutate' as const };

// Four running DEX services, no leases, and ordinary desktop activity at roughly 10-20% CPU: the shapes
// named in the incident sample (WindowServer, DexDictate, Brave, Terminal, an unidentified Node.js
// process) plus an OS daemon and the DEX node's own resident compatibility adapter.
const DEX_SERVICES = `
  922     1  0.0  0.3    01:06:22 /opt/homebrew/opt/node/bin/node /Users/owner/.dex-reach/runtime/releases/r/dist/src/gateway/main.js
  929     1  0.0  0.3    01:06:22 /opt/homebrew/opt/node/bin/node /Users/owner/.dex-reach/runtime/releases/r/dist/src/coordinator/main.js
  930     1  3.0  0.6    01:06:22 /opt/homebrew/opt/node/bin/node /Users/owner/.dex-reach/runtime/releases/r/dist/src/node/main.js
  931     1  0.0  0.1    01:06:22 /opt/homebrew/opt/node/bin/node /Users/owner/.dex-reach/runtime/releases/r/dist/src/worker/main.js
`;
const ORDINARY_DESKTOP = DEX_SERVICES + `
  417     1 14.0  0.6    01:05:14 /System/Library/PrivateFrameworks/SkyLight.framework/Resources/WindowServer -daemon
  967     1 11.9  0.4    01:04:46 /Applications/DexDictate.app/Contents/MacOS/DexDictate
 1200     1 12.0  2.5    01:00:00 /Applications/Brave Browser.app/Contents/MacOS/Brave Browser
 1201  1200 18.0  1.5    01:00:00 /Applications/Brave Browser.app/Contents/Frameworks/Brave Browser Framework.framework/Versions/1/Helpers/Brave Browser Helper (Renderer).app/Contents/MacOS/Brave Browser Helper (Renderer) --type=renderer
 1202  1200 15.0  0.8    01:00:00 /Applications/Brave Browser.app/Contents/Frameworks/Brave Browser Framework.framework/Versions/1/Helpers/Brave Browser Helper (GPU).app/Contents/MacOS/Brave Browser Helper (GPU) --type=gpu-process
70343     1 18.8  0.5       04:45 /System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal
 4548     1 16.0  0.2    01:01:42 /opt/homebrew/bin/node ./dist/server.mjs
  749     1 15.5  0.4    01:05:07 /usr/libexec/duetexpertd
 1191   930 13.0  0.1    01:05:40 /opt/homebrew/bin/node /Users/owner/.dex-reach/runtime/releases/r/node_modules/@wonderwhy-er/desktop-commander/dist/index.js --no-onboarding
`;
const ACTIVE_AGENT = '  5000     1 31.0  3.0    00:10:00 /opt/homebrew/bin/claude --output-format stream-json --private-prompt-text\n';
const ACTIVE_CODEX = '  5100     1 61.4  2.1    00:10:00 /Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex app-server\n';

function decide(table: string, load: number | null = host.loadAverage1m, probe: Record<string, unknown> = {}, counts: { activeSubstantive?: number; activeHeavy?: number } = {}, request: { workload: 'light' | 'medium' | 'heavy'; access: 'read' | 'mutate' | 'exclusive' } = mutate) {
  const observed = classifyObservedWorkloads(rows(table), { selfPid: 2_147_483_000, hostCpu: cpuOf(load) });
  const capacity = evaluateCapacity({ ...host, loadAverage1m: load, ...probe } as never,
    { activeSubstantive: counts.activeSubstantive ?? 0, activeHeavy: counts.activeHeavy ?? 0, observedUncoordinatedHeavy: observed.uncoordinatedHeavy, processObservation: 'observed' }, request);
  return { observed, capacity };
}

test('reproduction: the historical classifier view of ordinary desktop activity yields the incident refusal', () => {
  // Without host pressure evidence the classifier fails closed and counts every hot group, exactly as
  // the installed runtime did: seven uncoordinated workloads against one slot.
  const observed = classifyObservedWorkloads(rows(ORDINARY_DESKTOP), { selfPid: 2_147_483_000 });
  assert.equal(observed.dexServices, 4);
  assert.equal(observed.uncoordinatedHeavy, 7);
  const capacity = evaluateCapacity(host, { activeSubstantive: 0, activeHeavy: 0, observedUncoordinatedHeavy: observed.uncoordinatedHeavy }, mutate);
  assert.equal(capacity.canAdmit, false);
  assert.ok(capacity.reasons.includes('substantive slots exhausted (7/1, including 7 uncoordinated heavy workload(s))'), capacity.reasons.join('; '));
});

test('1. ordinary desktop activity does not consume the only slot on a host with healthy CPU', () => {
  for (const memory of ['healthy', 'warning'] as const) {
    const { observed, capacity } = decide(ORDINARY_DESKTOP, host.loadAverage1m, { memory });
    assert.equal(observed.uncoordinatedHeavy, 0, JSON.stringify(observed.uncoordinatedDetails));
    assert.equal(capacity.canAdmit, true, `${memory}: ${capacity.reasons.join('; ')}`);
  }
});

test('2. an independent active Claude or Codex session still competes for the slot', () => {
  for (const agent of [ACTIVE_AGENT, ACTIVE_CODEX]) {
    const { observed, capacity } = decide(ORDINARY_DESKTOP + agent);
    assert.equal(observed.uncoordinatedHeavy, 1, agent);
    assert.equal(capacity.canAdmit, false);
  }
});

test('3. active compilers, builds and tests still compete on a healthy host', () => {
  for (const job of [
    '  700     1 20.0  1.0    00:01:00 node /Users/owner/p/node_modules/typescript/bin/tsc -p tsconfig.json\n',
    '  701     1 12.0  1.5    00:02:00 node --test --import tsx tests/a.test.ts\n',
    '  702     1  3.0  6.0    00:02:00 /opt/homebrew/bin/cargo build --release\n',
    '  703     1 11.0  0.5    00:00:30 python3 -m pytest -q\n',
    '  704     1 15.0  0.9    00:00:30 /usr/bin/xcodebuild -scheme App build\n'
  ]) {
    const { observed, capacity } = decide(ORDINARY_DESKTOP + job);
    assert.equal(observed.uncoordinatedHeavy, 1, job);
    assert.equal(capacity.canAdmit, false, job);
  }
});

test('4. a genuinely demanding desktop renderer still competes, its helpers summed as one app', () => {
  const single = decide('  601     1 185.2  5.5    00:08:00 /Applications/ChatGPT.app/Contents/Frameworks/Codex Helper (Renderer).app/Contents/MacOS/Codex Helper (Renderer) --type=renderer\n');
  assert.equal(single.observed.uncoordinatedHeavy, 1);
  // No single helper reaches a full core, but together the browser is doing job-sized work.
  const helpers = decide(`
 1300     1 12.0  2.5    01:00:00 /Applications/Brave Browser.app/Contents/MacOS/Brave Browser
 1301  1300 35.0  1.5    01:00:00 /Applications/Brave Browser.app/Contents/Frameworks/B.framework/Helpers/Brave Browser Helper (Renderer).app/Contents/MacOS/Brave Browser Helper (Renderer) --type=renderer
 1302  1300 38.0  0.8    01:00:00 /Applications/Brave Browser.app/Contents/Frameworks/B.framework/Helpers/Brave Browser Helper (GPU).app/Contents/MacOS/Brave Browser Helper (GPU) --type=gpu-process
`);
  assert.equal(helpers.observed.uncoordinatedHeavy, 1);
  assert.deepEqual(helpers.observed.uncoordinatedDetails?.[0]?.pids, [1300, 1301, 1302]);
  assert.equal(helpers.capacity.canAdmit, false);
});

test('5. unknown resource-intensive processes are not exempt, and unknown host CPU fails closed', () => {
  for (const job of [
    '  1100     1 95.0  5.0    00:01:00 /usr/bin/python3 /tmp/x.py --name claude --tool tsc\n',
    '  1101     1 100.0 1.0    00:01:00 /usr/local/bin/mystery-build --jobs 1\n'
  ]) assert.equal(decide(ORDINARY_DESKTOP + job).observed.uncoordinatedHeavy, 1, job);
  // A busy (not saturated) host does not spend its only slot on multiple sub-core UI processes.
  const busy = decide(ORDINARY_DESKTOP, 6.5);
  assert.equal(busy.observed.uncoordinatedHeavy, 0);
  assert.equal(busy.capacity.livePressure.cpu, 'busy');
  assert.equal(busy.capacity.canAdmit, true, busy.capacity.reasons.join('; '));
  // Real jobs still compete, and heavy work still queues on a busy CPU.
  assert.equal(decide(ORDINARY_DESKTOP + ACTIVE_AGENT, 6.5).observed.uncoordinatedHeavy, 1);
  assert.equal(decide(ORDINARY_DESKTOP + '  1199     1 95.0  0.5    00:03:00 /usr/local/bin/unknown-build\n', 6.5).observed.uncoordinatedHeavy, 1);
  assert.equal(decide(ORDINARY_DESKTOP, 6.5, {}, {}, { workload: 'heavy', access: 'mutate' }).capacity.canAdmit, false);
  // Saturated or unmeasured CPU remains fail-closed for anonymous hot activity.
  assert.equal(decide(ORDINARY_DESKTOP, null).observed.uncoordinatedHeavy, 7);
  assert.equal(decide(ORDINARY_DESKTOP, null).capacity.canAdmit, false);
  for (const hostCpu of ['saturated', 'unknown'] as const)
    assert.equal(classifyObservedWorkloads(rows(ORDINARY_DESKTOP), { selfPid: 2_147_483_000, hostCpu }).uncoordinatedHeavy, 7, hostCpu);
});

test('6. related process trees count once; work under an idle agent belongs to that agent', () => {
  const { observed } = decide(ORDINARY_DESKTOP + `
  5200     1  0.4  2.6    01:00:00 /opt/homebrew/bin/claude
  5201  5200 30.0  0.5    00:00:20 /usr/local/bin/mystery-helper --scan
  5202  5201 25.0  0.5    00:00:10 /usr/local/bin/mystery-child
`);
  assert.equal(observed.uncoordinatedHeavy, 1);
  assert.deepEqual(observed.uncoordinatedDetails?.[0]?.pids, [5201, 5202]);
  assert.equal(observed.uncoordinatedDetails?.[0]?.processLabel, 'claude');
});

test('7. a leased workload is not counted twice', () => {
  const table = ORDINARY_DESKTOP + ACTIVE_AGENT + '  5001  5000 70.0  3.0    00:01:00 npm run verify\n';
  assert.equal(decide(table).observed.uncoordinatedHeavy, 1);
  const leased = classifyObservedWorkloads(rows(table), { selfPid: 2_147_483_000, leasedPids: [5000], hostCpu: 'healthy' });
  assert.equal(leased.uncoordinatedHeavy, 0);
});

test('8. a reused PID does not inherit lease identity on a healthy host', () => {
  const observedAt = Date.parse('2026-11-08T13:00:00Z');
  const table = rows('  800     1 20.0  4.0    00:00:20 npm run build\n');
  const options = { selfPid: 2_147_483_000, observedAt, hostCpu: 'healthy' as const };
  assert.equal(classifyObservedWorkloads(table, { ...options, leases: [{ pid: 800, createdAt: '2026-11-08T12:00:00Z' }] }).uncoordinatedHeavy, 1);
  assert.equal(classifyObservedWorkloads(table, { ...options, leases: [{ pid: 800, createdAt: '2026-11-08T12:59:50Z' }] }).uncoordinatedHeavy, 0);
});

test('9-11. one real lease fills the slot; critical memory and saturated CPU still refuse', () => {
  assert.equal(decide(ORDINARY_DESKTOP, host.loadAverage1m, {}, { activeSubstantive: 1 }).capacity.canAdmit, false);
  const critical = decide(ORDINARY_DESKTOP, host.loadAverage1m, { memory: 'critical' });
  assert.equal(critical.capacity.canAdmit, false); assert.ok(critical.capacity.reasons.includes('memory pressure critical'));
  const saturated = decide(ORDINARY_DESKTOP, 8.2);
  assert.equal(saturated.capacity.canAdmit, false); assert.match(saturated.capacity.reasons.join(';'), /CPU saturated/);
  // Heavy work still queues behind busy CPU and warning memory exactly as before.
  assert.equal(decide(ORDINARY_DESKTOP, host.loadAverage1m, { memory: 'warning' }, {}, { workload: 'heavy', access: 'mutate' }).capacity.canAdmit, false);
});

test('12. an unreadable process table still fails closed regardless of host CPU', async () => {
  const blind = await observeWorkloadsResult({ rows: null, hostCpu: 'healthy' });
  assert.equal(blind.processObservation, 'unknown');
  const capacity = evaluateCapacity(host, { activeSubstantive: 0, activeHeavy: 0, observedUncoordinatedHeavy: blind.uncoordinatedHeavy, processObservation: 'unknown' }, mutate);
  assert.equal(capacity.canAdmit, false);
});

test('13. the admission snapshot binds classification to its own CPU probe and stale samples still refuse', async () => {
  const { classifyForSnapshot, decideAdmission } = await import('../src/shared/work-coordinator.js');
  const table = rows(ORDINARY_DESKTOP);
  assert.equal(classifyForSnapshot(table, host, [], Date.now()).uncoordinatedHeavy, 0);
  assert.equal(classifyForSnapshot(table, { ...host, loadAverage1m: 6.5 }, [], Date.now()).uncoordinatedHeavy, 0);
  assert.equal(classifyForSnapshot(table, { ...host, loadAverage1m: null }, [], Date.now()).uncoordinatedHeavy, 7);
  assert.equal(classifyForSnapshot(null, host, [], Date.now()).processObservation, 'unknown');
  const observed = classifyForSnapshot(table, host, [], Date.now());
  const state = { leases: [], tickets: [], degraded: false, degradedReasons: [] };
  assert.equal(decideAdmission(state, { ...host, observed, sampledAtMs: Date.now() - 3000 }, mutate).admit, false);
  assert.equal(decideAdmission(state, { ...host, observed, sampledAtMs: Date.now() }, mutate).admit, true);
});

test('14-15. light reads stay available; shell execution keeps its conservative substantive class', () => {
  assert.equal(decide(ORDINARY_DESKTOP, null, {}, { activeSubstantive: 1 }, { workload: 'light', access: 'read' }).capacity.canAdmit, true);
  assert.equal(classifyOperationSafety('dex.process.run'), 'PROCESS_UNKNOWN_EFFECT');
  assert.equal(classifyOperationSafety('dc.call'), 'PROCESS_UNKNOWN_EFFECT');
  // The node maps non-read safety classes to mutate/medium, which always consumes a substantive slot.
  assert.equal(isSubstantive('medium', 'mutate'), true);
});

test('16. queueing, cancellation and eventual admission through the node wait loop', { timeout: 30_000 }, async () => {
  const state = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'dex-desktop-admission-')));
  const previous = process.env.DEX_REACH_STATE_DIR;
  process.env.DEX_REACH_STATE_DIR = state;
  try {
    const { acquireWork, cancelTicket, releaseWork, readCoordinatorState, classifyForSnapshot } = await import('../src/shared/work-coordinator.js');
    const { acquireTaskAdmission } = await import('../src/node/task-admission.js');
    let table = ORDINARY_DESKTOP + ACTIVE_AGENT;
    const snapshot = () => ({ ...host, sampledAtMs: Date.now(), observed: classifyForSnapshot(rows(table), host, [], Date.now()) });
    let clock = 0;
    const statuses: string[] = [];
    const hooks = {
      acquire: (request: Parameters<typeof acquireWork>[0]) => acquireWork({ ...request, snapshot: snapshot() }),
      cancel: cancelTicket, release: (id: string) => releaseWork(id, { force: true }),
      now: () => clock, sleep: async (ms: number) => { clock += ms; }
    };
    const request = { executor: 'other' as const, ...mutate, repositoryRoot: state, phase: 'dex.process.run' };

    // A genuine competing agent queues the request until the deadline, then the ticket is cancelled.
    await assert.rejects(acquireTaskAdmission(request, async status => { statuses.push(status); }, 1000, hooks), /COORDINATOR_WAIT_TIMEOUT: .*uncoordinated heavy/);
    assert.match(statuses[0] ?? '', /^WAITING_FOR_COORDINATOR: /);
    assert.equal((await readCoordinatorState()).tickets.length, 0);

    // The competitor finishes while the request waits: the same request is admitted.
    clock = 0;
    const leaseId = await acquireTaskAdmission(request, async () => { table = ORDINARY_DESKTOP; }, 5000, hooks);
    const held = await readCoordinatorState();
    assert.equal(held.leases.length, 1); assert.equal(held.tickets.length, 0);
    // Desktop activity never displaces that lease: a second substantive request queues behind it.
    const second = await acquireWork({ ...request, snapshot: snapshot() });
    assert.equal(second.status, 'queued');
    assert.equal(await cancelTicket(second.status === 'queued' ? second.ticket.id : ''), true);
    assert.equal((await releaseWork(leaseId, { force: true })).released, true);
    assert.equal((await acquireWork({ ...request, snapshot: snapshot() })).status, 'acquired');
  } finally {
    if (previous === undefined) delete process.env.DEX_REACH_STATE_DIR; else process.env.DEX_REACH_STATE_DIR = previous;
    await fs.rm(state, { recursive: true, force: true });
  }
});

test('17. status detail carries bounded labels only, and capacity evidence grants no authority', () => {
  const { observed, capacity } = decide(ORDINARY_DESKTOP + ACTIVE_AGENT);
  const shared = JSON.stringify({ observed, capacity });
  for (const secret of ['owner', 'private-prompt-text', 'stream-json', 'desktop-commander', '.dex-reach']) assert.ok(!JSON.stringify(observed.uncoordinatedDetails).includes(secret), secret);
  for (const field of ['grant', 'token', 'mode', 'root', 'capability']) assert.ok(!Object.keys(capacity).includes(field), field);
  assert.ok(shared.length < 20_000);
});

// Independent-review finding: an idle unknown parent whose unknown children are busy is one process
// family. Without grouping, each child is judged alone and the family escapes the job-sized bar.
const FAMILY = `
  6000     1  1.0  0.4    00:05:00 /usr/local/bin/mystery-runner --jobs 3
  6001  6000 35.0  1.0    00:04:00 /usr/local/bin/mystery-worker
  6002  6000 35.0  1.0    00:04:00 /usr/local/bin/mystery-worker
  6003  6000 35.0  1.0    00:04:00 /usr/local/bin/mystery-worker
`;

test('18. a busy unknown family under an idle unknown parent is one job-sized workload that blocks the slot', () => {
  const { observed, capacity } = decide(ORDINARY_DESKTOP + FAMILY);
  assert.equal(observed.uncoordinatedHeavy, 1, JSON.stringify(observed.uncoordinatedDetails));
  assert.equal(observed.uncoordinatedDetails?.[0]?.pid, 6000);
  // Family accounting includes every member, so the idle parent's 1% is part of the reported 106%.
  assert.deepEqual(observed.uncoordinatedDetails?.[0]?.pids, [6000, 6001, 6002, 6003]);
  assert.equal(observed.uncoordinatedDetails?.[0]?.cpu, 106);
  assert.equal(capacity.canAdmit, false);
  assert.match(capacity.reasons.join(';'), /substantive slots exhausted \(1\/1, including 1 uncoordinated heavy workload/);
  // A family is counted once, never once per child, whatever the host pressure.
  for (const load of [6.5, 8.5, null]) assert.equal(decide(FAMILY, load).observed.uncoordinatedHeavy, 1, String(load));
  // A single moderately busy child below the bar remains ordinary activity on a healthy host.
  assert.equal(decide('  6100     1  1.0  0.4    00:05:00 /usr/local/bin/mystery-runner\n  6101  6100 35.0  1.0    00:04:00 /usr/local/bin/mystery-worker\n').observed.uncoordinatedHeavy, 0);
});

test('19. launchd and PID 1 never group unrelated processes; separate families stay separate', () => {
  const launchdSiblings = `
  6200     1 35.0  1.0    00:04:00 /usr/local/bin/mystery-a
  6201     1 35.0  1.0    00:04:00 /usr/local/bin/mystery-b
  6202     1 35.0  1.0    00:04:00 /usr/libexec/mystery-c
`;
  const healthy = decide(launchdSiblings).observed;
  assert.equal(healthy.uncoordinatedHeavy, 0);
  // Busy but not saturated CPU alone does not turn sub-core launchd children into job-sized work.
  const busy = decide(launchdSiblings, 6.5).observed;
  assert.equal(busy.uncoordinatedHeavy, 0);
  // Unmeasured CPU still fails closed and preserves separate workload identities.
  const unknown = decide(launchdSiblings, null).observed;
  assert.equal(unknown.uncoordinatedHeavy, 3);
  assert.ok(!unknown.uncoordinatedDetails?.some(detail => detail.pid === 1));
  const second = FAMILY.replace(/600(\d)/g, '700$1');
  const two = decide(FAMILY + second).observed;
  assert.equal(two.uncoordinatedHeavy, 2);
  assert.deepEqual(two.uncoordinatedDetails?.map(detail => detail.pid), [6000, 7000]);
});

test('20. agent trees, desktop helpers, leases and PID reuse keep their behaviour with family grouping', () => {
  const agent = decide(`
  5300     1  0.4  2.6    01:00:00 /opt/homebrew/bin/claude
  5301  5300 30.0  0.5    00:00:20 /usr/local/bin/mystery-worker
  5302  5300 30.0  0.5    00:00:20 /usr/local/bin/mystery-worker
`).observed;
  assert.equal(agent.uncoordinatedHeavy, 1);
  assert.equal(agent.uncoordinatedDetails?.[0]?.processLabel, 'claude');
  assert.deepEqual(agent.uncoordinatedDetails?.[0]?.pids, [5301, 5302]);
  // Desktop helpers below a core in total remain ordinary activity; the incident fixture stays at zero.
  assert.equal(decide(ORDINARY_DESKTOP).observed.uncoordinatedHeavy, 0);
  // The parent started at 12:55. A lease created after that start covers the parent and its descendants.
  const observedAt = Date.parse('2026-11-08T13:00:00Z');
  const base = { selfPid: 2_147_483_000, observedAt, hostCpu: 'healthy' as const };
  assert.equal(classifyObservedWorkloads(rows(FAMILY), { ...base, leases: [{ pid: 6000, createdAt: '2026-11-08T12:58:00Z' }] }).uncoordinatedHeavy, 0);
  // A lease created before that start belongs to an earlier holder of a reused PID and covers nothing.
  assert.equal(classifyObservedWorkloads(rows(FAMILY), { ...base, leases: [{ pid: 6000, createdAt: '2026-11-08T12:00:00Z' }] }).uncoordinatedHeavy, 1);
  // The caller's own ancestors are never adopted as a competing family root.
  const own = classifyObservedWorkloads(rows(FAMILY.replace('6000     1', '6000  6999') + '  6999     1  0.1  0.1    01:00:00 -zsh\n  6998  6999  0.1  0.1    00:00:01 node coordinator-client\n'), { selfPid: 6998, hostCpu: 'healthy' });
  assert.ok(!own.uncoordinatedDetails?.some(detail => detail.pid === 6999));
});

// Second independent review (findings A-C). A two-slot host (16 GiB, 8 CPUs) shows multi-slot undercount.
const twoSlot = { physicalMemoryBytes: 16 * GIB };
const SHELL_JOBS = `
  9000     1  1.0  0.1    01:00:00 -zsh
  9001  9000 95.0  1.0    00:03:00 /usr/local/bin/mystery-a
  9002  9000 95.0  1.0    00:03:00 /usr/local/bin/mystery-b
`;
const DEEP_FAMILY = `
  7000     1  1.0  0.2    00:10:00 /usr/local/bin/mystery-orchestrator
  7100  7000  0.0  0.1    00:09:00 /usr/local/bin/mystery-stage
  7101  7100 35.0  0.5    00:08:00 /usr/local/bin/mystery-worker
  7102  7100 35.0  0.5    00:08:00 /usr/local/bin/mystery-worker
  7200  7000  0.0  0.1    00:09:00 /usr/local/bin/mystery-stage
  7201  7200 35.0  0.5    00:08:00 /usr/local/bin/mystery-worker
  7202  7200 35.0  0.5    00:08:00 /usr/local/bin/mystery-worker
`;
const SUBTHRESHOLD = '  8000     1  1.0  0.2    00:10:00 /usr/local/bin/mystery-pool\n' +
  Array.from({ length: 12 }, (_, i) => `  ${8001 + i}  8000  9.0  0.3    00:09:00 /usr/local/bin/mystery-worker\n`).join('');

test('21 (A). independent job-sized processes under one idle shell are separate workloads on one- and two-slot hosts', () => {
  const two = decide(SHELL_JOBS, host.loadAverage1m, twoSlot);
  assert.equal(two.observed.uncoordinatedHeavy, 2, JSON.stringify(two.observed.uncoordinatedDetails));
  assert.equal(two.capacity.substantiveSlots, 2);
  assert.equal(two.capacity.canAdmit, false);
  assert.equal(decide(SHELL_JOBS).capacity.canAdmit, false);
  // One such job leaves the second slot of a two-slot host free.
  const one = decide(SHELL_JOBS.split('\n').filter(line => !line.includes('9002')).join('\n'), host.loadAverage1m, twoSlot);
  assert.equal(one.observed.uncoordinatedHeavy, 1); assert.equal(one.capacity.canAdmit, true, one.capacity.reasons.join('; '));
  for (const load of [6.5, null]) assert.equal(decide(SHELL_JOBS, load, twoSlot).observed.uncoordinatedHeavy, 2, String(load));
});

test('22 (B). a deep unknown family separated by idle intermediaries is one visible job-sized workload', () => {
  const { observed, capacity } = decide(ORDINARY_DESKTOP + DEEP_FAMILY);
  assert.equal(observed.uncoordinatedHeavy, 1, JSON.stringify(observed.uncoordinatedDetails));
  assert.equal(observed.uncoordinatedDetails?.[0]?.pid, 7000);
  assert.equal(capacity.canAdmit, false);
  assert.equal(decide(DEEP_FAMILY, 6.5).observed.uncoordinatedHeavy >= 1, true);
});

test('23 (C). many sub-10% workers with job-sized aggregate CPU do not disappear', () => {
  const { observed, capacity } = decide(ORDINARY_DESKTOP + SUBTHRESHOLD);
  assert.equal(observed.uncoordinatedHeavy, 1, JSON.stringify(observed.uncoordinatedDetails));
  assert.equal(observed.uncoordinatedDetails?.[0]?.pid, 8000);
  assert.equal(capacity.canAdmit, false);
  // Contention can only add competition, never remove a family that a healthy host would count.
  for (const load of [6.5, 8.5, null]) assert.equal(decide(SUBTHRESHOLD, load).observed.uncoordinatedHeavy, 1, String(load));
  // A few idle-ish workers stay ordinary activity.
  assert.equal(decide('  8100     1  1.0  0.2    00:10:00 /usr/local/bin/mystery-pool\n  8101  8100  9.0  0.3    00:09:00 /usr/local/bin/w\n  8102  8100  9.0  0.3    00:09:00 /usr/local/bin/w\n').observed.uncoordinatedHeavy, 0);
});

const PG_HEADER = '  PID  PPID  PGID %CPU %MEM     ELAPSED COMMAND\n';
const pgDecide = (table: string, load: number | null = host.loadAverage1m, probe: Record<string, unknown> = {}) => {
  const observed = classifyObservedWorkloads(parseProcessTable(PG_HEADER + table), { selfPid: 2_147_483_000, hostCpu: cpuOf(load) });
  return { observed, capacity: evaluateCapacity({ ...host, loadAverage1m: load, ...probe } as never, { activeSubstantive: 0, activeHeavy: 0, observedUncoordinatedHeavy: observed.uncoordinatedHeavy, processObservation: 'observed' }, mutate) };
};

test('24. process-group evidence separates independent jobs and supervisors but never splits one job', () => {
  const rowsWithPgid = parseProcessTable(PG_HEADER + '  9000     1  9000  1.0  0.1    01:00:00 -zsh\n');
  assert.equal(rowsWithPgid[0]!.pgid, 9000); assert.equal(rowsWithPgid[0]!.cpu, 1); assert.equal(rowsWithPgid[0]!.command, '-zsh');
  assert.equal(parseProcessTable(HEADER + '  9000     1  1.0  0.1    01:00:00 -zsh\n')[0]!.pgid, undefined);
  // Job control: each job owns a process group. Job-sized jobs count separately; sub-core jobs in different
  // groups are not summed into one job on a healthy or merely busy host; unknown/saturated CPU remains conservative.
  assert.equal(pgDecide('  9000     1  9000  1.0  0.1    01:00:00 -zsh\n  9001  9000  9001 95.0  1.0    00:03:00 /usr/local/bin/a\n  9002  9000  9002 95.0  1.0    00:03:00 /usr/local/bin/b\n', host.loadAverage1m, twoSlot).observed.uncoordinatedHeavy, 2);
  const separateSmall = '  9100     1  9100  1.0  0.1    01:00:00 -zsh\n  9101  9100  9101 50.0  1.0    00:03:00 /usr/local/bin/a\n  9102  9100  9102 50.0  1.0    00:03:00 /usr/local/bin/b\n';
  assert.equal(pgDecide(separateSmall).observed.uncoordinatedHeavy, 0);
  assert.equal(pgDecide(separateSmall, 6.5).observed.uncoordinatedHeavy, 0);
  assert.equal(pgDecide(separateSmall, null).observed.uncoordinatedHeavy, 2);
  // Without PGID evidence the same shape merges conservatively into one job-sized family.
  assert.equal(decide('  9100     1  1.0  0.1    01:00:00 -zsh\n  9101  9100 50.0  1.0    00:03:00 /usr/local/bin/a\n  9102  9100 50.0  1.0    00:03:00 /usr/local/bin/b\n').observed.uncoordinatedHeavy, 1);
  // A non-PID-1 supervisor (systemd --user style) whose services each own a session is not one job.
  const supervisor = '  1500     1  1500  0.5  0.2    05:00:00 /usr/lib/systemd/systemd --user\n' +
    [1501, 1502, 1503, 1504].map(pid => `  ${pid}  1500  ${pid} 30.0  1.0    04:00:00 /usr/libexec/service-${pid}\n`).join('');
  assert.equal(pgDecide(supervisor).observed.uncoordinatedHeavy, 0);
  // One job keeps one process group through idle intermediaries: the deep family and the worker pool count.
  const deep = DEEP_FAMILY.replace(/^(\s+(\d+)\s+(\d+))/gm, '$1  7000');
  assert.equal(pgDecide(deep).observed.uncoordinatedHeavy, 1);
  const pool = SUBTHRESHOLD.replace(/^(\s+(\d+)\s+(\d+))/gm, '$1  8000');
  assert.equal(pgDecide(pool).observed.uncoordinatedHeavy, 1);
  // A non-interactive launcher shares one group; its independent job-sized workers still count separately.
  assert.equal(pgDecide('  9200     1  9200  0.1  0.1    01:00:00 /bin/sh -c a & b\n  9201  9200  9200 95.0  1.0    00:03:00 /usr/local/bin/a\n  9202  9200  9200 95.0  1.0    00:03:00 /usr/local/bin/b\n', host.loadAverage1m, twoSlot).observed.uncoordinatedHeavy, 2);
  // App helpers in their own process groups are still one app workload.
  const app = pgDecide(`
 1300     1  1300 12.0  2.5    01:00:00 /Applications/Brave Browser.app/Contents/MacOS/Brave Browser
 1301  1300  1301 35.0  1.5    01:00:00 /Applications/Brave Browser.app/Contents/Frameworks/B.framework/Helpers/Brave Browser Helper (Renderer).app/Contents/MacOS/Brave Browser Helper (Renderer) --type=renderer
 1302  1300  1302 38.0  0.8    01:00:00 /Applications/Brave Browser.app/Contents/Frameworks/B.framework/Helpers/Brave Browser Helper (GPU).app/Contents/MacOS/Brave Browser Helper (GPU) --type=gpu-process
`).observed;
  assert.equal(app.uncoordinatedHeavy, 1); assert.deepEqual(app.uncoordinatedDetails?.[0]?.pids, [1300, 1301, 1302]);
  // The incident desktop with real per-process groups stays at zero on a healthy host.
  assert.equal(pgDecide(ORDINARY_DESKTOP.replace(/^(\s+(\d+)\s+(\d+))/gm, '$1  $2')).observed.uncoordinatedHeavy, 0);
});

test('25. recognized sessions, leases and the caller keep their accounting; nothing is counted twice', () => {
  // An idle agent whose many small tools add up is that agent's workload, labelled by the agent.
  const quietAgent = '  5400     1  0.3  2.6    01:00:00 /opt/homebrew/bin/claude\n' +
    Array.from({ length: 12 }, (_, i) => `  ${5401 + i}  5400  9.0  0.3    00:01:00 /usr/local/bin/w\n`).join('');
  const agent = decide(quietAgent).observed;
  assert.equal(agent.uncoordinatedHeavy, 1); assert.equal(agent.uncoordinatedDetails?.[0]?.processLabel, 'claude');
  // An active agent with a 95% unknown child and a busy npm is one session, never three workloads.
  const busy = decide(ACTIVE_AGENT + '  5002  5000 95.0  1.0    00:01:00 /usr/local/bin/mystery\n  5003  5000 70.0  2.0    00:01:00 npm run build\n');
  assert.equal(busy.observed.uncoordinatedHeavy, 1);
  // A compiler beside an unrelated unknown job-sized process: two workloads.
  assert.equal(decide('  700     1 60.0  1.0    00:01:00 node /p/node_modules/typescript/bin/tsc\n  1101     1 100.0 1.0    00:01:00 /usr/local/bin/mystery-build\n', host.loadAverage1m, twoSlot).observed.uncoordinatedHeavy, 2);
  // A lease on the top of a deep family covers every descendant; on an intermediary it covers only that branch.
  const at = Date.parse('2026-11-08T13:00:00Z');
  const opts = { selfPid: 2_147_483_000, observedAt: at, hostCpu: 'healthy' as const };
  assert.equal(classifyObservedWorkloads(rows(DEEP_FAMILY), { ...opts, leases: [{ pid: 7000, createdAt: '2026-11-08T12:55:00Z' }] }).uncoordinatedHeavy, 0);
  assert.equal(classifyObservedWorkloads(rows(DEEP_FAMILY), { ...opts, leases: [{ pid: 7100, createdAt: '2026-11-08T12:55:00Z' }] }).uncoordinatedHeavy, 0);
  assert.equal(classifyObservedWorkloads(rows(DEEP_FAMILY + '  7300  7000 50.0  0.5    00:08:00 /usr/local/bin/w\n'), { ...opts, leases: [{ pid: 7100, createdAt: '2026-11-08T12:55:00Z' }] }).uncoordinatedHeavy, 1);
  // A lease created before the family's start (reused PID) covers nothing.
  assert.equal(classifyObservedWorkloads(rows(DEEP_FAMILY), { ...opts, leases: [{ pid: 7000, createdAt: '2026-11-08T12:00:00Z' }] }).uncoordinatedHeavy, 1);
  // The caller's own shell is never adopted as a family root, so the caller's siblings stay separate.
  const own = classifyObservedWorkloads(rows('  9300     1  0.5  0.1    01:00:00 -zsh\n  9301  9300  0.5  0.1    00:00:01 node coordinator-client\n  9302  9300 50.0  1.0    00:03:00 /usr/local/bin/a\n  9303  9300 50.0  1.0    00:03:00 /usr/local/bin/b\n'), { selfPid: 9301, hostCpu: 'healthy' });
  assert.equal(own.uncoordinatedHeavy, 0); assert.ok(!own.uncoordinatedDetails?.some(detail => detail.pid === 9300));
});

test('26. owner-visible CPU is the summed group CPU that admission compared', () => {
  const shell = decide(SHELL_JOBS, host.loadAverage1m, twoSlot).observed.uncoordinatedDetails!;
  assert.deepEqual(shell.map(detail => [detail.pid, detail.cpu]), [[9001, 95], [9002, 95]]);
  assert.equal(decide(DEEP_FAMILY).observed.uncoordinatedDetails?.[0]?.cpu, 141);
  assert.equal(decide(SUBTHRESHOLD).observed.uncoordinatedDetails?.[0]?.cpu, 109);
  const session = decide(ACTIVE_AGENT + '  5001  5000 70.0  3.0    00:01:00 npm run verify\n').observed.uncoordinatedDetails![0]!;
  assert.equal(session.cpu, 101); assert.equal(session.mem, 3);
});

test('27. malformed ancestry terminates and stays visible; deep chains are linear', () => {
  const cycle = rows('  9400  9401 50.0  1.0    00:01:00 /usr/local/bin/a\n  9401  9400 50.0  1.0    00:01:00 /usr/local/bin/b\n  9402  9402 90.0  1.0    00:01:00 /usr/local/bin/self-parent\n');
  const observed = classifyObservedWorkloads(cycle, { selfPid: 2_147_483_000, hostCpu: 'healthy' });
  assert.deepEqual(observed.uncoordinatedDetails?.map(detail => [detail.pid, detail.cpu]), [[9400, 100], [9402, 90]]);
  const chain = Array.from({ length: 5_000 }, (_, i) => `  ${20_000 + i}  ${i ? 19_999 + i : 1}  2.0  0.1    00:01:00 /usr/local/bin/link`).join('\n') + '\n';
  const table = rows(chain);
  const started = process.hrtime.bigint();
  const deep = classifyObservedWorkloads(table, { selfPid: 2_147_483_000, hostCpu: 'healthy' });
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  console.log(`CLASSIFY_5000_CHAIN_MS=${ms.toFixed(2)}`);
  // 5,000 x 2% = 10,000% along one chain: one workload per job-sized stretch, reported once each.
  assert.equal(deep.uncoordinatedHeavy, 125);
  assert.equal(new Set(deep.uncoordinatedDetails?.flatMap(detail => detail.pids)).size, 5_000);
  assert.ok(ms < 1_000, `classification ${ms}ms`);
});

test('28. a momentarily hot launchd never becomes a workload root that swallows unrelated jobs', () => {
  const table = `
     1     0 12.0  0.1    02:00:00 /sbin/launchd
  5000     1 31.0  3.0    00:10:00 /opt/homebrew/bin/claude
   700     1 60.0  1.0    00:01:00 node /p/node_modules/typescript/bin/tsc
  1101     1 100.0 1.0    00:01:00 /usr/local/bin/mystery-build
`;
  const { observed } = decide(table, host.loadAverage1m, { physicalMemoryBytes: 64 * GIB });
  assert.deepEqual(observed.uncoordinatedDetails?.map(detail => [detail.pid, detail.processLabel]), [[700, 'tsc'], [1101, 'mystery-build'], [5000, 'claude']]);
  // The ordinary desktop under a hot launchd stays ordinary on a healthy host.
  assert.equal(decide('     1     0 12.0  0.1    02:00:00 /sbin/launchd\n' + ORDINARY_DESKTOP).observed.uncoordinatedHeavy, 0);
});

// Review finding E: a hot generic shell is not an owner. Its compiler and unrelated build are two jobs.
const HOT_SHELL_JOBS = `
  8000     1  8000 15.0  0.1    00:05:00 /bin/sh -c two-jobs
  8001  8000  8001 60.0  1.0    00:04:00 node /p/node_modules/typescript/bin/tsc
  8002  8000  8002 95.0  1.0    00:04:00 /usr/local/bin/unknown-build
`;

test('29 (E). a hot unrecognized shell never merges an independent compiler and build into one workload', () => {
  const { observed, capacity } = pgDecide(HOT_SHELL_JOBS, host.loadAverage1m, twoSlot);
  assert.equal(capacity.substantiveSlots, 2);
  assert.deepEqual(observed.uncoordinatedDetails?.map(detail => [detail.pid, detail.processLabel]), [[8001, 'tsc'], [8002, 'unknown-build']]);
  assert.equal(capacity.canAdmit, false, capacity.reasons.join('; '));
  // Identity, not PGID, justifies the separation: the same shape without PGID evidence gives the same answer.
  const noPgid = decide(HOT_SHELL_JOBS.replace(/^(\s+\d+\s+\d+)\s+\d+/gm, '$1'), host.loadAverage1m, twoSlot);
  assert.equal(noPgid.observed.uncoordinatedHeavy, 2);
  assert.equal(noPgid.capacity.canAdmit, false);
});

test('30. recognized owners keep their trees across hot intermediaries; hot generic parents own nothing', () => {
  const big = { physicalMemoryBytes: 64 * GIB };
  const labels = (table: string, probe: Record<string, unknown> = big) => pgDecide(table, host.loadAverage1m, probe).observed.uncoordinatedDetails?.map(detail => [detail.pid, detail.processLabel, detail.pids]);
  // An agent owns its subprocess tree through a hot shell in another process group: one session.
  assert.deepEqual(labels(`
  5500     1  5500 31.0  3.0    00:10:00 /opt/homebrew/bin/claude
  5501  5500  5501 15.0  0.1    00:01:00 /bin/zsh -c npm-and-build
  5502  5501  5502 60.0  1.0    00:01:00 node /p/node_modules/typescript/bin/tsc
  5503  5501  5503 95.0  1.0    00:01:00 /usr/local/bin/unknown-build
`), [[5500, 'claude', [5500, 5501, 5502, 5503]]]);
  // Two agents under one hot shell are two sessions; two compilers under one hot shell are two jobs.
  assert.equal(labels('  5600     1  5600 15.0  0.1    01:00:00 -zsh\n  5601  5600  5601 30.0  3.0    00:10:00 /opt/homebrew/bin/claude\n  5602  5600  5602 30.0  3.0    00:10:00 /opt/homebrew/bin/codex exec\n')?.length, 2);
  assert.equal(labels('  5700     1  5700 15.0  0.1    01:00:00 -zsh\n  5701  5700  5701 60.0  1.0    00:01:00 node /a/node_modules/typescript/bin/tsc\n  5702  5700  5702 60.0  1.0    00:01:00 node /b/node_modules/typescript/bin/tsc\n')?.length, 2);
  // A recognized build tool owns compilers it runs through a hot wrapper shell: one build.
  assert.deepEqual(labels('  5800     1  5800 20.0  1.0    00:02:00 npm run build\n  5801  5800  5800 15.0  0.1    00:02:00 /bin/sh -c tsc\n  5802  5801  5800 60.0  1.0    00:02:00 node /p/node_modules/typescript/bin/tsc\n'), [[5800, 'npm', [5800, 5801, 5802]]]);
  // A hot shell with only unknown job-sized children keeps the A result.
  assert.equal(labels('  5900     1  5900 15.0  0.1    01:00:00 -zsh\n  5901  5900  5901 95.0  1.0    00:03:00 /usr/local/bin/a\n  5902  5900  5902 95.0  1.0    00:03:00 /usr/local/bin/b\n')?.length, 2);
  // The Codex desktop app: the agent owns its tools; the app's own demanding renderer is a separate workload.
  const chatgpt = labels(`
  2847     1  2847  6.5  2.6    01:00:00 /Applications/ChatGPT.app/Contents/MacOS/ChatGPT
  2969  2847  2847 61.4  2.1    01:00:00 /Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex app-server
  7460  2969  7460 36.9  0.4    00:00:01 /opt/homebrew/bin/python3 /tmp/plugin.py
  3045  2847  2847 81.6  4.3    01:00:00 /Applications/ChatGPT.app/Contents/Frameworks/Codex Framework.framework/Helpers/Codex (Renderer).app/Contents/MacOS/Codex (Renderer) --type=renderer
`);
  assert.deepEqual(chatgpt, [[2847, 'ChatGPT', [2847, 3045]], [2969, 'codex', [2969, 7460]]]);
  // A lease on the agent covers its whole tree, hot shell included; the caller's own hot shell owns nothing.
  const at = Date.parse('2026-11-08T13:00:00Z');
  const tree = parseProcessTable(PG_HEADER + '  5500     1  5500 31.0  3.0    00:10:00 /opt/homebrew/bin/claude\n  5501  5500  5501 15.0  0.1    00:01:00 /bin/zsh -c x\n  5502  5501  5502 60.0  1.0    00:01:00 node /p/node_modules/typescript/bin/tsc\n');
  assert.equal(classifyObservedWorkloads(tree, { selfPid: 2_147_483_000, observedAt: at, hostCpu: 'healthy', leases: [{ pid: 5500, createdAt: '2026-11-08T12:55:00Z' }] }).uncoordinatedHeavy, 0);
  const caller = parseProcessTable(PG_HEADER + '  6600     1  6600 15.0  0.1    01:00:00 -zsh\n  6601  6600  6601  0.5  0.1    00:00:01 node coordinator-client\n  6602  6600  6602 60.0  1.0    00:01:00 node /p/node_modules/typescript/bin/tsc\n  6603  6600  6603 95.0  1.0    00:01:00 /usr/local/bin/unknown-build\n');
  const seen = classifyObservedWorkloads(caller, { selfPid: 6601, hostCpu: 'healthy' });
  assert.deepEqual(seen.uncoordinatedDetails?.map(detail => detail.pid), [6602, 6603]);
});

test('29. hot generic ancestor cannot merge independent compiler and unknown job', () => {
  const independent = `
  8000     1  8000 15.0  0.4    00:08:00 /bin/sh -c two-jobs
  8001  8000  8001 60.0  1.0    00:03:00 node /p/node_modules/typescript/bin/tsc
  8002  8000  8002 95.0  1.0    00:03:00 /usr/local/bin/unknown-build
`;
  const { observed, capacity } = pgDecide(independent, host.loadAverage1m, { physicalMemoryBytes: 16 * GIB });
  assert.equal(capacity.substantiveSlots, 2);
  assert.equal(observed.uncoordinatedHeavy, 2, JSON.stringify(observed.uncoordinatedDetails));
  assert.deepEqual(observed.uncoordinatedDetails?.map(d => d.pid).sort((a, b) => a - b), [8001, 8002]);
  assert.equal(capacity.canAdmit, false, capacity.reasons.join('; '));
  assert.match(capacity.reasons.join('; '), /substantive slots exhausted/);
});
