/**
 * Build and stage a node-only Big Mac upgrade. This command never edits a LaunchAgent,
 * reloads a service, changes node credentials, or changes owner policy.
 *
 * Run from the verified Big Mac candidate checkout:
 *   npm run bigmac:stage-node-upgrade
 */
import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { loadAccessState } from '../src/shared/access.js';
import { REACH_PROTOCOL_V2, REACH_TASK_EVENT_STREAM_CAPABILITY, REACH_TWO_PHASE_PLAN_CAPABILITY, REACH_DURABLE_TASK_CAPABILITY } from '../src/shared/protocol.js';
import { DEX_REACH_VERSION } from '../src/shared/version.js';
import { stateDir } from '../src/shared/local-env.js';
import { atomicWriteFile, withFileLock } from '../src/shared/state-io.js';
import { loadNodeConfig } from '../src/node/config.js';
import { arg, readEnvFile } from './lib/node-files.js';
import { buildRuntimeRelease, installLockFile, runtimeReleaseId, runtimeReleasesDir, verifyRuntimeRelease } from './lib/runtime-release.js';
import { runtimeTreeSha256 } from './lib/runtime-rollback.js';
import { servicePath, stableNodeBin } from './lib/service.js';
import { launchdIsRunning, runLaunchctl } from './lib/launchctl.js';
import { BIGMAC_NODE_ID, BIGMAC_NODE_LABEL, createBigMacNodePlist, validateBigMacNodeConfig, validateExistingNodeAgent, versionGreater, type ExistingNodeAgent } from './lib/bigmac-node-upgrade.js';

const execFileAsync = promisify(execFile);
const canonicalRepo = '/Users/bigmac/DEX-REACH';
const nodeLabel = BIGMAC_NODE_LABEL;
const nodeId = BIGMAC_NODE_ID;
const envFile = path.join(stateDir(), 'nodes', `${nodeId}.env`);
const activePlist = path.join(os.homedir(), 'Library', 'LaunchAgents', `${nodeLabel}.plist`);
const logsDir = path.join(stateDir(), 'logs');
const domain = `gui/${process.getuid?.() ?? os.userInfo().uid}`;
const sourceRoot = path.resolve(process.cwd());

type Agent = ExistingNodeAgent;
type StageManifest = {
  schemaVersion: 1;
  state: 'staged';
  stagedAt: string;
  nodeId: string;
  targetVersion: string;
  sourceCommit: string;
  sourceDirty: boolean;
  candidateProtocol: string;
  candidateCapabilities: string[];
  allowedRoots: string[];
  profile: string;
  accessMode: string;
  gatewayHost: string;
  environmentFile: string;
  candidateReleaseId: string;
  candidateReleaseRoot: string;
  candidateReleaseSha256: string;
  previousVersion: string;
  previousSourceCommit: string;
  previousSourceRoot: string;
  previousReleaseId: string;
  previousReleaseRoot: string;
  previousReleaseSha256: string;
  originalAgentSnapshot: string;
  rollbackAgent: string;
  candidateAgent: string;
  activeAgentPath: string;
  explicitDeploymentAuthorizationRequired: true;
};

function redactError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function readAgent(): Promise<Agent> {
  const { stdout } = await execFileAsync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', activePlist], { maxBuffer: 128 * 1024 });
  const value = JSON.parse(stdout) as Agent;
  validateExistingNodeAgent(value, canonicalRepo, envFile);
  return value;
}

function plistFor(releaseRoot: string, nodeBin: string, pathEnv: string): string {
  return createBigMacNodePlist({ releaseRoot, nodeBin, envFile, stateDir: stateDir(), pathEnv, logsDir });
}

async function gitFacts(root = sourceRoot): Promise<{ commit: string; dirty: boolean }> {
  try {
    const [{ stdout: commit }, { stdout: status }] = await Promise.all([
      execFileAsync('/usr/bin/git', ['-C', root, 'rev-parse', '--verify', 'HEAD']),
      execFileAsync('/usr/bin/git', ['-C', root, 'status', '--porcelain'])
    ]);
    return { commit: commit.trim(), dirty: Boolean(status.trim()) };
  } catch {
    throw new Error('candidate source must be a Git checkout pinned to a verified commit');
  }
}

