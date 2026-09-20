import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const agentsDir = path.join(os.homedir(), 'Library', 'LaunchAgents');
const domain = `gui/${process.getuid?.() ?? os.userInfo().uid}`;
const labels = [
  'com.stinkyweasel.dex-reach.coordinator',
  'com.stinkyweasel.dex-reach.gateway',
  'com.stinkyweasel.dex-reach.node'
];

for (const label of labels) {
  const target = path.join(agentsDir, `${label}.plist`);
  try { await execFileAsync('launchctl', ['bootout', domain, target]); } catch {}
  await fs.rm(target, { force: true });
  console.log(`Removed ${label}`);
}
console.log('DEX//REACH services removed; local state and secrets were preserved.');
