import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyCpuPressure,
  classifyObservedWorkloads,
  cpuSubstantiveSlots,
  evaluateCapacity,
  heavySlotsFor,
  isDexServiceCommand,
  isSubstantive,
  parseDarwinMemoryPressure,
  parseDarwinPressureLevel,
  parseDarwinSwapUsage,
  parseDarwinThermal,
  parseLinuxMemInfo,
  parseLinuxMemoryPsi,
  collectExcludedPids,
  parseProcessTable,
  probeHost,
  substantiveSlotsFor,
  substantiveSlotsForProfile
} from '../src/shared/machine-capacity.js';

const GIB = 1024 ** 3;
const healthy = { memory: 'healthy' as const, thermal: 'healthy' as const };
const idle = { activeSubstantive: 0, activeHeavy: 0, observedUncoordinatedHeavy: 0 };

test('memory tiers produce the documented substantive and heavy ceilings', () => {
  // A machine at or under 12 GiB runs exactly one substantive job, whatever its core count.
  assert.equal(substantiveSlotsFor(8 * GIB, 32), 1);
  assert.equal(substantiveSlotsFor(12 * GIB, 32), 1);
  assert.equal(heavySlotsFor(12 * GIB, 32), 1);

  assert.equal(substantiveSlotsFor(16 * GIB, 32), 2);
  assert.equal(substantiveSlotsFor(24 * GIB, 32), 2);
  assert.equal(heavySlotsFor(24 * GIB, 32), 1);

  assert.equal(substantiveSlotsFor(32 * GIB, 32), 3);
  assert.equal(heavySlotsFor(48 * GIB, 32), 2);

  assert.equal(substantiveSlotsFor(64 * GIB, 32), 4);
  assert.equal(heavySlotsFor(64 * GIB, 32), 2);

  // Nonsense hardware readings fall back to the most conservative ceiling rather than a guess.
  assert.equal(substantiveSlotsFor(0, 0), 1);
  assert.equal(substantiveSlotsFor(Number.NaN, Number.NaN), 1);
});

test('the CPU-derived ceiling wins when it is smaller than the memory-derived one', () => {
  assert.equal(cpuSubstantiveSlots(4), 1);
  assert.equal(cpuSubstantiveSlots(10), 2);
  // 64 GiB would allow 4 substantive jobs, but 4 logical CPUs allow only 1.
  assert.equal(substantiveSlotsFor(64 * GIB, 4), 1);
  assert.equal(heavySlotsFor(64 * GIB, 4), 1);
});

test('interactive capacity expands only after its sustained-health gate is ready', () => {
  assert.equal(substantiveSlotsForProfile(8 * GIB, 8, 'interactive', false), 1);
  assert.equal(substantiveSlotsForProfile(8 * GIB, 8, 'interactive', true), 2);
  assert.equal(substantiveSlotsForProfile(8 * GIB, 2, 'interactive', true), 1);
  assert.equal(substantiveSlotsForProfile(8 * GIB, 8, 'conservative', true), 1);
});

test('CPU pressure thresholds follow load average against logical CPUs', () => {
  assert.equal(classifyCpuPressure(1.0, 8), 'healthy');
  assert.equal(classifyCpuPressure(6.0, 8), 'busy');
  assert.equal(classifyCpuPressure(8.0, 8), 'saturated');
  assert.equal(classifyCpuPressure(12.0, 8), 'saturated');
  assert.equal(classifyCpuPressure(null, 8), 'unknown');
});

test('light read-only inspection never consumes a substantive slot', () => {
  assert.equal(isSubstantive('light', 'read'), false);
  assert.equal(isSubstantive('light', 'mutate'), true);
  assert.equal(isSubstantive('medium', 'read'), true);

  const busy = evaluateCapacity(
    { physicalMemoryBytes: 8 * GIB, logicalCpuCount: 8, loadAverage1m: 0.2, ...healthy },
    { activeSubstantive: 1, activeHeavy: 1, observedUncoordinatedHeavy: 0 },
    { workload: 'light', access: 'read' }
  );
  assert.equal(busy.canAdmit, true);
});

test('live pressure overrides otherwise-available static capacity for heavy work', () => {
  const base = { physicalMemoryBytes: 64 * GIB, logicalCpuCount: 16, loadAverage1m: 1 };
  const heavy = { workload: 'heavy' as const, access: 'mutate' as const };

  assert.equal(evaluateCapacity({ ...base, ...healthy }, idle, heavy).canAdmit, true);

  const criticalMemory = evaluateCapacity({ ...base, memory: 'critical', thermal: 'healthy' }, idle, heavy);
  assert.equal(criticalMemory.canAdmit, false);
  assert.match(criticalMemory.reasons.join(' '), /memory pressure critical/);

  const warned = evaluateCapacity({ ...base, memory: 'warning', thermal: 'healthy' }, idle, heavy);
  assert.equal(warned.canAdmit, false);

  const throttled = evaluateCapacity({ ...base, memory: 'healthy', thermal: 'limited' }, idle, heavy);
  assert.equal(throttled.canAdmit, false);
  assert.match(throttled.reasons.join(' '), /thermal/);

  const saturated = evaluateCapacity({ ...base, loadAverage1m: 20, ...healthy }, idle, heavy);
  assert.equal(saturated.canAdmit, false);
  assert.match(saturated.reasons.join(' '), /CPU saturated/);

  // Unknown pressure must be conservative for heavy work, never optimistic.
  const unknown = evaluateCapacity({ ...base, memory: 'unknown', thermal: 'unknown' }, idle, heavy);
  assert.equal(unknown.canAdmit, false);
  assert.match(unknown.reasons.join(' '), /unknown/);

  // A medium job is still admissible when only the heavy-specific signals are unknown.
  assert.equal(evaluateCapacity({ ...base, memory: 'healthy', thermal: 'unknown' }, idle, { workload: 'medium', access: 'mutate' }).canAdmit, true);
});

