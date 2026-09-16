import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { loadLocalSecrets } from '../src/shared/local-env.js';
import { launchdPlist } from './lib/service.js';

const execFileAsync = promisify(execFile);
loadLocalSecrets();
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const agentsDir = path.join(os.homedir(), 'Library', 'LaunchAgents');
const stateDir = path.join(os.homedir(), '.dex-reach');
const logsDir = path.join(stateDir, 'logs');
const domain = `gui/${process.getuid?.() ?? os.userInfo().uid}`;
const nodeBin = process.execPath;

await fs.mkdir(agentsDir, { recursive: true });
await fs.mkdir(logsDir, { recursive: true, mode: 0o700 });


const currentNodeId = process.env.DEX_REACH_NODE_ID || os.hostname().toLowerCase().replace(/[^a-z0-9._-]+/g, '-');
const nodeEnv = path.join(stateDir, 'nodes', `${currentNodeId}.env`);
const services = [
  { label: 'com.stinkyweasel.dex-reach.gateway', entry: 'dist/src/gateway/main.js', envFile: undefined },
  { label: 'com.stinkyweasel.dex-reach.node', entry: 'dist/src/node/main.js', envFile: nodeEnv }
];

for (const service of services) {
  const target = path.join(agentsDir, `${service.label}.plist`);
  try { await execFileAsync('launchctl', ['bootout', domain, target]); } catch {}
  await fs.writeFile(target, launchdPlist({ label: service.label, entry: service.entry, envFile: service.envFile, root, nodeBin, logsDir }), { mode: 0o600 });
  await execFileAsync('launchctl', ['bootstrap', domain, target]);
  await execFileAsync('launchctl', ['enable', `${domain}/${service.label}`]);
  await execFileAsync('launchctl', ['kickstart', '-k', `${domain}/${service.label}`]);
  console.log(`Installed ${service.label}`);
}

console.log('DEX//REACH launchd services installed.');
