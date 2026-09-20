import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { stateDir } from '../src/shared/local-env.js';
import { readEnvFile } from './lib/node-files.js';
import { atomicWriteFile } from '../src/shared/state-io.js';
import { DEX_REACH_VERSION } from '../src/shared/version.js';
import { launchdOneShotPlist, launchdPlist, servicePath } from './lib/service.js';
import { workspaceWorkerConfigFile, workspaceWorkerDir, workspaceWorkerRootsHash } from '../src/shared/workspace-worker.js';

const execFileAsync = promisify(execFile);

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const agentsDir = path.join(os.homedir(), 'Library', 'LaunchAgents');
const localStateDir = stateDir();
const logsDir = path.join(localStateDir, 'logs');
const domain = `gui/${process.getuid?.() ?? os.userInfo().uid}`;
const nodeBin = process.execPath;
const pathEnv = servicePath(nodeBin);
const helperEntry = path.join(root, 'dist', 'scripts', 'reload-launchagents.js');
const installStatus = path.join(localStateDir, 'install-macos.status.json');

await fs.mkdir(agentsDir, { recursive: true });
await fs.mkdir(logsDir, { recursive: true, mode: 0o700 });

const ownerEnv = await readEnvFile(path.join(localStateDir, 'secrets.env')).catch((): Record<string, string> => ({}));
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

const services = [
  { label: 'com.stinkyweasel.dex-reach.coordinator', entry: 'dist/src/coordinator/main.js', envFile: undefined, stateDir: localStateDir },
  { label: 'com.stinkyweasel.dex-reach.worker', entry: 'dist/src/worker/main.js', envFile: undefined, stateDir: undefined },
  { label: 'com.stinkyweasel.dex-reach.gateway', entry: 'dist/src/gateway/main.js', envFile: undefined, stateDir: localStateDir },
  { label: 'com.stinkyweasel.dex-reach.node', entry: 'dist/src/node/main.js', envFile: nodeEnv, stateDir: localStateDir }
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
    root,
    nodeBin,
    logsDir
  }), 0o600);
  await execFileAsync('/usr/bin/plutil', ['-lint', service.target]);
  console.log(`Staged ${service.label}`);
}

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
  '--cleanup-plist', helperTarget
];
for (const service of services) helperArgs.push('--service', service.label, service.target);

await atomicWriteFile(helperTarget, launchdOneShotPlist({
  label: helperLabel,
  programArguments: helperArgs,
  workingDirectory: root,
  logsDir
}), 0o600);
await execFileAsync('/usr/bin/plutil', ['-lint', helperTarget]);

await atomicWriteFile(installStatus, JSON.stringify({
  version: DEX_REACH_VERSION,
  state: 'scheduled',
  scheduledAt: new Date().toISOString(),
  domain,
  helperLabel,
  services: services.map(service => ({ label: service.label, target: service.target }))
}, null, 2) + '\n');

await execFileAsync('/bin/launchctl', ['bootstrap', domain, helperTarget]);

console.log(`DEX//REACH ${DEX_REACH_VERSION} launchd definitions staged and validated.`);
console.log(`DEX service reload delegated to one-shot helper ${helperLabel}.`);
console.log(`Reload status: ${installStatus}`);
console.log('The helper waits briefly so a DEX-hosted install can return before replacing its own transport.');
