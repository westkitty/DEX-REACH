import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  prepareRuntimeRollbackSnapshot,
  restoreRuntimeRollbackSnapshot,
  runtimeTreeSha256,
  validateRuntimeRollbackSnapshot,
  verifyTrustedLegacyRuntimeRelease,
  verifiedOnlineNodeCount,
  type RuntimeRollbackService
} from '../scripts/lib/runtime-rollback.js';
import { reloadLaunchdService } from '../scripts/lib/service-reloader.js';
import type { LaunchctlRunner } from '../scripts/lib/launchctl.js';
import { verifyRuntimeRelease } from '../scripts/lib/runtime-release.js';

const labels = ['coordinator', 'worker', 'gateway', 'node', 'oauth-canary']
  .map(name => `com.stinkyweasel.dex-reach.${name}`);
const requiredEntries = [
  'dist/src/coordinator/main.js',
  'dist/src/worker/main.js',
  'dist/src/gateway/main.js',
  'dist/src/node/main.js',
  'dist/src/node/compat-runtime/package.json',
  'dist/src/node/compat-runtime/runtime-files.json',
  'dist/src/node/compat-runtime/source-hashes.json',
  'dist/src/node/compat-runtime/runtime/index.js',
  'dist/src/node/compat-runtime/runtime/server.js',
  'dist/scripts/oauth-canary.js',
  'dist/scripts/reload-launchagents.js',
  'node_modules/@modelcontextprotocol/client/package.json'
];

test('rollback health receipt preserves the verified online-node count', () => {
  assert.equal(verifiedOnlineNodeCount(true, 2), 2);
  assert.equal(verifiedOnlineNodeCount(true, 0), null);
  assert.equal(verifiedOnlineNodeCount(false, 1), null);
  assert.equal(verifiedOnlineNodeCount(true, 1.5), null);
});

async function write(file: string, value: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, value);
}

function plist(label: string, release: string, root: string): string {
  const entry = label.endsWith('.coordinator') ? 'dist/src/coordinator/main.js'
    : label.endsWith('.worker') ? 'dist/src/worker/main.js'
      : label.endsWith('.gateway') ? 'dist/src/gateway/main.js'
        : label.endsWith('.node') ? 'dist/src/node/main.js' : 'dist/scripts/oauth-canary.js';
  return `<?xml version="1.0"?><plist><dict><key>Label</key><string>${label}</string><key>ProgramArguments</key><array><string>/usr/bin/node</string><string>${root}/${entry}</string></array><key>WorkingDirectory</key><string>${root}</string></dict></plist>\n`;
}

async function release(root: string): Promise<void> {
  for (const entry of requiredEntries) await write(path.join(root, entry), `fixture:${entry}`);
  const packageRoot = path.join(root, 'dist/src/node/compat-runtime');
  const files: Record<string, string> = {
    'package.json': JSON.stringify({ name: '@dex-reach/native-backend', version: 'test' }),
    'runtime-files.json': JSON.stringify(['index.js', 'server.js']),
    'LICENSE': 'test license', 'NOTICE.md': 'test notice',
    'runtime/index.js': 'test entry', 'runtime/server.js': 'test server'
  };
  const hashes: Record<string, string> = {};
  for (const [file, value] of Object.entries(files)) {
    await write(path.join(packageRoot, file), value);
    hashes[file] = crypto.createHash('sha256').update(value).digest('hex');
  }
  await write(path.join(packageRoot, 'source-hashes.json'), JSON.stringify(hashes));
}

