import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { stateDir } from '../src/shared/local-env.js';
import { readEnvFile } from './lib/node-files.js';
import { atomicWriteFile, withFileLock } from '../src/shared/state-io.js';
import { errorText, failureOutcome, launchctlWithReconciliation, launchdIsAbsent, launchdIsRunning, launchdServiceIsEnabled } from './lib/launchctl.js';
import { DEX_REACH_VERSION } from '../src/shared/version.js';
import { launchdIntervalPlist, launchdOneShotPlist, launchdPlist, servicePath } from './lib/service.js';
import { buildRuntimeRelease, runtimeReleaseId } from './lib/runtime-release.js';
import { prepareRuntimeRollbackSnapshot } from './lib/runtime-rollback.js';
import { workspaceWorkerConfigFile, workspaceWorkerDir, workspaceWorkerRootsHash } from '../src/shared/workspace-worker.js';

const execFileAsync = promisify(execFile);

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const agentsDir = path.join(os.homedir(), 'Library', 'LaunchAgents');
const localStateDir = stateDir();
const logsDir = path.join(localStateDir, 'logs');
const domain = `gui/${process.getuid?.() ?? os.userInfo().uid}`;
const nodeBin = process.execPath;
const installStatus = path.join(localStateDir, 'install-macos.status.json');