async function stagePreviousRuntime(agent: Agent, previousVersion: string, commit: string): Promise<{ id: string; root: string; digest: string }> {
  const releases = runtimeReleasesDir(stateDir());
  await fs.mkdir(releases, { recursive: true, mode: 0o700 });
  const id = `${previousVersion}-legacy-${commit.slice(0, 12)}`.toLowerCase();
  const target = path.join(releases, id);
  const sourceDist = path.join(canonicalRepo, 'dist');
  const sourceModules = path.join(canonicalRepo, 'node_modules');
  let existing = await fs.lstat(target).catch(() => null);
  if (!existing) {
    const sourceDistHash = await runtimeTreeSha256(sourceDist);
    const sourceModulesHash = await runtimeTreeSha256(sourceModules);
    for (const name of await fs.readdir(releases)) {
      if (!name.startsWith(`${previousVersion}-legacy-`)) continue;
      const candidate = path.join(releases, name);
      try {
        await verifyRuntimeRelease(candidate);
        const candidatePackage = JSON.parse(await fs.readFile(path.join(candidate, 'package.json'), 'utf8')) as { version?: string };
        if (candidatePackage.version !== previousVersion) continue;
        const [distHash, modulesHash] = await Promise.all([
          runtimeTreeSha256(path.join(candidate, 'dist')),
          runtimeTreeSha256(path.join(candidate, 'node_modules'))
        ]);
        if (sourceDistHash === distHash && sourceModulesHash === modulesHash) {
          return { id: name, root: candidate, digest: await runtimeTreeSha256(candidate) };
        }
      } catch { /* An unrelated incomplete release is preserved and skipped. */ }
    }
    existing = await fs.lstat(target).catch(() => null);
  }
  if (!existing) {
    const staging = `${target}.staging-${process.pid}`;
    await fs.mkdir(staging, { mode: 0o700 });
    try {
      await fs.cp(sourceDist, path.join(staging, 'dist'), { recursive: true, dereference: false, verbatimSymlinks: true });
      await fs.cp(sourceModules, path.join(staging, 'node_modules'), { recursive: true, dereference: false, verbatimSymlinks: true });
      for (const file of ['package.json', 'package-lock.json']) await fs.copyFile(path.join(canonicalRepo, file), path.join(staging, file));
      await verifyRuntimeRelease(staging);
      await fs.rename(staging, target);
    } finally {
      await fs.rm(staging, { recursive: true, force: true }).catch(() => undefined);
    }
  } else {
    await verifyRuntimeRelease(target);
    const [sourceDistHash, savedDistHash, sourceModulesHash, savedModulesHash] = await Promise.all([
      runtimeTreeSha256(sourceDist), runtimeTreeSha256(path.join(target, 'dist')),
      runtimeTreeSha256(sourceModules), runtimeTreeSha256(path.join(target, 'node_modules'))
    ]);
    if (sourceDistHash !== savedDistHash || sourceModulesHash !== savedModulesHash) throw new Error('previous rollback release ID exists with different contents; preserving it and refusing overwrite');
  }
  const previousPlist = await fs.readFile(activePlist);
  const agentDir = path.join(stateDir(), 'runtime', 'bigmac-node-upgrade', id);
  await fs.mkdir(agentDir, { recursive: true, mode: 0o700 });
  const originalAgentSnapshot = path.join(agentDir, 'original-node.plist');
  const rollbackAgent = path.join(agentDir, 'rollback-node.plist');
  await atomicWriteFile(originalAgentSnapshot, previousPlist, 0o600);
  const nodeBin = agent.ProgramArguments![0]!;
  const inherited = (process.env.PATH || '').split(path.delimiter).filter(entry => path.resolve(entry) !== path.resolve(path.join(sourceRoot, 'node_modules/.bin'))).join(path.delimiter);
  const rollbackPath = servicePath(nodeBin, inherited, target);
  await atomicWriteFile(rollbackAgent, plistFor(target, nodeBin, rollbackPath), 0o600);
  await execFileAsync('/usr/bin/plutil', ['-lint', rollbackAgent]);
  return { id, root: target, digest: await runtimeTreeSha256(target) };
}

