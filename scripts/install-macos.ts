import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { loadLocalSecrets } from '../src/shared/local-env.js';

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

function xml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function plist(label: string, entry: string, envFile?: string): string {
  const out = path.join(logsDir, `${label}.log`);
  const err = path.join(logsDir, `${label}.err.log`);
  const envBlock = envFile ? `<key>EnvironmentVariables</key><dict><key>DEX_REACH_ENV_FILE</key><string>${xml(envFile)}</string></dict>\n` : '';
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${xml(label)}</string>
<key>ProgramArguments</key><array><string>${xml(nodeBin)}</string><string>${xml(path.join(root, entry))}</string></array>
<key>WorkingDirectory</key><string>${xml(root)}</string>
${envBlock}<key>RunAtLoad</key><true/>
<key>KeepAlive</key><true/>
<key>ThrottleInterval</key><integer>5</integer>
<key>ProcessType</key><string>Background</string>
<key>StandardOutPath</key><string>${xml(out)}</string>
<key>StandardErrorPath</key><string>${xml(err)}</string>
</dict></plist>\n`;
}

const currentNodeId = process.env.DEX_REACH_NODE_ID || os.hostname().toLowerCase().replace(/[^a-z0-9._-]+/g, '-');
const nodeEnv = path.join(stateDir, 'nodes', `${currentNodeId}.env`);
const services = [
  { label: 'com.stinkyweasel.dex-reach.gateway', entry: 'dist/src/gateway/main.js', envFile: undefined },
  { label: 'com.stinkyweasel.dex-reach.node', entry: 'dist/src/node/main.js', envFile: nodeEnv }
];

for (const service of services) {
  const target = path.join(agentsDir, `${service.label}.plist`);
  try { await execFileAsync('launchctl', ['bootout', domain, target]); } catch {}
  await fs.writeFile(target, plist(service.label, service.entry, service.envFile), { mode: 0o600 });
  await execFileAsync('launchctl', ['bootstrap', domain, target]);
  await execFileAsync('launchctl', ['enable', `${domain}/${service.label}`]);
  await execFileAsync('launchctl', ['kickstart', '-k', `${domain}/${service.label}`]);
  console.log(`Installed ${service.label}`);
}

console.log('DEX//REACH launchd services installed.');
