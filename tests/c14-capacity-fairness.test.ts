import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyObservedWorkloads, evaluateCapacity, parseProcessTable, processWorkloadIdentity, type ProcessRow } from '../src/shared/machine-capacity.js';

// MacBook tier fixed by the existing slot policy: 8 GiB, 8 logical CPUs -> one substantive slot.
const GIB = 1024 ** 3;
const host = { physicalMemoryBytes: 8 * GIB, logicalCpuCount: 8, loadAverage1m: 0.6, memory: 'healthy' as const, thermal: 'healthy' as const };
const HEADER = '  PID  PPID %CPU %MEM     ELAPSED COMMAND\n';
const rows = (table: string) => parseProcessTable(HEADER + table);
const admit = (table: string, counts: { activeSubstantive?: number; activeHeavy?: number } = {}, probe: Partial<typeof host> & Record<string, unknown> = {}, workload: 'medium' | 'heavy' = 'medium') => {
  const observed = classifyObservedWorkloads(rows(table), { selfPid: 999 });
  return { observed, capacity: evaluateCapacity({ ...host, ...probe } as never, { activeSubstantive: counts.activeSubstantive ?? 0, activeHeavy: counts.activeHeavy ?? 0, observedUncoordinatedHeavy: observed.uncoordinatedHeavy, processObservation: 'observed' }, { workload, access: 'mutate' }) };
};
// Shapes taken from the owner's host process table, with the home directory replaced.
const DESKTOP = `
  500     1  4.4  1.4    02:00:00 /Applications/Claude.app/Contents/MacOS/Claude
  501   500  1.8  1.2    02:00:00 /Applications/Claude.app/Contents/Frameworks/Claude Helper.app/Contents/MacOS/Claude Helper --type=gpu-process
  502   500  0.3  4.2    02:00:00 /Applications/Claude.app/Contents/Frameworks/Claude Helper (Renderer).app/Contents/MacOS/Claude Helper (Renderer) --type=renderer
  503   500  0.4  0.4    02:00:00 /Applications/Claude.app/Contents/Frameworks/Claude Helper.app/Contents/MacOS/Claude Helper --type=utility
  504   500  0.0  0.0    01:00:00 /Applications/Claude.app/Contents/Helpers/disclaimer -- /opt/homebrew/bin/npm run dev --prefix /Users/owner/project
  505   500  0.0  0.0    01:00:00 /Applications/Claude.app/Contents/Helpers/disclaimer --pgroup -- /Users/owner/Library/Application Support/Claude/claude-code/2.1.293/8433d0d9cd0d/claude.app/Contents/MacOS/claude
`;
const IDLE_AGENT = `
  506   505  0.4  2.6    01:00:00 /Users/owner/Library/Application Support/Claude/claude-code/2.1.293/8433d0d9cd0d/claude.app/Contents/MacOS/claude --output-format stream-json --secret-flag private-value
`;
const ACTIVE_AGENT = `
  506   505 31.0  3.0    01:00:00 /Users/owner/Library/Application Support/Claude/claude-code/2.1.293/8433d0d9cd0d/claude.app/Contents/MacOS/claude --output-format stream-json
`;

