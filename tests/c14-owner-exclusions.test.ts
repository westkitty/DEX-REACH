import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fixture } from './helpers/recovery-fixture.js';
import { captureHarness, COMPAT_POLICY } from './helpers/capture-harness.js';
import { inspectCoverage, verifyCoverage, type Manifest } from '../scripts/lib/recovery-coverage.js';
import { assertExclusionPrefixAllowed } from '../scripts/lib/recovery-exclusions.js';
import { reconcileTransaction } from '../scripts/lib/recovery-evidence.js';
import type { LinkPolicy } from '../scripts/lib/recovery-symlinks.js';

const OWNER = { ownerExclusions: true } as const;
const OWNER_RULES = ['compat-home-pnpm-store', 'compat-home-npm-cache', 'compat-home-library-caches', 'checkpoint-untracked-node-modules'];
const PNPM_STORE = 'compat-home/Library/pnpm', NPM_CACHE = 'compat-home/.npm', CACHES = 'compat-home/Library/Caches', UNTRACKED_MODULES = 'checkpoints/cp1/untracked/app/node_modules';

/**
 * Synthetic owner-state with every excludable shape: a pnpm store holding six links (absolute, escaping,
 * dangling, internal, self-cycle, directory), an npm cache, a Library cache, and untracked node_modules.
 * Returns the exact byte totals so accounting is asserted against independent constants, not the code.
 */
async function seed(state: string, outside: string) {
  const write = async (relative: string, data: string) => { const f = path.join(state, relative); await fs.mkdir(path.dirname(f), { recursive: true, mode: 0o700 }); await fs.writeFile(f, data, { mode: 0o600 }); return Buffer.byteLength(data); };
  const link = async (relative: string, target: string) => { const f = path.join(state, relative); await fs.mkdir(path.dirname(f), { recursive: true, mode: 0o700 }); await fs.symlink(target, f); };
  const pnpmPackage = JSON.stringify({ name: 'synthetic-store-entry' });
  const pnpm = await write(`${PNPM_STORE}/files/ab/index.bin`, 'P'.repeat(4096)) + await write(`${PNPM_STORE}/files/ab/package.json`, pnpmPackage);
  await link(`${PNPM_STORE}/projects/p1/link-absolute`, '/synthetic/never-followed');
  await link(`${PNPM_STORE}/projects/p1/link-escape`, '../../../../../../../' + path.basename(outside));
  await link(`${PNPM_STORE}/projects/p1/link-dangling`, 'missing-target');
  await link(`${PNPM_STORE}/projects/p1/link-internal`, '../../files/ab/index.bin');
  await link(`${PNPM_STORE}/projects/p2/link-loop`, 'link-loop');
  await link(`${PNPM_STORE}/projects/p2/link-directory`, '../p1');
  const npm = await write(`${NPM_CACHE}/_logs/2026.log`, 'L'.repeat(100));
  const caches = await write(`${CACHES}/com.example/cache.bin`, 'C'.repeat(2000));
  const modules = await write(`${UNTRACKED_MODULES}/left-pad/index.js`, 'module.exports = 1;\n') + await write(`${UNTRACKED_MODULES}/left-pad/package.json`, pnpmPackage);
  const kept = await write(`compat-home/.config/keep/notes.txt`, 'kept');
  await write('checkpoints/cp1/tracked/src/main.ts', 'export {};\n');
  await write('checkpoints/cp1/untracked/app/src/main.js', 'console.log(1);\n');
  return {
    pnpm: { files: 2, links: 6, bytes: pnpm }, npm: { files: 1, links: 0, bytes: npm }, caches: { files: 1, links: 0, bytes: caches },
    modules: { files: 2, links: 0, bytes: modules }, keptBytes: kept
  };
}

async function setup() {
  const w = await fixture();
  const outside = path.join(w.directory, 'outside-never-followed');
  await fs.mkdir(outside, { mode: 0o700 }); await fs.writeFile(path.join(outside, 'data.bin'), 'O'.repeat(5000), { mode: 0o600 });
  const expected = await seed(w.source.state, outside);
  return { w, expected, harness: await captureHarness(w) };
}