test('an observed anonymous heavy workload reduces admission capacity', () => {
  const probe = { physicalMemoryBytes: 16 * GIB, logicalCpuCount: 8, loadAverage1m: 0.5, ...healthy };
  const request = { workload: 'medium' as const, access: 'mutate' as const };

  assert.equal(evaluateCapacity(probe, idle, request).canAdmit, true);
  // 16 GiB gives 2 substantive slots; one coordinated job plus one anonymous heavy job fills them.
  const crowded = evaluateCapacity(probe, { activeSubstantive: 1, activeHeavy: 0, observedUncoordinatedHeavy: 1 }, request);
  assert.equal(crowded.canAdmit, false);
  assert.match(crowded.reasons.join(' '), /uncoordinated heavy workload/);
});

test('macOS probe output parses into pressure levels', () => {
  assert.equal(parseDarwinPressureLevel('1\n'), 'healthy');
  assert.equal(parseDarwinPressureLevel('2\n'), 'warning');
  assert.equal(parseDarwinPressureLevel('4\n'), 'critical');
  assert.equal(parseDarwinPressureLevel('sysctl: unknown oid\n'), 'unknown');

  assert.equal(parseDarwinMemoryPressure('System-wide memory free percentage: 62%\n'), 'healthy');
  assert.equal(parseDarwinMemoryPressure('System-wide memory free percentage: 14%\n'), 'warning');
  assert.equal(parseDarwinMemoryPressure('System-wide memory free percentage: 3%\n'), 'critical');
  assert.equal(parseDarwinMemoryPressure('command not found\n'), 'unknown');

  assert.equal(parseDarwinSwapUsage('total = 2048.00M  used = 512.00M  free = 1536.00M  (encrypted)\n'), 512 * 1024 ** 2);
  assert.equal(parseDarwinSwapUsage('nothing here'), null);

  assert.equal(parseDarwinThermal('CPU_Power_Limit \t= 100\nCPU_Speed_Limit \t= 100\n'), 'healthy');
  assert.equal(parseDarwinThermal('CPU_Speed_Limit \t= 62\n'), 'limited');
  assert.equal(parseDarwinThermal('No thermal warning level has been recorded\n'), 'unknown');
});

test('Linux probe output parses into pressure levels', () => {
  assert.equal(parseLinuxMemoryPsi('some avg10=0.00 avg60=0.00 avg300=0.00 total=0\nfull avg10=0.00\n'), 'healthy');
  assert.equal(parseLinuxMemoryPsi('some avg10=8.42 avg60=3.10 avg300=1.00 total=12\n'), 'warning');
  assert.equal(parseLinuxMemoryPsi('some avg10=44.10 avg60=30.00 avg300=9.00 total=99\n'), 'critical');
  assert.equal(parseLinuxMemoryPsi(''), 'unknown');

  const meminfo = 'MemTotal:       16000000 kB\nMemAvailable:    1200000 kB\nSwapTotal:       2000000 kB\nSwapFree:        1500000 kB\n';
  const parsed = parseLinuxMemInfo(meminfo);
  assert.equal(parsed.memory, 'critical');
  assert.equal(parsed.swapUsedBytes, 500000 * 1024);
  assert.equal(parseLinuxMemInfo('garbage').memory, 'unknown');
});

const PS_FIXTURE = `  PID  PPID %CPU %MEM     ELAPSED COMMAND
  101     1 92.4  8.1    01:20:11 node /opt/homebrew/bin/tsc -p tsconfig.json
  102     1  0.0  0.1    12:00:00 node /Users/owner/DEX-REACH/dist/src/gateway/main.js
  103     1  0.1  0.3 3-12:00:00 node /Users/owner/DEX-REACH/dist/src/node/main.js
  108     1  0.0  0.1 3-12:00:00 node /Users/owner/DEX-REACH/dist/src/coordinator/main.js
  109     1  0.0  0.1 3-12:00:00 node /Users/owner/DEX-REACH/dist/src/worker/main.js
  104     1 74.0 12.0    00:05:00 claude --dangerously-skip-permissions
  105   104 30.0  4.0    00:04:00 npm run verify
  106     1  0.0  0.0    00:00:02 npm ls
  107     1  1.2  0.2    09:00:00 /Applications/Safari.app/Contents/MacOS/Safari
`;