async function run(): Promise<void> {
  if (process.platform !== 'darwin' || os.userInfo().username !== 'bigmac' || os.hostname().split('.')[0] !== 'bigmac') throw new Error('node-only staging is allowed only on the verified bigmac macOS account');
  if (arg('--node-id') && arg('--node-id') !== nodeId) throw new Error('target node ID must be exactly bigmac');
  if (!path.resolve(sourceRoot).startsWith('/Users/bigmac/')) throw new Error('candidate source must be under /Users/bigmac');
  if (!await fs.realpath(sourceRoot).then(value => value === sourceRoot)) throw new Error('candidate source path must not resolve through a symlink');
  const facts = await gitFacts();
  const packageJson = JSON.parse(await fs.readFile(path.join(sourceRoot, 'package.json'), 'utf8')) as { version?: string };
  if (packageJson.version !== DEX_REACH_VERSION || !versionGreater(DEX_REACH_VERSION, '0.3.2')) throw new Error('candidate package version does not match compiled DEX version or is not newer than installed 0.3.2');

  const envStat = await fs.lstat(envFile);
  if (!envStat.isFile() || envStat.isSymbolicLink() || (envStat.mode & 0o077) !== 0) throw new Error('existing Big Mac node environment file must be a private regular file');
  const priorEnv = { ...process.env };
  const settings = await readEnvFile(envFile);
  try {
    for (const key of ['DEX_REACH_NODE_ID', 'DEX_REACH_NODE_TOKEN', 'DEX_REACH_GATEWAY_WS', 'DEX_REACH_ALLOWED_ROOTS', 'DEX_REACH_PROFILE']) {
      if (settings[key] !== undefined) process.env[key] = settings[key];
    }
    const config = loadNodeConfig();
    // The credentials are needed only to validate the existing configuration. Do not pass them
    // into the compiler or helper processes spawned while staging a release.
    for (const key of ['DEX_REACH_NODE_ID', 'DEX_REACH_NODE_TOKEN', 'DEX_REACH_GATEWAY_WS', 'DEX_REACH_ALLOWED_ROOTS', 'DEX_REACH_PROFILE']) {
      if (priorEnv[key] === undefined) delete process.env[key]; else process.env[key] = priorEnv[key]!;
    }
    validateBigMacNodeConfig({ platform: process.platform, username: os.userInfo().username, hostname: os.hostname(), nodeId: config.nodeId, allowedRoots: config.allowedRoots, sourceRoot });
    const gateway = new URL(config.gatewayWs);
    const access = await loadAccessState(nodeId);
    const agent = await readAgent();
    const launchd = await runLaunchctl(['print', `${domain}/${nodeLabel}`], 5000);
    if (!launchdIsRunning(launchd.stdout)) throw new Error('existing Big Mac node is not running; preserve it and repair before staging');
    const previousPackage = JSON.parse(await fs.readFile(path.join(canonicalRepo, 'package.json'), 'utf8')) as { version?: string };
    const previousVersion = previousPackage.version || 'unknown';
    const previousFacts = await gitFacts(canonicalRepo);
    const distVersion = await fs.readFile(path.join(canonicalRepo, 'dist/src/shared/version.js'), 'utf8');
    if (!distVersion.includes(`DEX_REACH_VERSION = '${previousVersion}'`)) throw new Error('existing node checkout version and compiled runtime version disagree');
    const disk = await fs.statfs(stateDir());
    const free = disk.bavail * disk.bsize;
    if (free < 2 * 1024 * 1024 * 1024) throw new Error('less than 2 GiB is free for a recoverable node-only staging operation');

    const previous = await stagePreviousRuntime(agent, previousVersion, previousFacts.commit.slice(0, 12));
    const candidateId = await runtimeReleaseId(sourceRoot, DEX_REACH_VERSION);
    const nodeBin = await stableNodeBin(agent.ProgramArguments![0]!);
    const candidateRoot = await buildRuntimeRelease(sourceRoot, stateDir(), candidateId, nodeBin);
    await verifyRuntimeRelease(candidateRoot);
    const candidateHash = await runtimeTreeSha256(candidateRoot);
    const transactionDir = path.join(stateDir(), 'runtime', 'bigmac-node-upgrade', candidateId);
    await fs.mkdir(transactionDir, { recursive: true, mode: 0o700 });
    const candidateAgent = path.join(transactionDir, 'candidate-node.plist');
    const inherited = (process.env.PATH || '').split(path.delimiter).filter(entry => path.resolve(entry) !== path.resolve(path.join(sourceRoot, 'node_modules/.bin'))).join(path.delimiter);
    const candidatePath = servicePath(nodeBin, inherited, candidateRoot);
    await atomicWriteFile(candidateAgent, plistFor(candidateRoot, nodeBin, candidatePath), 0o600);
    await execFileAsync('/usr/bin/plutil', ['-lint', candidateAgent]);
    const rollbackSourcePlist = path.join(stateDir(), 'runtime', 'bigmac-node-upgrade', previous.id, 'rollback-node.plist');
    const rollbackCopy = path.join(transactionDir, 'rollback-node.plist');
    if (rollbackSourcePlist !== rollbackCopy) await fs.copyFile(rollbackSourcePlist, rollbackCopy, constants.COPYFILE_EXCL).catch(async error => {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if ((await fs.readFile(rollbackSourcePlist)).compare(await fs.readFile(rollbackCopy)) !== 0) throw new Error('existing staged rollback LaunchAgent differs; refusing overwrite');
    });
    const originalAgentSnapshot = path.join(stateDir(), 'runtime', 'bigmac-node-upgrade', previous.id, 'original-node.plist');
    const rollbackAgent = path.join(transactionDir, 'rollback-node.plist');
    const manifest: StageManifest = {
      schemaVersion: 1,
      state: 'staged',
      stagedAt: new Date().toISOString(),
      nodeId,
      targetVersion: DEX_REACH_VERSION,
      sourceCommit: facts.commit,
      sourceDirty: facts.dirty,
      candidateProtocol: REACH_PROTOCOL_V2,
      candidateCapabilities: [REACH_DURABLE_TASK_CAPABILITY, REACH_TASK_EVENT_STREAM_CAPABILITY, REACH_TWO_PHASE_PLAN_CAPABILITY],
      allowedRoots: config.allowedRoots,
      profile: config.profile,
      accessMode: access.mode,
      gatewayHost: gateway.hostname,
      environmentFile: envFile,
      candidateReleaseId: candidateId,
      candidateReleaseRoot: candidateRoot,
      candidateReleaseSha256: candidateHash,
      previousVersion,
      previousSourceCommit: previousFacts.commit,
      previousSourceRoot: canonicalRepo,
      previousReleaseId: previous.id,
      previousReleaseRoot: previous.root,
      previousReleaseSha256: previous.digest,
      originalAgentSnapshot,
      rollbackAgent,
      candidateAgent,
      activeAgentPath: activePlist,
      explicitDeploymentAuthorizationRequired: true
    };
    await atomicWriteFile(path.join(transactionDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 0o600);
    console.log(JSON.stringify({
      state: 'STAGED', nodeId, previousVersion, candidateVersion: DEX_REACH_VERSION,
      sourceCommit: facts.commit, sourceDirty: facts.dirty, candidateReleaseId: candidateId,
      previousReleaseId: previous.id, protocol: REACH_PROTOCOL_V2,
      capabilities: manifest.candidateCapabilities, allowedRoots: manifest.allowedRoots,
      profile: manifest.profile, accessMode: manifest.accessMode, gatewayHost: manifest.gatewayHost,
      credentialAndPolicyFilesChanged: false, launchAgentsChanged: false,
      activation: 'AWAITING_EXPLICIT_OWNER_AUTHORIZATION',
      manifest: path.join(transactionDir, 'manifest.json')
    }, null, 2));
  } finally {
    for (const key of ['DEX_REACH_NODE_ID', 'DEX_REACH_NODE_TOKEN', 'DEX_REACH_GATEWAY_WS', 'DEX_REACH_ALLOWED_ROOTS', 'DEX_REACH_PROFILE']) {
      if (priorEnv[key] === undefined) delete process.env[key]; else process.env[key] = priorEnv[key]!;
    }
  }
}

await withFileLock(installLockFile(stateDir()), run, { timeoutMs: 1000 });
