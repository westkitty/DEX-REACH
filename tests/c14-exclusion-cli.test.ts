import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { fixture } from './helpers/recovery-fixture.js';
import { inspectCoverage } from '../scripts/lib/recovery-coverage.js';
import { isAuthoritativeEntry, EXCLUSION_REFUSALS } from '../scripts/lib/recovery-exclusions.js';
import { parseCaptureExclusionFlags } from '../scripts/lib/recovery-capture-flags.js';

const run = promisify(execFile);
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PNPM = 'compat-home/Library/pnpm', NPM = 'compat-home/.npm';

// ---- 1. Source- and path-aware authority rule (pure, synthetic names only) ----

test('ordinary pnpm and npm cache names are not authority: store.json and events.jsonl inside a cache tree', () => {
  for (const name of ['store.json', 'events.jsonl']) {
    assert.equal(isAuthoritativeEntry(`${PNPM}/v3/files/${name}`), false, `${PNPM} ${name}`);
    assert.equal(isAuthoritativeEntry(`${NPM}/_cacache/${name}`), false, `${NPM} ${name}`);
    assert.equal(isAuthoritativeEntry(`compat-home/Library/Caches/tool/${name}`), false, `Library/Caches ${name}`);
  }
});

test('the same generic names are authority only at their owner-state locations', () => {
  for (const p of ['tasks/store.json', 'tasks/events.jsonl', 'audit.jsonl', 'coordinator/history/events.jsonl', 'receipts/rc-1.jsonl']) assert.equal(isAuthoritativeEntry(p), true, p);
  // Elsewhere in owner state these generic names are not owner locations, so they are ordinary content.
  for (const p of ['events.jsonl', 'checkpoints/cp1/untracked/app/node_modules/x/store.json']) assert.equal(isAuthoritativeEntry(p), false, p);
});

test('names that are authority anywhere, including inside a cache tree, remain protected', () => {
  for (const p of [`${PNPM}/secrets.env`, `${NPM}/node-auth.json`, `${PNPM}/oauth-token.json`, `${PNPM}/x/revoked-nodes.json`, `${NPM}/a.access.json`, `${PNPM}/k.ed25519.pem`, `${PNPM}/k.ed25519.pub.pem`, `${NPM}/com.stinkyweasel.dex-reach.node.plist`, `${PNPM}/install-macos.status.json`, `${PNPM}/retained-evidence.json`, `${PNPM}/c13-maintenance.json`, `${PNPM}/macbook-air.local.env`]) {
    assert.equal(isAuthoritativeEntry(p), true, p);
  }
  assert.equal(isAuthoritativeEntry('secrets.env'), true);
  assert.equal(isAuthoritativeEntry('nodes/macbook-air.local.env'), true);
});

test('ordinary package names that merely resemble authority are not authority', () => {
  for (const p of [`${PNPM}/files/ab/package.json`, `${NPM}/_logs/2026.log`, 'checkpoints/cp1/untracked/app/node_modules/left-pad/index.js']) assert.equal(isAuthoritativeEntry(p), false, p);
});

// ---- 2. CLI flag parsing (the exact argv the CLI receives) ----

test('exclusion flags default off and map to the policy options', () => {
  assert.deepEqual(parseCaptureExclusionFlags([]), { ownerPolicy: false, runtimeReleases: 'all' });
  assert.deepEqual(parseCaptureExclusionFlags(['--exclude-owner-policy']), { ownerPolicy: true, runtimeReleases: 'all' });
  assert.deepEqual(parseCaptureExclusionFlags(['--exclude-superseded-runtime']), { ownerPolicy: false, runtimeReleases: 'current-and-rollback' });
  assert.deepEqual(parseCaptureExclusionFlags(['--exclude-owner-policy', '--exclude-superseded-runtime']), { ownerPolicy: true, runtimeReleases: 'current-and-rollback' });
});

test('an unknown or repeated exclusion flag is refused, never silently ignored', () => {
  assert.throws(() => parseCaptureExclusionFlags(['--exclude-everything']), /USAGE_UNKNOWN_EXCLUSION_FLAG/);
  assert.throws(() => parseCaptureExclusionFlags(['--exclude-owner-policy', '--exclude-owner-policy']), /USAGE_DUPLICATE_EXCLUSION_FLAG/);
});

// ---- 3. Synthetic fixture through the parsed flags into coverage inspection ----

async function seedCaches(state: string) {
  const write = async (relative: string, data: string) => { const f = path.join(state, relative); await fs.mkdir(path.dirname(f), { recursive: true, mode: 0o700 }); await fs.writeFile(f, data, { mode: 0o600 }); };
  await write(`${PNPM}/v3/files/ab/index.bin`, 'P'.repeat(512));
  await write(`${PNPM}/v3/store.json`, '{"synthetic":true}\n');
  await write(`${PNPM}/v3/events.jsonl`, '{"synthetic":1}\n');
  await write(`${NPM}/_cacache/events.jsonl`, '{"synthetic":2}\n');
}

