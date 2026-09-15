import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const stateDir = path.join(os.homedir(), '.dex-reach');
const file = path.join(stateDir, 'secrets.env');
const publicFlag = process.argv.indexOf('--public-url');
const publicUrl = publicFlag >= 0 ? process.argv[publicFlag + 1] : 'http://127.0.0.1:8787';
if (!publicUrl) throw new Error('--public-url requires a value');

await fs.mkdir(stateDir, { recursive: true, mode: 0o700 });
try {
  await fs.access(file);
  console.log(`DEX//REACH secrets already exist at ${file}; existing credentials preserved.`);
  process.exit(0);
} catch {
  // First boot.
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
await fs.writeFile(file, lines.join('\n') + '\n', { mode: 0o600 });
console.log(`DEX//REACH secrets created at ${file} with mode 0600.`);
console.log('Owner password was generated locally and was not printed.');
