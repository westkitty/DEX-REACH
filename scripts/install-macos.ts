import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { stateDir } from '../src/shared/local-env.js';
import { atomicWriteFile, withFileLock } from '../src/shared/state-io.js';
import { DEX_REACH_VERSION } from '../src/shared/version.js';
import { launchdIntervalPlist, launchdOneShotPlist, launchdPlist, servicePath, serviceNodeBinary } from './lib/service.js';
import { buildRuntimeRelease, runtimeReleaseId } from './lib/runtime-release.js';
import { readMacConfig } from './lib/macos-config.js';
import { parseServiceHealth, waitInstallStatus } from './lib/macos-health.js';
import { loadAccessState, resolveMode } from '../src/shared/access.js';
import { workspaceWorkerConfigFile, workspaceWorkerDir, workspaceWorkerRootsHash } from '../src/shared/workspace-worker.js';

const execFileAsync = promisify(execFile);

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const agentsDir = path.join(os.homedir(), 'Library', 'LaunchAgents');
const localStateDir = stateDir();
const logsDir = path.join(localStateDir, 'logs');
const domain = `gui/${process.getuid?.() ?? os.userInfo().uid}`;
const nodeBin = await serviceNodeBinary();
const installStatus = path.join(localStateDir, 'install-macos.status.json');