const byRule = (m: Manifest) => new Map(m.exclusions.map(x => [x.rule, x]));
const inside = (m: Manifest, prefix: string) => m.entries.filter(e => e.relative === prefix || e.relative.startsWith(`${prefix}/`));

test('default policy includes everything, records no exclusions, and refuses the absolute store link rather than dropping it', async () => {
  const s = await setup(); try {
    const m = await inspectCoverage(s.w.source, 'synthetic');
    assert.deepEqual(m.exclusions, []);
    assert.ok(m.problems.includes('compatibility:LINK_REFUSED:UNAPPROVED_LINK_UNCLASSIFIABLE_ABSOLUTE_LINK_REFUSED'), 'the absolute link is still an unapproved link under the default policy');
    assert.equal(m.consistent, true);
    assert.equal(m.exclusionPolicy.ownerPolicy, false);
    assert.equal(m.exclusionPolicy.runtimeReleases, 'all');
    assert.ok(inside(m, PNPM_STORE).length >= 2 && inside(m, UNTRACKED_MODULES).length === 2, 'excludable content is included by default');
    assert.equal(m.families.find(f => f.id === 'compatibility')?.status, 'BLOCKED_BY_LINK_POLICY');
  } finally { await s.w.cleanup(); }
});

test('owner policy excludes exactly the four approved subtrees, accounted by count and logical bytes', async () => {
  const s = await setup(); try {
    const m = await inspectCoverage(s.w.source, 'synthetic', undefined, OWNER);
    assert.deepEqual(m.problems, [], 'links inside the excluded store are counted, never followed or refused');
    assert.deepEqual([...byRule(m).keys()].sort(), [...OWNER_RULES].sort());
    const rules = byRule(m);
    const pnpm = rules.get('compat-home-pnpm-store')!;
    assert.equal(pnpm.relative, PNPM_STORE); assert.equal(pnpm.reason, 'excluded by owner policy');
    assert.equal(pnpm.files, s.expected.pnpm.files); assert.equal(pnpm.links, s.expected.pnpm.links); assert.equal(pnpm.bytes, s.expected.pnpm.bytes);
    assert.equal(rules.get('compat-home-npm-cache')!.bytes, s.expected.npm.bytes);
    assert.equal(rules.get('compat-home-library-caches')!.bytes, s.expected.caches.bytes);
    const modules = rules.get('checkpoint-untracked-node-modules')!;
    assert.equal(modules.relative, UNTRACKED_MODULES); assert.equal(modules.files, s.expected.modules.files); assert.equal(modules.bytes, s.expected.modules.bytes);
    assert.match(pnpm.digest, /^[a-f0-9]{64}$/);
    // Excluded bytes are absent from the entries; included neighbours remain.
    for (const prefix of [PNPM_STORE, NPM_CACHE, CACHES, UNTRACKED_MODULES]) assert.equal(inside(m, prefix).length, 0, prefix);
    assert.ok(m.entries.some(e => e.relative === 'compat-home/.config/keep/notes.txt'));
    assert.ok(m.entries.some(e => e.relative === 'checkpoints/cp1/untracked/app/src/main.js'));
    assert.equal(m.families.find(f => f.id === 'compatibility')?.status, 'PARTIALLY_EXCLUDED_BY_POLICY');
    assert.equal(m.families.find(f => f.id === 'checkpoints')?.status, 'PARTIALLY_EXCLUDED_BY_POLICY');
    // The excluded entries do not appear in the manifest totals at all.
    assert.equal(m.totalBytes, m.entries.reduce((n, e) => n + e.bytes, 0));
  } finally { await s.w.cleanup(); }
});

test('symlinks inside an excluded store are never followed: outside bytes are not counted', async () => {
  const s = await setup(); try {
    const m = await inspectCoverage(s.w.source, 'synthetic', undefined, OWNER);
    assert.equal(byRule(m).get('compat-home-pnpm-store')!.links, 6);
    assert.equal(byRule(m).get('compat-home-pnpm-store')!.bytes, s.expected.pnpm.bytes, 'the 5000-byte outside target is not counted');
    assert.ok(!m.entries.some(e => e.relative.includes('outside')));
  } finally { await s.w.cleanup(); }
});