async function markAsLegacyAndTrust(f: Awaited<ReturnType<typeof fixture>>): Promise<string> {
  await fs.rm(path.join(f.previousRoot, 'dist/src/node/compat-runtime'), { recursive: true, force: true });
  await write(path.join(f.previousRoot, 'package.json'), JSON.stringify({ name: 'dex-reach', version: '0.3.2' }));
  await write(path.join(f.previousRoot, 'package-lock.json'), JSON.stringify({
    name: 'dex-reach', version: '0.3.2', lockfileVersion: 3,
    packages: { '': { name: 'dex-reach', version: '0.3.2' } }
  }));
  const digest = await runtimeTreeSha256(f.previousRoot);
  const olderId = '0.3.2-older-retained';
  const snapshot = {
    schemaVersion: 1,
    candidateReleaseId: f.previousId,
    candidateReleaseSha256: digest,
    previousReleaseId: olderId,
    preparedAt: new Date(0).toISOString(),
    previousReleaseSha256: 'a'.repeat(64),
    services: f.services.map(service => {
      const oldText = plist(service.label, olderId, path.join(f.stateDir, 'runtime', 'releases', olderId));
      return { label: service.label, file: {
        path: service.target,
        previousBase64: Buffer.from(oldText).toString('base64'),
        previousSha256: crypto.createHash('sha256').update(oldText).digest('hex'),
        candidateSha256: 'b'.repeat(64)
      } };
    }),
    workerConfig: {
      path: f.workerConfigPath,
      previousBase64: Buffer.from(f.previousConfig).toString('base64'),
      previousSha256: crypto.createHash('sha256').update(f.previousConfig).digest('hex'),
      candidateSha256: 'c'.repeat(64)
    }
  };
  const directory = path.join(f.stateDir, 'runtime', 'rollback', f.previousId);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await fs.chmod(directory, 0o700);
  await fs.writeFile(path.join(directory, 'snapshot.json'), `${JSON.stringify(snapshot)}\n`, { mode: 0o600 });
  await fs.chmod(path.join(directory, 'snapshot.json'), 0o600);
  return digest;
}

async function fixture(workerLocation: 'inside' | 'sibling' = 'inside'): Promise<{
  base: string; stateDir: string; agentsDir: string; workerConfigPath: string;
  candidateId: string; previousId: string; candidateRoot: string; previousRoot: string;
  services: RuntimeRollbackService[]; candidatePlists: Record<string, string>;
  previousPlists: Map<string, string>; previousConfig: string; candidateConfig: string;
  snapshot: (workerConfigOverride?: string) => Promise<string>;
}> {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'dex-runtime-rollback-'));
  const stateDir = path.join(base, 'state');
  const agentsDir = path.join(base, 'LaunchAgents');
  const previousId = '0.3.2-known-good';
  const candidateId = '0.3.2-candidate';
  const releasesDir = path.join(stateDir, 'runtime', 'releases');
  const previousRoot = path.join(releasesDir, previousId);
  const candidateRoot = path.join(releasesDir, candidateId);
  await release(previousRoot);
  await release(candidateRoot);
  const services = labels.map(label => ({ label, target: path.join(agentsDir, `${label}.plist`) }));
  const previousPlists = new Map<string, string>();
  const candidatePlists: Record<string, string> = {};
  for (const service of services) {
    const old = plist(service.label, previousId, previousRoot);
    const next = plist(service.label, candidateId, candidateRoot);
    previousPlists.set(service.label, old);
    candidatePlists[service.label] = next;
    await write(service.target, old);
  }
  const workerConfigPath = workerLocation === 'sibling'
    ? path.join(base, '.dex-reach-worker', 'config.json')
    : path.join(stateDir, 'workspace-worker', 'config.json');
  const previousConfig = '{"version":1,"nodeId":"macbook-air.local","allowedRoots":["/Users/andrew"],"rootsHash":"old-hash"}\n';
  const candidateConfig = '{"version":1,"nodeId":"macbook-air.local","allowedRoots":["/Users/andrew"],"rootsHash":"new-hash"}\n';
  await write(workerConfigPath, previousConfig);
  if (workerLocation === 'sibling') {
    await fs.chmod(path.dirname(workerConfigPath), 0o700);
    await fs.chmod(workerConfigPath, 0o600);
  }
  return {
    base, stateDir, agentsDir, workerConfigPath, candidateId, previousId, candidateRoot, previousRoot,
    services, candidatePlists, previousPlists, previousConfig, candidateConfig,
    snapshot: (workerConfigOverride = workerConfigPath) => prepareRuntimeRollbackSnapshot({
      stateDir, agentsDir, candidateReleaseId: candidateId, candidateReleaseRoot: candidateRoot,
      services, candidatePlists, workerConfigPath: workerConfigOverride, candidateWorkerConfig: candidateConfig
    }).then(value => {
      if (!value) throw new Error('expected a previous runtime snapshot');
      return value;
    })
  };
}

