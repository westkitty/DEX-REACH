import fs from 'node:fs/promises';
import path from 'node:path';
import { Client, UnauthorizedError, type OAuthClientProvider, type OAuthDiscoveryState } from '@modelcontextprotocol/client';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { OAuthClientInformationFull, OAuthClientMetadata, OAuthTokens } from '@modelcontextprotocol/server';
import { atomicWriteFile } from '../src/shared/state-io.js';
import { loadOwnerSecrets, stateDir } from '../src/shared/local-env.js';
import { DEX_REACH_VERSION } from '../src/shared/version.js';

loadOwnerSecrets();

const base = new URL(process.env.DEX_REACH_PUBLIC_BASE_URL || 'http://127.0.0.1:8787');
const resource = new URL('/mcp', base);
const nodeId = process.env.DEX_REACH_NODE_ID || '';
const ownerUser = process.env.DEX_REACH_OWNER_USER || '';
const ownerPassword = process.env.DEX_REACH_OWNER_PASSWORD || '';
const callbackUrl = 'http://127.0.0.1:49153/callback';
const dir = stateDir();
const credentialFile = path.join(dir, 'oauth-canary.json');
const statusFile = path.join(dir, 'oauth-canary-status.json');

type CanaryCredentialState = {
  version: 1;
  client?: OAuthClientInformationFull;
  tokens?: OAuthTokens;
  verifier?: string;
  discovery?: OAuthDiscoveryState;
};

type CanaryStatus = {
  version: 1;
  checkedAt: string;
  ok: boolean;
  publicBaseUrl: string;
  nodeOnline: boolean;
  refreshCredentialPresent: boolean;
  refreshRecoveryVerified: boolean;
  postRefreshMcpVerified: boolean;
  accessTokenChanged: boolean;
  failureClass: string | null;
};

class CanaryOAuthProvider implements OAuthClientProvider {
  private stored: CanaryCredentialState = { version: 1 };
  authorizationUrl?: URL;

  async initialize(): Promise<void> {
    try {
      this.stored = JSON.parse(await fs.readFile(credentialFile, 'utf8')) as CanaryCredentialState;
    } catch {
      this.stored = { version: 1 };
    }
  }

  get redirectUrl(): string | URL { return callbackUrl; }
  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: 'DEX REACH OAuth Canary',
      redirect_uris: [callbackUrl],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none'
    };
  }

  clientInformation(): OAuthClientInformationFull | undefined { return this.stored.client; }
  async saveClientInformation(value: OAuthClientInformationFull): Promise<void> {
    this.stored.client = value;
    await this.persist();
  }
  tokens(): OAuthTokens | undefined { return this.stored.tokens; }
  async saveTokens(value: OAuthTokens): Promise<void> {
    this.stored.tokens = value;
    await this.persist();
  }
  redirectToAuthorization(url: URL): void { this.authorizationUrl = url; }
  async saveCodeVerifier(value: string): Promise<void> {
    this.stored.verifier = value;
    await this.persist();
  }
  codeVerifier(): string {
    if (!this.stored.verifier) throw new Error('missing PKCE verifier');
    return this.stored.verifier;
  }
  async saveDiscoveryState(value: OAuthDiscoveryState): Promise<void> {
    this.stored.discovery = value;
    await this.persist();
  }
  discoveryState(): OAuthDiscoveryState | undefined {
    return this.stored.discovery;
  }

  async invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery'): Promise<void> {
    if (scope === 'all' || scope === 'client') delete this.stored.client;
    if (scope === 'all' || scope === 'tokens') delete this.stored.tokens;
    if (scope === 'all' || scope === 'verifier') delete this.stored.verifier;
    if (scope === 'all' || scope === 'discovery') delete this.stored.discovery;
    await this.persist();
  }

  private async persist(): Promise<void> {
    await atomicWriteFile(credentialFile, JSON.stringify(this.stored, null, 2) + '\n', 0o600);
  }
}

async function authorize(url: URL): Promise<URLSearchParams> {
  const page = await fetch(url);
  if (!page.ok) throw new Error(`authorization_page_${page.status}`);
  const html = await page.text();
  const ticket = html.match(/name="ticket" value="([^"]+)"/)?.[1];
  if (!ticket) throw new Error('authorization_ticket_missing');
  const approval = await fetch(new URL('/dex/approve', base), {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ ticket, username: ownerUser, password: ownerPassword }),
    redirect: 'manual'
  });
  if (approval.status < 300 || approval.status >= 400) throw new Error(`approval_${approval.status}`);
  const location = approval.headers.get('location');
  if (!location) throw new Error('approval_redirect_missing');
  return new URL(location).searchParams;
}