async function install(): Promise<void> {
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
const workerConfigContents = JSON.stringify({
  version: 1,
  nodeId: workerNodeId,
  allowedRoots: workerRoots,
  rootsHash: workspaceWorkerRootsHash(workerRoots)
}, null, 2) + '\n';

const services = [
  { label: 'com.stinkyweasel.dex-reach.coordinator', entry: 'dist/src/coordinator/main.js', envFile: undefined, stateDir: localStateDir },
  { label: 'com.stinkyweasel.dex-reach.worker', entry: 'dist/src/worker/main.js', envFile: undefined, stateDir: undefined },
  { label: 'com.stinkyweasel.dex-reach.gateway', entry: 'dist/src/gateway/main.js', envFile: undefined, stateDir: localStateDir },
  { label: 'com.stinkyweasel.dex-reach.node', entry: 'dist/src/node/main.js', envFile: nodeEnv, stateDir: localStateDir }
].map(service => ({ ...service, target: path.join(agentsDir, `${service.label}.plist`) }));

const canaryLabel = 'com.stinkyweasel.dex-reach.oauth-canary';
const canaryTarget = path.join(agentsDir, `${canaryLabel}.plist`);
const ownerEnvFile = path.join(localStateDir, 'secrets.env');
const helperLabel = 'com.stinkyweasel.dex-reach.install-reloader-once';
const persistentPlists = services.map(service => ({
  service,
  contents: launchdPlist({
    label: service.label,
    entry: service.entry,
    envFile: service.envFile,
    stateDir: service.stateDir,
    pathEnv,
    root: runtimeRoot,
    nodeBin,
    logsDir,
    processType: service.label === 'com.stinkyweasel.dex-reach.node' ? 'Standard' : 'Background'
  })
}));
const canaryPlist = launchdIntervalPlist({
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
});

// Validate the complete candidate set before changing any active LaunchAgent or worker config.
const validationDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dex-reach-launchagents-'));
try {
  for (const { service, contents } of persistentPlists) {
    const staged = path.join(validationDir, `${service.label}.plist`);
    await fs.writeFile(staged, contents, { mode: 0o600 });
    await execFileAsync('/usr/bin/plutil', ['-lint', staged]);
  }
  const stagedCanary = path.join(validationDir, `${canaryLabel}.plist`);
  await fs.writeFile(stagedCanary, canaryPlist, { mode: 0o600 });
  await execFileAsync('/usr/bin/plutil', ['-lint', stagedCanary]);
} finally {
  await fs.rm(validationDir, { recursive: true, force: true });
}

// Refuse to replace a mixed, disabled, or already-reloading service set. launchd permits one job
// per label; this preflight also records that the currently proven four daemons are distinct.
const disabledState = (await execFileAsync('/bin/launchctl', ['print-disabled', domain])).stdout;
const servicePids = new Set<number>();
for (const service of [...services, { label: canaryLabel, target: canaryTarget }]) {
  if (!launchdServiceIsEnabled(disabledState, service.label)) throw new Error(`LaunchAgent is disabled; refusing install: ${service.label}`);
  const observed = (await execFileAsync('/bin/launchctl', ['print', `${domain}/${service.label}`])).stdout;
  const activeDefinition = await fs.readFile(service.target, 'utf8');
  const declaredRoot = activeDefinition.match(/<key>WorkingDirectory<\/key><string>([^<]+)<\/string>/)?.[1]
    ?.replace(/&(?:amp|lt|gt);/g, entity => ({ '&amp;': '&', '&lt;': '<', '&gt;': '>' })[entity] ?? entity);
  if (!declaredRoot || !observed.includes(`working directory = ${declaredRoot}`)) {
    throw new Error(`running LaunchAgent does not match its on-disk runtime definition: ${service.label}`);
  }
  if (service.label === canaryLabel) {
    if (launchdIsRunning(observed)) throw new Error('OAuth canary is running; refusing install until its scheduled task exits');
  } else {
    if (!launchdIsRunning(observed)) throw new Error(`required DEX service is not running; refusing install: ${service.label}`);
    const pid = Number(observed.match(/\bpid = (\d+)\b/)?.[1]);
    if (!Number.isInteger(pid) || servicePids.has(pid)) throw new Error('DEX services do not have distinct running process identities');
    servicePids.add(pid);
  }
}
for (const label of ['com.stinkyweasel.dex-reach.install-reloader', helperLabel]) {
  const observed = await execFileAsync('/bin/launchctl', ['print', `${domain}/${label}`])
    .then(result => result.stdout)
    .catch(error => { if (launchdIsAbsent(error)) return ''; throw error; });
  if (observed && launchdIsRunning(observed)) throw new Error(`another DEX installer helper is running: ${label}`);
}
const priorInstallStatus = await fs.readFile(installStatus, 'utf8').then(text => JSON.parse(text) as { state?: string }).catch(() => null);
if (priorInstallStatus?.state === 'scheduled' || priorInstallStatus?.state === 'waiting') {
  throw new Error(`prior macOS installation is still in progress: ${priorInstallStatus.state}`);
}

const rollbackSnapshot = await prepareRuntimeRollbackSnapshot({
  stateDir: localStateDir,
  agentsDir,
  candidateReleaseId: releaseId,
  candidateReleaseRoot: runtimeRoot,
  services: [...services.map(({ label, target }) => ({ label, target })), { label: canaryLabel, target: canaryTarget }],
  candidatePlists: Object.fromEntries([
    ...persistentPlists.map(({ service, contents }) => [service.label, contents]),
    [canaryLabel, canaryPlist]
  ]),
  workerConfigPath: workspaceWorkerConfigFile(),
  candidateWorkerConfig: workerConfigContents
});
if (!rollbackSnapshot) throw new Error('current active immutable runtime was not captured for rollback');
console.log(`Verified previous runtime rollback snapshot ${rollbackSnapshot}`);

// Only after candidate syntax and the previous runtime snapshot are durable do active files change.
await atomicWriteFile(workspaceWorkerConfigFile(), workerConfigContents, 0o600);
for (const { service, contents } of persistentPlists) {
  await atomicWriteFile(service.target, contents, 0o600);
  console.log(`Staged ${service.label}`);
}
await atomicWriteFile(canaryTarget, canaryPlist, 0o600);
await execFileAsync('/usr/bin/plutil', ['-lint', canaryTarget]);
console.log(`Staged ${canaryLabel}`);

// Clean up the experimental submitted-job label used by early 0.3.1 development. A submitted job
// can be respawned by launchd after a successful exit. Production installation instead uses one
// fixed RunAtLoad helper with no KeepAlive; each install unloads the prior inactive helper first.
const legacyHelperLabel = 'com.stinkyweasel.dex-reach.install-reloader';
await launchctlWithReconciliation({
  args: ['remove', legacyHelperLabel], reconcileArgs: ['print', `${domain}/${legacyHelperLabel}`],
  reconciled: () => false, reconciledError: launchdIsAbsent,
  reconcileFailures: true,
  expectation: 'legacy helper absent after remove timeout'
}).catch(error => { if (!launchdIsAbsent(error)) throw error; });

const helperTarget = path.join(agentsDir, `${helperLabel}.plist`);
await launchctlWithReconciliation({
  args: ['bootout', `${domain}/${helperLabel}`], reconcileArgs: ['print', `${domain}/${helperLabel}`],
  reconciled: () => false, reconciledError: launchdIsAbsent,
  expectation: 'prior one-shot helper absent after bootout timeout'
}).catch(error => { if (!launchdIsAbsent(error)) throw error; });
const helperArgs = [
  nodeBin,
  helperEntry,
  '--domain', domain,
  '--status', installStatus,
  '--delay-ms', '3000',
  '--health-url', healthUrl,
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

const scheduledAt = new Date().toISOString();
await atomicWriteFile(installStatus, JSON.stringify({
  version: DEX_REACH_VERSION,
  state: 'scheduled',
  scheduledAt,
  domain,
  helperLabel,
  runtimeRoot,
  services: [...services.map(service => ({ label: service.label, target: service.target })), { label: canaryLabel, target: canaryTarget }]
}, null, 2) + '\n');

try {
  await launchctlWithReconciliation({
    args: ['bootstrap', domain, helperTarget], reconcileArgs: ['print', `${domain}/${helperLabel}`],
    reconciled: state => launchdIsRunning(state.stdout),
    expectation: 'one-shot helper running after bootstrap timeout'
  });
} catch (error) {
  await atomicWriteFile(installStatus, JSON.stringify({
    version: DEX_REACH_VERSION, state: 'failed', outcome: failureOutcome(error), scheduledAt, failedAt: new Date().toISOString(),
    domain, helperLabel, runtimeRoot, error: errorText(error),
    services: [...services.map(service => ({ label: service.label, target: service.target })), { label: canaryLabel, target: canaryTarget }]
  }, null, 2) + '\n');
  throw error;
}

console.log(`DEX//REACH ${DEX_REACH_VERSION} launchd definitions staged and validated.`);
console.log(`DEX service reload delegated to one-shot helper ${helperLabel}.`);
console.log(`Reload status: ${installStatus}`);
console.log('The helper waits briefly so a DEX-hosted install can return before replacing its own transport.');
}

await withFileLock(path.join(localStateDir, 'runtime', 'install.lock'), install, { timeoutMs: 1000 });