test('pre-activation snapshot pins exact old runtime and candidate and excludes credential contents', async () => {
  const f = await fixture();
  try {
    await write(path.join(f.stateDir, 'secrets.env'), 'REFRESH_TOKEN=SECRET_VALUE\n');
    const snapshotPath = await f.snapshot();
    const snapshot = JSON.parse(await fs.readFile(snapshotPath, 'utf8')) as {
      candidateReleaseId: string; candidateReleaseSha256: string; previousReleaseId: string;
      previousReleaseSha256: string; services: Array<{ file: { previousSha256: string } }>;
    };
    assert.equal(snapshot.candidateReleaseId, f.candidateId);
    assert.equal(snapshot.previousReleaseId, f.previousId);
    assert.match(snapshot.candidateReleaseSha256, /^[a-f0-9]{64}$/);
    assert.equal(snapshot.previousReleaseSha256, await runtimeTreeSha256(f.previousRoot));
    assert.equal(snapshot.services.length, 5);
    assert.equal((await fs.stat(path.dirname(snapshotPath))).mode & 0o777, 0o700);
    assert.equal((await fs.stat(snapshotPath)).mode & 0o777, 0o600);
    assert.doesNotMatch(await fs.readFile(snapshotPath, 'utf8'), /SECRET_VALUE|REFRESH_TOKEN/);
  } finally { await fs.rm(f.base, { recursive: true, force: true }); }
});

test('exact owner-private sibling worker config is captured and restored without widening targets', async () => {
  const f = await fixture('sibling');
  try {
    const snapshotPath = await f.snapshot();
    const snapshot = JSON.parse(await fs.readFile(snapshotPath, 'utf8')) as { workerConfig: { path: string } };
    assert.equal(snapshot.workerConfig.path, f.workerConfigPath);
    for (const service of f.services) await write(service.target, f.candidatePlists[service.label]!);
    await write(f.workerConfigPath, f.candidateConfig);
    const input = { snapshotPath, stateDir: f.stateDir, agentsDir: f.agentsDir,
      workerConfigPath: f.workerConfigPath, services: f.services };
    assert.equal(await validateRuntimeRollbackSnapshot(input), f.previousId);
    assert.equal(await restoreRuntimeRollbackSnapshot(input), f.previousId);
    assert.equal(await fs.readFile(f.workerConfigPath, 'utf8'), f.previousConfig);
  } finally { await fs.rm(f.base, { recursive: true, force: true }); }
});

test('worker config guard refuses arbitrary sibling paths and symlinked dedicated directories', async () => {
  const f = await fixture('sibling');
  try {
    const original = f.workerConfigPath;
    f.workerConfigPath = path.join(f.base, 'unrelated', 'config.json');
    await write(f.workerConfigPath, f.previousConfig);
    await assert.rejects(f.snapshot(f.workerConfigPath), /outside the two approved locations/);
    f.workerConfigPath = original;
    await fs.rename(path.dirname(original), path.join(f.base, 'saved-worker-dir'));
    await fs.symlink(path.join(f.base, 'saved-worker-dir'), path.dirname(original), 'dir');
    await assert.rejects(f.snapshot(), /not owner-private and non-symlinked/);
  } finally { await fs.rm(f.base, { recursive: true, force: true }); }
});

test('failed candidate preflight writes no rollback or active-state files', async () => {
  const f = await fixture();
  try {
    const before = await Promise.all(f.services.map(service => fs.readFile(service.target, 'utf8')));
    await fs.rm(f.candidateRoot, { recursive: true, force: true });
    await assert.rejects(f.snapshot(), /runtime release is incomplete/);
    assert.deepEqual(await Promise.all(f.services.map(service => fs.readFile(service.target, 'utf8'))), before);
    await assert.rejects(fs.stat(path.join(f.stateDir, 'runtime', 'rollback')), { code: 'ENOENT' });
  } finally { await fs.rm(f.base, { recursive: true, force: true }); }
});

