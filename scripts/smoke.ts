import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { UnauthorizedError, type OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import type { OAuthClientInformationFull, OAuthClientMetadata, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import { loadLocalSecrets } from '../src/shared/local-env.js';

const execFileAsync = promisify(execFile);

loadLocalSecrets();
const base = new URL(process.env.DEX_REACH_PUBLIC_BASE_URL || 'http://127.0.0.1:8787');
const resource = new URL('/mcp', base);
const ownerUser = process.env.DEX_REACH_OWNER_USER || '';
const ownerPassword = process.env.DEX_REACH_OWNER_PASSWORD || '';
const callbackUrl = 'http://127.0.0.1:49152/callback';

class SmokeOAuthProvider implements OAuthClientProvider {
  private info?: OAuthClientInformationFull;
  private savedTokens?: OAuthTokens;
  private verifier?: string;
  authorizationUrl?: URL;

  get redirectUrl(): string | URL { return callbackUrl; }
  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: 'DEX REACH Smoke',
      redirect_uris: [callbackUrl],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none'
    };
  }
  clientInformation(): OAuthClientInformationFull | undefined { return this.info; }
  saveClientInformation(value: OAuthClientInformationFull): void { this.info = value; }
  tokens(): OAuthTokens | undefined { return this.savedTokens; }
  saveTokens(value: OAuthTokens): void { this.savedTokens = value; }
  redirectToAuthorization(url: URL): void { this.authorizationUrl = url; }
  saveCodeVerifier(value: string): void { this.verifier = value; }
  codeVerifier(): string { if (!this.verifier) throw new Error('missing PKCE verifier'); return this.verifier; }
}

async function authorize(url: URL): Promise<string> {
  const page = await fetch(url);
  if (!page.ok) throw new Error(`authorization page failed: ${page.status} ${await page.text()}`);
  const html = await page.text();
  const ticket = html.match(/name="ticket" value="([^"]+)"/)?.[1];
  if (!ticket) throw new Error('authorization ticket was not rendered');
  const approval = await fetch(new URL('/dex/approve', base), {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ ticket, username: ownerUser, password: ownerPassword }),
    redirect: 'manual'
  });
  if (approval.status < 300 || approval.status >= 400) throw new Error(`approval failed: ${approval.status}`);
  const location = approval.headers.get('location');
  if (!location) throw new Error('approval redirect missing');
  const code = new URL(location).searchParams.get('code');
  if (!code) throw new Error('authorization code missing');
  return code;
}

const provider = new SmokeOAuthProvider();
const client = new Client({ name: 'dex-reach-smoke', version: '0.2.0' }, { capabilities: {} });

async function connect(): Promise<void> {
  const transport = new StreamableHTTPClientTransport(resource, { authProvider: provider });
  try {
    await client.connect(transport);
  } catch (error) {
    if (!(error instanceof UnauthorizedError) || !provider.authorizationUrl) throw error;
    const code = await authorize(provider.authorizationUrl);
    await transport.finishAuth(code);
    await connect();
  }
}

await connect();
const tools = await client.listTools();
const required = ['reach_list_nodes', 'reach_list_tools', 'reach_call', 'reach_fingerprint', 'reach_repo_info', 'reach_adb_devices', 'reach_checkpoint', 'reach_file_read', 'reach_file_write', 'reach_process_run', 'reach_result_read', 'reach_revoke_node'];
for (const name of required) {
  if (!tools.tools.some(tool => tool.name === name)) throw new Error(`missing MCP tool: ${name}`);
}
const nodeId = process.env.DEX_REACH_NODE_ID || '';
if (!nodeId) throw new Error('DEX_REACH_NODE_ID missing');
const nodes = await client.callTool({ name: 'reach_list_nodes', arguments: {} });
if (nodes.isError || !JSON.stringify(nodes).includes(nodeId)) throw new Error('reach_list_nodes did not contain the local node');
const fingerprint = await client.callTool({ name: 'reach_fingerprint', arguments: { node_id: nodeId } });
if (fingerprint.isError || !JSON.stringify(fingerprint).includes(nodeId)) throw new Error('reach_fingerprint returned an invalid result');
const config = await client.callTool({ name: 'reach_call', arguments: { node_id: nodeId, tool: 'get_config', arguments: {} } });
if (config.isError) throw new Error('routed get_config returned an error');
const adbResult = await client.callTool({ name: 'reach_adb_devices', arguments: { node_id: nodeId } });
if (adbResult.isError || !JSON.stringify(adbResult).includes('available')) throw new Error('DEX-native ADB discovery failed');
const tempPath = `/tmp/dex-reach-smoke-${process.pid}.txt`;
const marker = `DEX-REACH-SMOKE-${Date.now()}`;
const writeResult = await client.callTool({ name: 'reach_file_write', arguments: { node_id: nodeId, path: tempPath, text: marker, mode: 'rewrite' } });
if (writeResult.isError) throw new Error('DEX-native file write returned an error');
const readResult = await client.callTool({ name: 'reach_file_read', arguments: { node_id: nodeId, path: tempPath } });
if (readResult.isError || !JSON.stringify(readResult).includes(marker)) throw new Error('DEX-native file roundtrip did not preserve content');
const processResult = await client.callTool({ name: 'reach_process_run', arguments: { node_id: nodeId, command: 'pwd', cwd: '/tmp', timeout_ms: 4000 } });
if (processResult.isError) throw new Error('DEX-native process execution failed');
const fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'dex-reach-checkpoint-smoke-'));
await execFileAsync('git', ['init', '-q'], { cwd: fixture });
await execFileAsync('git', ['config', 'user.email', 'smoke@dex-reach.invalid'], { cwd: fixture });
await execFileAsync('git', ['config', 'user.name', 'DEX REACH Smoke'], { cwd: fixture });
await fs.writeFile(path.join(fixture, 'tracked.txt'), 'baseline\n');
await execFileAsync('git', ['add', 'tracked.txt'], { cwd: fixture });
await execFileAsync('git', ['commit', '-q', '-m', 'baseline'], { cwd: fixture });
await fs.writeFile(path.join(fixture, 'tracked.txt'), 'changed\n');
await fs.writeFile(path.join(fixture, 'untracked.txt'), 'recover me\n');
const checkpoint = await client.callTool({ name: 'reach_checkpoint', arguments: { node_id: nodeId, cwd: fixture } });
if (checkpoint.isError || !JSON.stringify(checkpoint).includes('untracked.txt') || !JSON.stringify(checkpoint).includes('patchBytes')) throw new Error('DEX checkpoint proof failed');
await fs.unlink(tempPath).catch(() => undefined);
await fs.rm(fixture, { recursive: true, force: true });
await client.close();
console.log(JSON.stringify({ ok: true, oauth: true, mcpTools: tools.tools.length, nodeId, compatibilityToolCall: true, nativeFileRoundTrip: true, nativeProcessExecution: true, adbDiscovery: true, checkpoint: true }, null, 2));
