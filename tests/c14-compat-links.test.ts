import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fixture } from './helpers/recovery-fixture.js';
import { inspectCoverage, familyRegistry } from '../scripts/lib/recovery-coverage.js';
import { inspectLink, defaultLinkPolicy, COMPAT_HOME_PRESERVATION_RULE, type LinkPolicy } from '../scripts/lib/recovery-symlinks.js';
import { SNAPSHOT_WRITERS, SyntheticWriterCohort } from '../scripts/lib/recovery-consistency.js';
import { captureSynthetic, inspectSyntheticTransaction } from '../scripts/lib/recovery-capture.js';
import { recoveryStoragePlan } from '../scripts/lib/recovery-storage.js';
import type { DestinationFacts } from '../scripts/lib/recovery-destination.js';

// Shapes mirror the live compat-home findings: pnpm 11 store project registries and package links.
const registry = 'compat-home/Library/pnpm/store/v11/projects/d92d8194ee63f6b745dba9f5726d2963';
const dangling = 'compat-home/Library/pnpm/package-manager-store/v11/projects/b6579c7d425767a91f64fbe80a6bc696';
const internal = 'compat-home/Library/pnpm/package-manager-store/v11/links/pkg/node_modules/dep';
const later = 'compat-home/Library/pnpm/package-manager-store/v11/tmp/zz-after-links.txt';
const opaque: LinkPolicy = { version: 1, rules: [COMPAT_HOME_PRESERVATION_RULE] };

async function compatFixture() {
  const w = await fixture(), state = w.source.state;
  const mk = async (relative: string) => fs.mkdir(path.join(state, relative), { recursive: true, mode: 0o700 });
  for (const d of [path.dirname(registry), path.dirname(dangling), path.dirname(internal), path.dirname(later), 'compat-home/Library/pnpm/package-manager-store/v11/files/dep']) await mk(d);
  await fs.writeFile(path.join(state, 'compat-home/Library/pnpm/package-manager-store/v11/files/dep/index.js'), 'synthetic', { mode: 0o600 });
  await fs.writeFile(path.join(state, later), 'must remain inventoried after refused links', { mode: 0o600 });
  // Escapes compat-home (seven hops up from the registry directory), like the live link to a user project.
  await fs.symlink('../../../../../../../outside-project', path.join(state, registry));
  await fs.symlink('../tmp/pnpm-engine-11.22.0-98382-1791140929981294000', path.join(state, dangling));
  await fs.symlink('../../../files/dep', path.join(state, internal));
  return w;
}
const linkProblems = (problems: string[]) => problems.filter(p => p.includes('LINK')).sort();

test('default policy reports each unapproved compat-home link precisely without truncating the family', async () => {
  const w = await compatFixture(); try {
    const m = await inspectCoverage(w.source, 'synthetic', defaultLinkPolicy());
    assert.deepEqual(linkProblems(m.problems), ['compatibility:LINK_REFUSED:UNAPPROVED_LINK_DANGLING', 'compatibility:LINK_REFUSED:UNAPPROVED_LINK_ESCAPES_BOUNDARY', 'compatibility:LINK_REFUSED:UNAPPROVED_LINK_INTERNAL']);
    assert.equal(m.families.find(f => f.id === 'compatibility')!.status, 'BLOCKED_BY_LINK_POLICY');
    assert.ok(!m.problems.some(p => p.startsWith('compatibility:') && /INVALID_OR_UNSUPPORTED|UNREADABLE/.test(p)));
    // The walk continues past refused links: later bytes are still inventoried, refused links are not.
    assert.ok(m.entries.some(e => e.relative === later && e.kind === 'file'));
    assert.ok(!m.entries.some(e => [registry, dangling, internal].includes(e.relative)));
  } finally { await w.cleanup(); }
});

