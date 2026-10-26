/** Independent node-only rollback path; it does not depend on the DEX gateway or node transport. */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { atomicWriteFile, withFileLock } from '../src/shared/state-io.js';
import { stateDir } from '../src/shared/local-env.js';
import { arg } from './lib/node-files.js';
import { verifyRuntimeRelease, installLockFile } from './lib/runtime-release.js';
import { runtimeTreeSha256 } from './lib/runtime-rollback.js';
import { launchdIsRunning, runLaunchctl } from './lib/launchctl.js';
import { reloadLaunchdService } from './lib/service-reloader.js';
import { BIGMAC_NODE_LABEL, validateExistingNodeAgent } from './lib/bigmac-node-upgrade.js';

const execFileAsync = promisify(execFile);
const transactionId = arg('--transaction');
const approval = arg('--confirm-node-only-rollback');
const preflightOnly = process.argv.includes('--preflight');
const domain = `gui/${process.getuid?.() ?? os.userInfo().uid}`;
const activeAgent = path.join(os.homedir(), 'Library', 'LaunchAgents', `${BIGMAC_NODE_LABEL}.plist`);

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
};

function safeReleaseId(value: string): boolean { return /^[a-z0-9][a-z0-9._-]{0,119}$/.test(value); }

async function readPlist(file: string): Promise<Record<string, unknown>> {
  const { stdout } = await execFileAsync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', file], { maxBuffer: 128 * 1024 });
  return JSON.parse(stdout) as Record<string, unknown>;
}

async function rollback(): Promise<void> {
  if (process.platform !== 'darwin' || os.userInfo().username !== 'bigmac' || os.hostname().split('.')[0] !== 'bigmac') throw new Error('rollback is allowed only on the verified bigmac macOS account');
  if (!transactionId || !safeReleaseId(transactionId)) throw new Error('provide the exact staged release ID with --transaction');
  if (!preflightOnly && approval !== 'bigmac') throw new Error('rollback requires --confirm-node-only-rollback bigmac');
  const transactionDir = path.join(stateDir(), 'runtime', 'bigmac-node-upgrade', transactionId);
  const manifest = JSON.parse(await fs.readFile(path.join(transactionDir, 'manifest.json'), 'utf8')) as Manifest;
  if (manifest.schemaVersion !== 1 || manifest.state !== 'staged' || manifest.nodeId !== 'bigmac' || manifest.candidateReleaseId !== transactionId) throw new Error('node upgrade transaction manifest is invalid');
  if (path.resolve(manifest.activeAgentPath) !== path.resolve(activeAgent)) throw new Error('rollback LaunchAgent target changed; refusing to restore');
  if (path.resolve(manifest.candidateAgent) !== path.join(transactionDir, 'candidate-node.plist') || path.resolve(manifest.rollbackAgent) !== path.join(transactionDir, 'rollback-node.plist')) throw new Error('rollback transaction paths are not canonical');
  if (path.resolve(manifest.originalAgentSnapshot) !== path.join(stateDir(), 'runtime', 'bigmac-node-upgrade', manifest.previousReleaseId, 'original-node.plist')) throw new Error('original LaunchAgent snapshot path is not canonical');
  const releasesDir = path.join(stateDir(), 'runtime', 'releases');
  if (!safeReleaseId(manifest.previousReleaseId) || path.resolve(manifest.previousReleaseRoot) !== path.join(releasesDir, manifest.previousReleaseId) || path.resolve(manifest.candidateReleaseRoot) !== path.join(releasesDir, manifest.candidateReleaseId)) throw new Error('release paths do not match the staged transaction');
  await verifyRuntimeRelease(manifest.previousReleaseRoot);
  await verifyRuntimeRelease(manifest.candidateReleaseRoot);
  if (await runtimeTreeSha256(manifest.previousReleaseRoot) !== manifest.previousReleaseSha256) throw new Error('previous release integrity check failed');
  if (await runtimeTreeSha256(manifest.candidateReleaseRoot) !== manifest.candidateReleaseSha256) throw new Error('candidate release integrity check failed');
  const [current, candidateBytes, rollbackBytes] = await Promise.all([
    fs.readFile(activeAgent), fs.readFile(manifest.candidateAgent), fs.readFile(manifest.rollbackAgent)
  ]);
  const candidate = await readPlist(manifest.candidateAgent);
  const previous = await readPlist(manifest.rollbackAgent);
  validateExistingNodeAgent(candidate, manifest.candidateReleaseRoot, manifest.environmentFile);
  validateExistingNodeAgent(previous, manifest.previousReleaseRoot, manifest.environmentFile);
  await execFileAsync('/usr/bin/plutil', ['-lint', manifest.rollbackAgent]);
  if (rollbackBytes.length === 0) throw new Error('rollback LaunchAgent is empty');

  if (preflightOnly) {
    const original = await fs.readFile(manifest.originalAgentSnapshot);
    if (current.compare(original) !== 0) throw new Error('active LaunchAgent changed since staging; rollback preflight refuses ambiguous service state');
    console.log(JSON.stringify({
      state: 'ROLLBACK_READY', transactionId, nodeId: 'bigmac',
      previousReleaseRoot: manifest.previousReleaseRoot, previousVersion: manifest.previousVersion,
      candidateAgentValid: true, rollbackAgentValid: true, activeAgentMatchesBaseline: true,
      liveServiceMutated: false, gatewayReconnect: 'not exercised by rollback preflight'
    }, null, 2));
    return;
  }
  if (current.compare(candidateBytes) !== 0) throw new Error('active node LaunchAgent differs from the staged candidate; refusing ambiguous rollback');

  const statusFile = path.join(transactionDir, 'rollback-status.json');
  await atomicWriteFile(statusFile, `${JSON.stringify({ state: 'restoring', transactionId, at: new Date().toISOString() }, null, 2)}\n`, 0o600);
  try {
    await atomicWriteFile(activeAgent, rollbackBytes, 0o600);
    await reloadLaunchdService({ label: BIGMAC_NODE_LABEL, target: activeAgent }, domain);
    const state = await runLaunchctl(['print', `${domain}/${BIGMAC_NODE_LABEL}`], 5000);
    if (!launchdIsRunning(state.stdout)) throw new Error('previous node did not remain running after rollback');
    await atomicWriteFile(statusFile, `${JSON.stringify({
      state: 'restored', transactionId, completedAt: new Date().toISOString(),
      nodeId: 'bigmac', version: manifest.previousVersion, releaseRoot: manifest.previousReleaseRoot,
      launchd: 'running', gatewayReconnect: 'not measured by the offline rollback helper'
    }, null, 2)}\n`, 0o600);
  } catch (error) {
    await atomicWriteFile(statusFile, `${JSON.stringify({ state: 'failed', transactionId, failedAt: new Date().toISOString(), error: error instanceof Error ? error.message : String(error) }, null, 2)}\n`, 0o600);
    throw error;
  }
  console.log(`Big Mac node restored from ${manifest.previousReleaseRoot}. Verify exact gateway reconnection separately.`);
}

await withFileLock(installLockFile(stateDir()), rollback, { timeoutMs: 1000 });