test('1. idle desktop app and an idle resident agent session no longer consume the only slot', () => {
  const { observed, capacity } = admit(DESKTOP + IDLE_AGENT);
  assert.equal(observed.uncoordinatedHeavy, 0); assert.equal(capacity.canAdmit, true, capacity.reasons.join('; '));
});
test('2. an active agent session and genuine compilers/tests still compete for the slot', () => {
  for (const table of [ACTIVE_AGENT, '  700     1 60.0  1.0    00:01:00 node /Users/owner/p/node_modules/typescript/bin/tsc -p tsconfig.json\n',
    '  701     1 85.0  1.5    00:02:00 node --test --import tsx tests/a.test.ts tests/b.test.ts\n', '  702     1  3.0  6.0    00:02:00 /opt/homebrew/bin/cargo build --release\n',
    '  703     1 40.0  0.5    00:00:30 python3 -m pytest -q\n', '  704     1 22.0  2.1    00:02:00 /opt/homebrew/bin/claude --print "inspect repository"\n']) {
    const { observed, capacity } = admit(DESKTOP + table);
    assert.equal(observed.uncoordinatedHeavy, 1, table); assert.equal(capacity.canAdmit, false);
  }
});
test('3. an existing coordinated lease still blocks a second conflicting lease', () => {
  assert.equal(admit(DESKTOP + IDLE_AGENT, { activeSubstantive: 1 }).capacity.canAdmit, false);
});
test('4. critical memory pressure refuses new work even with the slot free', () => {
  const { capacity } = admit(DESKTOP + IDLE_AGENT, {}, { memory: 'critical' } as never);
  assert.equal(capacity.canAdmit, false); assert.ok(capacity.reasons.includes('memory pressure critical'));
  assert.equal(admit(DESKTOP + IDLE_AGENT, {}, { thermal: 'limited' } as never, 'heavy').capacity.canAdmit, false);
  assert.equal(admit(DESKTOP + IDLE_AGENT, {}, { loadAverage1m: 9 } as never, 'heavy').capacity.canAdmit, false);
});
test('5. unknown required pressure and an unavailable process table stay conservative', () => {
  assert.equal(admit(DESKTOP, {}, { memory: 'unknown' } as never, 'heavy').capacity.canAdmit, false);
  const blind = evaluateCapacity(host, { activeSubstantive: 0, activeHeavy: 0, observedUncoordinatedHeavy: 0, processObservation: 'unknown' }, { workload: 'medium', access: 'mutate' });
  assert.equal(blind.canAdmit, false); assert.match(blind.reasons.join(';'), /process observation unavailable/);
  // Light read-only inspection is unaffected: it never consumed a substantive slot.
  assert.equal(evaluateCapacity(host, { activeSubstantive: 0, activeHeavy: 0, observedUncoordinatedHeavy: 0, processObservation: 'unknown' }, { workload: 'light', access: 'read' }).canAdmit, true);
});
test('6. a process that exits before observation is simply absent; a failed observation is not proof of capacity', async () => {
  const { observeWorkloadsResult } = await import('../src/shared/machine-capacity.js');
  const failed = await observeWorkloadsResult({ rows: null });
  assert.equal(failed.processObservation, 'unknown'); assert.equal(failed.uncoordinatedHeavy, 0);
  const seen = await observeWorkloadsResult({ rows: rows(DESKTOP) });
  assert.equal(seen.processObservation, 'observed');
});
test('7. a reused PID does not inherit a lease: identity requires a start time no later than the lease', () => {
  const observedAt = Date.parse('2026-10-10T13:00:00Z');
  const table = rows('  800     1 70.0  4.0    00:00:20 npm run build\n'); // started 20 s before observation
  const leasedLongAgo = { pid: 800, createdAt: '2026-10-10T12:00:00Z' }, leasedJustNow = { pid: 800, createdAt: '2026-10-10T12:59:50Z' };
  // The lease predates this process: the PID was reused by an unrelated job, which must still count.
  assert.equal(classifyObservedWorkloads(table, { selfPid: 999, leases: [leasedLongAgo], observedAt }).uncoordinatedHeavy, 1);
  assert.equal(classifyObservedWorkloads(table, { selfPid: 999, leases: [leasedJustNow], observedAt }).uncoordinatedHeavy, 0);
  // Missing start time is insufficient identity: no exclusion.
  const noElapsed = [{ ...table[0]!, elapsedSeconds: undefined }] as ProcessRow[];
  assert.equal(classifyObservedWorkloads(noElapsed, { selfPid: 999, leases: [leasedJustNow], observedAt }).uncoordinatedHeavy, 1);
});
test('8. one session with several busy helpers and tools consumes one slot, not several', () => {
  const { observed } = admit(DESKTOP + ACTIVE_AGENT + `
  900   506 70.0  3.0    00:01:00 npm run verify
  901   900 90.0  4.0    00:00:50 node --test tests/x.test.ts
  902   506 40.0  2.5    00:00:40 node /p/node_modules/typescript/bin/tsc --noEmit
`);
  assert.equal(observed.uncoordinatedHeavy, 1);
  assert.deepEqual(observed.uncoordinatedDetails?.[0]?.pids, [506, 900, 901, 902]);
  // An idle session whose tools are busy is still one workload, rooted at the session.
  const idleRoot = admit(DESKTOP + IDLE_AGENT + '  903   506 70.0  3.0    00:01:00 npm run verify\n');
  assert.equal(idleRoot.observed.uncoordinatedHeavy, 1);
});
test('9. multiple independent active coding sessions retain proper competition', () => {
  const { observed } = admit(`
  1000     1 25.0  3.0    00:10:00 /opt/homebrew/bin/claude
  1001     1 30.0  3.0    00:10:00 /opt/homebrew/bin/codex exec
  1002     1  0.2  2.8    00:10:00 /opt/homebrew/bin/claude
`);
  assert.equal(observed.uncoordinatedHeavy, 2);
});
test('10. identity comes from the executable, never from misleading arguments', () => {
  assert.equal(processWorkloadIdentity('/Applications/Claude.app/Contents/Helpers/disclaimer -- /opt/homebrew/bin/npm run dev'), null);
  assert.equal(processWorkloadIdentity('/usr/bin/python3 /tmp/x.py --name claude --tool tsc'), null);
  assert.equal(processWorkloadIdentity('bash -c "npm run build && claude"'), null);
  assert.equal(processWorkloadIdentity('/Users/o/claude-501/scratch/run.sh'), null);
  assert.equal(processWorkloadIdentity('/Applications/Claude.app/Contents/MacOS/Claude'), null);
  assert.deepEqual(processWorkloadIdentity('/Users/o/Library/Application Support/Claude/claude-code/2.1/abc/claude.app/Contents/MacOS/claude --x'), { name: 'claude', kind: 'agent' });
  assert.deepEqual(processWorkloadIdentity('node --import tsx --test tests/a.ts'), { name: 'node-test', kind: 'tool' });
  assert.deepEqual(processWorkloadIdentity('node /opt/homebrew/lib/node_modules/npm/bin/npm-cli.js run build'), { name: 'npm', kind: 'tool' });
  assert.deepEqual(processWorkloadIdentity('/opt/homebrew/bin/npm run verify'), { name: 'npm', kind: 'tool' });
  assert.deepEqual(processWorkloadIdentity('python3 -m pytest'), { name: 'pytest', kind: 'tool' });
  // Unknown busy processes remain anonymous competitors; misleading arguments cannot exempt them.
  assert.equal(admit('  1100     1 95.0  5.0    00:01:00 /usr/bin/python3 /tmp/x.py --name claude --tool tsc\n').observed.uncoordinatedHeavy, 1);
});
test('shared status labels carry the bounded executable identity, never arguments or private paths', () => {
  const { observed } = admit(ACTIVE_AGENT);
  const detail = JSON.stringify(observed.uncoordinatedDetails);
  assert.match(detail, /"processLabel":"claude"/);
  for (const secret of ['owner', 'Application Support', 'stream-json', '8433d0d9cd0d']) assert.ok(!detail.includes(secret), secret);
});
test('classification is deterministic and bounded for large tables', () => {
  const big = Array.from({ length: 2_000 }, (_, i) => `  ${3000 + i}     1 ${i % 7 === 0 ? '30.0' : '0.1'}  0.5    00:01:00 ${i % 3 === 0 ? 'node --test t.ts' : '/usr/bin/top'}`).join('\n') + '\n';
  const a = admit(big).observed, b = admit(big).observed;
  assert.deepEqual(a, b);
  const t = process.hrtime.bigint(); for (let i = 0; i < 20; i++) classifyObservedWorkloads(rows(big), { selfPid: 999 });
  const ms = Number(process.hrtime.bigint() - t) / 1e6 / 20;
  console.log(`CLASSIFY_2000_ROWS_MS=${ms.toFixed(2)}`);
  assert.ok(ms < 250, `classification ${ms}ms`);
});
