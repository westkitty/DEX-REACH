import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { NodeAuthStore } from '../src/gateway/node-auth.js';
import { loadOwnerSecrets, stateDir as configuredStateDir } from '../src/shared/local-env.js';
import { removeRevokedNode } from '../src/shared/revoked-nodes.js';
import { atomicWriteFile } from '../src/shared/state-io.js';

loadOwnerSecrets();
const stateDir = configuredStateDir();
const store = new NodeAuthStore(stateDir);
await store.initialize();

function cleanNodeId(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
}

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function publicNodeWs(): string {
  const base = new URL(process.env.DEX_REACH_PUBLIC_BASE_URL || 'http://127.0.0.1:8787');
  base.protocol = base.protocol === 'https:' ? 'wss:' : 'ws:';
  base.pathname = '/node';
  base.search = '';
  return base.toString();
}
async function writeNodeEnv(file: string, nodeId: string, token: string, defaults: Record<string, string> = {}): Promise<void> {
  let current: Record<string, string> = {};
  try {
    for (const line of (await fs.readFile(file, 'utf8')).split(/\r?\n/)) {
      if (!line || line.startsWith('#') || !line.includes('=')) continue;
      const [key, ...rest] = line.split('=');
      if (!key) continue;
      current[key] = rest.join('=');
    }
  } catch {}
  const values: Record<string, string> = {
    DEX_REACH_ALLOWED_ROOTS: process.env.DEX_REACH_ALLOWED_ROOTS || os.homedir(),
    DEX_REACH_PROFILE: process.env.DEX_REACH_PROFILE || 'development',
    DEX_REACH_GATEWAY_WS: publicNodeWs(),
    ...current,
    ...defaults,
    DEX_REACH_NODE_ID: nodeId,
    DEX_REACH_NODE_TOKEN: token
  };
  // A freshly enrolled device starts with AI access OFF; its owner turns it on locally.
  if (!('DEX_REACH_INITIAL_ACCESS' in values)) values.DEX_REACH_INITIAL_ACCESS = 'off';
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const text = Object.entries(values).map(([key, value]) => `${key}=${value}`).join('\n') + '\n';
  await atomicWriteFile(file, text, 0o600);
}

const command = process.argv[2] || 'list';
const rawNodeId = process.argv[3];
const nodeId = rawNodeId ? cleanNodeId(rawNodeId) : undefined;
const defaultOutput = nodeId ? path.join(stateDir, 'nodes', `${nodeId}.env`) : undefined;
if (command === 'list') {
  console.log(JSON.stringify(store.list(), null, 2));
} else if (command === 'migrate-local') {
  const legacyNodeId = cleanNodeId(process.env.DEX_REACH_NODE_ID || os.hostname());
  const legacyToken = process.env.DEX_REACH_NODE_TOKEN || '';
  if (legacyToken.length < 24) throw new Error('legacy DEX_REACH_NODE_TOKEN is unavailable');
  const imported = await store.importLegacy(legacyNodeId, legacyToken);
  const output = path.join(stateDir, 'nodes', `${legacyNodeId}.env`);
  await writeNodeEnv(output, legacyNodeId, legacyToken, {
    DEX_REACH_GATEWAY_WS: process.env.DEX_REACH_GATEWAY_WS || 'ws://127.0.0.1:8787/node'
  });
  console.log(`${imported ? 'Imported' : 'Preserved'} ${legacyNodeId}; credential file: ${output}`);
} else if (command === 'enroll') {
  if (!nodeId) throw new Error('enroll requires a node id');
  const token = await store.enroll(nodeId);
  const output = path.resolve(arg('--output') || defaultOutput!);
  await writeNodeEnv(output, nodeId, token, {
    DEX_REACH_PROFILE: arg('--profile') || 'development',
    DEX_REACH_ALLOWED_ROOTS: arg('--roots') || os.homedir(),
    DEX_REACH_GATEWAY_WS: arg('--gateway-ws') || publicNodeWs()
  });
  console.log(`Enrolled ${nodeId}; credential written to ${output} (mode 0600, token not shown).`);
  console.log('Send that file to the device owner over a private channel, then on that device run:');
  console.log(`  npm run install:node -- --env ${path.basename(output)} --service`);
  console.log('The new node starts with AI access OFF until its owner runs: npm run dex -- enable');
} else if (command === 'rotate') {
  if (!nodeId) throw new Error('rotate requires a node id');
  const graceSeconds = Number(arg('--grace-seconds') || 600);
  const token = await store.rotate(nodeId, graceSeconds * 1000);
  const output = path.resolve(arg('--output') || defaultOutput!);
  await writeNodeEnv(output, nodeId, token);
  console.log(`Rotated ${nodeId}; new credential written to ${output}; old credential grace=${graceSeconds}s`);
} else if (command === 'revoke') {
  if (!nodeId) throw new Error('revoke requires a node id');
  const changed = await store.revoke(nodeId);
  console.log(changed ? `Revoked ${nodeId}` : `No enrolled node named ${nodeId}`);
} else if (command === 'forget') {
  if (!nodeId) throw new Error('forget requires a node id');
  const removed = await store.forget(nodeId);
  await removeRevokedNode(stateDir, nodeId);
  console.log(removed ? `Forgot revoked node ${nodeId}` : `No enrolled node named ${nodeId}`);
} else if (command === 'enroll-token') {
  if (!nodeId) throw new Error('enroll-token requires a node id');
  const token = await store.createEnrollmentToken(nodeId);
  console.log(`One-use enrollment token for ${nodeId} created. Deliver it privately; it is not stored in plaintext.`);
  console.log(token);
} else if (command === 'complete-migration') {
  if (!nodeId) throw new Error('complete-migration requires a node id');
  await store.completeMigration(nodeId);
  console.log(`${nodeId} is now asymmetric-only. Bearer tokens no longer authenticate and the node cannot silently downgrade.`);
} else {
  throw new Error('usage: node-credentials.ts list | migrate-local | enroll <node> | enroll-token <node> | complete-migration <node> | rotate <node> | revoke <node> | forget <revoked node>');
}