test('preserved-opaque rule records exact link bytes and classification without dereferencing', async (t) => {
  const w = await compatFixture(); try {
    await fs.writeFile(path.join(w.directory, 'outside-project'), 'outside the boundary');
    const original = fs.lstat.bind(fs), touched: string[] = [];
    t.mock.method(fs, 'lstat', async (p: string) => { touched.push(String(p)); return original(p); });
    const m = await inspectCoverage(w.source, 'synthetic', opaque);
    t.mock.restoreAll();
    assert.deepEqual(linkProblems(m.problems), []);
    const byPath = (r: string) => m.entries.find(e => e.relative === r)!;
    assert.equal(byPath(registry).link!.resolution, 'ESCAPES_BOUNDARY');
    assert.equal(byPath(dangling).link!.resolution, 'DANGLING');
    assert.equal(byPath(internal).link!.resolution, 'INTERNAL');
    for (const r of [registry, dangling, internal]) {
      const e = byPath(r);
      assert.equal(e.kind, 'link'); assert.equal(e.link!.role, 'preserved-opaque'); assert.equal(e.link!.dereference, false); assert.equal(e.link!.requiredTarget, false);
      assert.equal(e.link!.target, await fs.readlink(path.join(w.source.state, r)));
      assert.equal(e.sensitive, true);
    }
    // The escaping link's target outside compat-home was never examined (root-ancestor checks are expected).
    assert.ok(!touched.some(p => p.includes('outside-project')));
    const compat = path.join(w.source.state, 'compat-home');
    assert.ok(touched.some(p => p.startsWith(compat)));
  } finally { await w.cleanup(); }
});

test('preserved-opaque links capture and restore byte-identical, dangling stays dangling', async () => {
  const w = await compatFixture(); try {
    const cohort = new SyntheticWriterCohort(w); for (const writer of SNAPSHOT_WRITERS) cohort.checkpoint(writer);
    const boundary = await cohort.freeze(opaque);
    const root = path.join(w.directory, 'backups'); await fs.mkdir(root, { mode: 0o700 });
    const st = await fs.lstat(root), v = await fs.statfs(root);
    const facts: DestinationFacts = { root, approvedRoot: root, approved: true, device: st.dev, approvedDevice: st.dev, inode: st.ino, approvedInode: st.ino, mountIdentity: 'synthetic-volume', approvedMountIdentity: 'synthetic-volume', ownerUid: st.uid, expectedUid: st.uid, mode: 0o700, writable: true, cloudSynced: false, cloudApproved: false, encrypted: true, durable: true, freeBytes: v.bavail * v.bsize, measured: true, space: recoveryStoragePlan(boundary.manifest), sources: w.source, gitRoots: ['/synthetic/git'] };
    await captureSynthetic(w, boundary, facts);
    for (const r of [registry, dangling, internal]) assert.equal(await fs.readlink(path.join(root, boundary.transactionId, 'state', r)), await fs.readlink(path.join(w.source.state, r)));
    await assert.rejects(fs.stat(path.join(root, boundary.transactionId, 'state', dangling)), /ENOENT/);
    assert.equal((await inspectSyntheticTransaction(w, boundary)).state, 'CERTIFIED');
  } finally { await w.cleanup(); }
});

test('preserved-opaque rule refuses absolute links and changed links', async () => {
  const w = await compatFixture(); try {
    const abs = 'compat-home/Library/pnpm/store/v11/projects/absolute';
    await fs.symlink('/Users/andrew/dex-router', path.join(w.source.state, abs));
    await assert.rejects(inspectLink(w.source.state, abs, opaque), /ABSOLUTE_LINK_REFUSED/);
    const m = await inspectCoverage(w.source, 'synthetic', opaque);
    assert.deepEqual(linkProblems(m.problems), ['compatibility:LINK_REFUSED:ABSOLUTE_LINK_REFUSED']);
  } finally { await w.cleanup(); }
});

test('preserved-opaque role cannot cover authoritative families or be widened', async () => {
  const w = await compatFixture(); try {
    await fs.symlink('absent', path.join(w.source.state, 'plans/alias'));
    for (const rule of [
      { prefix: 'plans/', boundary: 'plans', role: 'preserved-opaque', requiredTarget: false },
      { prefix: 'compat-home/', boundary: 'compat-home', role: 'preserved-opaque', requiredTarget: true },
      { prefix: 'compat-home/', boundary: 'compat-home', role: 'internal-alias', requiredTarget: false },
      { prefix: '', boundary: '', role: 'preserved-opaque', requiredTarget: false }
    ]) await assert.rejects(inspectLink(w.source.state, rule.prefix.startsWith('plans') ? 'plans/alias' : dangling, { version: 1, rules: [rule as never] }), /UNAPPROVED_LINK/);
  } finally { await w.cleanup(); }
});

test('compatibility home is classified sensitive preserved state, never rebuildable', () => {
  const f = familyRegistry().families.find(f => f.id === 'compatibility')!;
  assert.notEqual(f.category, 'REBUILDABLE');
  assert.equal(f.sensitive, true); assert.match(f.retention, /preserve/);
});

test('the default link policy remains empty: compat-home preservation is never self-approved', () => {
  assert.deepEqual(defaultLinkPolicy(), { version: 1, rules: [] });
});
