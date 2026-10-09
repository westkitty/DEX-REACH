import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { atomicWriteFile, withFileLock } from '../src/shared/state-io.js';
import { stateDir } from '../src/shared/local-env.js';
import { workspaceWorkerConfigFile } from '../src/shared/workspace-worker.js';
import { errorText, failureOutcome, launchdIsRunning, launchdServiceIsEnabled } from './lib/launchctl.js';
import { reloadLaunchdService } from './lib/service-reloader.js';
import { readEnvFile } from './lib/node-files.js';
import { restoreRuntimeRollbackSnapshot, validateRuntimeRollbackSnapshot, type RuntimeRollbackService } from './lib/runtime-rollback.js';

const releaseIndex = process.argv.indexOf('--candidate-release-id');
const candidateReleaseId = releaseIndex >= 0 ? process.argv[releaseIndex + 1] : undefined;
if (!candidateReleaseId || !/^[a-z0-9][a-z0-9._-]{0,119}$/.test(candidateReleaseId)) {
  throw new Error('usage: npm run rollback:macos -- --candidate-release-id <installed-candidate-id>');
}

const localStateDir = stateDir();
const agentsDir = path.join(os.homedir(), 'Library', 'LaunchAgents');
const domain = `gui/${process.getuid?.() ?? os.userInfo().uid}`;
const execFileAsync = promisify(execFile);
const ownerEnv = await readEnvFile(path.join(localStateDir, 'secrets.env')).catch((): Record<string, string> => ({}));
const gatewayPort = Number(ownerEnv.DEX_REACH_GATEWAY_PORT || 8787);
if (!Number.isInteger(gatewayPort) || gatewayPort < 1 || gatewayPort > 65535) throw new Error('invalid configured gateway port');
const snapshotPath = path.join(localStateDir, 'runtime', 'rollback', candidateReleaseId, 'snapshot.json');
const statusPath = path.join(localStateDir, 'runtime', 'rollback', candidateReleaseId, 'rollback-status.json');
const installStatusPath = path.join(localStateDir, 'install-macos.status.json');
const services: RuntimeRollbackService[] = [
  'coordinator', 'worker', 'gateway', 'node', 'oauth-canary'
].map(name => {
  const label = `com.stinkyweasel.dex-reach.${name}`;
  return { label, target: path.join(agentsDir, `${label}.plist`) };
});
async function rollback(): Promise<void> {
const startedAt = new Date().toISOString();

async function runLaunchctl(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('/bin/launchctl', args, { timeout: 8000, killSignal: 'SIGKILL' });
  return stdout;
}

async function verifyGateway(): Promise<void> {
  const url = `http://127.0.0.1:${gatewayPort}/healthz`;
  let last = 'gateway has not responded';
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1500) });
      const text = await response.text();
      const body = JSON.parse(text) as { onlineNodes?: number };
      if (response.ok && typeof body.onlineNodes === 'number' && body.onlineNodes >= 1) return;
      last = `gateway health did not report an online node: ${text.slice(0, 200)}`;
    } catch (error) { last = errorText(error); }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  throw new Error(`rollback runtime failed exact-node health check: ${last}`);
}