if (process.platform !== 'darwin') throw new Error('install:macos requires macOS launchd');
await withFileLock(path.join(localStateDir, 'install-macos.lock'), async () => {
// Never boot out an in-flight reloader. Serializing staging and waiting for the previous helper
// prevents two installs from replacing each other's definitions/status or killing a half-reload.
const prior = await fs.readFile(installStatus, 'utf8').then(text => JSON.parse(text) as { state?: string }).catch(() => null);
if (prior && ['scheduled', 'waiting'].includes(prior.state || '')) {
  const helper = await execFileAsync('/bin/launchctl', ['print', `${domain}/com.stinkyweasel.dex-reach.install-reloader-once`])
    .then(({ stdout }) => parseServiceHealth(stdout)).catch(() => null);
  if (helper && (helper.running || helper.runs === 0)) await waitInstallStatus(localStateDir);
}
// Preflight owner and enrollment files before building or mutating any service definition.
const { node, ownerFile, nodeFile, healthUrl } = await readMacConfig(localStateDir, process.env.DEX_REACH_NODE_ID);
const expectedMode = resolveMode(await loadAccessState(node.nodeId));

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

const currentNodeId = node.nodeId;
const workerNodeId = node.nodeId;
// Parsed exactly as `loadNodeConfig` parses it, including the order: empty segments are dropped
// before resolution, because `path.resolve('')` is the installer's working directory. Resolving
// first would write that directory into the worker's allowed roots and put the roots hash out of
// step with the node's, leaving the worker permanently unusable for a trailing `:` in the env.
const workerRoots = node.allowedRoots;
if (!workerRoots.length) throw new Error('workspace worker requires at least one configured node root');
await fs.mkdir(workspaceWorkerDir(), { recursive: true, mode: 0o700 });
await fs.chmod(workspaceWorkerDir(), 0o700);
await atomicWriteFile(workspaceWorkerConfigFile(), JSON.stringify({
  version: 1,
  nodeId: workerNodeId,
  allowedRoots: workerRoots,
  rootsHash: workspaceWorkerRootsHash(workerRoots)
}, null, 2) + '\n', 0o600);

const services = [
  { label: 'com.stinkyweasel.dex-reach.coordinator', entry: 'dist/src/coordinator/main.js', envFile: undefined, stateDir: localStateDir },
  { label: 'com.stinkyweasel.dex-reach.worker', entry: 'dist/src/worker/main.js', envFile: undefined, stateDir: undefined },
  { label: 'com.stinkyweasel.dex-reach.gateway', entry: 'dist/src/gateway/main.js', envFile: ownerFile, stateDir: localStateDir },
  { label: 'com.stinkyweasel.dex-reach.node', entry: 'dist/src/node/main.js', envFile: nodeFile, stateDir: localStateDir }
].map(service => ({ ...service, target: path.join(agentsDir, `${service.label}.plist`) }));

// Stage and syntax-check every LaunchAgent before replacing any live process. This matters when
// install:macos is itself executed through DEX//REACH: cycling the gateway or node inline would
// sever the request carrying the install before the caller received its result.
for (const service of services) {
  await atomicWriteFile(service.target, launchdPlist({
    label: service.label,
    entry: service.entry,
    envFile: service.envFile,
    stateDir: service.stateDir,
    pathEnv,
    root: runtimeRoot,
    nodeBin,
    logsDir
  }), 0o600);
  await execFileAsync('/usr/bin/plutil', ['-lint', service.target]);
  console.log(`Staged ${service.label}`);
}

const canaryLabel = 'com.stinkyweasel.dex-reach.oauth-canary';
const canaryTarget = path.join(agentsDir, `${canaryLabel}.plist`);
await atomicWriteFile(canaryTarget, launchdIntervalPlist({
  label: canaryLabel,
  entry: 'dist/scripts/oauth-canary.js',
  envFile: ownerFile,
  stateDir: localStateDir,
  pathEnv,
  root: runtimeRoot,
  nodeBin,
  logsDir,
  intervalSeconds: 6 * 60 * 60,
  environment: { DEX_REACH_NODE_ID: currentNodeId }
}), 0o600);
await execFileAsync('/usr/bin/plutil', ['-lint', canaryTarget]);
console.log(`Staged ${canaryLabel}`);

// Clean up the experimental submitted-job label used by early 0.3.1 development. A submitted job
// can be respawned by launchd after a successful exit. Production installation instead uses one
// fixed RunAtLoad helper with no KeepAlive; each install unloads the prior inactive helper first.
try {
  await execFileAsync('/bin/launchctl', ['remove', 'com.stinkyweasel.dex-reach.install-reloader']);
} catch {}

const helperLabel = 'com.stinkyweasel.dex-reach.install-reloader-once';
const helperTarget = path.join(agentsDir, `${helperLabel}.plist`);
try {
  await execFileAsync('/bin/launchctl', ['bootout', `${domain}/${helperLabel}`]);
} catch {}
const helperArgs = [
  nodeBin,
  helperEntry,
  '--domain', domain,
  '--status', installStatus,
  '--delay-ms', '3000',
  '--health-url', healthUrl,
  '--state-dir', localStateDir,
  '--node-id', currentNodeId,
  '--expected-profile', node.profile,
  '--expected-mode', expectedMode,
  '--cleanup-plist', helperTarget
];
for (const service of services) helperArgs.push('--service', service.label, service.target);
helperArgs.push('--service', canaryLabel, canaryTarget);

await atomicWriteFile(helperTarget, launchdOneShotPlist({
  label: helperLabel,
  programArguments: helperArgs,
  workingDirectory: runtimeRoot,
  logsDir
}), 0o600);
await execFileAsync('/usr/bin/plutil', ['-lint', helperTarget]);

await atomicWriteFile(installStatus, JSON.stringify({
  version: DEX_REACH_VERSION,
  state: 'scheduled',
  scheduledAt: new Date().toISOString(),
  domain,
  helperLabel,
  runtimeRoot,
  services: [...services.map(service => ({ label: service.label, target: service.target })), { label: canaryLabel, target: canaryTarget }]
}, null, 2) + '\n');

await execFileAsync('/bin/launchctl', ['bootstrap', domain, helperTarget]);

console.log(`DEX//REACH ${DEX_REACH_VERSION} launchd definitions staged and validated.`);
console.log(`DEX service reload delegated to one-shot helper ${helperLabel}.`);
console.log(`Reload status: ${installStatus}`);
console.log('The helper waits briefly so a DEX-hosted install can return before replacing its own transport.');
console.log('Install is scheduled, not yet healthy. Run npm run healthz:assert -- --wait-install from a local terminal.');
}, { timeoutMs: 480_000 });