test('an authoritative file under an excluded name refuses the capture; the default policy still includes it', async () => {
  const s = await setup(); try {
    await fs.writeFile(path.join(s.w.source.state, CACHES, 'secrets.env'), 'SYNTHETIC_ONLY=cache-copy\n', { mode: 0o600 });
    const refused = await inspectCoverage(s.w.source, 'synthetic', undefined, OWNER);
    assert.ok(refused.problems.includes('EXCLUSION_HIDES_AUTHORITATIVE_FILE'));
    const outcome = await s.harness.capture({ exclusions: { ownerPolicy: true } });
    assert.equal(outcome.status, 'REFUSED'); assert.equal(outcome.reason, 'EXCLUSION_HIDES_AUTHORITATIVE_FILE');
    assert.equal(outcome.retryAuthorized, false);
    // Nothing was copied or certified for the refused window.
    assert.deepEqual((await fs.readdir(s.harness.root)).filter(n => !n.startsWith('.')), [], 'no backup directory was written');

    const included = await inspectCoverage(s.w.source, 'synthetic');
    assert.ok(included.entries.some(e => e.relative === `${CACHES}/secrets.env`), 'without the policy the same file is an included entry');
    assert.ok(!included.problems.includes('EXCLUSION_HIDES_AUTHORITATIVE_FILE'));
    assert.deepEqual(included.exclusions, []);
  } finally { await s.w.cleanup(); }
});

test('a required link into an excluded subtree refuses the capture', async () => {
  const s = await setup(); try {
    // A runtime-dependency rule (requiredTarget true) for the checkpoint: its link needs the excluded modules.
    const policy: LinkPolicy = { version: 1, rules: [{ prefix: 'checkpoints/cp1/', boundary: 'checkpoints/cp1', role: 'runtime-dependency', requiredTarget: true }] };
    await fs.mkdir(path.join(s.w.source.state, 'checkpoints/cp1/tracked'), { recursive: true });
    await fs.symlink('../untracked/app/node_modules/left-pad', path.join(s.w.source.state, 'checkpoints/cp1/tracked/dep'));
    const included = await inspectCoverage(s.w.source, 'synthetic', policy);
    assert.ok(!included.problems.includes('LINK_TARGET_EXCLUDED_BY_POLICY'), 'without exclusion the required link resolves to included content');
    assert.ok(!included.problems.includes('LINK_TARGET_NOT_INDEPENDENTLY_COVERED'));
    const excluded = await inspectCoverage(s.w.source, 'synthetic', policy, OWNER);
    assert.ok(excluded.problems.includes('LINK_TARGET_EXCLUDED_BY_POLICY'));
    const outcome = await s.harness.capture({ linkPolicy: policy, exclusions: { ownerPolicy: true } });
    assert.equal(outcome.status, 'REFUSED'); assert.equal(outcome.reason, 'LINK_TARGET_EXCLUDED_BY_POLICY');
  } finally { await s.w.cleanup(); }
});

