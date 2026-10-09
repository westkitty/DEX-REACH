import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  prepareRuntimeRollbackSnapshot,
  restoreRuntimeRollbackSnapshot,
  runtimeTreeSha256,
  validateRuntimeRollbackSnapshot,
  verifiedOnlineNodeCount,
  type RuntimeRollbackService
} from '../scripts/lib/runtime-rollback.js';
import { reloadLaunchdService } from '../scripts/lib/service-reloader.js';
import type { LaunchctlRunner } from '../scripts/lib/launchctl.js';

const labels = ['coordinator', 'worker', 'gateway', 'node', 'oauth-canary']
  .map(name => `com.stinkyweasel.dex-reach.${name}`);
const requiredEntries = [
  'dist/src/coordinator/main.js',
  'dist/src/worker/main.js',
  'dist/src/gateway/main.js',
  'dist/src/node/main.js',
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
}

async function fixture(): Promise<{
  base: string; stateDir: string; agentsDir: string; workerConfigPath: string;
  candidateId: string; previousId: string; candidateRoot: string; previousRoot: string;
  services: RuntimeRollbackService[]; candidatePlists: Record<string, string>;
  previousPlists: Map<string, string>; previousConfig: string; candidateConfig: string;
  snapshot: () => Promise<string>;
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
  const workerConfigPath = path.join(stateDir, 'workspace-worker', 'config.json');
  const previousConfig = '{"version":1,"nodeId":"macbook-air.local","allowedRoots":["/Users/andrew"],"rootsHash":"old-hash"}\n';
  const candidateConfig = '{"version":1,"nodeId":"macbook-air.local","allowedRoots":["/Users/andrew"],"rootsHash":"new-hash"}\n';
  await write(workerConfigPath, previousConfig);
  return {
    base, stateDir, agentsDir, workerConfigPath, candidateId, previousId, candidateRoot, previousRoot,
    services, candidatePlists, previousPlists, previousConfig, candidateConfig,
    snapshot: () => prepareRuntimeRollbackSnapshot({
      stateDir, agentsDir, candidateReleaseId: candidateId, candidateReleaseRoot: candidateRoot,
      services, candidatePlists, workerConfigPath, candidateWorkerConfig: candidateConfig
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
