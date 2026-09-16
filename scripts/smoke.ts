import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { UnauthorizedError, type OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import type { OAuthClientInformationFull, OAuthClientMetadata, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import { loadOwnerSecrets } from '../src/shared/local-env.js';
import { DEX_REACH_VERSION } from '../src/shared/version.js';

const execFileAsync = promisify(execFile);
loadOwnerSecrets();
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
    return { client_name: 'DEX REACH Smoke', redirect_uris: [callbackUrl], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' };
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
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ ticket, username: ownerUser, password: ownerPassword }), redirect: 'manual'
  });
  if (approval.status < 300 || approval.status >= 400) throw new Error(`approval failed: ${approval.status}`);
  const location = approval.headers.get('location');
  if (!location) throw new Error('approval redirect missing');
  const code = new URL(location).searchParams.get('code');
  if (!code) throw new Error('authorization code missing');
  return code;
}

function textContent(result: Awaited<ReturnType<Client['callTool']>>): string {
  const pieces = Array.isArray(result.content)
    ? result.content.filter((item): item is { type: 'text'; text: string } => item.type === 'text' && typeof item.text === 'string').map(item => item.text)
    : [];
  return pieces.join('\n');
}
function jsonContent<T>(result: Awaited<ReturnType<Client['callTool']>>, label: string): T {
  if (result.isError) throw new Error(`${label} returned an MCP error: ${textContent(result)}`);
  const text = textContent(result);
  try { return JSON.parse(text) as T; } catch { throw new Error(`${label} did not return JSON: ${text.slice(0, 300)}`); }
}

const provider = new SmokeOAuthProvider();
const client = new Client({ name: 'dex-reach-smoke', version: DEX_REACH_VERSION }, { capabilities: {} });
async function connect(): Promise<void> {
  const transport = new StreamableHTTPClientTransport(resource, { authProvider: provider });
  try { await client.connect(transport); }
  catch (error) {
    if (!(error instanceof UnauthorizedError) || !provider.authorizationUrl) throw error;
    const code = await authorize(provider.authorizationUrl);
    await transport.finishAuth(code);
    await connect();
  }
}