test('missing or mixed previous release fails closed before snapshot creation', async () => {
  const missing = await fixture();
  try {
    await fs.rm(missing.previousRoot, { recursive: true, force: true });
    await assert.rejects(missing.snapshot(), /runtime release is incomplete/);
    await assert.rejects(fs.stat(path.join(missing.stateDir, 'runtime', 'rollback')), { code: 'ENOENT' });
  } finally { await fs.rm(missing.base, { recursive: true, force: true }); }

  const mixed = await fixture();
  try {
    const first = mixed.services[0]!;
    await write(first.target, plist(first.label, '0.3.2-unrecognized', path.join(mixed.stateDir, 'runtime', 'releases', '0.3.2-unrecognized')));
    await assert.rejects(mixed.snapshot(), /active LaunchAgents do not share one runtime release/);
    await assert.rejects(fs.stat(path.join(mixed.stateDir, 'runtime', 'rollback')), { code: 'ENOENT' });
  } finally { await fs.rm(mixed.base, { recursive: true, force: true }); }
});

test('candidate revision mismatch is rejected without replacing active LaunchAgents', async () => {
  const f = await fixture();
  try {
    const first = f.services[0]!;
    const before = await fs.readFile(first.target, 'utf8');
    f.candidatePlists[first.label] = plist(first.label, '0.3.2-other', path.join(f.stateDir, 'runtime', 'releases', '0.3.2-other'));
    await assert.rejects(f.snapshot(), /candidate LaunchAgent does not match candidate release|runtime root mismatch/);
    assert.equal(await fs.readFile(first.target, 'utf8'), before);
    await assert.rejects(fs.stat(path.join(f.stateDir, 'runtime', 'rollback')), { code: 'ENOENT' });
  } finally { await fs.rm(f.base, { recursive: true, force: true }); }
});

test('rollback restores prior revision and generated worker config repeatedly', async () => {
  const f = await fixture();
  try {
    const snapshotPath = await f.snapshot();
    for (const service of f.services) await write(service.target, f.candidatePlists[service.label]!);
    await write(f.workerConfigPath, f.candidateConfig);
    const input = {
      snapshotPath, stateDir: f.stateDir, agentsDir: f.agentsDir,
      workerConfigPath: f.workerConfigPath, services: f.services
    };
    assert.equal(await restoreRuntimeRollbackSnapshot(input), f.previousId);
    assert.equal(await restoreRuntimeRollbackSnapshot(input), f.previousId, 'a repeated rollback is idempotent');
    assert.deepEqual(await Promise.all(f.services.map(service => fs.readFile(service.target, 'utf8'))), f.services.map(service => f.previousPlists.get(service.label)));
    assert.equal(await fs.readFile(f.workerConfigPath, 'utf8'), f.previousConfig);
  } finally { await fs.rm(f.base, { recursive: true, force: true }); }
});

test('partial failed activation can be restored while unrelated persistent state stays byte-identical', async () => {
  const f = await fixture();
  try {
    const snapshotPath = await f.snapshot();
    for (const service of f.services.slice(0, 2)) await write(service.target, f.candidatePlists[service.label]!);
    await write(f.workerConfigPath, f.candidateConfig);
    const protectedFiles = [
      'secrets.env', 'task-store.json', 'receipts.json', 'policy.json', 'grants.json', 'budgets.json',
      'nodes/macbook-air.local.access.json'
    ];
    const protectedBefore = new Map<string, string>();
    for (const name of protectedFiles) {
      const file = path.join(f.stateDir, name);
      await write(file, `preserved:${name}`);
      protectedBefore.set(file, await fs.readFile(file, 'utf8'));
    }
    await restoreRuntimeRollbackSnapshot({
      snapshotPath, stateDir: f.stateDir, agentsDir: f.agentsDir,
      workerConfigPath: f.workerConfigPath, services: f.services
    });
    for (const [file, value] of protectedBefore) assert.equal(await fs.readFile(file, 'utf8'), value);
    assert.equal(await fs.readFile(f.workerConfigPath, 'utf8'), f.previousConfig);
  } finally { await fs.rm(f.base, { recursive: true, force: true }); }
});

