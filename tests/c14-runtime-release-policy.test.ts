import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { expandedFixture } from './helpers/recovery-fixture.js';
import { captureHarness } from './helpers/capture-harness.js';
import { inspectCoverage, type Manifest } from '../scripts/lib/recovery-coverage.js';
import { retainedRuntimeReleases } from '../scripts/lib/recovery-exclusions.js';

const CURRENT = 'synthetic-retained', PREVIOUS = 'synthetic-previous', SUPERSEDED_A = 'synthetic-superseded-a', SUPERSEDED_B = 'synthetic-superseded-b';
const OPT = { runtimeReleases: 'current-and-rollback' } as const;
const RULE = 'superseded-runtime-release', REASON = 'superseded runtime release excluded by policy';

/**
 * Expanded fixture (current release, five LaunchAgents pointing at it) plus a rollback target, two superseded releases,
 * and the installer's rollback snapshot that names current -> previous. Superseded releases carry an internal dependency
 * link so the exclusion's link accounting is exercised; retained releases carry no links.
 */
async function setup() {
  const w = await expandedFixture(), runtime = path.join(w.source.state, 'runtime');
  const write = async (relative: string, data: string) => { const f = path.join(runtime, relative); await fs.mkdir(path.dirname(f), { recursive: true, mode: 0o700 }); await fs.writeFile(f, data, { mode: 0o600 }); return Buffer.byteLength(data); };
  const pkg = JSON.stringify({ version: '0.3.1' });
  const bytes = { a: 0, b: 0 };
  for (const [id, key] of [[PREVIOUS, null], [SUPERSEDED_A, 'a'], [SUPERSEDED_B, 'b']] as const) {
    let total = await write(`releases/${id}/package.json`, pkg);
    if (id === PREVIOUS) { await write(`releases/${id}/dist/src/main.js`, 'retained-previous();\n'); continue; }
    total += await write(`releases/${id}/dist/src/main.js`, 'x'.repeat(300));
    total += await write(`releases/${id}/node_modules/dep/index.js`, 'module.exports = 1;\n');
    await fs.symlink('index.js', path.join(runtime, `releases/${id}/node_modules/dep/alias.js`));
    bytes[key!] = total;
  }
  const snapshot = (candidate: string, previous: string) => JSON.stringify({ schemaVersion: 1, candidateReleaseId: candidate, previousReleaseId: previous, candidateReleaseSha256: 'a'.repeat(64), previousReleaseSha256: 'b'.repeat(64), services: [] });
  await write(`rollback/${CURRENT}/snapshot.json`, snapshot(CURRENT, PREVIOUS));
  return { w, runtime, bytes, state: w.source.state, agents: w.source.agents, harness: await captureHarness(w) };
}

const rule = (m: Manifest, id: string) => m.exclusions.find(x => x.rule === RULE && x.relative === `runtime/releases/${id}`);

test('default off: every runtime release is included and nothing is recorded as excluded', async () => {
  const s = await setup(); try {
    for (const m of [await inspectCoverage(s.w.source, 'synthetic'), await inspectCoverage(s.w.source, 'synthetic', undefined, { runtimeReleases: 'all' })]) {
      assert.deepEqual(m.exclusions, []);
      assert.deepEqual(m.problems, []);
      assert.equal(m.exclusionPolicy.runtimeReleases, 'all');
      assert.deepEqual(m.exclusionPolicy.retainedRuntimeReleases, []);
      assert.ok(m.entries.some(e => e.relative === `runtime/releases/${SUPERSEDED_A}/package.json`), 'superseded release present by default');
      assert.equal(m.families.find(f => f.id === 'runtime')?.status, 'INCLUDED');
    }
  } finally { await s.w.cleanup(); }
});

test('current-and-rollback keeps the LaunchAgent release and the single rollback target, and records the rest with sizes', async () => {
  const s = await setup(); try {
    assert.deepEqual(await retainedRuntimeReleases({ state: s.state, agents: s.agents }), [PREVIOUS, CURRENT].sort());
    const m = await inspectCoverage(s.w.source, 'synthetic', undefined, OPT);
    assert.deepEqual(m.problems, [], 'the superseded link is excluded with its release, so it is not refused');
    assert.deepEqual(m.exclusionPolicy, { version: 1, ownerPolicy: false, runtimeReleases: 'current-and-rollback', retainedRuntimeReleases: [PREVIOUS, CURRENT].sort() });
    assert.deepEqual(m.exclusions.map(x => x.relative), [`runtime/releases/${SUPERSEDED_A}`, `runtime/releases/${SUPERSEDED_B}`]);
    const a = rule(m, SUPERSEDED_A)!;
    assert.equal(a.reason, REASON);
    assert.equal(a.files, 3); assert.equal(a.links, 1); assert.equal(a.bytes, s.bytes.a);
    assert.equal(rule(m, SUPERSEDED_B)!.bytes, s.bytes.b);
    for (const id of [CURRENT, PREVIOUS]) assert.ok(m.entries.some(e => e.relative === `runtime/releases/${id}/package.json`), `${id} retained`);
    assert.ok(!m.entries.some(e => e.relative.startsWith(`runtime/releases/${SUPERSEDED_A}/`)), 'excluded bytes are absent from entries');
    assert.equal(m.families.find(f => f.id === 'runtime')?.status, 'PARTIALLY_EXCLUDED_BY_POLICY');
  } finally { await s.w.cleanup(); }
});

