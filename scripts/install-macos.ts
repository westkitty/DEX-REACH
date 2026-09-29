import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stateDir } from '../src/shared/local-env.js';
import { readEnvFile } from './lib/node-files.js';
import { atomicWriteFile } from '../src/shared/state-io.js';
import { DEX_REACH_VERSION } from '../src/shared/version.js';
import { launchdIntervalPlist, launchdOneShotPlist, launchdPlist, servicePath } from './lib/service.js';
import { buildRuntimeRelease, runtimeReleaseId } from './lib/runtime-release.js';
import { workspaceWorkerConfigFile, workspaceWorkerDir, workspaceWorkerRootsHash } from '../src/shared/workspace-worker.js';
import { execFileDeadline } from './lib/process-deadline.js';
import { restorePlist, snapshotPlist } from './lib/plist-rollback.js';
import { acquireInstallLock } from './lib/install-lock.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const agentsDir = path.join(os.homedir(), 'Library', 'LaunchAgents');
const localStateDir = stateDir();
const logsDir = path.join(localStateDir, 'logs');
const domain = `gui/${process.getuid?.() ?? os.userInfo().uid}`;
const nodeBin = process.execPath;
const installStatus = path.join(localStateDir, 'install-macos.status.json');
const rollbackDir = path.join(localStateDir, 'install-rollback', `${Date.now()}-${process.pid}`);
const installLock = await acquireInstallLock(localStateDir);

await fs.mkdir(agentsDir, { recursive: true });
await fs.mkdir(logsDir, { recursive: true, mode: 0o700 });

const releaseId = await runtimeReleaseId(root, DEX_REACH_VERSION);
const runtimeRoot = await buildRuntimeRelease(root, localStateDir, releaseId, nodeBin);
const sourceNodeBin = path.join(root, 'node_modules', '.bin');
const inheritedPath = (process.env.PATH || '').split(path.delimiter)
  .filter(entry => path.resolve(entry) !== path.resolve(sourceNodeBin))
  .join(path.delimiter);
const pathEnv = servicePath(nodeBin, inheritedPath, runtimeRoot);
const helperEntry = path.join(runtimeRoot, 'dist', 'scripts', 'reload-launchagents.js');
console.log(`Staged immutable runtime release ${runtimeRoot}`);

const ownerEnv = await readEnvFile(path.join(localStateDir, 'secrets.env')).catch((): Record<string, string> => ({}));
const gatewayPort = Number(ownerEnv.DEX_REACH_GATEWAY_PORT || 8787);
if (!Number.isInteger(gatewayPort) || gatewayPort < 1 || gatewayPort > 65535) throw new Error('invalid DEX_REACH_GATEWAY_PORT');
const healthUrl = `http://127.0.0.1:${gatewayPort}/healthz`;
const currentNodeId = process.env.DEX_REACH_NODE_ID || ownerEnv.DEX_REACH_NODE_ID || os.hostname().toLowerCase().replace(/[^a-z0-9._-]+/g, '-');
const nodeEnv = path.join(localStateDir, 'nodes', `${currentNodeId}.env`);
const nodeSettings = await readEnvFile(nodeEnv);
const workerNodeId = nodeSettings.DEX_REACH_NODE_ID || currentNodeId;
// Parsed exactly as `loadNodeConfig` parses it, including the order: empty segments are dropped
// before resolution, because `path.resolve('')` is the installer's working directory. Resolving
// first would write that directory into the worker's allowed roots and put the roots hash out of
// step with the node's, leaving the worker permanently unusable for a trailing `:` in the env.
const workerRoots = (nodeSettings.DEX_REACH_ALLOWED_ROOTS || os.homedir())
  .split(path.delimiter).map(root => root.trim()).filter(Boolean).map(root => path.resolve(root));
if (!workerRoots.length) throw new Error('workspace worker requires at least one configured node root');
await fs.mkdir(workspaceWorkerDir(), { recursive: true, mode: 0o700 });
await fs.chmod(workspaceWorkerDir(), 0o700);
await atomicWriteFile(workspaceWorkerConfigFile(), JSON.stringify({
  version: 1,
  nodeId: workerNodeId,
  allowedRoots: workerRoots,
  rootsHash: workspaceWorkerRootsHash(workerRoots)
}, null, 2) + '\n', 0o600);

type InstallService = { label: string; entry: string; envFile?: string; stateDir?: string; target: string; rollbackTarget?: string; candidateTarget?: string };

const services: InstallService[] = [
  { label: 'com.stinkyweasel.dex-reach.coordinator', entry: 'dist/src/coordinator/main.js', envFile: undefined, stateDir: localStateDir },
  { label: 'com.stinkyweasel.dex-reach.worker', entry: 'dist/src/worker/main.js', envFile: undefined, stateDir: undefined },
  { label: 'com.stinkyweasel.dex-reach.gateway', entry: 'dist/src/gateway/main.js', envFile: undefined, stateDir: localStateDir },
  { label: 'com.stinkyweasel.dex-reach.node', entry: 'dist/src/node/main.js', envFile: nodeEnv, stateDir: localStateDir }
].map(service => ({ ...service, target: path.join(agentsDir, `${service.label}.plist`) }));

await fs.mkdir(rollbackDir, { recursive: true, mode: 0o700 });
for (const service of services) {
  const backup = path.join(rollbackDir, `${service.label}.plist`);
  if (await snapshotPlist(service.target, backup)) service.rollbackTarget = backup;
}

