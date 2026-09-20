import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  RELEASE_LIMITATIONS,
  buildReleaseManifest,
  check,
  checksumTree,
  compareTrees,
  countSbomComponents,
  describeReleaseManifest,
  normalizeSbom,
  platformClaims,
  type ArtifactChecksum
} from '../src/shared/provenance.js';
import { cleanBuildComparison } from '../scripts/lib/clean-build.js';
import { canonicalJson } from '../src/shared/hash.js';

const execFileAsync = promisify(execFile);

/**
 * Phase 14 — release provenance.
 *
 * The behaviour under test is not "does the build work" but "would this record mislead someone".
 * So the tests are mostly about what the manifest refuses to claim: a platform nobody exercised
 * stays unverified, a dirty tree is stated rather than smoothed over, an install failure is not
 * reported as a reproducibility failure, and the difference report names files rather than
 * announcing that something drifted.
 */

function sample(path: string, content: string): ArtifactChecksum {
  return { path, sha256: crypto.createHash('sha256').update(content).digest('hex'), bytes: content.length };
}

test('a tree comparison names every differing file and why it differs', () => {
  const reference = [sample('a.js', 'same'), sample('stale.js', 'left over'), sample('b.js', 'built here')];
  const rebuild = [sample('a.js', 'same'), sample('b.js', 'built there'), sample('new.js', 'only clean')];
  const differences = compareTrees(reference, rebuild);

  assert.deepEqual(differences.map(entry => `${entry.path}:${entry.kind}`), [
    'b.js:content-differs',
    'new.js:only-in-rebuild',
    'stale.js:only-in-reference'
  ]);
  // "Something drifted" sends someone hunting. Each entry has to say what to look for.
  assert.match(differences.find(entry => entry.path === 'stale.js')!.detail, /untracked file|leftover artifact/);
  assert.match(differences.find(entry => entry.path === 'b.js')!.detail, /absolute path|hostname|timestamp/);
  assert.match(differences.find(entry => entry.path === 'new.js')!.detail, /stale or was pruned/);
  assert.deepEqual(compareTrees(reference, reference), []);
});