test('an owner-approved capture certifies, records the exclusion totals, and restores without the excluded bytes', async () => {
  const s = await setup(); try {
    const req = s.harness.request({ exclusions: { ownerPolicy: true } });
    const outcome = await s.harness.capture({ exclusions: { ownerPolicy: true }, transactionId: req.transactionId });
    assert.equal(outcome.status, 'OFFLINE_BACKUP_CERTIFIED', outcome.reason);
    assert.equal(outcome.excluded?.subtrees, 4);
    assert.equal(outcome.excluded?.files, s.expected.pnpm.files + s.expected.npm.files + s.expected.caches.files + s.expected.modules.files);
    assert.equal(outcome.excluded?.links, 6);
    assert.equal(outcome.excluded?.bytes, s.expected.pnpm.bytes + s.expected.npm.bytes + s.expected.caches.bytes + s.expected.modules.bytes);
    // Public outcome carries counts only, never excluded paths.
    assert.ok(!JSON.stringify(outcome).includes('pnpm'));
    // Staging nests each root: the captured state tree is <txn>/state.
    const captured = path.join(s.harness.root, req.transactionId, 'state');
    for (const prefix of [PNPM_STORE, NPM_CACHE, CACHES, UNTRACKED_MODULES]) await assert.rejects(fs.lstat(path.join(captured, prefix)), /ENOENT/, prefix);
    assert.equal(await fs.readFile(path.join(captured, 'compat-home/.config/keep/notes.txt'), 'utf8'), 'kept');
    assert.equal(await fs.readFile(path.join(captured, 'checkpoints/cp1/untracked/app/src/main.js'), 'utf8'), 'console.log(1);\n');
    const records = await s.harness.log.read(req.transactionId);
    const certified = records.at(-1)!;
    assert.equal(certified.state, 'CERTIFIED');
    assert.equal((certified.data.excluded as { subtrees: number }).subtrees, 4, 'the evidence log records exclusion totals');
    assert.equal((await reconcileTransaction(s.harness.log, s.harness.expectations, s.harness.root, req.transactionId)).state, 'CERTIFIED_VERIFIED');
  } finally { await s.w.cleanup(); }
});

test('the default policy never silently drops the store: the same workspace is refused, nothing is written', async () => {
  const s = await setup(); try {
    const req = s.harness.request();
    const outcome = await s.harness.capture({ transactionId: req.transactionId });
    assert.equal(outcome.status, 'REFUSED');
    assert.equal(outcome.reason, 'SNAPSHOT_UNPROVEN');
    assert.equal(outcome.excluded, undefined);
    await assert.rejects(fs.lstat(path.join(s.harness.root, req.transactionId)), /ENOENT/);
  } finally { await s.w.cleanup(); }
});

test('verification refuses a source that changed inside an excluded subtree after inspection', async () => {
  const s = await setup(); try {
    const m = await inspectCoverage(s.w.source, 'synthetic', undefined, OWNER);
    await verifyCoverage(m, s.w.source, m.digest);
    await fs.writeFile(path.join(s.w.source.state, PNPM_STORE, 'files/ab/new.bin'), 'added after inspection', { mode: 0o600 });
    await assert.rejects(verifyCoverage(m, s.w.source, m.digest), /EXCLUSION_INVENTORY_MISMATCH/);
  } finally { await s.w.cleanup(); }
});

test('verification refuses a manifest whose recorded exclusion policy is altered', async () => {
  const s = await setup(); try {
    const m = structuredClone(await inspectCoverage(s.w.source, 'synthetic', undefined, OWNER));
    m.exclusions[0]!.bytes += 1;
    const { digest: _digest, ...body } = m; void _digest;
    const { manifestDigest } = await import('../scripts/lib/recovery-coverage.js');
    const forged = { ...m, digest: manifestDigest(body as Manifest) };
    await assert.rejects(verifyCoverage(forged, s.w.source, forged.digest), /EXCLUSION_INVENTORY_MISMATCH|INVALID|INTEGRITY/);
  } finally { await s.w.cleanup(); }
});

test('exclusion prefixes that overlap protected authority are rejected', () => {
  for (const prefix of ['tasks', 'tasks/store.json', 'results/x', 'receipts', 'nodes/macbook-air.local.env', 'node-auth.json', 'oauth.json', 'oauth-canary.json', 'secrets.env', 'plans', 'coordinator/leases', 'recovery', 'runtime', 'runtime/releases/x', 'com.stinkyweasel.dex-reach.node.plist', 'worker', 'config.json', '../escape', '/absolute']) {
    assert.throws(() => assertExclusionPrefixAllowed(prefix), /EXCLUSION_POLICY_(OVERLAPS_PROTECTED|INVALID_PREFIX)/, prefix);
  }
  for (const prefix of [PNPM_STORE, NPM_CACHE, CACHES, 'checkpoints']) assert.doesNotThrow(() => assertExclusionPrefixAllowed(prefix), prefix);
});
