/** Schedule a node-only Big Mac replacement using an independent one-shot launchd helper. */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { atomicWriteFile, withFileLock } from '../src/shared/state-io.js';
import { stateDir } from '../src/shared/local-env.js';
import { arg } from './lib/node-files.js';
import { launchdIsAbsent, launchdIsRunning, runLaunchctl } from './lib/launchctl.js';
import { reloadLaunchdService } from './lib/service-reloader.js';
import { verifyRuntimeRelease, installLockFile } from './lib/runtime-release.js';
import { runtimeTreeSha256 } from './lib/runtime-rollback.js';
import { BIGMAC_NODE_ID, BIGMAC_NODE_LABEL, BIGMAC_NODE_UPGRADE_HELPER_LABEL, createBigMacNodeUpgradeHelperPlist, validateExistingNodeAgent } from './lib/bigmac-node-upgrade.js';

const execFileAsync = promisify(execFile);
const helperLabel = BIGMAC_NODE_UPGRADE_HELPER_LABEL;
const domain = `gui/${process.getuid?.() ?? os.userInfo().uid}`;
const activeAgent = path.join(os.homedir(), 'Library', 'LaunchAgents', `${BIGMAC_NODE_LABEL}.plist`);
const transactionId = arg('--transaction');
const transactionDir = transactionId ? path.join(stateDir(), 'runtime', 'bigmac-node-upgrade', transactionId) : '';
const manifestPath = transactionDir ? path.join(transactionDir, 'manifest.json') : '';
const statusPath = transactionDir ? path.join(transactionDir, 'activation-status.json') : '';
const candidateSourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

type Manifest = {
  schemaVersion: 1;
  state: 'staged';
  nodeId: string;
  candidateReleaseId: string;
  candidateReleaseRoot: string;
  candidateReleaseSha256: string;
  previousReleaseId: string;
  previousReleaseRoot: string;
  previousReleaseSha256: string;
  originalAgentSnapshot: string;
  rollbackAgent: string;
  candidateAgent: string;
  activeAgentPath: string;
  environmentFile: string;
  previousVersion: string;
  targetVersion: string;
};

function safeId(value: string): boolean { return /^[a-z0-9][a-z0-9._-]{0,119}$/.test(value); }
function sleep(ms: number): Promise<void> { return new Promise(resolve => setTimeout(resolve, ms)); }

async function loadManifest(): Promise<Manifest> {
  if (!transactionId || !safeId(transactionId)) throw new Error('provide the exact staged candidate release ID with --transaction');
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8')) as Manifest;
  if (manifest.schemaVersion !== 1 || manifest.state !== 'staged' || manifest.nodeId !== BIGMAC_NODE_ID || manifest.candidateReleaseId !== transactionId) throw new Error('staged node upgrade manifest is invalid');
  if (path.resolve(manifest.activeAgentPath) !== path.resolve(activeAgent)) throw new Error('active LaunchAgent path differs from staged manifest');
  if (path.resolve(manifest.candidateAgent) !== path.join(transactionDir, 'candidate-node.plist') || path.resolve(manifest.rollbackAgent) !== path.join(transactionDir, 'rollback-node.plist')) throw new Error('staged LaunchAgent paths are not canonical');
  const releases = path.join(stateDir(), 'runtime', 'releases');
  if (path.resolve(manifest.candidateReleaseRoot) !== path.join(releases, manifest.candidateReleaseId) || path.resolve(manifest.previousReleaseRoot) !== path.join(releases, manifest.previousReleaseId)) throw new Error('staged runtime paths are not canonical');
  await verifyRuntimeRelease(manifest.candidateReleaseRoot);
  await verifyRuntimeRelease(manifest.previousReleaseRoot);
  if (await runtimeTreeSha256(manifest.candidateReleaseRoot) !== manifest.candidateReleaseSha256) throw new Error('candidate release integrity check failed');
  if (await runtimeTreeSha256(manifest.previousReleaseRoot) !== manifest.previousReleaseSha256) throw new Error('previous release integrity check failed');
  const [candidate, previous] = await Promise.all([
    execFileAsync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', manifest.candidateAgent]),
    execFileAsync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', manifest.rollbackAgent])
  ]);
  const candidateAgent = JSON.parse(candidate.stdout) as Parameters<typeof validateExistingNodeAgent>[0];
  const rollbackAgent = JSON.parse(previous.stdout) as Parameters<typeof validateExistingNodeAgent>[0];
  validateExistingNodeAgent(candidateAgent, manifest.candidateReleaseRoot, manifest.environmentFile);
  validateExistingNodeAgent(rollbackAgent, manifest.previousReleaseRoot, manifest.environmentFile);
  await execFileAsync('/usr/bin/plutil', ['-lint', manifest.candidateAgent]);
  await execFileAsync('/usr/bin/plutil', ['-lint', manifest.rollbackAgent]);
  return manifest;
}