test('rollback remains available when the installed candidate tree is damaged', async () => {
  const f = await fixture();
  try {
    const snapshotPath = await f.snapshot();
    for (const service of f.services) await write(service.target, f.candidatePlists[service.label]!);
    await write(f.workerConfigPath, f.candidateConfig);
    await write(path.join(f.candidateRoot, 'dist/src/gateway/main.js'), 'damaged after install');
    const input = { snapshotPath, stateDir: f.stateDir, agentsDir: f.agentsDir,
      workerConfigPath: f.workerConfigPath, services: f.services };
    assert.equal(await validateRuntimeRollbackSnapshot(input), f.previousId);
    assert.equal(await restoreRuntimeRollbackSnapshot(input), f.previousId);
    assert.deepEqual(await Promise.all(f.services.map(service => fs.readFile(service.target, 'utf8'))),
      f.services.map(service => f.previousPlists.get(service.label)));
  } finally { await fs.rm(f.base, { recursive: true, force: true }); }
});

test('ambiguous service activation after restore is recoverable by repeating rollback and reload', async () => {
  const f = await fixture();
  try {
    const snapshotPath = await f.snapshot();
    for (const service of f.services) await write(service.target, f.candidatePlists[service.label]!);
    await write(f.workerConfigPath, f.candidateConfig);
    const input = { snapshotPath, stateDir: f.stateDir, agentsDir: f.agentsDir, workerConfigPath: f.workerConfigPath, services: f.services };
    await restoreRuntimeRollbackSnapshot(input);

    let running = false;
    let failBootstrap = true;
    let pid = 700;
    const calls: string[][] = [];
    const runner: LaunchctlRunner = async args => {
      calls.push(args);
      if (args[0] === 'bootout') { running = false; return { stdout: '', stderr: '' }; }
      if (args[0] === 'bootstrap') {
        if (failBootstrap) throw Object.assign(new Error('launchctl timed out'), { code: 'ETIMEDOUT' });
        running = true;
        return { stdout: '', stderr: '' };
      }
      if (args[0] === 'print') return { stdout: running ? `state = running\n pid = ${pid}\n` : 'state = spawn scheduled\nlast exit code = 78\n', stderr: '' };
      return { stdout: '', stderr: '' };
    };
    const firstService = f.services[0]!;
    await assert.rejects(reloadLaunchdService(firstService, 'gui/501', runner), /was not proven/);
    assert.equal(running, false);

    await restoreRuntimeRollbackSnapshot(input);
    failBootstrap = false;
    pid += 1;
    await reloadLaunchdService(firstService, 'gui/501', runner);
    assert.equal(running, true);
    assert.deepEqual(calls.filter(args => args[0] === 'bootstrap').length, 2);
    assert.equal(await fs.readFile(firstService.target, 'utf8'), f.previousPlists.get(firstService.label));
  } finally { await fs.rm(f.base, { recursive: true, force: true }); }
});

test('ambiguous changed LaunchAgent or worker config refuses all restoration writes', async () => {
  const f = await fixture();
  try {
    const snapshotPath = await f.snapshot();
    const first = f.services[0]!;
    await write(first.target, '<plist>owner changed this after candidate activation</plist>');
    for (const service of f.services.slice(1)) await write(service.target, f.candidatePlists[service.label]!);
    await write(f.workerConfigPath, f.candidateConfig);
    const before = await Promise.all(f.services.map(service => fs.readFile(service.target, 'utf8')));
    await assert.rejects(restoreRuntimeRollbackSnapshot({
      snapshotPath, stateDir: f.stateDir, agentsDir: f.agentsDir,
      workerConfigPath: f.workerConfigPath, services: f.services
    }), /ambiguous LaunchAgent state/);
    assert.deepEqual(await Promise.all(f.services.map(service => fs.readFile(service.target, 'utf8'))), before);
    assert.equal(await fs.readFile(f.workerConfigPath, 'utf8'), f.candidateConfig);
  } finally { await fs.rm(f.base, { recursive: true, force: true }); }
});

