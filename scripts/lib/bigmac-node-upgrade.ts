import path from 'node:path';
import { launchdOneShotPlist, launchdPlist } from './service.js';

export const BIGMAC_NODE_LABEL = 'com.stinkyweasel.dex-reach.node';
export const BIGMAC_NODE_ID = 'bigmac';
export const BIGMAC_ALLOWED_ROOTS = ['/Users/bigmac'] as const;
export const BIGMAC_NODE_UPGRADE_HELPER_LABEL = 'com.stinkyweasel.dex-reach.bigmac-node-upgrade-once';

export type ExistingNodeAgent = {
  Label?: string;
  ProgramArguments?: string[];
  WorkingDirectory?: string;
  EnvironmentVariables?: Record<string, string>;
};

export function versionGreater(target: string, current: string): boolean {
  const tuple = (value: string): number[] => {
    const match = value.match(/^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/);
    if (!match) throw new Error(`invalid semantic version: ${value}`);
    return match.slice(1, 4).map(Number);
  };
  const a = tuple(target), b = tuple(current);
  for (let index = 0; index < 3; index += 1) if (a[index] !== b[index]) return a[index]! > b[index]!;
  return false;
}

export function validateBigMacNodeConfig(input: {
  platform: string;
  username: string;
  hostname: string;
  nodeId: string;
  allowedRoots: string[];
  sourceRoot: string;
}): void {
  if (input.platform !== 'darwin' || input.username !== 'bigmac' || input.hostname.split('.')[0] !== 'bigmac') {
    throw new Error('operation is allowed only on the verified bigmac macOS account');
  }
  if (input.nodeId !== BIGMAC_NODE_ID) throw new Error('target node ID must be exactly bigmac');
  if (input.allowedRoots.length !== 1 || path.resolve(input.allowedRoots[0]!) !== BIGMAC_ALLOWED_ROOTS[0]) {
    throw new Error('existing node identity or allowed roots differ from the recorded Big Mac baseline');
  }
  if (!path.resolve(input.sourceRoot).startsWith('/Users/bigmac/')) throw new Error('candidate source must be under /Users/bigmac');
}

export function validateExistingNodeAgent(agent: ExistingNodeAgent, canonicalRepo: string, envFile: string): string {
  if (agent.Label !== BIGMAC_NODE_LABEL || !Array.isArray(agent.ProgramArguments) || agent.ProgramArguments.length !== 2) {
    throw new Error('existing LaunchAgent is not the expected single node service');
  }
  if (path.resolve(agent.WorkingDirectory || '') !== path.resolve(canonicalRepo)) throw new Error('existing node LaunchAgent working directory changed; refusing to stage');
  if (path.resolve(agent.ProgramArguments[1] || '') !== path.join(canonicalRepo, 'dist/src/node/main.js')) throw new Error('existing node LaunchAgent entry changed; refusing to stage');
  if (path.resolve(agent.EnvironmentVariables?.DEX_REACH_ENV_FILE || '') !== path.resolve(envFile)) throw new Error('existing node credential-file reference changed; refusing to stage');
  if (!agent.ProgramArguments[0]) throw new Error('existing node LaunchAgent has no Node executable');
  return agent.ProgramArguments[0];
}

export function createBigMacNodePlist(input: {
  releaseRoot: string;
  nodeBin: string;
  envFile: string;
  stateDir: string;
  pathEnv: string;
  logsDir: string;
}): string {
  return launchdPlist({
    label: BIGMAC_NODE_LABEL,
    entry: 'dist/src/node/main.js',
    envFile: input.envFile,
    stateDir: input.stateDir,
    pathEnv: input.pathEnv,
    root: input.releaseRoot,
    nodeBin: input.nodeBin,
    logsDir: input.logsDir,
    processType: 'Background'
  });
}

export function createBigMacNodeUpgradeHelperPlist(input: {
  transactionId: string;
  releaseRoot: string;
  nodeBin: string;
  logsDir: string;
}): string {
  if (!/^[a-z0-9][a-z0-9._-]{0,119}$/.test(input.transactionId)) throw new Error('invalid node-upgrade transaction ID');
  return launchdOneShotPlist({
    label: BIGMAC_NODE_UPGRADE_HELPER_LABEL,
    programArguments: [input.nodeBin, path.join(input.releaseRoot, 'dist/scripts/activate-bigmac-node-upgrade.js'), '--run-helper', '--transaction', input.transactionId],
    workingDirectory: input.releaseRoot,
    logsDir: input.logsDir
  });
}
