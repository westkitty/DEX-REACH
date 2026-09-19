import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Response } from 'express';
import type { OAuthServerProvider, AuthorizationParams } from '@modelcontextprotocol/server-legacy/auth';
import type { OAuthClientInformationFull, OAuthTokenRevocationRequest, OAuthTokens } from '@modelcontextprotocol/server';
import type { AuthInfo } from '@modelcontextprotocol/server';
import { timingSafeEqualText } from '../shared/security.js';
import { atomicWriteFile } from '../shared/state-io.js';

type TokenRecord = {
  clientId: string;
  scopes: string[];
  expiresAt: number;
  resource?: string;
};

type PersistedAuth = {
  clients: Record<string, OAuthClientInformationFull>;
  access: Record<string, TokenRecord>;
  refresh: Record<string, TokenRecord>;
};

type CodeRecord = {
  client: OAuthClientInformationFull;
  params: AuthorizationParams;
  expiresAt: number;
};

type PendingApproval = CodeRecord & { ticketId: string };

const EMPTY_STATE: PersistedAuth = { clients: {}, access: {}, refresh: {} };
export const SUPPORTED_SCOPES: readonly string[] = ['mcp:tools'];

function tokenHash(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function randomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString('base64url');
}

function htmlEscape(value: string): string {
  return value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
}
class PersistentClientsStore {
  constructor(private readonly owner: ReachOAuthProvider) {}

  async getClient(clientId: string): Promise<OAuthClientInformationFull | undefined> {
    return this.owner.getClient(clientId);
  }

  async registerClient(client: Omit<OAuthClientInformationFull, 'client_id' | 'client_id_issued_at'>): Promise<OAuthClientInformationFull> {
    const incoming = client as OAuthClientInformationFull;
    const now = Math.floor(Date.now() / 1000);
    // Dynamic registration identifiers are server authority. Do not honor extra runtime fields that
    // try to smuggle a chosen client_id/client_id_issued_at through the structurally typed input.
    const { client_id: _ignoredClientId, client_id_issued_at: _ignoredIssuedAt, ...metadata } = incoming;
    const full: OAuthClientInformationFull = {
      ...metadata,
      client_id: crypto.randomUUID(),
      client_id_issued_at: now
    };
    await this.owner.saveClient(full);
    return full;
  }
}

export class ReachOAuthProvider implements OAuthServerProvider {
  readonly clientsStore: PersistentClientsStore;
  private state: PersistedAuth = structuredClone(EMPTY_STATE);
  private readonly codes = new Map<string, CodeRecord>();
  private readonly pending = new Map<string, PendingApproval>();
  private readonly stateFile: string;
  private persistQueue: Promise<void> = Promise.resolve();

  constructor(
    stateDir: string,
    private readonly ownerUser: string,
    private readonly ownerPassword: string,
    private readonly resourceUrl: URL,
    private readonly issuerUrl: URL = new URL('/', resourceUrl)
  ) {
    this.stateFile = path.join(stateDir, 'oauth.json');
    this.clientsStore = new PersistentClientsStore(this);
  }

  async initialize(): Promise<void> {
    try {
      this.state = JSON.parse(await fs.readFile(this.stateFile, 'utf8')) as PersistedAuth;
    } catch {
      this.state = structuredClone(EMPTY_STATE);
    }
    this.sweep();
  }

  /**
   * The issuer identifier exactly as the discovery document reports it. A client compares `iss`
   * against `metadata.issuer` by string equality, so this deliberately reuses the same URL the
   * router is given rather than rebuilding a value that could differ by a trailing slash.
   */
  issuerIdentifier(): string {
    return this.issuerUrl.href;
  }

  getClient(clientId: string): OAuthClientInformationFull | undefined {
    return this.state.clients[clientId];
  }

  async saveClient(client: OAuthClientInformationFull): Promise<void> {
    this.state.clients[client.client_id] = client;
    await this.persist();
  }
  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    if (!client.redirect_uris.map(String).includes(params.redirectUri)) throw new Error('unregistered redirect_uri');
    if (params.resource && params.resource.toString() !== this.resourceUrl.toString()) throw new Error('invalid resource');
    // Clients that omit `scope` (or register without one) get the single supported scope instead of an
    // empty grant that the bearer middleware would later reject; unknown scopes are refused outright.
    const requestedScopes = params.scopes?.length ? params.scopes : [...SUPPORTED_SCOPES];
    if (requestedScopes.some(scope => !SUPPORTED_SCOPES.includes(scope))) throw new Error('unsupported scope');
    params = { ...params, scopes: requestedScopes };
    const ticketId = randomToken(24);
    this.pending.set(ticketId, { ticketId, client, params, expiresAt: Date.now() + 10 * 60 * 1000 });
    const clientName = htmlEscape(client.client_name || client.client_id);
    const scopes = htmlEscape((params.scopes || []).join(' ') || 'mcp:tools');
    res.type('html').send(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>DEX//REACH Authorization</title></head><body><main><h1>DEX//REACH</h1><p><strong>${clientName}</strong> is requesting <code>${scopes}</code>.</p><form method="post" action="/dex/approve"><input type="hidden" name="ticket" value="${ticketId}"><label>User <input name="username" autocomplete="username" required></label><br><label>Password <input name="password" type="password" autocomplete="current-password" required></label><br><button type="submit">Authorize</button></form></main></body></html>`);
  }