test('unexpected worker configuration fails closed before LaunchAgent restoration', async () => {
  const f = await fixture();
  try {
    const snapshotPath = await f.snapshot();
    for (const service of f.services) await write(service.target, f.candidatePlists[service.label]!);
    await write(f.workerConfigPath, '{"version":1,"rootsHash":"owner-changed"}\n');
    const before = await Promise.all(f.services.map(service => fs.readFile(service.target, 'utf8')));
    await assert.rejects(restoreRuntimeRollbackSnapshot({
      snapshotPath, stateDir: f.stateDir, agentsDir: f.agentsDir,
      workerConfigPath: f.workerConfigPath, services: f.services, candidateReleaseId: f.candidateId
    }), /ambiguous worker configuration state/);
    assert.deepEqual(await Promise.all(f.services.map(service => fs.readFile(service.target, 'utf8'))), before);
  } finally { await fs.rm(f.base, { recursive: true, force: true }); }
});

test('rollback command cannot use a snapshot belonging to a different candidate id', async () => {
  const f = await fixture();
  try {
    const snapshotPath = await f.snapshot();
    await assert.rejects(validateRuntimeRollbackSnapshot({
      snapshotPath, stateDir: f.stateDir, agentsDir: f.agentsDir,
      workerConfigPath: f.workerConfigPath, services: f.services, candidateReleaseId: '0.3.2-other'
    }), /candidate revision mismatch/);
  } finally { await fs.rm(f.base, { recursive: true, force: true }); }
});

test('service reload keeps at most one live process for its LaunchAgent label', async () => {
  const f = await fixture();
  try {
    let runningPid: number | null = 88;
    let maximum = 1;
    const runner: LaunchctlRunner = async args => {
      if (args[0] === 'bootout') { runningPid = null; return { stdout: '', stderr: '' }; }
      if (args[0] === 'bootstrap') {
        if (runningPid !== null) maximum = Math.max(maximum, 2);
        else runningPid = 89;
        return { stdout: '', stderr: '' };
      }
      if (args[0] === 'kickstart') {
        if (runningPid === null) runningPid = 89;
        return { stdout: '', stderr: '' };
      }
      if (args[0] === 'print') return { stdout: runningPid === null ? 'state = not running\n' : `state = running\n pid = ${runningPid}\n`, stderr: '' };
      return { stdout: '', stderr: '' };
    };
    const firstService = f.services[0]!;
    await reloadLaunchdService(firstService, 'gui/501', runner);
    assert.equal(maximum, 1);
    assert.equal(runningPid, 89);
  } finally { await fs.rm(f.base, { recursive: true, force: true }); }
});

test('modified prior runtime fails its integrity check before restoration', async () => {
  const f = await fixture();
  try {
    const snapshotPath = await f.snapshot();
    for (const service of f.services) await write(service.target, f.candidatePlists[service.label]!);
    await write(f.workerConfigPath, f.candidateConfig);
    await write(path.join(f.previousRoot, 'dist/src/node/main.js'), 'tampered');
    await assert.rejects(restoreRuntimeRollbackSnapshot({
      snapshotPath, stateDir: f.stateDir, agentsDir: f.agentsDir,
      workerConfigPath: f.workerConfigPath, services: f.services
    }), /previous runtime integrity check failed/);
    const first = f.services[0]!;
    assert.equal(await fs.readFile(first.target, 'utf8'), f.candidatePlists[first.label]);
  } finally { await fs.rm(f.base, { recursive: true, force: true }); }
});

test('authenticated pre-native legacy release passes recovery verification while strict candidate verification rejects it', async () => {
  const f = await fixture();
  try {
    const digest = await markAsLegacyAndTrust(f);
    await assert.rejects(verifyRuntimeRelease(f.previousRoot), /missing dist\/src\/node\/compat-runtime\/package\.json/);
    await verifyTrustedLegacyRuntimeRelease({ stateDir: f.stateDir, releaseId: f.previousId, expectedTreeSha256: digest });
    assert.equal(await runtimeTreeSha256(f.previousRoot), digest);
  } finally { await fs.rm(f.base, { recursive: true, force: true }); }
});

