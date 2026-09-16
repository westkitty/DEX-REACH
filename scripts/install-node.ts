/**
 * Second-device node installer. Run on the machine that will become a node, after the gateway owner
 * has enrolled it and handed over the generated <node>.env file:
 *
 *   npm run install:node -- --env /path/to/second-laptop.env [--roots /home/device-owner/projects] [--profile development]
 *                          [--access off|read-only|on] [--service] [--node-id override]
 *
 * Default initial AI access is OFF: installing a node never grants any AI client execution by itself.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { stateDir } from '../src/shared/local-env.js';
import { isAccessMode, saveAccessState, loadAccessState, defaultAccessState } from '../src/shared/access.js';
import { arg, cleanNodeId, flag, nodeEnvFile, readEnvFile, writeEnvFile } from './lib/node-files.js';
import { launchAgentsDir, launchdOneShotPlist, launchdPlist, servicePath, systemdUnit, systemdUserDir } from './lib/service.js';
import { atomicWriteFile } from '../src/shared/state-io.js';

const execFileAsync = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = arg('--env');
if (!source) throw new Error('usage: install-node --env <enrollment .env file> [--roots a:b] [--profile p] [--access off|read-only|on] [--service]');

const incoming = await readEnvFile(path.resolve(source));
if (!incoming.DEX_REACH_NODE_TOKEN || incoming.DEX_REACH_NODE_TOKEN.length < 24) throw new Error('enrollment file has no usable DEX_REACH_NODE_TOKEN');
const nodeId = cleanNodeId(arg('--node-id') || incoming.DEX_REACH_NODE_ID || os.hostname());
const roots = (arg('--roots') || incoming.DEX_REACH_ALLOWED_ROOTS || os.homedir()).split(path.delimiter).map(r => path.resolve(r.trim())).filter(Boolean);
const profile = arg('--profile') || incoming.DEX_REACH_PROFILE || 'development';
const requestedAccess = arg('--access') || incoming.DEX_REACH_INITIAL_ACCESS || 'off';
if (!isAccessMode(requestedAccess)) throw new Error(`invalid --access ${requestedAccess}`);
if (!incoming.DEX_REACH_GATEWAY_WS) throw new Error('enrollment file has no DEX_REACH_GATEWAY_WS');
if (!/^wss:/.test(incoming.DEX_REACH_GATEWAY_WS) && !/^ws:\/\/(127\.0\.0\.1|localhost)/.test(incoming.DEX_REACH_GATEWAY_WS)) {
  throw new Error('refusing a non-TLS gateway URL for a remote node; DEX_REACH_GATEWAY_WS must be wss://');
}
for (const r of roots) {
  try { if (!(await fs.stat(r)).isDirectory()) throw new Error(); } catch { throw new Error(`allowed root does not exist on this machine: ${r}`); }
}

const target = nodeEnvFile(nodeId);
await writeEnvFile(target, {
  DEX_REACH_NODE_ID: nodeId,
  DEX_REACH_NODE_TOKEN: incoming.DEX_REACH_NODE_TOKEN,
  DEX_REACH_GATEWAY_WS: incoming.DEX_REACH_GATEWAY_WS,
  DEX_REACH_ALLOWED_ROOTS: roots.join(path.delimiter),
  DEX_REACH_PROFILE: profile,
  DEX_REACH_INITIAL_ACCESS: requestedAccess
});
// The policy file is created explicitly so the owner's chosen starting mode is on disk before the node runs.
const existing = await fs.stat(path.join(stateDir(), 'nodes', `${nodeId}.access.json`)).catch(() => null);
if (!existing) await saveAccessState(nodeId, { ...defaultAccessState(), mode: requestedAccess });
const access = await loadAccessState(nodeId);
console.log(`Installed node credential for ${nodeId} at ${target} (mode 0600).`);
console.log(`Machine: ${os.hostname()} ${process.platform}/${process.arch} user ${os.userInfo().username}`);
console.log(`Allowed roots: ${roots.join(', ')}`);
console.log(`Profile: ${profile}`);
console.log(`AI access: ${access.mode.toUpperCase()}${access.mode === 'off' ? ' — nothing can run remotely until you run: npm run dex -- enable [--for 30m]' : ''}`);

if (flag('--service')) {
  const logsDir = path.join(stateDir(), 'logs');
  await fs.mkdir(logsDir, { recursive: true, mode: 0o700 });
  const spec = { label: 'com.stinkyweasel.dex-reach.node', entry: 'dist/src/node/main.js', envFile: target, stateDir: stateDir(), pathEnv: servicePath(process.execPath), root, nodeBin: process.execPath, logsDir };
  if (process.platform === 'darwin') {
    const domain = `gui/${process.getuid?.() ?? os.userInfo().uid}`;
    const plist = path.join(launchAgentsDir(), `${spec.label}.plist`);
    const helperLabel = 'com.stinkyweasel.dex-reach.node-install-reloader-once';
    const helperTarget = path.join(launchAgentsDir(), `${helperLabel}.plist`);
    const helperEntry = path.join(root, 'dist', 'scripts', 'reload-launchagents.js');
    const installStatus = path.join(stateDir(), 'install-node.status.json');
    await fs.mkdir(launchAgentsDir(), { recursive: true });

    // Stage and lint the node definition before touching a running service. A node may be updating
    // itself through DEX//REACH, so inline bootout/kickstart would destroy the request doing the update.
    await atomicWriteFile(plist, launchdPlist(spec), 0o600);
    await execFileAsync('/usr/bin/plutil', ['-lint', plist]);
    try { await execFileAsync('/bin/launchctl', ['bootout', `${domain}/${helperLabel}`]); } catch {}
    await atomicWriteFile(installStatus, JSON.stringify({
      state: 'scheduled', scheduledAt: new Date().toISOString(), domain,
      services: [{ label: spec.label, target: plist }]
    }, null, 2) + '\n', 0o600);
    await atomicWriteFile(helperTarget, launchdOneShotPlist({
      label: helperLabel,
      programArguments: [process.execPath, helperEntry, '--domain', domain, '--status', installStatus, '--delay-ms', '3000', '--cleanup-plist', helperTarget, '--service', spec.label, plist],
      workingDirectory: root,
      logsDir
    }), 0o600);
    await execFileAsync('/usr/bin/plutil', ['-lint', helperTarget]);
    await execFileAsync('/bin/launchctl', ['bootstrap', domain, helperTarget]);
    console.log(`Staged launchd service ${spec.label}; one-shot reload scheduled. Status: ${installStatus}`);
  } else if (process.platform === 'linux') {
    const unit = path.join(systemdUserDir(), 'dex-reach-node.service');
    await fs.mkdir(systemdUserDir(), { recursive: true });
    await atomicWriteFile(unit, systemdUnit(spec), 0o600);
    console.log(`Wrote ${unit} (systemd user unit; not yet verified on real Linux hardware).`);
    try {
      await execFileAsync('systemctl', ['--user', 'daemon-reload']);
      await execFileAsync('systemctl', ['--user', 'enable', '--now', 'dex-reach-node.service']);
      console.log('Enabled and started dex-reach-node.service.');
    } catch (error) {
      console.log(`systemctl --user was not usable here (${error instanceof Error ? error.message : String(error)}); start manually:`);
      console.log(`  DEX_REACH_ENV_FILE=${target} node ${path.join(root, 'dist/src/node/main.js')}`);
    }
  } else {
    console.log(`No service integration for ${process.platform}. Start the node manually:`);
    console.log(`  DEX_REACH_ENV_FILE=${target} node ${path.join(root, 'dist/src/node/main.js')}`);
  }
} else {
  console.log('Start the node now with:');
  console.log(`  DEX_REACH_ENV_FILE=${target} npm run node`);
  console.log('or re-run with --service to install it as a background service (macOS launchd verified; Linux systemd generated, unverified).');
}
console.log('Check it any time with: npm run dex -- status');
