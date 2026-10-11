import test from 'node:test';
import { fixture } from './helpers/recovery-fixture.js';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { NodeTaskStore } from '../src/node/task-store.js';
import { ResultStore } from '../src/node/result-store.js';
import { appendReceipt } from '../src/shared/receipts.js';
import { workspaceWorkerRootsHash } from '../src/shared/workspace-worker.js';
import { NodeAuthStore } from '../src/gateway/node-auth.js';
import { classifyTask, inspectTasks, publicTaskReport, safeRead, type Evidence } from '../scripts/lib/recovery-reconciliation.js';
import { inspectCoverage, verifyCoverage, manifestDigest, publicCoverage, type Manifest } from '../scripts/lib/recovery-coverage.js';
import { createSyntheticWorkspace, rehearseRestore, type SyntheticWorkspace } from '../scripts/lib/recovery-rehearsal.js';
import { C14_ROOT, RETAINED_RELEASE, RETAINED_TREE, baselineBlockers, evaluatePreflight, requiredFreeBytes, type PreflightFacts } from '../scripts/lib/c14-recovery-preflight.js';

const nodeId = 'macbook-air.local', hash = 'a'.repeat(64);
const evidence: Evidence = { result: 'missing', activity: false, lease: false, ticket: false, process: 'absent', sharedProcess: false, stale: true, complete: true, eventState: 'PREPARING' };
test('17-record report conditions preserve uncertainty and never authorize replay', () => {
  const cases: Array<[string, Partial<Evidence>, string, string?]> = [
    ['PREPARING', {}, 'STRANDED_OR_STALE'], ['PREPARING', { complete: false }, 'INSUFFICIENT_EVIDENCE'],
    ['PREPARING', { result: 'verified' }, 'RECOVERABLE_WITH_EVIDENCE'], ['PREPARING', { ticket: true }, 'ACTIVE_UNVERIFIED'],
    ['RUNNING', { eventState: 'RUNNING', activity: true, lease: true, process: 'matching', stale: false }, 'ACTIVE_CONFIRMED'],
    ['RUNNING', { eventState: 'RUNNING', activity: true, lease: true, process: 'matching', sharedProcess: true }, 'ACTIVE_UNVERIFIED'],
    ['RUNNING', { eventState: 'RUNNING' }, 'AMBIGUOUS_EFFECT', 'PROCESS_UNKNOWN_EFFECT'],
    ['RUNNING', { eventState: 'RUNNING' }, 'STRANDED_OR_STALE'], ['PREPARING', { result: 'invalid-or-expired' }, 'REQUIRES_OWNER_DECISION'],
    ['PREPARING', { process: 'unknown' }, 'INSUFFICIENT_EVIDENCE'], ['AMBIGUOUS', {}, 'AMBIGUOUS_EFFECT'],
    ['INPUT_REQUIRED', {}, 'REQUIRES_OWNER_DECISION'], ['PREPARING', { eventState: 'RUNNING' }, 'INSUFFICIENT_EVIDENCE'],
    ['PREPARING', { activity: true }, 'ACTIVE_UNVERIFIED'], ['PREPARING', { lease: true }, 'ACTIVE_UNVERIFIED'],
    ['RUNNING', { eventState: 'RUNNING', complete: false }, 'INSUFFICIENT_EVIDENCE'], ['PREPARING', { stale: false }, 'INSUFFICIENT_EVIDENCE']
  ];
  for (const [state, e, expected, safetyClass] of cases) assert.equal(classifyTask({ state: state as any, safetyClass: (safetyClass ?? 'PURE_READ_IDEMPOTENT') as any }, { ...evidence, ...e }), expected);
});
test('read-only inspector preserves complete task/event fixture, wrong root/node refuse', async () => {
  const w = await fixture(); try {
    const before = await inspectCoverage(w.source, 'synthetic');
    const rows = await inspectTasks({ root: w.source.state, expectedRoot: w.source.state, nodeId });
    assert.equal(rows.length, 1); assert.equal(rows[0]!.classification, 'RECOVERABLE_WITH_EVIDENCE'); assert.equal(rows[0]!.replayAuthorized, false);
    assert.ok(!JSON.stringify(publicTaskReport(rows)).includes(rows[0]!.taskId));
    await assert.rejects(inspectTasks({ root: w.source.state, expectedRoot: '/wrong-root', nodeId }));
    await assert.rejects(inspectTasks({ root: w.source.state, expectedRoot: w.source.state, nodeId: 'bigmac' }));
    const after = await inspectCoverage(w.source, 'synthetic'); assert.deepEqual(after.entries, before.entries);
  } finally { await w.cleanup(); }
});
test('complete synthetic backup restores application state, policy, receipts and recovery without changing source', async () => {
  const w = await fixture(); try {
    const m = await inspectCoverage(w.source, 'synthetic'); assert.deepEqual(m.problems, []);
    const restored = await rehearseRestore(w, m, m.digest); assert.equal(restored.passed, true); assert.equal(restored.scope, 'synthetic');
    await verifyCoverage(m, w.source, m.digest);
    assert.ok(!JSON.stringify(publicCoverage(m)).includes('not-a-production-credential')); assert.ok(!JSON.stringify(publicCoverage(m)).includes(m.entries[0]!.sha256));
  } finally { await w.cleanup(); }
});
for (const family of ['results', 'receipts', 'enrollment', 'oauth', 'tasks', 'events', 'secrets', 'plans', 'coordinator', 'runtime', 'services', 'worker', 'revocations']) {
  test(`backup certification refuses omitted authoritative family ${family}`, async () => {
    const w = await fixture(); try {
      const m = await inspectCoverage(w.source, 'synthetic'); const altered = structuredClone(m);
      altered.entries = altered.entries.filter(e => e.family !== family); altered.totalBytes = altered.entries.reduce((n, e) => n + e.bytes, 0); altered.digest = manifestDigest(altered);
      await assert.rejects(verifyCoverage(altered, w.source, altered.digest));
      await assert.rejects(rehearseRestore(w, altered, m.digest));
    } finally { await w.cleanup(); }
  });
}
for (const fault of ['hash', 'permissions', 'schema', 'duplicate', 'truncated', 'timestamps', 'symlink', 'missing-volume', 'partial', 'corrupt', 'credential-key']) {
  test(`negative snapshot ${fault} fails safely`, async () => {
    const w = await fixture(); try {
      const m = await inspectCoverage(w.source, 'synthetic'); let changed: Manifest = structuredClone(m);
      if (fault === 'hash') changed.entries[0]!.sha256 = 'b'.repeat(64);
      if (fault === 'duplicate') changed.entries.push(changed.entries[0]!);
      if (fault === 'truncated') changed.entries.pop();
      if (fault === 'timestamps') changed.endedAt = '1970-01-01T00:00:00Z';
      if (fault === 'permissions') await fs.chmod(path.join(w.source.state, 'secrets.env'), 0o644);
      if (fault === 'schema') await fs.writeFile(path.join(w.source.state, 'oauth.json'), '{"version":99}');
      if (fault === 'partial') await fs.rm(path.join(w.source.state, 'results/manifest.json'));
      if (fault === 'corrupt') await fs.writeFile(path.join(w.source.state, 'tasks/store.json'), '{');
      if (fault === 'credential-key') await fs.writeFile(path.join(w.source.state, `receipts/${nodeId}.ed25519.pem`), 'bad-key');
      if (fault === 'symlink') { await fs.rm(path.join(w.source.state, 'secrets.env')); await fs.symlink('/etc/passwd', path.join(w.source.state, 'secrets.env')); }
      const roots = fault === 'missing-volume' ? { ...w.source, worker: path.join(w.directory, 'missing') } : w.source;
      await assert.rejects(verifyCoverage(changed, roots, m.digest));
      if (fault !== 'missing-volume') await assert.rejects(rehearseRestore(w, changed, m.digest));
      else { const original = w.source.worker; w.source.worker = roots.worker; await assert.rejects(rehearseRestore(w, changed, m.digest), /FIXTURE_IDENTITY_CHANGED/); w.source.worker = original; }
    } finally { await w.cleanup(); }
  });
}
test('recomputed integrity cannot hide incompatible application state; original remains unchanged', async () => {
  const w = await fixture(); try {
    await fs.writeFile(path.join(w.source.state, 'node-auth.json'), '{"version":99,"nodes":{}}');
    const m = await inspectCoverage(w.source, 'synthetic'); await assert.rejects(rehearseRestore(w, m, m.digest), /APPLICATION_ENROLLMENT/);
    await verifyCoverage(m, w.source, m.digest);
    const forged = { ...w }; await assert.rejects(rehearseRestore(forged, m, m.digest), /UNOWNED_FIXTURE/);
    await assert.rejects(safeRead(w.source.state, '../secrets.env'));
  } finally { await w.cleanup(); }
});
function goodFacts(): PreflightFacts {
  return { hostname: 'MacBook-Air.local', model: 'MacBookAir10,1', platform: 'darwin', arch: 'arm64', user: 'andrew', uid: 501, home: '/Users/andrew', root: C14_ROOT, branch: 'c14-chaos-recovery', head: 'a'.repeat(40), remoteHead: 'a'.repeat(40), dirty: false, approvedSha: 'a'.repeat(40), candidateVersion: '0.3.2', approvedVersion: '0.3.2', ciHead: 'a'.repeat(40), ciChecks: Object.fromEntries(['validate', 'runtime-proof', 'reproducible-build', 'analyze', 'CodeQL'].map(k => [k, 'SUCCESS'])), installedIntact: true, installedRelease: RETAINED_RELEASE, servicesVerified: true, backupCertified: true,
    baseline: { previousReleaseId: RETAINED_RELEASE, previousDigest: RETAINED_TREE, observedDigest: RETAINED_TREE, previousExists: true, provenance: 'manifest-verified', legacyProvenanceApproved: false, transactionId: '12345678-1234-4234-8234-123456789abc', state: 'prepared', fresh: true, serviceReleaseIds: Array(5).fill(RETAINED_RELEASE), configVerified: true, inventoryVerified: true, helperIdle: true, rollbackActive: false, provenanceDetails: { sourceSha: '87a99494ebb3471d3ecc3a79acd630ec18858a92', installTransaction: '9bf5079f-397e-4cd8-af35-99f1550d3d68', dependencyDigest: hash, configDigest: hash, expectedConfigDigest: hash, policyDigest: hash, expectedPolicyDigest: hash, ownerManifestDigest: hash, trustedManifestDigest: hash, snapshotComplete: true, metadataVerified: true, reserveVerified: true } },
    restoreProof: { scope: 'synthetic', sourceSha: 'a'.repeat(40), passed: true }, taskCount: 0, taskUnresolved: 0, claimsKnown: true, claimsCount: 0, ownerPreservationVerified: true, freeBytes: 10 * 1024 ** 3, spaceMeasured: true, space: { candidateBytes: 100, dependencyBytes: 100, retainedBytes: 100, backupBytes: 100, restoreBytes: 100, stagingBytes: 100, reserveBytes: 2 * 1024 ** 3 }, exactLegacyPairingVerified: true, credentialsCompatible: true, requiredHostCapabilityAvailable: true, maintenanceAuthorized: true };
}
test('twenty source prerequisites cannot bypass missing live boundary proof and cannot reinterpret synthetic proof', () => {
  const f = goodFacts(); const report = evaluatePreflight(f); assert.equal(report.status, 'BLOCKED'); assert.ok(report.blockers.includes('SNAPSHOT_CONSISTENCY')); assert.ok(report.checks.SYNTHETIC_RESTORE); assert.equal(report.installationCommandAvailable, false); assert.equal(report.syntheticIsInstalledProof, false);
  f.restoreProof.scope = 'installed'; assert.ok(evaluatePreflight(f).blockers.includes('SYNTHETIC_RESTORE'));
  assert.throws(() => requiredFreeBytes({ ...f.space, reserveBytes: 0 }));
});
const faults: Array<[string, (f: PreflightFacts) => void]> = [
  ['wrong host', f => { f.hostname = 'bigmac'; }], ['wrong branch', f => { f.branch = 'main'; }], ['dirty', f => { f.dirty = true; }], ['candidate changed', f => { f.head = 'b'.repeat(40); }], ['stale CI', f => { f.ciHead = 'b'.repeat(40); }], ['missing previous', f => { f.baseline.previousExists = false; }], ['wrong capsule', f => { f.baseline.previousReleaseId = 'similar-release'; }], ['changed digest', f => { f.baseline.observedDigest = 'b'.repeat(64); }], ['unknown process', f => { f.servicesVerified = false; }], ['mixed service', f => { f.baseline.serviceReleaseIds[2] = 'other'; }], ['ambiguous task', f => { f.taskUnresolved = 1; }], ['running task', f => { f.taskCount = 1; }], ['uncertain claims', f => { f.claimsKnown = false; }], ['incomplete backup', f => { f.backupCertified = false; }], ['missing config', f => { f.baseline.configVerified = false; }], ['insufficient disk', f => { f.freeBytes = 1; }], ['unknown installer', f => { f.baseline.state = 'uncertain'; }], ['partial activation', f => { f.baseline.state = 'partial'; }], ['rollback active', f => { f.baseline.rollbackActive = true; }], ['credential incompatible', f => { f.credentialsCompatible = false; }], ['host capability', f => { f.requiredHostCapabilityAvailable = false; }], ['no authority', f => { f.maintenanceAuthorized = false; }], ['unapproved version', f => { delete f.approvedVersion; }]
];
for (const [name, alter] of faults) test(`preflight refuses ${name} without mutating evidence or invoking installation`, () => {
  const f = goodFacts(); alter(f); const before = JSON.stringify(f); const report = evaluatePreflight(f); assert.equal(report.status, 'BLOCKED'); assert.equal(report.installationExecuted, false); assert.equal(JSON.stringify(f), before); assert.ok(report.blockers.length);
});
test('legacy provenance is explicit and incomplete baseline cannot become rollback-ready', () => {
  const b = goodFacts().baseline; b.provenance = 'journal-bound'; assert.ok(baselineBlockers(b).includes('PROVENANCE_UNAPPROVED')); b.legacyProvenanceApproved = true; assert.deepEqual(baselineBlockers(b), []); b.inventoryVerified = false; assert.ok(baselineBlockers(b).length);
});

