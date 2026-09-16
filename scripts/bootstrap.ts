import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { stateDir as configuredStateDir } from '../src/shared/local-env.js';
import { atomicWriteFile, withFileLock } from '../src/shared/state-io.js';

const stateDir = configuredStateDir();
const file = path.join(stateDir, 'secrets.env');
const lockFile = path.join(stateDir, '.bootstrap.lock');
const publicFlag = process.argv.indexOf('--public-url');
const publicUrl = publicFlag >= 0 ? process.argv[publicFlag + 1] : 'http://127.0.0.1:8787';
if (!publicUrl) throw new Error('--public-url requires a value');

await fs.mkdir(stateDir, { recursive: true, mode: 0o700 });
let created = false;
await withFileLock(lockFile, async () => {
  try {
    await fs.access(file);
    return;
  } catch {
    // First boot. Continue while holding the bootstrap lock.
  }

  const ownerPassword = crypto.randomBytes(24).toString('base64url');
  const nodeToken = crypto.randomBytes(32).toString('base64url');
  const nodeId = os.hostname().toLowerCase().replace(/[^a-z0-9._-]+/g, '-');
  const roots = [os.homedir(), '/tmp'].join(path.delimiter);
  const lines = [
    'DEX_REACH_GATEWAY_HOST=127.0.0.1',
    'DEX_REACH_GATEWAY_PORT=8787',
    `DEX_REACH_PUBLIC_BASE_URL=${publicUrl}`,
    `DEX_REACH_OWNER_USER=${os.userInfo().username}`,
    `DEX_REACH_OWNER_PASSWORD=${ownerPassword}`,
    `DEX_REACH_NODE_TOKEN=${nodeToken}`,
    `DEX_REACH_NODE_ID=${nodeId}`,
    `DEX_REACH_ALLOWED_ROOTS=${roots}`,
    'DEX_REACH_PROFILE=full-local',
    'DEX_REACH_GATEWAY_WS=ws://127.0.0.1:8787/node'
  ];

  const nodeDir = path.join(stateDir, 'nodes');
  await fs.mkdir(nodeDir, { recursive: true, mode: 0o700 });
  const nodeFile = path.join(nodeDir, `${nodeId}.env`);
  const nodeLines = lines.filter(line => /^(DEX_REACH_NODE_|DEX_REACH_ALLOWED_ROOTS|DEX_REACH_PROFILE|DEX_REACH_GATEWAY_WS)=?/.test(line));

  // Write the node enrollment copy first. secrets.env is the bootstrap commit marker and is written
  // last, so a crash cannot leave a completed-looking bootstrap whose node file was never created.
  await atomicWriteFile(nodeFile, nodeLines.join('\n') + '\n', 0o600);
  await atomicWriteFile(file, lines.join('\n') + '\n', 0o600);
  created = true;
});

if (!created) {
  console.log(`DEX//REACH secrets already exist at ${file}; existing credentials preserved.`);
} else {
  console.log(`DEX//REACH secrets created at ${file} with mode 0600.`);
  console.log('Owner password was generated locally and was not printed.');
}
