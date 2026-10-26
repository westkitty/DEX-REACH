import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { BIGMAC_NODE_LABEL, BIGMAC_NODE_UPGRADE_HELPER_LABEL, createBigMacNodePlist, createBigMacNodeUpgradeHelperPlist, validateBigMacNodeConfig, validateExistingNodeAgent, versionGreater } from '../scripts/lib/bigmac-node-upgrade.js';

test('candidate version must be a strictly newer semantic release', () => {
  assert.equal(versionGreater('0.4.0', '0.3.2'), true);
  assert.equal(versionGreater('0.4.0', '0.4.0'), false);
  assert.equal(versionGreater('0.3.1', '0.3.2'), false);
  assert.throws(() => versionGreater('main', '0.3.2'), /invalid semantic version/);
});

test('Big Mac target checks preserve the existing node identity and refuse volume roots', () => {
  assert.doesNotThrow(() => validateBigMacNodeConfig({
    platform: 'darwin', username: 'bigmac', hostname: 'bigmac', nodeId: 'bigmac',
    allowedRoots: ['/Users/bigmac'], sourceRoot: '/Users/bigmac/DEX-REACH-bigmac-hub-candidate'
  }));
  assert.throws(() => validateBigMacNodeConfig({
    platform: 'darwin', username: 'bigmac', hostname: 'bigmac', nodeId: 'bigmac',
    allowedRoots: ['/Users/bigmac', '/Volumes/wc2tb'], sourceRoot: '/Users/bigmac/candidate'
  }), /allowed roots/);
  assert.throws(() => validateBigMacNodeConfig({
    platform: 'darwin', username: 'bigmac', hostname: 'bigmac', nodeId: 'other',
    allowedRoots: ['/Users/bigmac'], sourceRoot: '/Users/bigmac/candidate'
  }), /node ID/);
  assert.throws(() => validateBigMacNodeConfig({
    platform: 'darwin', username: 'andrew', hostname: 'MacBook-Air', nodeId: 'bigmac',
    allowedRoots: ['/Users/bigmac'], sourceRoot: '/Users/bigmac/candidate'
  }), /verified bigmac/);
});

test('existing service admission accepts only the current Big Mac node LaunchAgent', () => {
  const valid = {
    Label: BIGMAC_NODE_LABEL,
    ProgramArguments: ['/opt/homebrew/bin/node', '/Users/bigmac/DEX-REACH/dist/src/node/main.js'],
    WorkingDirectory: '/Users/bigmac/DEX-REACH',
    EnvironmentVariables: { DEX_REACH_ENV_FILE: '/Users/bigmac/.dex-reach/nodes/bigmac.env' }
  };
  assert.equal(validateExistingNodeAgent(valid, '/Users/bigmac/DEX-REACH', valid.EnvironmentVariables.DEX_REACH_ENV_FILE), '/opt/homebrew/bin/node');
  assert.throws(() => validateExistingNodeAgent({ ...valid, Label: 'com.stinkyweasel.dex-reach.gateway' }, '/Users/bigmac/DEX-REACH', valid.EnvironmentVariables.DEX_REACH_ENV_FILE), /single node service/);
  assert.throws(() => validateExistingNodeAgent({ ...valid, ProgramArguments: [...valid.ProgramArguments, '--gateway'] }, '/Users/bigmac/DEX-REACH', valid.EnvironmentVariables.DEX_REACH_ENV_FILE), /single node service/);
});

test('staged LaunchAgent contains only the node entry and reuses the existing private config path', () => {
  const plist = createBigMacNodePlist({
    releaseRoot: '/Users/bigmac/.dex-reach/runtime/releases/0.4.0-candidate',
    nodeBin: '/opt/homebrew/bin/node',
    envFile: '/Users/bigmac/.dex-reach/nodes/bigmac.env',
    stateDir: '/Users/bigmac/.dex-reach',
    pathEnv: '/opt/homebrew/bin:/usr/bin',
    logsDir: '/Users/bigmac/.dex-reach/logs'
  });
  assert.match(plist, /<key>Label<\/key><string>com\.stinkyweasel\.dex-reach\.node<\/string>/);
  assert.ok(plist.includes(path.join('/Users/bigmac/.dex-reach/runtime/releases/0.4.0-candidate', 'dist/src/node/main.js')));
  assert.match(plist, /<key>DEX_REACH_ENV_FILE<\/key><string>\/Users\/bigmac\/\.dex-reach\/nodes\/bigmac\.env<\/string>/);
  assert.equal((plist.match(/<key>Label<\/key>/g) || []).length, 1);
  assert.doesNotMatch(plist, /dex-reach\.(?:gateway|coordinator|worker)/);
  assert.doesNotMatch(plist, /Volumes\/wc2tb/);
});

test('activation is delegated to one independent one-shot launchd helper', () => {
  const plist = createBigMacNodeUpgradeHelperPlist({
    transactionId: '0.4.0-candidate',
    releaseRoot: '/Users/bigmac/.dex-reach/runtime/releases/0.4.0-candidate',
    nodeBin: '/opt/homebrew/bin/node',
    logsDir: '/Users/bigmac/.dex-reach/logs'
  });
  assert.match(plist, new RegExp(`<key>Label</key><string>${BIGMAC_NODE_UPGRADE_HELPER_LABEL.replaceAll('.', '\\.')}</string>`));
  assert.match(plist, /<key>RunAtLoad<\/key><true\/>/);
  assert.match(plist, /--run-helper/);
  assert.match(plist, /--transaction/);
  assert.doesNotMatch(plist, /<key>KeepAlive<\/key>/);
  assert.throws(() => createBigMacNodeUpgradeHelperPlist({
    transactionId: '../../gateway', releaseRoot: '/tmp', nodeBin: '/usr/bin/node', logsDir: '/tmp'
  }), /transaction ID/);
});