async function gatewayHealthUrl(envFile: string): Promise<string> {
  const lines = await fs.readFile(envFile, 'utf8');
  const value = lines.split(/\r?\n/).find(line => line.startsWith('DEX_REACH_GATEWAY_WS='))?.slice('DEX_REACH_GATEWAY_WS='.length).trim();
  if (!value) throw new Error('existing node config has no gateway address');
  const url = new URL(value);
  if (url.protocol === 'wss:') url.protocol = 'https:';
  else if (url.protocol === 'ws:') url.protocol = 'http:';
  else throw new Error('existing node gateway address has an unsupported scheme');
  url.username = '';
  url.password = '';
  url.pathname = '/healthz';
  url.search = '';
  url.hash = '';
  return url.toString();
}

async function probeHealth(url: string): Promise<{ count: number; body: string }> {
  const response = await fetch(url, { signal: AbortSignal.timeout(2500) });
  const body = await response.text();
  if (!response.ok) throw new Error(`gateway health returned HTTP ${response.status}`);
  const health = JSON.parse(body) as { ok?: boolean; onlineNodes?: unknown };
  if (health.ok !== true || !Number.isInteger(health.onlineNodes) || Number(health.onlineNodes) < 1) throw new Error('gateway health response is not ready');
  return { count: Number(health.onlineNodes), body };
}

async function requireCleanProductionAudit(): Promise<void> {
  try {
    await execFileAsync('npm', ['audit', '--omit=dev', '--audit-level=high'], {
      cwd: candidateSourceRoot,
      timeout: 120_000,
      maxBuffer: 1024 * 1024
    });
  } catch {
    throw new Error('production dependency audit failed; node activation is blocked until the high-severity finding is resolved');
  }
}

async function currentJob(): Promise<string> {
  const { stdout } = await runLaunchctl(['print', `${domain}/${helperLabel}`], 5000);
  return stdout;
}