test('mutating a minted fixture cannot redirect restore or cleanup to another fixture', async () => {
  const a = await fixture(), b = await fixture(), original = { directory: a.directory, source: a.source };
  try {
    const m = await inspectCoverage(b.source, 'synthetic'), before = await fs.readdir(b.directory);
    a.directory = b.directory; a.source = b.source;
    await assert.rejects(rehearseRestore(a, m, m.digest), /FIXTURE_IDENTITY_CHANGED/);
    await assert.rejects(a.cleanup(), /FIXTURE_IDENTITY_CHANGED/);
    assert.deepEqual(await fs.readdir(b.directory), before);
  } finally { a.directory = original.directory; a.source = original.source; await a.cleanup(); await b.cleanup(); }
});
for (const fault of ['transport-pin', 'revocation', 'worker-roots', 'coordination-history', 'coordination-claim', 'unknown-family', 'directory-added']) test(`recomputed snapshot refuses ${fault}`, async () => {
  const w = await fixture(); try {
    const initial = await inspectCoverage(w.source, 'synthetic');
    if (fault === 'transport-pin') { const p = path.join(w.source.state, 'node-auth.json'); const a = JSON.parse(await fs.readFile(p, 'utf8')); a.nodes[nodeId].transport.publicKey = 'wrong'; await fs.writeFile(p, JSON.stringify(a)); }
    if (fault === 'revocation') await fs.writeFile(path.join(w.source.state, 'revoked-nodes.json'), JSON.stringify([nodeId]));
    if (fault === 'worker-roots') { const p = path.join(w.source.worker, 'config.json'); const a = JSON.parse(await fs.readFile(p, 'utf8')); a.rootsHash = hash; await fs.writeFile(p, JSON.stringify(a)); }
    if (fault === 'coordination-history') await fs.writeFile(path.join(w.source.state, 'coordinator/history/events.jsonl'), '{}\n');
    if (fault === 'coordination-claim') await fs.writeFile(path.join(w.source.state, 'coordinator/leases/bad.json'), '{}');
    if (fault === 'unknown-family') await fs.writeFile(path.join(w.source.state, 'unknown-authority.json'), '{}');
    if (fault === 'directory-added') await fs.mkdir(path.join(w.source.state, 'plans/new-directory'));
    await assert.rejects(verifyCoverage(initial, w.source, initial.digest));
    const m = await inspectCoverage(w.source, 'synthetic');
    if (fault !== 'directory-added') await assert.rejects(rehearseRestore(w, m, m.digest));
  } finally { await w.cleanup(); }
});
for (const age of [0, 151_000, -30_000, NaN]) test(`persisted ISO coordinator heartbeat age ${age} is interpreted conservatively`, async () => {
  const w = await fixture(); try {
    const store = new NodeTaskStore(w.source.state), [task] = await store.list();
    const now = Date.now();
    await fs.writeFile(path.join(w.source.state, 'coordinator/leases/test.json'), JSON.stringify({ id: 'test', taskId: task!.taskId, attempt: task!.attemptNumber, pid: 1234, executor: 'codex', access: 'read', workload: 'light', createdAt: new Date(now).toISOString(), heartbeatAt: Number.isNaN(age) ? 'invalid' : new Date(now - age).toISOString() }));
    const [row] = await inspectTasks({ root: w.source.state, expectedRoot: w.source.state, nodeId, now });
    assert.equal(row!.evidence.lease, age === 0); assert.equal(row!.replayAuthorized, false);
  } finally { await w.cleanup(); }
});

test('unreadable policy cannot be certified or restored', async () => {
  const w = await fixture(); try {
    const m = await inspectCoverage(w.source, 'synthetic');
    await fs.chmod(path.join(w.source.state, `nodes/${nodeId}.access.json`), 0);
    await assert.rejects(verifyCoverage(m, w.source, m.digest));
    await assert.rejects(rehearseRestore(w, m, m.digest));
  } finally { await w.cleanup(); }
});
test('unmeasured space estimates and invalid transaction binding fail closed', () => {
  const f = goodFacts(); f.spaceMeasured = false; assert.ok(evaluatePreflight(f).blockers.includes('FREE_SPACE'));
  f.baseline.transactionId = 'not-a-transaction'; assert.ok(baselineBlockers(f.baseline).includes('CAPSULE_INCOMPLETE_OR_UNCERTAIN'));
});