// Build and lint every candidate definition in private staging before replacing any live plist.
// A syntax/validation failure therefore leaves the currently installed definitions untouched.
for (const service of services) {
  service.candidateTarget = path.join(rollbackDir, `${service.label}.candidate.plist`);
  await atomicWriteFile(service.candidateTarget, launchdPlist({
    label: service.label,
    entry: service.entry,
    envFile: service.envFile,
    stateDir: service.stateDir,
    pathEnv,
    root: runtimeRoot,
    nodeBin,
    logsDir
  }), 0o600);
  await execFileDeadline('/usr/bin/plutil', ['-lint', service.candidateTarget]);
  console.log(`Validated candidate ${service.label}`);
}

const canaryLabel = 'com.stinkyweasel.dex-reach.oauth-canary';
const canaryTarget = path.join(agentsDir, `${canaryLabel}.plist`);
const ownerEnvFile = path.join(localStateDir, 'secrets.env');
const canaryRollbackTarget = path.join(rollbackDir, `${canaryLabel}.plist`);
const hadCanary = await snapshotPlist(canaryTarget, canaryRollbackTarget);
const canaryCandidateTarget = path.join(rollbackDir, `${canaryLabel}.candidate.plist`);
await atomicWriteFile(canaryCandidateTarget, launchdIntervalPlist({
  label: canaryLabel,
  entry: 'dist/scripts/oauth-canary.js',
  envFile: ownerEnvFile,
  stateDir: localStateDir,
  pathEnv,
  root: runtimeRoot,
  nodeBin,
  logsDir,
  intervalSeconds: 6 * 60 * 60,
  environment: { DEX_REACH_NODE_ID: currentNodeId }
}), 0o600);
await execFileDeadline('/usr/bin/plutil', ['-lint', canaryCandidateTarget]);
console.log(`Validated candidate ${canaryLabel}`);

// Candidate definitions stay private until the helper proves the complete replacement.
// The helper bootstraps launchd directly from these candidate files, verifies gateway/node/canary,
// and only then atomically persists them to the canonical LaunchAgents paths. A failed candidate
// therefore leaves the known-good on-disk definitions untouched.
for (const service of services) {
  if (!service.candidateTarget) throw new Error(`missing candidate definition for ${service.label}`);
  console.log(`Validated ${service.label}; persistence deferred until live proof`);
}
console.log(`Validated ${canaryLabel}; persistence deferred until live proof`);

// Clean up the experimental submitted-job label used by early 0.3.1 development. A submitted job
// can be respawned by launchd after a successful exit. Production installation instead uses one
// fixed RunAtLoad helper with no KeepAlive; each install unloads the prior inactive helper first.
try {
  await execFileDeadline('/bin/launchctl', ['remove', 'com.stinkyweasel.dex-reach.install-reloader']);
} catch {}

const helperLabel = 'com.stinkyweasel.dex-reach.install-reloader-once';
const helperTarget = path.join(agentsDir, `${helperLabel}.plist`);
try {
  await execFileDeadline('/bin/launchctl', ['bootout', `${domain}/${helperLabel}`]);
} catch {}
const helperArgs = [
  nodeBin,
  helperEntry,
  '--domain', domain,
  '--status', installStatus,
  '--delay-ms', '3000',
  '--health-url', healthUrl,
  '--cleanup-plist', helperTarget,
  '--cleanup-dir', rollbackDir,
  '--install-lock', installLock.path,
  '--command-timeout-ms', '10000'
];
for (const service of services) helperArgs.push(
  '--service', service.label, service.target, service.candidateTarget!, service.rollbackTarget || '-'
);
helperArgs.push('--service', canaryLabel, canaryTarget, canaryCandidateTarget, hadCanary ? canaryRollbackTarget : '-');

await atomicWriteFile(helperTarget, launchdOneShotPlist({
  label: helperLabel,
  programArguments: helperArgs,
  workingDirectory: runtimeRoot,
  logsDir
}), 0o600);
await execFileDeadline('/usr/bin/plutil', ['-lint', helperTarget]);

await atomicWriteFile(installStatus, JSON.stringify({
  version: DEX_REACH_VERSION,
  state: 'scheduled',
  scheduledAt: new Date().toISOString(),
  domain,
  helperLabel,
  runtimeRoot,
  services: [...services.map(service => ({ label: service.label, target: service.target })), { label: canaryLabel, target: canaryTarget }]
}, null, 2) + '\n');

await installLock.handoff();
try {
  await execFileDeadline('/bin/launchctl', ['bootstrap', domain, helperTarget], 10_000);
} catch (error) {
  for (const service of services) await restorePlist(service.target, service.rollbackTarget);
  await restorePlist(canaryTarget, hadCanary ? canaryRollbackTarget : undefined);
  await atomicWriteFile(installStatus, JSON.stringify({
    version: DEX_REACH_VERSION,
    state: 'failed',
    scheduledAt: new Date().toISOString(),
    failedAt: new Date().toISOString(),
    domain,
    helperLabel,
    runtimeRoot,
    error: error instanceof Error ? error.message : String(error),
    rollback: { attempted: true, ok: true, mode: 'definitions-only' }
  }, null, 2) + '\n');
  await installLock.release().catch(() => undefined);
  throw error;
}

console.log(`DEX//REACH ${DEX_REACH_VERSION} launchd definitions staged and validated.`);
console.log(`DEX service reload delegated to one-shot helper ${helperLabel}.`);
console.log(`Reload status: ${installStatus}`);
console.log('The helper waits briefly so a DEX-hosted install can return before replacing its own transport.');