test('a historical rollback record for another candidate does not change the single target', async () => {
  const s = await setup(); try {
    const other = path.join(s.runtime, 'rollback', SUPERSEDED_A);
    await fs.mkdir(other, { recursive: true, mode: 0o700 });
    await fs.writeFile(path.join(other, 'snapshot.json'), JSON.stringify({ schemaVersion: 1, candidateReleaseId: SUPERSEDED_A, previousReleaseId: SUPERSEDED_B }), { mode: 0o600 });
    assert.deepEqual(await retainedRuntimeReleases({ state: s.state, agents: s.agents }), [PREVIOUS, CURRENT].sort());
  } finally { await s.w.cleanup(); }
});

test('ambiguity refuses: LaunchAgents disagree, lack WorkingDirectory, or point outside the state root', async () => {
  for (const [name, mutate] of [
    ['disagreeing labels', async (s: Awaited<ReturnType<typeof setup>>) => { const f = path.join(s.agents, 'com.stinkyweasel.dex-reach.node.plist'); await fs.writeFile(f, (await fs.readFile(f, 'utf8')).replace(`runtime/releases/${CURRENT}`, `runtime/releases/${PREVIOUS}`)); }],
    ['missing WorkingDirectory', async (s: Awaited<ReturnType<typeof setup>>) => { const f = path.join(s.agents, 'com.stinkyweasel.dex-reach.worker.plist'); await fs.writeFile(f, '<plist><dict></dict></plist>'); }],
    ['working directory outside state', async (s: Awaited<ReturnType<typeof setup>>) => { const f = path.join(s.agents, 'com.stinkyweasel.dex-reach.gateway.plist'); await fs.writeFile(f, (await fs.readFile(f, 'utf8')).replace(/<key>WorkingDirectory<\/key><string>[^<]+<\/string>/, `<key>WorkingDirectory</key><string>/elsewhere/runtime/releases/${CURRENT}</string>`)); }]
  ] as const) {
    const s = await setup(); try {
      await mutate(s);
      await assert.rejects(inspectCoverage(s.w.source, 'synthetic', undefined, OPT), /RUNTIME_RELEASE_UNDETERMINED/, name);
    } finally { await s.w.cleanup(); }
  }
});

test('ambiguity refuses: no rollback record, conflicting record, corrupt record, or missing rollback target', async () => {
  for (const [name, mutate, code] of [
    ['no rollback record', async (s: Awaited<ReturnType<typeof setup>>) => { await fs.rm(path.join(s.runtime, 'rollback'), { recursive: true }); }, 'RUNTIME_ROLLBACK_UNDETERMINED'],
    ['conflicting record under another name', async (s: Awaited<ReturnType<typeof setup>>) => { const d = path.join(s.runtime, 'rollback', 'synthetic-copy'); await fs.mkdir(d); await fs.writeFile(path.join(d, 'snapshot.json'), JSON.stringify({ schemaVersion: 1, candidateReleaseId: CURRENT, previousReleaseId: SUPERSEDED_A })); }, 'RUNTIME_ROLLBACK_UNDETERMINED'],
    ['corrupt record', async (s: Awaited<ReturnType<typeof setup>>) => { await fs.writeFile(path.join(s.runtime, 'rollback', CURRENT, 'snapshot.json'), '{not json'); }, 'RUNTIME_ROLLBACK_UNDETERMINED'],
    ['rollback target missing', async (s: Awaited<ReturnType<typeof setup>>) => { await fs.rm(path.join(s.runtime, 'releases', PREVIOUS), { recursive: true }); }, 'RUNTIME_ROLLBACK_UNDETERMINED']
  ] as const) {
    const s = await setup(); try {
      await mutate(s);
      await assert.rejects(inspectCoverage(s.w.source, 'synthetic', undefined, OPT), new RegExp(code), name);
    } finally { await s.w.cleanup(); }
  }
});

test('capture refuses an ambiguous release selection with its exact code and writes nothing', async () => {
  const s = await setup(); try {
    await fs.rm(path.join(s.runtime, 'rollback'), { recursive: true });
    const outcome = await s.harness.capture({ exclusions: { runtimeReleases: 'current-and-rollback' } });
    assert.equal(outcome.status, 'REFUSED'); assert.equal(outcome.reason, 'RUNTIME_ROLLBACK_UNDETERMINED');
    assert.deepEqual((await fs.readdir(s.harness.root)).sort(), [], 'no backup directory was written');
  } finally { await s.w.cleanup(); }
});

test('an owner-approved release selection certifies: superseded releases absent, current and rollback restored', async () => {
  const s = await setup(); try {
    const req = s.harness.request({ exclusions: { runtimeReleases: 'current-and-rollback' } });
    const outcome = await s.harness.capture({ exclusions: { runtimeReleases: 'current-and-rollback' }, transactionId: req.transactionId });
    assert.equal(outcome.status, 'OFFLINE_BACKUP_CERTIFIED', outcome.reason);
    assert.equal(outcome.excluded?.subtrees, 2);
    assert.equal(outcome.excluded?.bytes, s.bytes.a + s.bytes.b);
    assert.equal(outcome.excluded?.links, 2);
    const captured = path.join(s.harness.root, req.transactionId, 'state', 'runtime', 'releases');
    assert.deepEqual((await fs.readdir(captured)).sort(), [CURRENT, PREVIOUS].sort());
    assert.ok((await fs.lstat(path.join(captured, PREVIOUS, 'package.json'))).isFile());
    assert.ok((await fs.lstat(path.join(captured, CURRENT, 'package.json'))).isFile());
  } finally { await s.w.cleanup(); }
});