  async approve(ticketId: string, username: string, password: string): Promise<string> {
    const pending = this.pending.get(ticketId);
    if (!pending || pending.expiresAt < Date.now()) throw new Error('authorization request expired');
    if (!timingSafeEqualText(username, this.ownerUser) || !timingSafeEqualText(password, this.ownerPassword)) {
      throw new Error('invalid owner credentials');
    }
    this.pending.delete(ticketId);
    const code = randomToken(32);
    this.codes.set(code, { client: pending.client, params: pending.params, expiresAt: Date.now() + 5 * 60 * 1000 });
    const redirect = new URL(pending.params.redirectUri);
    redirect.searchParams.set('code', code);
    if (pending.params.state) redirect.searchParams.set('state', pending.params.state);
    // RFC 9207. The discovery document advertises `authorization_response_iss_parameter_supported`,
    // and a client that reads that claim MUST reject an authorization response without `iss`. The
    // SDK appends it for providers that redirect from inside /authorize; this gateway does not --
    // it renders an owner login form there and emits the authorization response from its own
    // /dex/approve route, which the SDK never sees. Omitting it here made the advertised claim a
    // lie and stopped every spec-compliant MCP client at the callback, with a server that otherwise
    // looked healthy.
    redirect.searchParams.set('iss', this.issuerIdentifier());
    return redirect.toString();
  }

  async challengeForAuthorizationCode(client: OAuthClientInformationFull, authorizationCode: string): Promise<string> {
    const record = this.codes.get(authorizationCode);
    if (!record || record.expiresAt < Date.now() || record.client.client_id !== client.client_id) throw new Error('invalid authorization code');
    return record.params.codeChallenge;
  }

  async exchangeAuthorizationCode(client: OAuthClientInformationFull, authorizationCode: string): Promise<OAuthTokens> {
    const record = this.codes.get(authorizationCode);
    if (!record || record.expiresAt < Date.now() || record.client.client_id !== client.client_id) throw new Error('invalid authorization code');
    this.codes.delete(authorizationCode);
    return this.issueTokens(client.client_id, record.params.scopes?.length ? record.params.scopes : [...SUPPORTED_SCOPES], record.params.resource?.toString());
  }
  async exchangeRefreshToken(client: OAuthClientInformationFull, refreshToken: string, scopes?: string[], resource?: URL): Promise<OAuthTokens> {
    const record = this.state.refresh[tokenHash(refreshToken)];
    if (!record || record.expiresAt < Date.now() || record.clientId !== client.client_id) throw new Error('invalid refresh token');
    const requested = scopes?.length ? scopes : record.scopes;
    if (requested.some(scope => !record.scopes.includes(scope))) throw new Error('refresh scope escalation is not permitted');
    if (resource && resource.toString() !== (record.resource || this.resourceUrl.toString())) throw new Error('invalid resource');
    delete this.state.refresh[tokenHash(refreshToken)];
    return this.issueTokens(client.client_id, requested, record.resource);
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    this.sweep();
    const record = this.state.access[tokenHash(token)];
    if (!record || record.expiresAt < Date.now()) throw new Error('invalid or expired access token');
    return {
      token,
      clientId: record.clientId,
      scopes: record.scopes,
      expiresAt: Math.floor(record.expiresAt / 1000),
      resource: record.resource ? new URL(record.resource) : this.resourceUrl
    };
  }

  async revokeToken(_client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest): Promise<void> {
    const key = tokenHash(request.token);
    delete this.state.access[key];
    delete this.state.refresh[key];
    await this.persist();
  }

  private async issueTokens(clientId: string, scopes: string[], resource?: string): Promise<OAuthTokens> {
    const accessToken = randomToken(32);
    const refreshToken = randomToken(32);
    const now = Date.now();
    const targetResource = resource || this.resourceUrl.toString();
    this.state.access[tokenHash(accessToken)] = { clientId, scopes, expiresAt: now + 60 * 60 * 1000, resource: targetResource };
    this.state.refresh[tokenHash(refreshToken)] = { clientId, scopes, expiresAt: now + 30 * 24 * 60 * 60 * 1000, resource: targetResource };
    await this.persist();
    return {
      access_token: accessToken,
      refresh_token: refreshToken,
      token_type: 'Bearer',
      expires_in: 3600,
      scope: scopes.join(' ')
    };
  }
  private sweep(): void {
    const now = Date.now();
    for (const [key, value] of Object.entries(this.state.access)) if (value.expiresAt < now) delete this.state.access[key];
    for (const [key, value] of Object.entries(this.state.refresh)) if (value.expiresAt < now) delete this.state.refresh[key];
    for (const [key, value] of this.codes) if (value.expiresAt < now) this.codes.delete(key);
    for (const [key, value] of this.pending) if (value.expiresAt < now) this.pending.delete(key);
  }

  private async persist(): Promise<void> {
    this.sweep();
    const snapshot = JSON.stringify(this.state, null, 2) + '\n';
    const next = this.persistQueue.catch(() => undefined).then(() => atomicWriteFile(this.stateFile, snapshot, 0o600));
    this.persistQueue = next;
    await next;
  }
}