async function verifyCanary(service: RuntimeRollbackService): Promise<void> {
  let last = '';
  for (let attempt = 0; attempt < 500; attempt += 1) {
    last = await runLaunchctl(['print', `${domain}/${service.label}`]);
    if (/\blast exit code = 0\b/.test(last) && !/\bstate = running\b/.test(last)) return;
    if (/\blast exit code = [1-9]\d*\b/.test(last) && !/\bstate = running\b/.test(last)) {
      throw new Error(`restored OAuth canary exited non-zero: ${last.slice(0, 400)}`);
    }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error(`restored OAuth canary did not complete: ${last.slice(0, 400)}`);
}

const disabledState = await runLaunchctl(['print-disabled', domain]);
for (const service of services) {
  if (!launchdServiceIsEnabled(disabledState, service.label)) throw new Error(`LaunchAgent is disabled; refusing rollback: ${service.label}`);
}
const validatedPreviousReleaseId = await validateRuntimeRollbackSnapshot({
  snapshotPath, stateDir: localStateDir, agentsDir,
  workerConfigPath: workspaceWorkerConfigFile(), services, candidateReleaseId
});
await atomicWriteFile(statusPath, JSON.stringify({ schemaVersion: 1, state: 'validating', candidateReleaseId, startedAt, restoredReleaseId: validatedPreviousReleaseId }, null, 2) + '\n');
await atomicWriteFile(installStatusPath, JSON.stringify({
  schemaVersion: 1, state: 'rollback-in-progress', candidateReleaseId, startedAt,
  restoredReleaseId: validatedPreviousReleaseId, rollbackStatus: statusPath
}, null, 2) + '\n');
try {
  const previousReleaseId = await restoreRuntimeRollbackSnapshot({
    snapshotPath,
    stateDir: localStateDir,
    agentsDir,
    workerConfigPath: workspaceWorkerConfigFile(),
    services,
    candidateReleaseId
  });
  if (previousReleaseId !== validatedPreviousReleaseId) throw new Error('rollback identity changed after preflight');
  await atomicWriteFile(statusPath, JSON.stringify({ schemaVersion: 1, state: 'reloading', candidateReleaseId, restoredReleaseId: previousReleaseId, startedAt }, null, 2) + '\n');

  const persistent = services.filter(service => !service.label.endsWith('.oauth-canary'));
  for (const service of persistent) await reloadLaunchdService(service, domain);
  await verifyGateway();

  const pids = new Set<number>();
  for (const service of persistent) {
    const observed = await runLaunchctl(['print', `${domain}/${service.label}`]);
    if (!launchdIsRunning(observed)) throw new Error(`restored service is not running: ${service.label}`);
    const pid = Number(observed.match(/\bpid = (\d+)\b/)?.[1]);
    if (!Number.isInteger(pid) || pids.has(pid)) throw new Error('restored DEX services do not have distinct process identities');
    pids.add(pid);
  }

  const canary = services.find(service => service.label.endsWith('.oauth-canary'))!;
  await reloadLaunchdService(canary, domain);
  await verifyCanary(canary);
  const completedAt = new Date().toISOString();
  await atomicWriteFile(statusPath, JSON.stringify({
    schemaVersion: 1, state: 'complete', candidateReleaseId, restoredReleaseId: previousReleaseId,
    startedAt, completedAt, persistentServices: [...pids.keys()].length, gatewayOnlineNodes: 1,
    canary: 'exit-0'
  }, null, 2) + '\n');
  await atomicWriteFile(installStatusPath, JSON.stringify({
    schemaVersion: 1, state: 'rolled-back', attemptedReleaseId: candidateReleaseId,
    installedReleaseId: previousReleaseId, completedAt, rollbackStatus: statusPath
  }, null, 2) + '\n');
  console.log(`Rollback complete: candidate ${candidateReleaseId}; restored ${previousReleaseId}; status ${statusPath}`);
} catch (error) {
  await atomicWriteFile(statusPath, JSON.stringify({
    schemaVersion: 1, state: 'failed', candidateReleaseId, startedAt,
    failedAt: new Date().toISOString(), outcome: failureOutcome(error), error: errorText(error)
  }, null, 2) + '\n');
  await atomicWriteFile(installStatusPath, JSON.stringify({
    schemaVersion: 1, state: 'rollback-failed', candidateReleaseId,
    failedAt: new Date().toISOString(), outcome: failureOutcome(error), rollbackStatus: statusPath
  }, null, 2) + '\n');
  throw error;
}
}

await withFileLock(path.join(localStateDir, 'runtime', 'install.lock'), rollback, { timeoutMs: 1000 });