test('legacy previous release participates in snapshot preparation and read-only restore preflight', async () => {
  const f = await fixture();
  try {
    const digest = await markAsLegacyAndTrust(f);
    const snapshotPath = await f.snapshot();
    const snapshot = JSON.parse(await fs.readFile(snapshotPath, 'utf8')) as { previousReleaseId: string; previousReleaseSha256: string };
    assert.equal(snapshot.previousReleaseId, f.previousId);
    assert.equal(snapshot.previousReleaseSha256, digest);
    for (const service of f.services) await write(service.target, f.candidatePlists[service.label]!);
    await write(f.workerConfigPath, f.candidateConfig);
    assert.equal(await validateRuntimeRollbackSnapshot({ snapshotPath, stateDir: f.stateDir, agentsDir: f.agentsDir,
      workerConfigPath: f.workerConfigPath, services: f.services }), f.previousId);
  } finally { await fs.rm(f.base, { recursive: true, force: true }); }
});

test('legacy recovery refuses unknown identity, missing or public provenance, and mismatched expected digest', async () => {
  const f = await fixture();
  try {
    const digest = await markAsLegacyAndTrust(f);
    await assert.rejects(verifyTrustedLegacyRuntimeRelease({ stateDir: f.stateDir, releaseId: '0.3.2-fabricated', expectedTreeSha256: digest }), /provenance is missing/);
    await assert.rejects(verifyTrustedLegacyRuntimeRelease({ stateDir: f.stateDir, releaseId: f.previousId, expectedTreeSha256: 'd'.repeat(64) }), /identity or digest mismatch/);
    const snapshotPath = path.join(f.stateDir, 'runtime/rollback', f.previousId, 'snapshot.json');
    await fs.chmod(snapshotPath, 0o644);
    await assert.rejects(verifyTrustedLegacyRuntimeRelease({ stateDir: f.stateDir, releaseId: f.previousId, expectedTreeSha256: digest }), /provenance is not owner-private/);
    await fs.rm(snapshotPath);
    await assert.rejects(verifyTrustedLegacyRuntimeRelease({ stateDir: f.stateDir, releaseId: f.previousId, expectedTreeSha256: digest }), /provenance is missing/);
  } finally { await fs.rm(f.base, { recursive: true, force: true }); }
});

test('legacy recovery rejects tampered files, changed modes, missing runtime entry points, and escaping links', async () => {
  const f = await fixture();
  try {
    const digest = await markAsLegacyAndTrust(f);
    const main = path.join(f.previousRoot, 'dist/src/node/main.js');
    await write(main, 'changed');
    await assert.rejects(verifyTrustedLegacyRuntimeRelease({ stateDir: f.stateDir, releaseId: f.previousId, expectedTreeSha256: digest }), /integrity check failed/);
    await write(main, 'fixture:dist/src/node/main.js');
    await fs.chmod(main, 0o600);
    await assert.rejects(verifyTrustedLegacyRuntimeRelease({ stateDir: f.stateDir, releaseId: f.previousId, expectedTreeSha256: digest }), /integrity check failed/);
    await fs.chmod(main, 0o644);
    await fs.rm(path.join(f.previousRoot, 'dist/src/gateway/main.js'));
    await assert.rejects(verifyTrustedLegacyRuntimeRelease({ stateDir: f.stateDir, releaseId: f.previousId, expectedTreeSha256: digest }), /missing dist\/src\/gateway\/main\.js/);
  } finally { await fs.rm(f.base, { recursive: true, force: true }); }

  const linked = await fixture();
  try {
    const digest = await markAsLegacyAndTrust(linked);
    const external = path.join(linked.base, 'external.txt');
    await write(external, 'outside');
    await fs.symlink(external, path.join(linked.previousRoot, 'escape'));
    await assert.rejects(verifyTrustedLegacyRuntimeRelease({ stateDir: linked.stateDir, releaseId: linked.previousId, expectedTreeSha256: digest }), /link escapes its release/);
  } finally { await fs.rm(linked.base, { recursive: true, force: true }); }
});