test('with the owner-policy flag, ordinary cache store.json and events.jsonl are excluded and accounted, not refused', async () => {
  const w = await fixture();
  try {
    await seedCaches(w.source.state);
    const opts = parseCaptureExclusionFlags(['--exclude-owner-policy']);
    const m = await inspectCoverage(w.source, 'synthetic', undefined, { ownerExclusions: opts.ownerPolicy, runtimeReleases: opts.runtimeReleases });
    assert.ok(!m.problems.includes('EXCLUSION_HIDES_AUTHORITATIVE_FILE'), m.problems.join(','));
    const pnpm = m.exclusions.find(x => x.rule === 'compat-home-pnpm-store');
    const npm = m.exclusions.find(x => x.rule === 'compat-home-npm-cache');
    assert.ok(pnpm && pnpm.files === 3 && pnpm.bytes > 0, 'pnpm store excluded with explicit counts');
    assert.ok(npm && npm.files === 1, 'npm cache excluded with explicit counts');
    assert.equal(m.entries.some(e => e.relative.startsWith(PNPM)), false, 'excluded subtree is absent from verifiable entries');
  } finally { await w.cleanup(); }
});

test('without the flag the same cache content is included, and no exclusion is recorded', async () => {
  const w = await fixture();
  try {
    await seedCaches(w.source.state);
    const opts = parseCaptureExclusionFlags([]);
    const m = await inspectCoverage(w.source, 'synthetic', undefined, { ownerExclusions: opts.ownerPolicy, runtimeReleases: opts.runtimeReleases });
    assert.deepEqual(m.exclusions, []);
    assert.ok(m.entries.some(e => e.relative === `${PNPM}/v3/store.json`), 'included by default');
    assert.ok(!m.problems.includes('EXCLUSION_HIDES_AUTHORITATIVE_FILE'));
  } finally { await w.cleanup(); }
});

test('with the flag, a real secret placed in a cache tree still refuses: protection is kept', async () => {
  const w = await fixture();
  try {
    await seedCaches(w.source.state);
    await fs.writeFile(path.join(w.source.state, PNPM, 'v3', 'secrets.env'), 'SYNTHETIC_ONLY=cache-copy\n', { mode: 0o600 });
    const opts = parseCaptureExclusionFlags(['--exclude-owner-policy']);
    const m = await inspectCoverage(w.source, 'synthetic', undefined, { ownerExclusions: opts.ownerPolicy, runtimeReleases: opts.runtimeReleases });
    assert.ok(m.problems.includes('EXCLUSION_HIDES_AUTHORITATIVE_FILE'));
    assert.ok(EXCLUSION_REFUSALS.has('EXCLUSION_HIDES_AUTHORITATIVE_FILE'));
  } finally { await w.cleanup(); }
});

// ---- 4. The real CLI as a child process: flags are accepted and never bypass the live-target guard ----

test('capture-offline with both exclusion flags is refused by the live-target guard and writes nothing', async () => {
  const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'c14-excl-cli-'));
  try {
    const dest = path.join(sandbox, 'destination'), evidence = path.join(sandbox, 'evidence'), expectations = path.join(sandbox, 'expectations');
    await fs.mkdir(dest, { mode: 0o700 });
    const argv = ['--import', 'tsx', 'scripts/c14-recovery.ts', 'capture-offline', '--exclude-owner-policy', '--exclude-superseded-runtime',
      '--transaction-id', 'synthetic-txn-1', '--destination', dest, '--approved-device', '1', '--approved-inode', '1', '--approved-volume-uuid', 'SYNTHETIC',
      '--evidence-root', evidence, '--expectation-root', expectations];
    const result = await run(process.execPath, argv, { cwd: REPO, timeout: 60_000 }).then(r => ({ code: 0, out: r.stdout + r.stderr }), (e: NodeJS.ErrnoException & { code?: number | string; stdout?: string; stderr?: string }) => ({ code: typeof e.code === 'number' ? e.code : 1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` }));
    assert.notEqual(result.code, 0, 'the guard must refuse off the owner host');
    assert.ok(result.out.includes('RECOVERY_INSPECTION_REFUSED'), result.out.slice(0, 300));
    assert.ok(!result.out.includes('OFFLINE_BACKUP_CERTIFIED'));
    assert.deepEqual(await fs.readdir(dest), [], 'destination is empty');
    await assert.rejects(fs.access(evidence), 'no evidence root was created');
  } finally { await fs.rm(sandbox, { recursive: true, force: true }); }
});

test('capture-offline with an unknown exclusion flag is refused and writes nothing (the parser itself is covered in section 2)', async () => {
  const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'c14-excl-cli-'));
  try {
    const dest = path.join(sandbox, 'destination');
    await fs.mkdir(dest, { mode: 0o700 });
    const argv = ['--import', 'tsx', 'scripts/c14-recovery.ts', 'capture-offline', '--exclude-everything',
      '--transaction-id', 'synthetic-txn-2', '--destination', dest, '--approved-device', '1', '--approved-inode', '1', '--approved-volume-uuid', 'SYNTHETIC',
      '--evidence-root', path.join(sandbox, 'evidence'), '--expectation-root', path.join(sandbox, 'expectations')];
    const result = await run(process.execPath, argv, { cwd: REPO, timeout: 60_000 }).then(() => ({ code: 0, out: '' }), (e: NodeJS.ErrnoException & { code?: number | string; stdout?: string; stderr?: string }) => ({ code: typeof e.code === 'number' ? e.code : 1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` }));
    assert.notEqual(result.code, 0);
    assert.ok(!result.out.includes('OFFLINE_BACKUP_CERTIFIED'));
    assert.deepEqual(await fs.readdir(dest), []);
  } finally { await fs.rm(sandbox, { recursive: true, force: true }); }
});