test('process observation separates DEX services from anonymous heavy jobs', () => {
  const rows = parseProcessTable(PS_FIXTURE);
  assert.equal(rows.length, 9);
  assert.equal(rows[0]!.pid, 101);
  assert.equal(rows[0]!.command, 'node /opt/homebrew/bin/tsc -p tsconfig.json');

  const observed = classifyObservedWorkloads(rows, { selfPid: 999 });
  // Persistent coordinator/worker/gateway/node services are services, not competing coding jobs.
  assert.equal(observed.dexServices, 4);
  // tsc is one job; the Claude session and its npm child are one process tree; idle npm/Safari are not.
  assert.equal(observed.uncoordinatedHeavy, 2);
  assert.deepEqual(observed.uncoordinatedDetails?.map(item => item.pids), [[101], [104, 105]]);

  assert.equal(isDexServiceCommand('node /Users/owner/DEX-REACH/dist/src/node/main.js'), true);
  assert.equal(isDexServiceCommand('node /Users/owner/DEX-REACH/dist/src/coordinator/main.js'), true);
  assert.equal(isDexServiceCommand('node /Users/owner/DEX-REACH/dist/src/worker/main.js'), true);
  assert.equal(isDexServiceCommand('node /opt/homebrew/bin/tsc'), false);
  // The owner control CLI is a short-lived command, not a persistent service.
  assert.equal(isDexServiceCommand('node /Users/owner/DEX-REACH/dist/scripts/dex-reach.js work-status'), false);
});

test('desktop application helper processes do not consume an anonymous coding-work slot', () => {
  const rows = parseProcessTable(`  PID  PPID %CPU %MEM     ELAPSED COMMAND
  601     1 185.2  5.5    00:08:00 /Applications/ChatGPT.app/Contents/Frameworks/Codex\ (Renderer).app/Contents/MacOS/Codex\ (Renderer) --type=renderer --standard-schemes=app,codex-sandbox --user-data-dir=/private/var/folders/dex
  602     1  22.0  2.1    00:02:00 /opt/homebrew/bin/claude --print "inspect repository"
`);

  const observed = classifyObservedWorkloads(rows, { selfPid: 999 });
  // Electron/Chromium renderer helpers inherit application names such as "Codex", but are not
  // independent coding sessions. A real CLI session remains a competing workload.
  assert.equal(observed.uncoordinatedHeavy, 1);
  assert.equal(
    evaluateCapacity(
      { physicalMemoryBytes: 8 * GIB, logicalCpuCount: 8, loadAverage1m: 0.5, ...healthy },
      { activeSubstantive: 0, activeHeavy: 0, observedUncoordinatedHeavy: observed.uncoordinatedHeavy },
      { workload: 'medium', access: 'mutate' }
    ).canAdmit,
    false
  );
});

test('processes belonging to a known lease are not double-counted as anonymous', () => {
  const rows = parseProcessTable(PS_FIXTURE);
  // Leasing pid 104 also covers its npm child at 105.
  const observed = classifyObservedWorkloads(rows, { selfPid: 999, leasedPids: [104] });
  assert.equal(observed.uncoordinatedHeavy, 1);
});

test('the calling process tree is not counted as a competing workload', () => {
  const rows = parseProcessTable(`  PID  PPID %CPU %MEM     ELAPSED COMMAND
  200     1  0.1  0.1    01:00:00 -zsh
  201   200  5.0  1.0    00:10:00 claude
  202   201 80.0  9.0    00:02:00 npm run verify
  203   202 70.0  8.0    00:01:00 node /opt/tsc
  300     1 90.0 10.0    00:30:00 claude
  301   300 88.0  9.0    00:20:00 npm run build
`);

  // Called from the npm process: its shell ancestors, its sibling-free chain and its child are all
  // this session. The other agent's tree at 300 is exactly what the coordinator must still see.
  const excluded = collectExcludedPids(rows, { selfPid: 202 });
  assert.deepEqual([...excluded].sort((a, b) => a - b), [200, 201, 202, 203]);

  const observed = classifyObservedWorkloads(rows, { selfPid: 202 });
  assert.equal(observed.uncoordinatedHeavy, 1);

  // A coordinated lease on the other agent's root covers its children too.
  assert.equal(classifyObservedWorkloads(rows, { selfPid: 202, leasedPids: [300] }).uncoordinatedHeavy, 0);
});

test('the host probe reports this machine without inventing values', async () => {
  const probe = await probeHost();
  assert.equal(probe.platform, process.platform);
  assert.ok(probe.physicalMemoryBytes > 0);
  assert.ok(probe.logicalCpuCount >= 1);
  assert.ok(['healthy', 'warning', 'critical', 'unknown'].includes(probe.memory));
  assert.ok(['healthy', 'limited', 'unknown'].includes(probe.thermal));
  assert.ok(probe.loadAverage1m === null || probe.loadAverage1m >= 0);
});