test('partial native packaging cannot use the legacy recovery path', async () => {
  const f = await fixture();
  try {
    const digest = await markAsLegacyAndTrust(f);
    const packageRoot = path.join(f.previousRoot, 'dist/src/node/compat-runtime');
    await write(path.join(packageRoot, 'runtime/index.js'), 'partial');
    await assert.rejects(verifyTrustedLegacyRuntimeRelease({ stateDir: f.stateDir, releaseId: f.previousId, expectedTreeSha256: digest }), /partial native compatibility package/);
    await fs.rm(packageRoot, { recursive: true, force: true });
    await write(path.join(packageRoot, 'package.json'), JSON.stringify({ name: '@dex-reach/native-backend' }));
    await assert.rejects(verifyTrustedLegacyRuntimeRelease({ stateDir: f.stateDir, releaseId: f.previousId, expectedTreeSha256: digest }), /partial native compatibility package/);
  } finally { await fs.rm(f.base, { recursive: true, force: true }); }
});

test('legacy package lock must match a supported historical format', async () => {
  const f = await fixture();
  try {
    const digest = await markAsLegacyAndTrust(f);
    await write(path.join(f.previousRoot, 'package-lock.json'), JSON.stringify({
      name: 'dex-reach', version: '0.3.2', lockfileVersion: 4
    }));
    await assert.rejects(verifyTrustedLegacyRuntimeRelease({ stateDir: f.stateDir, releaseId: f.previousId, expectedTreeSha256: digest }), /package identity does not match/);
  } finally { await fs.rm(f.base, { recursive: true, force: true }); }
});

test('malformed provenance and a snapshot bound to the wrong previous release fail before restoration writes', async () => {
  const malformed = await fixture();
  try {
    const digest = await markAsLegacyAndTrust(malformed);
    const anchor = path.join(malformed.stateDir, 'runtime/rollback', malformed.previousId, 'snapshot.json');
    await fs.writeFile(anchor, '{broken');
    await assert.rejects(verifyTrustedLegacyRuntimeRelease({ stateDir: malformed.stateDir, releaseId: malformed.previousId, expectedTreeSha256: digest }), /provenance is invalid/);
  } finally { await fs.rm(malformed.base, { recursive: true, force: true }); }

  const wrong = await fixture();
  try {
    const snapshotPath = await wrong.snapshot();
    const raw = JSON.parse(await fs.readFile(snapshotPath, 'utf8')) as { previousReleaseId: string };
    raw.previousReleaseId = '0.3.2-other-release';
    await fs.writeFile(snapshotPath, `${JSON.stringify(raw)}\n`);
    const before = await Promise.all(wrong.services.map(service => fs.readFile(service.target, 'utf8')));
    await assert.rejects(validateRuntimeRollbackSnapshot({ snapshotPath, stateDir: wrong.stateDir, agentsDir: wrong.agentsDir,
      workerConfigPath: wrong.workerConfigPath, services: wrong.services }), /saved LaunchAgent integrity mismatch/);
    assert.deepEqual(await Promise.all(wrong.services.map(service => fs.readFile(service.target, 'utf8'))), before);
  } finally { await fs.rm(wrong.base, { recursive: true, force: true }); }
});

test('repeated legacy verification is deterministic and does not mutate the release or owner files', async () => {
  const f = await fixture();
  try {
    const digest = await markAsLegacyAndTrust(f);
    const before = await runtimeTreeSha256(f.previousRoot);
    const agentsBefore = await Promise.all(f.services.map(service => fs.readFile(service.target)));
    const configBefore = await fs.readFile(f.workerConfigPath);
    for (let i = 0; i < 3; i++) await verifyTrustedLegacyRuntimeRelease({ stateDir: f.stateDir, releaseId: f.previousId, expectedTreeSha256: digest });
    assert.equal(await runtimeTreeSha256(f.previousRoot), before);
    assert.deepEqual(await Promise.all(f.services.map(service => fs.readFile(service.target))), agentsBefore);
    assert.deepEqual(await fs.readFile(f.workerConfigPath), configBefore);
  } finally { await fs.rm(f.base, { recursive: true, force: true }); }
});
