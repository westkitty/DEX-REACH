/**
 * Two-node routing/policy proof against the LIVE gateway through the public OAuth + MCP path.
 * Requires: the real node online, and a second node enrolled and running with an isolated state dir:
 *   SIM_NODE_ID=test-second-node SIM_STATE_DIR=/tmp/dex-sim-second/state SIM_ROOT=/tmp/dex-sim-second/home npx tsx scripts/sim-two-nodes.ts
 * It flips the simulated node's LOCAL policy file (as its owner would) and proves the node, not the gateway
 * or the client, decides. It never touches the real node's policy.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { UnauthorizedError, type OAuthClientProvider } from '@modelcontextprotocol/client';
import type { OAuthClientInformationFull, OAuthClientMetadata, OAuthTokens } from '@modelcontextprotocol/server';
import { loadOwnerSecrets } from '../src/shared/local-env.js';
import { loadAccessState, saveAccessState } from '../src/shared/access.js';
import { DEX_REACH_VERSION } from '../src/shared/version.js';

loadOwnerSecrets();
const base = new URL(process.env.DEX_REACH_PUBLIC_BASE_URL || 'http://127.0.0.1:8787');
const resource = new URL('/mcp', base);
const realNode = process.env.DEX_REACH_NODE_ID || '';
const simNode = process.env.SIM_NODE_ID || 'test-second-node';
const simState = process.env.SIM_STATE_DIR || '/tmp/dex-sim-second/state';
const simRoot = process.env.SIM_ROOT || '/tmp/dex-sim-second/home';
const callbackUrl = 'http://127.0.0.1:49153/callback';

class Provider implements OAuthClientProvider {
  private info?: OAuthClientInformationFull; private saved?: OAuthTokens; private verifier?: string; authorizationUrl?: URL;
  get redirectUrl() { return callbackUrl; }
  get clientMetadata(): OAuthClientMetadata { return { client_name: 'DEX REACH Smoke (two-node sim)', redirect_uris: [callbackUrl], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' }; }
  clientInformation() { return this.info; } saveClientInformation(v: OAuthClientInformationFull) { this.info = v; }
  tokens() { return this.saved; } saveTokens(v: OAuthTokens) { this.saved = v; }
  redirectToAuthorization(url: URL) { this.authorizationUrl = url; }
  saveCodeVerifier(v: string) { this.verifier = v; } codeVerifier() { if (!this.verifier) throw new Error('no verifier'); return this.verifier; }
}

async function authorize(url: URL): Promise<URLSearchParams> {
  const html = await (await fetch(url)).text();
  const ticket = html.match(/name="ticket" value="([^"]+)"/)?.[1];
  if (!ticket) throw new Error('no ticket');
  const approval = await fetch(new URL('/dex/approve', base), { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ ticket, username: process.env.DEX_REACH_OWNER_USER || '', password: process.env.DEX_REACH_OWNER_PASSWORD || '' }), redirect: 'manual' });
  // The whole response, so the SDK can check RFC 9207's `iss` rather than being handed a bare code.
  const params = new URL(approval.headers.get('location') || '').searchParams;
  if (!params.get('code')) throw new Error('approval failed');
  return params;
}

const provider = new Provider();
const client = new Client({ name: 'dex-reach-two-node-sim', version: DEX_REACH_VERSION }, { capabilities: {} });
async function connect(): Promise<void> {
  const transport = new StreamableHTTPClientTransport(resource, { authProvider: provider });
  try { await client.connect(transport); } catch (error) {
    if (!(error instanceof UnauthorizedError) || !provider.authorizationUrl) throw error;
    await transport.finishAuth(await authorize(provider.authorizationUrl));
    await connect();
  }
}

type Outcome = { ok: boolean; text: string };
async function call(name: string, args: Record<string, unknown>): Promise<Outcome> {
  const result = await client.callTool({ name, arguments: args });
  const text = (result.content as { text?: string }[]).map(c => c.text || '').join('');
  return { ok: !result.isError, text };
}
const results: { check: string; pass: boolean; detail: string }[] = [];
function expect(check: string, pass: boolean, detail: string): void { results.push({ check, pass, detail }); console.log(`${pass ? 'PASS' : 'FAIL'}  ${check}${pass ? '' : `  -> ${detail}`}`); }
async function setSimMode(mode: 'off' | 'read-only' | 'on', clients: Record<string, 'off' | 'read-only' | 'on'> = {}): Promise<void> {
  const current = await loadAccessState(simNode, simState);
  await saveAccessState(simNode, { ...current, mode, until: null, revertTo: null, clients }, simState);
  await new Promise(r => setTimeout(r, 2500)); // let the node publish its status to the gateway
}

await connect();
const nodes = JSON.parse((await call('reach_list_nodes', {})).text) as { nodeId: string; online: boolean; aiAccess: { mode: string } | string; allowedRoots: string[] }[];
const byId = Object.fromEntries(nodes.map(n => [n.nodeId, n]));
expect('both nodes listed separately', Boolean(byId[realNode] && byId[simNode]), JSON.stringify(nodes.map(n => n.nodeId)));
expect('nodes advertise different allowed roots', JSON.stringify(byId[realNode]?.allowedRoots) !== JSON.stringify(byId[simNode]?.allowedRoots), '');

// 1. Simulated node OFF (its installed default): everything refused locally, real node unaffected.
await setSimMode('off');
const offFp = await call('reach_fingerprint', { node_id: simNode });
expect('sim OFF: fingerprint refused with owner-attributed error', !offFp.ok && /NODE OWNER has disabled/.test(offFp.text), offFp.text);
const offWrite = await call('reach_file_write', { node_id: simNode, path: path.join(simRoot, 'should-not-exist.txt'), text: 'x' });
expect('sim OFF: write refused', !offWrite.ok, offWrite.text);
expect('sim OFF: no file created on sim root', (await fs.stat(path.join(simRoot, 'should-not-exist.txt')).catch(() => null)) === null, '');
const realFp = await call('reach_fingerprint', { node_id: realNode });
expect('real node still executes while sim is OFF', realFp.ok && realFp.text.includes(realNode), realFp.text.slice(0, 120));
const listed = JSON.parse((await call('reach_list_nodes', {})).text) as typeof nodes;
expect('gateway displays sim aiAccess=off', (listed.find(n => n.nodeId === simNode)?.aiAccess as { mode: string })?.mode === 'off', JSON.stringify(listed.find(n => n.nodeId === simNode)?.aiAccess));

// 2. Simulated node READ-ONLY: reads succeed, mutations refused.
await setSimMode('read-only');
const roFp = await call('reach_fingerprint', { node_id: simNode });
expect('sim READ-ONLY: fingerprint succeeds and is the sim identity', roFp.ok && roFp.text.includes(`"nodeId": "${simNode}"`), roFp.text.slice(0, 120));
const roWrite = await call('reach_file_write', { node_id: simNode, path: path.join(simRoot, 'ro-write.txt'), text: 'x' });
expect('sim READ-ONLY: write refused as mutation', !roWrite.ok && /read-only/.test(roWrite.text), roWrite.text);
const roPwd = await call('reach_process_run', { node_id: simNode, command: 'pwd', cwd: simRoot });
expect('sim READ-ONLY: inspection command allowed', roPwd.ok && roPwd.text.includes(simRoot), roPwd.text.slice(0, 120));
const roTouch = await call('reach_process_run', { node_id: simNode, command: 'touch ro-touch.txt', cwd: simRoot });
expect('sim READ-ONLY: mutating command refused', !roTouch.ok && /read-only profile/.test(roTouch.text), roTouch.text);
expect('sim READ-ONLY: nothing was created', (await fs.readdir(simRoot)).filter(f => f.endsWith('.txt')).length === 0, (await fs.readdir(simRoot)).join(','));

// 3. Simulated node ON: writes land on the sim root only, never on the real node.
await setSimMode('on');
const marker = `sim-${Date.now()}`;
const onWrite = await call('reach_file_write', { node_id: simNode, path: path.join(simRoot, 'projects', 'on-write.txt'), text: marker });
expect('sim ON: write succeeds', onWrite.ok, onWrite.text);
expect('sim ON: file exists on sim root with exact content', (await fs.readFile(path.join(simRoot, 'projects', 'on-write.txt'), 'utf8').catch(() => '')) === marker, '');
const escape = await call('reach_file_write', { node_id: simNode, path: '/tmp/dex-sim-escape.txt', text: marker });
expect('sim ON: path outside sim roots refused', !escape.ok && /outside allowed roots/.test(escape.text), escape.text);
expect('sim ON: escaped file not created', (await fs.stat('/tmp/dex-sim-escape.txt').catch(() => null)) === null, '');

// 4. Per-client ceiling: block only the "smoke" kind (which this script is) while node stays ON.
await setSimMode('on', { smoke: 'off' });
const ceiling = await call('reach_fingerprint', { node_id: simNode });
expect('sim ON + smoke client blocked: refused for this client kind only', !ceiling.ok && /for smoke clients/.test(ceiling.text), ceiling.text);
await setSimMode('on', { smoke: 'read-only' });
const ceilingRead = await call('reach_file_read', { node_id: simNode, path: path.join(simRoot, 'projects', 'on-write.txt') });
expect('sim ON + smoke read-only: read allowed', ceilingRead.ok && ceilingRead.text.includes(marker), ceilingRead.text.slice(0, 100));
const ceilingWrite = await call('reach_file_write', { node_id: simNode, path: path.join(simRoot, 'projects', 'x.txt'), text: 'x' });
expect('sim ON + smoke read-only: write refused', !ceilingWrite.ok, ceilingWrite.text);

// 5. Explicit routing: unknown and typo'd IDs fail; nothing falls back.
const typo = await call('reach_fingerprint', { node_id: 'test-second-nod' });
expect('typo node id fails, no fallback', !typo.ok && /not enrolled or not online/.test(typo.text), typo.text);
const unknown = await call('reach_process_run', { node_id: 'does-not-exist', command: 'pwd' });
expect('unknown node id fails', !unknown.ok, unknown.text);

// 6. Audit on the sim node attributes the actor.
const audit = (await fs.readFile(path.join(simState, 'audit.jsonl'), 'utf8')).trim().split('\n').map(l => JSON.parse(l) as { actor?: { kind: string; clientName: string }; operation: string; ok: boolean; args?: { text?: string } });
expect('sim audit attributes requests to the smoke client kind', audit.every(e => e.actor?.kind === 'smoke'), JSON.stringify(audit.slice(-1)));
expect('sim audit never stores written file content', audit.every(e => !e.args?.text || /bytes omitted/.test(e.args.text)), '');
expect('sim audit recorded refusals', audit.some(e => !e.ok), '');

await setSimMode('off');
await client.close();
const failed = results.filter(r => !r.pass);
console.log(JSON.stringify({ ok: failed.length === 0, checks: results.length, failed: failed.map(f => f.check) }, null, 2));
process.exit(failed.length ? 1 : 0);