test('checksums are relative, sorted, and absent rather than invented for a missing tree', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dex-reach-checksum-'));
  try {
    await fs.mkdir(path.join(root, 'nested', 'deep'), { recursive: true });
    await fs.writeFile(path.join(root, 'z.js'), 'z');
    await fs.writeFile(path.join(root, 'a.js'), 'a');
    await fs.writeFile(path.join(root, 'nested', 'deep', 'm.js'), 'm');
    const tree = await checksumTree(root);

    assert.deepEqual(tree.map(entry => entry.path), ['a.js', 'nested/deep/m.js', 'z.js']);
    assert.ok(!tree.some(entry => entry.path.includes(root)), 'an absolute path would make two trees incomparable by construction');
    assert.equal(tree[0]!.sha256, crypto.createHash('sha256').update('a').digest('hex'));
    assert.deepEqual(await checksumTree(path.join(root, 'does-not-exist')), []);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('an SBOM hashes the same across runs of one tree and differently across two', () => {
  const build = (serial: string, timestamp: string, components: unknown[]) => ({
    bomFormat: 'CycloneDX', specVersion: '1.5', serialNumber: serial,
    metadata: { timestamp, tools: [{ vendor: 'npm' }] }, components
  });
  const components = [{ name: 'ws', version: '8.18.0' }, { name: 'zod', version: '4.0.0' }];

  // npm stamps a fresh uuid and clock time into every document. Without normalization the hash
  // answers "was this generated twice", which nobody asked, instead of "is this the same tree".
  const first = canonicalJson(normalizeSbom(build('urn:uuid:aaa', '2026-01-01T00:00:00Z', components)));
  const second = canonicalJson(normalizeSbom(build('urn:uuid:bbb', '2026-09-19T18:00:00Z', components)));
  assert.equal(first, second);

  const changed = canonicalJson(normalizeSbom(build('urn:uuid:ccc', '2026-01-01T00:00:00Z', [...components, { name: 'left-pad', version: '1.0.0' }])));
  assert.notEqual(first, changed, 'a new dependency must change the hash, or the SBOM records nothing');

  assert.equal(countSbomComponents(build('u', 't', components)), 2);
  assert.equal(countSbomComponents({}), 0);
  assert.equal(countSbomComponents(null), 0);
  // Normalization must not quietly discard anything else.
  const normalized = normalizeSbom(build('u', 't', components)) as Record<string, unknown>;
  assert.equal(normalized.bomFormat, 'CycloneDX');
  assert.ok(Array.isArray(normalized.components));
  assert.deepEqual((normalized.metadata as Record<string, unknown>).tools, [{ vendor: 'npm' }]);
});

test('a platform nobody exercised stays unverified, including the one the build ran on', () => {
  const onLinux = platformClaims('linux/x64', true);
  assert.equal(onLinux.find(entry => entry.platform === 'linux')!.status, 'verified');
  for (const platform of ['macos', 'android', 'second-machine']) {
    const claimed = onLinux.find(entry => entry.platform === platform)!;
    assert.equal(claimed.status, 'unverified', `${platform} was not exercised and must not read as passing`);
    assert.match(claimed.detail, /UNVERIFIED/);
  }
  assert.match(onLinux.find(entry => entry.platform === 'android')!.detail, /HARDWARE NOT AVAILABLE/);
  assert.match(onLinux.find(entry => entry.platform === 'second-machine')!.detail, /simulation/);

  // A failing run does not get to claim the platform it failed on.
  assert.equal(platformClaims('linux/x64', false).find(entry => entry.platform === 'linux')!.status, 'unverified');
  assert.equal(platformClaims('darwin/arm64', true).find(entry => entry.platform === 'macos')!.status, 'verified');
  assert.equal(platformClaims('darwin/arm64', true).find(entry => entry.platform === 'linux')!.status, 'unverified');
});

test('a manifest from a dirty tree says so and claims no platform at all', () => {
  const passing = [check('typecheck', 'pass', 'ok'), check('build', 'pass', 'ok')];
  const base = { commit: 'abc123def456', branch: 'main', node: 'v22', npm: '11', platform: 'linux/x64', artifacts: [sample('a.js', 'a')], sbom: null };

  const clean = buildReleaseManifest({ ...base, clean: true, checks: passing });
  assert.equal(clean.source.clean, true);
  assert.equal(clean.platforms.find(entry => entry.platform === 'linux')!.status, 'verified');

  const dirty = buildReleaseManifest({ ...base, clean: false, checks: passing });
  assert.equal(dirty.source.clean, false);
  assert.equal(dirty.platforms.find(entry => entry.platform === 'linux')!.status, 'unverified',
    'a manifest that does not describe a commit cannot vouch for the platform it was built on');

  const text = describeReleaseManifest(dirty).join('\n');
  assert.match(text, /WORKING TREE NOT CLEAN/);
  assert.match(text, /does not describe the named commit/);
  assert.match(text, /Treat it as a local record, not as release provenance/);
});

test('a manifest carries what it does not say, including that no deployment was exercised', () => {
  const manifest = buildReleaseManifest({
    commit: 'abc', clean: true, branch: 'main', node: 'v22', npm: '11', platform: 'linux/x64',
    checks: [check('live deployment', 'unverified', 'Nothing here exercised a deployed gateway or a real MCP client session.')],
    artifacts: [], sbom: { format: 'CycloneDX', normalizedSha256: 'f'.repeat(64), components: 12 }
  });
  assert.deepEqual(manifest.limitations, [...RELEASE_LIMITATIONS]);
  assert.ok(manifest.limitations.some(line => /do not describe a deployment/.test(line)));
  assert.ok(manifest.limitations.some(line => /compromised upstream package/.test(line)));
  assert.ok(manifest.limitations.some(line => /not signatures/.test(line)));

  const text = describeReleaseManifest(manifest).join('\n');
  assert.match(text, /live deployment\s+UNVERIFIED/);
  assert.match(text, /What this does not say:/);
  assert.match(text, /12 production component\(s\)/);
  // No single overall verdict, for the same reason evidence verification has none.
  assert.ok(!/^\s*(RELEASE )?VERIFIED\s*$/mi.test(text));
});


test('a check that can never pass does not hold every platform at unverified', () => {
  // A manifest always carries "live deployment: UNVERIFIED" by construction. Requiring every check
  // to read PASS therefore left the build platform unverified on a run where nothing had failed,
  // which reads as "we tested nothing" and is the opposite of what happened.
  const manifest = buildReleaseManifest({
    commit: 'abc', clean: true, branch: 'main', node: 'v22', npm: '11', platform: 'linux/x64',
    checks: [
      check('typecheck', 'pass', 'ok'),
      check('clean-build reproducibility', 'pass', 'ok'),
      check('compatibility adapter probe', 'unverified', 'depends on what is installed here'),
      check('live deployment', 'unverified', 'no deployment was exercised')
    ],
    artifacts: [], sbom: null
  });
  assert.equal(manifest.platforms.find(entry => entry.platform === 'linux')!.status, 'verified');

  // One real failure still withdraws the claim.
  const failed = buildReleaseManifest({
    commit: 'abc', clean: true, branch: 'main', node: 'v22', npm: '11', platform: 'linux/x64',
    checks: [check('tests', 'fail', 'a test failed'), check('live deployment', 'unverified', 'none')],
    artifacts: [], sbom: null
  });
  assert.equal(failed.platforms.find(entry => entry.platform === 'linux')!.status, 'unverified');
});

test('a symlink is compared rather than silently skipped', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dex-reach-symlink-'));
  try {
    await fs.writeFile(path.join(root, 'real.js'), 'real');
    await fs.symlink('real.js', path.join(root, 'link.js'));
    const tree = await checksumTree(root);
    // Before this, a symlink was neither a file nor a directory to the walker, so a tree with one
    // and a tree without compared equal -- an invisible difference in a check built to find them.
    assert.deepEqual(tree.map(entry => entry.path), ['link.js', 'real.js']);
    assert.notEqual(tree[0]!.sha256, tree[1]!.sha256, 'a link must not hash as its target\'s contents');

    const withoutLink = tree.filter(entry => entry.path !== 'link.js');
    assert.deepEqual(compareTrees(tree, withoutLink).map(entry => entry.kind), ['only-in-reference']);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('the clean-build check separates "did not run" from "is not reproducible"', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dex-reach-cleanbuild-guard-'));
  try {
    await execFileAsync('git', ['-C', root, 'init', '-q', '-b', 'main']);
    await execFileAsync('git', ['-C', root, 'config', 'user.email', 'test@example.invalid']);
    await execFileAsync('git', ['-C', root, 'config', 'user.name', 'Test']);
    await fs.writeFile(path.join(root, 'a.txt'), 'a');
    await execFileAsync('git', ['-C', root, 'add', '-A']);
    await execFileAsync('git', ['-C', root, 'commit', '-qm', 'first']);

    // No build output. Comparing against nothing would otherwise report zero differences and pass.
    const empty = await cleanBuildComparison({ repoRoot: root });
    assert.equal(empty.compared, false);
    assert.equal(empty.ok, false);
    assert.match(empty.detail, /No build output/);
    assert.match(empty.detail, /pass for the wrong reason/);

    // A dirty tree cannot be compared to its own HEAD, and saying so beats a wall of differences
    // that are really just uncommitted work.
    await fs.writeFile(path.join(root, 'b.txt'), 'b');
    await fs.mkdir(path.join(root, 'dist'), { recursive: true });
    await fs.writeFile(path.join(root, 'dist', 'out.js'), 'out');
    const dirty = await cleanBuildComparison({ repoRoot: root });
    assert.equal(dirty.compared, false);
    assert.equal(dirty.ok, false);
    assert.match(dirty.detail, /uncommitted changes/);
    assert.deepEqual(dirty.differences, [], 'an uncomparable state must not be dressed up as differences');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