async function schedule(): Promise<void> {
  if (arg('--authorize-live-deployment') !== BIGMAC_NODE_ID) throw new Error('live deployment requires explicit --authorize-live-deployment bigmac authorization');
  const manifest = await loadManifest();
  await requireCleanProductionAudit();
  const [current, original] = await Promise.all([fs.readFile(activeAgent), fs.readFile(manifest.originalAgentSnapshot)]);
  if (current.compare(original) !== 0) throw new Error('active node LaunchAgent changed after staging; refusing deployment');
  const nodeJob = await runLaunchctl(['print', `${domain}/${BIGMAC_NODE_LABEL}`], 5000);
  if (!launchdIsRunning(nodeJob.stdout)) throw new Error('existing Big Mac node is not running; repair it before activation');
  const healthUrl = await gatewayHealthUrl(manifest.environmentFile);
  const before = await probeHealth(healthUrl);
  const helperState = await runLaunchctl(['print', `${domain}/${helperLabel}`], 5000).then(result => result.stdout).catch(error => {
    if (launchdIsAbsent(error)) return '';
    throw error;
  });
  if (helperState) throw new Error('a prior node-upgrade helper is still loaded; inspect its status before retrying');
  const candidate = JSON.parse((await execFileAsync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', manifest.candidateAgent])).stdout) as { ProgramArguments?: string[] };
  const nodeBin = candidate.ProgramArguments?.[0];
  if (!nodeBin) throw new Error('candidate node LaunchAgent has no executable');
  const helperPlist = path.join(transactionDir, 'activation-helper.plist');
  await atomicWriteFile(statusPath, `${JSON.stringify({ state: 'scheduled', transactionId, scheduledAt: new Date().toISOString(), gatewayOnlineNodesBefore: before.count }, null, 2)}\n`, 0o600);
  await atomicWriteFile(helperPlist, createBigMacNodeUpgradeHelperPlist({
    transactionId: transactionId!, releaseRoot: manifest.candidateReleaseRoot,
    nodeBin, logsDir: path.join(stateDir(), 'logs')
  }), 0o600);
  await execFileAsync('/usr/bin/plutil', ['-lint', helperPlist]);
  try {
    await runLaunchctl(['bootstrap', domain, helperPlist], 5000);
  } catch (error) {
    const observed = await runLaunchctl(['print', `${domain}/${helperLabel}`], 5000).then(result => result.stdout).catch(() => '');
    if (!launchdIsRunning(observed)) {
      await atomicWriteFile(statusPath, `${JSON.stringify({ state: 'unknown_outcome', transactionId, at: new Date().toISOString(), message: 'helper bootstrap outcome is ambiguous; inspect launchd and status before retrying' }, null, 2)}\n`, 0o600);
    }
    throw error;
  }
  console.log(`Node-only activation helper ${helperLabel} scheduled. Read ${statusPath}; do not repeat if its outcome is unknown.`);
}

async function runHelper(): Promise<void> {
  const state = await currentJob();
  const pid = Number(state.match(/\bpid = (\d+)\b/)?.[1]);
  if (!launchdIsRunning(state) || pid !== process.pid) throw new Error('activation helper must run as its independent launchd job');
  const manifest = await loadManifest();
  const status = JSON.parse(await fs.readFile(statusPath, 'utf8')) as { state?: string; gatewayOnlineNodesBefore?: number };
  if (status.state !== 'scheduled' || !Number.isInteger(status.gatewayOnlineNodesBefore)) throw new Error('activation transaction is not in its scheduled state');
  const [current, original] = await Promise.all([fs.readFile(activeAgent), fs.readFile(manifest.originalAgentSnapshot)]);
  if (current.compare(original) !== 0) throw new Error('active node LaunchAgent changed before helper activation');
  const healthUrl = await gatewayHealthUrl(manifest.environmentFile);
  let candidateInstalled = false;
  try {
    await probeHealth(healthUrl);
    await atomicWriteFile(statusPath, `${JSON.stringify({ ...status, state: 'activating', transactionId, startedAt: new Date().toISOString() }, null, 2)}\n`, 0o600);
    await atomicWriteFile(activeAgent, await fs.readFile(manifest.candidateAgent), 0o600);
    candidateInstalled = true;
    await reloadLaunchdService({ label: BIGMAC_NODE_LABEL, target: activeAgent }, domain);
    let candidatePid: number | null = null;
    const candidateJob = await runLaunchctl(['print', `${domain}/${BIGMAC_NODE_LABEL}`], 5000);
    if (!launchdIsRunning(candidateJob.stdout)) throw new Error('candidate node is not running after launchd replacement');
    candidatePid = Number(candidateJob.stdout.match(/\bpid = (\d+)\b/)?.[1]);
    const minimum = Number(status.gatewayOnlineNodesBefore);
    const deadline = Date.now() + 120_000;
    let connected = false;
    let lastHealthError = 'gateway node count has not recovered';
    while (Date.now() < deadline) {
      const observed = await runLaunchctl(['print', `${domain}/${BIGMAC_NODE_LABEL}`], 5000);
      const observedPid = Number(observed.stdout.match(/\bpid = (\d+)\b/)?.[1]);
      if (!launchdIsRunning(observed.stdout) || observedPid !== candidatePid) throw new Error('candidate node process stopped or restarted before gateway reconnection');
      try {
        const health = await probeHealth(healthUrl);
        if (health.count >= minimum) { connected = true; break; }
        lastHealthError = `onlineNodes=${health.count}; expected at least ${minimum}`;
      } catch (healthError) {
        lastHealthError = healthError instanceof Error ? healthError.message : String(healthError);
      }
      await sleep(1000);
    }
    if (!connected) throw new Error(`candidate did not reconnect to the gateway within 120 seconds: ${lastHealthError}`);
    await sleep(5000);
    const stableJob = await runLaunchctl(['print', `${domain}/${BIGMAC_NODE_LABEL}`], 5000);
    const stablePid = Number(stableJob.stdout.match(/\bpid = (\d+)\b/)?.[1]);
    if (!launchdIsRunning(stableJob.stdout) || stablePid !== candidatePid) throw new Error('candidate node process identity changed during its five-second stability window');
    await atomicWriteFile(statusPath, `${JSON.stringify({
      state: 'awaiting_exact_node_verification', transactionId, completedAt: new Date().toISOString(),
      nodeId: BIGMAC_NODE_ID, targetVersion: manifest.targetVersion, candidateReleaseRoot: manifest.candidateReleaseRoot,
      candidatePid: stablePid, gatewayOnlineNodes: (await probeHealth(healthUrl)).count,
      exactNodeReconnection: 'requires separate DEX node-list verification'
    }, null, 2)}\n`, 0o600);
  } catch (error) {
    if (!candidateInstalled) {
      await atomicWriteFile(statusPath, `${JSON.stringify({ state: 'blocked', transactionId, failedAt: new Date().toISOString(), error: error instanceof Error ? error.message : String(error), activeServiceChanged: false }, null, 2)}\n`, 0o600);
      throw error;
    }
    try {
      await atomicWriteFile(activeAgent, await fs.readFile(manifest.rollbackAgent), 0o600);
      await reloadLaunchdService({ label: BIGMAC_NODE_LABEL, target: activeAgent }, domain);
      const restored = await runLaunchctl(['print', `${domain}/${BIGMAC_NODE_LABEL}`], 5000);
      if (!launchdIsRunning(restored.stdout)) throw new Error('previous node did not remain running after automatic rollback');
      await atomicWriteFile(statusPath, `${JSON.stringify({ state: 'restored', transactionId, failedAt: new Date().toISOString(), candidateError: error instanceof Error ? error.message : String(error), previousVersion: manifest.previousVersion, launchd: 'running', gatewayReconnect: 'requires separate DEX node-list verification' }, null, 2)}\n`, 0o600);
    } catch (rollbackError) {
      await atomicWriteFile(statusPath, `${JSON.stringify({ state: 'unknown_outcome', transactionId, failedAt: new Date().toISOString(), candidateError: error instanceof Error ? error.message : String(error), rollbackError: rollbackError instanceof Error ? rollbackError.message : String(rollbackError) }, null, 2)}\n`, 0o600);
    }
    throw error;
  }
}

async function main(): Promise<void> {
  if (process.platform !== 'darwin' || os.userInfo().username !== 'bigmac' || os.hostname().split('.')[0] !== 'bigmac') throw new Error('node-only activation is allowed only on the verified bigmac macOS account');
  if (process.argv.includes('--run-helper')) await runHelper();
  else await schedule();
}

await withFileLock(installLockFile(stateDir()), main, { timeoutMs: process.argv.includes('--run-helper') ? 30_000 : 1000 });