const cleanupFiles: string[] = [];
let fixture = '';
let identityFixture = '';
try {
  await connect();
  const tools = await client.listTools();
  const required = ['reach_list_nodes', 'reach_list_tools', 'reach_call', 'reach_fingerprint', 'reach_trust_report', 'reach_repo_info', 'reach_adb_devices', 'reach_checkpoint', 'reach_file_read', 'reach_file_write', 'reach_process_run', 'reach_plan', 'reach_commit_plan', 'reach_receipts', 'reach_result_read', 'reach_revoke_node'];
  for (const name of required) {
    const tool = tools.tools.find(candidate => candidate.name === name);
    if (!tool) throw new Error(`missing MCP tool: ${name}`);
    if (!tool.title || !tool.description || typeof tool.annotations?.readOnlyHint !== 'boolean') throw new Error(`MCP tool ${name} is missing title, description, or readOnlyHint annotation`);
  }
  if (tools.tools.length < required.length) throw new Error(`tool count ${tools.tools.length} is below required ${required.length}`);

  const nodeId = process.env.DEX_REACH_NODE_ID || '';
  if (!nodeId) throw new Error('DEX_REACH_NODE_ID missing');
  type NodeRecord = { nodeId: string; online: boolean; allowedRoots: string[]; agentVersion: string; aiAccess?: { mode?: string } };
  const nodes = jsonContent<NodeRecord[]>(await client.callTool({ name: 'reach_list_nodes', arguments: {} }), 'reach_list_nodes');
  const nodeRecord = nodes.find(entry => entry.nodeId === nodeId);
  if (!nodeRecord?.online) throw new Error(`target node is not online: ${nodeId}`);
  if (nodeRecord.agentVersion !== DEX_REACH_VERSION) throw new Error(`deployed node version mismatch: expected ${DEX_REACH_VERSION}, got ${nodeRecord.agentVersion}`);

  const fingerprint = jsonContent<{ nodeId: string }>(await client.callTool({ name: 'reach_fingerprint', arguments: { node_id: nodeId } }), 'reach_fingerprint');
  if (fingerprint.nodeId !== nodeId) throw new Error('reach_fingerprint returned the wrong node');

  const trust = jsonContent<{ verdict: string; certificateHash: string; invariants: { count: number } }>(await client.callTool({ name: 'reach_trust_report', arguments: { node_id: nodeId } }), 'reach_trust_report');
  if (trust.verdict !== 'PASS') throw new Error(`reach_trust_report did not pass: ${JSON.stringify(trust)}`);
  if (!trust.certificateHash || trust.invariants.count < 21) throw new Error('reach_trust_report omitted certificate or invariant evidence');

  type CompatTool = { name: string };
  const compatTools = jsonContent<CompatTool[]>(await client.callTool({ name: 'reach_list_tools', arguments: { node_id: nodeId } }), 'reach_list_tools');
  const compatNames = new Set(compatTools.map(tool => tool.name));
  const blockedCompat = ['set_config_value', 'get_recent_tool_calls', 'give_feedback_to_desktop_commander', 'get_prompts'];
  for (const name of blockedCompat) if (compatNames.has(name)) throw new Error(`node exposed node-owned/vendor-only compatibility tool ${name}`);
  const expectedCompat = ['get_config', 'read_file', 'read_multiple_files', 'write_file', 'write_pdf', 'create_directory', 'list_directory', 'move_file', 'start_search', 'get_more_search_results', 'stop_search', 'list_searches', 'get_file_info', 'edit_block', 'start_process', 'read_process_output', 'interact_with_process', 'force_terminate', 'list_sessions', 'list_processes', 'kill_process', 'get_usage_stats'];
  for (const name of expectedCompat) if (!compatNames.has(name)) throw new Error(`missing safe compatibility tool ${name}`);
  if (compatTools.length !== expectedCompat.length) throw new Error(`unexpected remote compatibility tool count ${compatTools.length}; expected ${expectedCompat.length}`);

  const configMutation = await client.callTool({ name: 'reach_call', arguments: { node_id: nodeId, tool: 'set_config_value', arguments: { key: 'allowedDirectories', value: [] } } });
  if (!configMutation.isError) throw new Error('node-owned compatibility configuration was remotely mutable');
  const urlProxy = await client.callTool({ name: 'reach_call', arguments: { node_id: nodeId, tool: 'read_file', arguments: { path: 'http://127.0.0.1:8787/healthz', isUrl: true } } });
  if (!urlProxy.isError) throw new Error('compatibility URL proxy reads were remotely permitted');

  const configResult = await client.callTool({ name: 'reach_call', arguments: { node_id: nodeId, tool: 'get_config', arguments: {} } });
  if (configResult.isError) throw new Error(`routed get_config returned an error: ${textContent(configResult)}`);
  const configText = textContent(configResult);
  if (!configText.includes('"telemetryEnabled":false') && !configText.includes('"telemetryEnabled": false')) throw new Error('compatibility backend telemetry is not proven disabled');
  for (const root of nodeRecord.allowedRoots) if (!configText.includes(root)) throw new Error(`compatibility backend did not report allowed root ${root}`);

  const adb = jsonContent<{ available: boolean; devices?: unknown[]; error?: string }>(await client.callTool({ name: 'reach_adb_devices', arguments: { node_id: nodeId } }), 'reach_adb_devices');
  if (adb.available !== true) throw new Error(`ADB binary is unavailable to the deployed node: ${adb.error || 'unknown error'}`);

  const tempPath = `/tmp/dex-reach-smoke-${process.pid}.txt`;
  cleanupFiles.push(tempPath);
  const marker = `DEX-REACH-SMOKE-${Date.now()}`;
  const writeResult = await client.callTool({ name: 'reach_file_write', arguments: { node_id: nodeId, path: tempPath, text: marker, mode: 'rewrite' } });
  if (writeResult.isError) throw new Error(`DEX-native file write returned an error: ${textContent(writeResult)}`);
  const readResult = await client.callTool({ name: 'reach_file_read', arguments: { node_id: nodeId, path: tempPath } });
  if (readResult.isError || !textContent(readResult).includes(marker)) throw new Error('DEX-native file roundtrip did not preserve content');

  const processResult = await client.callTool({ name: 'reach_process_run', arguments: { node_id: nodeId, command: 'pwd', cwd: '/tmp', timeout_ms: 4000 } });
  if (processResult.isError) throw new Error(`DEX-native process execution failed: ${textContent(processResult)}`);
  const environmentResult = await client.callTool({ name: 'reach_process_run', arguments: { node_id: nodeId, command: 'env', cwd: '/tmp', timeout_ms: 4000 } });
  const environmentText = textContent(environmentResult);
  if (environmentResult.isError) throw new Error(`DEX-native sanitized environment probe failed: ${environmentText}`);
  if (/DEX_REACH_(?:NODE_TOKEN|OWNER_PASSWORD|ENV_FILE)=/i.test(environmentText) || /(?:TOKEN|PASSWORD|SECRET|API_KEY)=/i.test(environmentText)) {
    throw new Error('remote process environment exposed a credential-bearing variable');
  }

  const plannedPath = `/tmp/dex-reach-plan-smoke-${process.pid}.txt`;
  cleanupFiles.push(plannedPath);
  const plannedMarker = `DEX-REACH-PLANNED-${Date.now()}`;
  const rejectedIdentity = await client.callTool({
    name: 'reach_plan', arguments: { node_id: nodeId, operation: 'dex.file.write', arguments: { path: plannedPath, text: plannedMarker, mode: 'rewrite' }, expected_identity: { nodeId: `${nodeId}-wrong` } }
  });
  if (!rejectedIdentity.isError) throw new Error('reach_plan accepted a mismatched expected execution identity');

  const plan = jsonContent<{ id: string; requestHash: string; identityHash: string }>(await client.callTool({
    name: 'reach_plan', arguments: { node_id: nodeId, operation: 'dex.file.write', arguments: { path: plannedPath, text: plannedMarker, mode: 'rewrite' }, expected_identity: { nodeId } }
  }), 'reach_plan');
  if (!plan.id || !plan.requestHash || !plan.identityHash) throw new Error('reach_plan did not return an exact request and execution identity');
  const commit = await client.callTool({ name: 'reach_commit_plan', arguments: { node_id: nodeId, plan_id: plan.id } });
  if (commit.isError || !textContent(commit).includes(plan.requestHash)) throw new Error(`reach_commit_plan failed: ${textContent(commit)}`);
  const plannedRead = await client.callTool({ name: 'reach_file_read', arguments: { node_id: nodeId, path: plannedPath } });
  if (plannedRead.isError || !textContent(plannedRead).includes(plannedMarker)) throw new Error('planned write was not executed exactly');
  const receipts = await client.callTool({ name: 'reach_receipts', arguments: { node_id: nodeId, limit: 30 } });
  if (receipts.isError || !textContent(receipts).includes('dex.commitPlan')) throw new Error('signed receipt path did not expose the committed plan evidence');

  const roots = nodeRecord.allowedRoots ?? [];
  const fixtureBase = roots.find(root => path.resolve(os.tmpdir()).startsWith(root)) ?? roots.find(root => root === '/tmp' || root === '/private/tmp') ?? roots[0];
  if (!fixtureBase) throw new Error('node advertises no allowed roots for the checkpoint fixture');

  identityFixture = await fs.mkdtemp(path.join(fixtureBase, 'dex-reach-identity-smoke-'));
  await execFileAsync('git', ['init', '-q'], { cwd: identityFixture });
  await execFileAsync('git', ['config', 'user.email', 'smoke@dex-reach.invalid'], { cwd: identityFixture });
  await execFileAsync('git', ['config', 'user.name', 'DEX REACH Smoke'], { cwd: identityFixture });
  await fs.writeFile(path.join(identityFixture, 'baseline.txt'), 'baseline\n');
  await execFileAsync('git', ['add', 'baseline.txt'], { cwd: identityFixture });
  await execFileAsync('git', ['commit', '-q', '-m', 'baseline'], { cwd: identityFixture });
  await execFileAsync('git', ['branch', '-M', 'main'], { cwd: identityFixture });
  const canonicalIdentityFixture = await fs.realpath(identityFixture);
  const driftPath = path.join(identityFixture, 'must-not-write.txt');
  const driftPlan = jsonContent<{ id: string }>(await client.callTool({
    name: 'reach_plan', arguments: { node_id: nodeId, operation: 'dex.file.write', arguments: { path: driftPath, text: 'identity-drift-must-block', mode: 'rewrite' }, expected_identity: { branch: 'main', repositoryRoot: canonicalIdentityFixture } }
  }), 'reach_plan identity drift fixture');
  await execFileAsync('git', ['switch', '-q', '-c', 'identity-drift'], { cwd: identityFixture });
  const driftCommit = await client.callTool({ name: 'reach_commit_plan', arguments: { node_id: nodeId, plan_id: driftPlan.id } });
  if (!driftCommit.isError || !/execution identity changed after planning/.test(textContent(driftCommit))) {
    throw new Error(`reach_commit_plan did not block execution identity drift: ${textContent(driftCommit)}`);
  }
  try {
    await fs.access(driftPath);
    throw new Error('identity-drift plan mutated the filesystem despite refusal');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  fixture = await fs.mkdtemp(path.join(fixtureBase, 'dex-reach-checkpoint-smoke-'));
  await execFileAsync('git', ['init', '-q'], { cwd: fixture });
  await execFileAsync('git', ['config', 'user.email', 'smoke@dex-reach.invalid'], { cwd: fixture });
  await execFileAsync('git', ['config', 'user.name', 'DEX REACH Smoke'], { cwd: fixture });
  await fs.writeFile(path.join(fixture, 'tracked.txt'), 'baseline\n');
  await execFileAsync('git', ['add', 'tracked.txt'], { cwd: fixture });
  await execFileAsync('git', ['commit', '-q', '-m', 'baseline'], { cwd: fixture });
  await fs.writeFile(path.join(fixture, 'tracked.txt'), 'changed\n');
  await fs.writeFile(path.join(fixture, 'untracked.txt'), 'recover me\n');
  const checkpoint = await client.callTool({ name: 'reach_checkpoint', arguments: { node_id: nodeId, cwd: fixture } });
  if (checkpoint.isError || !textContent(checkpoint).includes('untracked.txt') || !textContent(checkpoint).includes('patchBytes')) throw new Error('DEX checkpoint proof failed');

  console.log(JSON.stringify({
    ok: true, version: DEX_REACH_VERSION, oauth: true, mcpTools: tools.tools.length, nodeId,
    compatibilityPolicyVerified: true, remoteCompatibilityTools: expectedCompat.length, compatibilityMutationBlocked: true, urlProxyBlocked: true, nativeFileRoundTrip: true, nativeProcessExecution: true, childEnvironmentSanitized: true,
    adbBinaryAvailable: true, trustReport: true, transactionalPlanCommit: true, executionIdentityPlanGuard: true, executionIdentityDriftBlocked: true, signedReceiptsVisible: true, checkpoint: true
  }, null, 2));
} finally {
  for (const file of cleanupFiles) await fs.unlink(file).catch(() => undefined);
  if (fixture) await fs.rm(fixture, { recursive: true, force: true }).catch(() => undefined);
  if (identityFixture) await fs.rm(identityFixture, { recursive: true, force: true }).catch(() => undefined);
  await client.close().catch(() => undefined);
}