function textContent(result: Awaited<ReturnType<Client['callTool']>>): string {
  return Array.isArray(result.content)
    ? result.content.filter((item): item is { type: 'text'; text: string } => item.type === 'text' && typeof item.text === 'string').map(item => item.text).join('\n')
    : '';
}

async function writeStatus(status: CanaryStatus): Promise<void> {
  await atomicWriteFile(statusFile, JSON.stringify(status, null, 2) + '\n', 0o600);
}

async function revokeCanaryAccessToken(clientId: string, accessToken: string): Promise<void> {
  const response = await fetch(new URL('/revoke', base), {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      token: accessToken,
      token_type_hint: 'access_token'
    })
  });
  if (!response.ok) throw new Error(`access_token_revoke_${response.status}`);
}

const provider = new CanaryOAuthProvider();
await provider.initialize();
const client = new Client({ name: 'dex-reach-oauth-canary', version: DEX_REACH_VERSION }, { capabilities: {} });

async function connect(): Promise<void> {
  const transport = new StreamableHTTPClientTransport(resource, { authProvider: provider });
  try {
    await client.connect(transport);
  } catch (error) {
    if (!(error instanceof UnauthorizedError) || !provider.authorizationUrl) throw error;
    await transport.finishAuth(await authorize(provider.authorizationUrl));
    await connect();
  }
}

try {
  if (!nodeId) throw new Error('node_id_missing');
  await connect();
  const nodesResult = await client.callTool({ name: 'reach_list_nodes', arguments: {} });
  if (nodesResult.isError) throw new Error('reach_list_nodes_failed');
  const nodes = JSON.parse(textContent(nodesResult)) as Array<{ nodeId: string; online: boolean }>;
  const node = nodes.find(item => item.nodeId === nodeId);
  if (!node?.online) throw new Error('target_node_offline');

  const fingerprint = await client.callTool({ name: 'reach_fingerprint', arguments: { node_id: nodeId } });
  if (fingerprint.isError) throw new Error('reach_fingerprint_failed');

  // Active refresh proof: revoke only this disposable canary access token, leave its refresh
  // credential intact, then make another real MCP call. The MCP client transport must receive
  // invalid_token, refresh through the public /token endpoint, save the replacement access token,
  // retry the original request, and complete it successfully. This exercises the same recovery
  // path an expired access token uses without weakening production token lifetimes or touching
  // any user/client credential.
  const before = provider.tokens();
  const clientInformation = provider.clientInformation();
  if (!before?.access_token) throw new Error('canary_access_token_missing');
  if (!before.refresh_token) throw new Error('canary_refresh_token_missing');
  if (!clientInformation?.client_id) throw new Error('canary_client_id_missing');

  await revokeCanaryAccessToken(clientInformation.client_id, before.access_token);

  const recoveredFingerprint = await client.callTool({ name: 'reach_fingerprint', arguments: { node_id: nodeId } });
  if (recoveredFingerprint.isError) throw new Error('post_refresh_fingerprint_failed');

  const after = provider.tokens();
  const accessTokenChanged = Boolean(after?.access_token && after.access_token !== before.access_token);
  const refreshRecoveryVerified = Boolean(accessTokenChanged && after?.refresh_token);
  if (!refreshRecoveryVerified) throw new Error('refresh_recovery_not_observed');

  await writeStatus({
    version: 1,
    checkedAt: new Date().toISOString(),
    ok: true,
    publicBaseUrl: base.origin,
    nodeOnline: true,
    refreshCredentialPresent: Boolean(after?.refresh_token),
    refreshRecoveryVerified: true,
    postRefreshMcpVerified: true,
    accessTokenChanged,
    failureClass: null
  });
  console.log(JSON.stringify({
    ok: true,
    nodeId,
    publicBaseUrl: base.origin,
    refreshCredentialPresent: Boolean(after?.refresh_token),
    refreshRecoveryVerified: true,
    postRefreshMcpVerified: true,
    accessTokenChanged
  }));
} catch (error) {
  const failureClass = error instanceof Error ? error.message.replace(/[^a-zA-Z0-9_.:-]+/g, '_').slice(0, 120) : 'unknown_error';
  await writeStatus({
    version: 1,
    checkedAt: new Date().toISOString(),
    ok: false,
    publicBaseUrl: base.origin,
    nodeOnline: false,
    refreshCredentialPresent: Boolean(provider.tokens()?.refresh_token),
    refreshRecoveryVerified: false,
    postRefreshMcpVerified: false,
    accessTokenChanged: false,
    failureClass
  });
  console.error(JSON.stringify({ ok: false, failureClass }));
  process.exitCode = 1;
} finally {
  await client.close().catch(() => undefined);
}
