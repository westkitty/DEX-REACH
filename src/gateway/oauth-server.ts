import crypto from 'node:crypto';
import express, { type Request, type Response } from 'express';
import { OAuthError, OAuthErrorCode, type OAuthClientInformationFull } from '@modelcontextprotocol/server';
import { ReachOAuthProvider, OFFLINE_ACCESS_SCOPE, REQUIRED_RESOURCE_SCOPE, SUPPORTED_SCOPES } from './auth.js';
import { InvalidClientError, InvalidGrantError, InvalidRequestError, InvalidScopeError, UnsupportedGrantTypeError } from './oauth-types.js';
import { OAuthHealthRecorder } from '../shared/oauth-diagnostics.js';

export const CHATGPT_STABLE_CIMD_CLIENT_ID = 'https://chatgpt.com/oauth/client.json';
const CHATGPT_CIMD = /^https:\/\/chatgpt\.com\/oauth\/(?:client\.json|[A-Za-z0-9_-]+\/client\.json)$/;

type ClientMetadataDocument = {
  client_name?: string;
  redirect_uris?: string[];
  grant_types?: string[];
  response_types?: string[];
  token_endpoint_auth_method?: string;
  token_endpoint_auth_methods_supported?: string[];
};

export type OAuthRouterOptions = {
  provider: ReachOAuthProvider;
  issuerUrl: URL;
  resourceUrl: URL;
  health?: OAuthHealthRecorder;
  fetchClientMetadata?: typeof fetch;
};

function oauthJson(res: Response, status: number, error: OAuthError): void {
  res.status(status).json({
    error: error.code,
    error_description: error.message,
    ...(error.errorUri ? { error_uri: error.errorUri } : {})
  });
}

function oauthStatus(error: OAuthError): number {
  return error.code === OAuthErrorCode.InvalidClient ? 401 : 400;
}

function parseScopes(raw: unknown): string[] | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  if (typeof raw !== 'string') throw new InvalidScopeError('scope must be a space-delimited string');
  const scopes = [...new Set(raw.split(/\s+/).map(value => value.trim()).filter(Boolean))];
  if (scopes.some(scope => !SUPPORTED_SCOPES.includes(scope))) throw new InvalidScopeError('unsupported scope');
  return scopes;
}

function parseResource(raw: unknown): URL | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  if (typeof raw !== 'string') throw new InvalidRequestError('resource must be a URL');
  try {
    return new URL(raw);
  } catch {
    throw new InvalidRequestError('resource must be a URL');
  }
}

function validateRedirectUris(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.some(uri => typeof uri !== 'string')) {
    throw new InvalidRequestError('redirect_uris must be a non-empty string array');
  }
  const uris = value as string[];
  for (const raw of uris) {
    let url: URL;
    try { url = new URL(raw); } catch { throw new InvalidRequestError('redirect_uri is invalid'); }
    const loopback = (url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]');
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
      throw new InvalidRequestError('redirect_uri must use HTTPS except for loopback clients');
    }
  }
  return uris;
}

function registrationMetadata(body: Record<string, unknown>): Omit<OAuthClientInformationFull, 'client_id' | 'client_id_issued_at'> {
  const redirect_uris = validateRedirectUris(body.redirect_uris);
  const tokenMethod = typeof body.token_endpoint_auth_method === 'string' ? body.token_endpoint_auth_method : 'none';
  if (tokenMethod !== 'none') throw new InvalidClientError('DEX//REACH supports public OAuth clients with token_endpoint_auth_method=none');
  const grantTypes = Array.isArray(body.grant_types) ? body.grant_types.filter((value): value is string => typeof value === 'string') : ['authorization_code', 'refresh_token'];
  if (grantTypes.some(value => !['authorization_code', 'refresh_token'].includes(value))) throw new InvalidRequestError('unsupported grant type in client metadata');
  const responseTypes = Array.isArray(body.response_types) ? body.response_types.filter((value): value is string => typeof value === 'string') : ['code'];
  if (responseTypes.some(value => value !== 'code')) throw new InvalidRequestError('unsupported response type in client metadata');
  return {
    client_name: typeof body.client_name === 'string' ? body.client_name.slice(0, 160) : 'OAuth client',
    redirect_uris,
    grant_types: grantTypes,
    response_types: responseTypes,
    token_endpoint_auth_method: 'none'
  } as Omit<OAuthClientInformationFull, 'client_id' | 'client_id_issued_at'>;
}

async function resolveChatGptCimdClient(
  clientId: string,
  provider: ReachOAuthProvider,
  fetchClientMetadata: typeof fetch
): Promise<OAuthClientInformationFull> {
  if (!CHATGPT_CIMD.test(clientId)) throw new InvalidClientError('unknown OAuth client');
  const response = await fetchClientMetadata(clientId, {
    method: 'GET',
    redirect: 'error',
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(5000)
  });
  if (!response.ok) throw new InvalidClientError('client metadata document is unavailable');
  const body = await response.json() as ClientMetadataDocument;
  const redirect_uris = validateRedirectUris(body.redirect_uris);
  const methods = Array.isArray(body.token_endpoint_auth_methods_supported)
    ? body.token_endpoint_auth_methods_supported
    : body.token_endpoint_auth_method ? [body.token_endpoint_auth_method] : [];
  if (!methods.includes('none')) throw new InvalidClientError('ChatGPT client metadata does not support public-client token exchange');
  const client = {
    client_id: clientId,
    client_id_issued_at: Math.floor(Date.now() / 1000),
    client_name: typeof body.client_name === 'string' ? body.client_name.slice(0, 160) : 'ChatGPT',
    redirect_uris,
    grant_types: body.grant_types ?? ['authorization_code', 'refresh_token'],
    response_types: body.response_types ?? ['code'],
    token_endpoint_auth_method: 'none'
  } as OAuthClientInformationFull;
  await provider.saveClient(client);
  return client;
}

async function resolveClient(clientId: string, options: OAuthRouterOptions): Promise<OAuthClientInformationFull> {
  const existing = options.provider.getClient(clientId);
  if (existing) return existing;
  return resolveChatGptCimdClient(clientId, options.provider, options.fetchClientMetadata ?? fetch);
}

function pkceChallenge(verifier: string): string {
  return crypto.createHash('sha256').update(verifier).digest('base64url');
}

function authorizeError(res: Response, redirectUri: string | null, state: string | undefined, issuer: URL, error: OAuthError): void {
  if (!redirectUri) return oauthJson(res, oauthStatus(error), error);
  let redirect: URL;
  try { redirect = new URL(redirectUri); } catch { return oauthJson(res, oauthStatus(error), error); }
  redirect.searchParams.set('error', String(error.code));
  redirect.searchParams.set('error_description', error.message);
  if (state) redirect.searchParams.set('state', state);
  redirect.searchParams.set('iss', issuer.href);
  res.redirect(redirect.toString());
}

function installRateLimit(router: express.Router): void {
  const windows = new Map<string, { started: number; count: number }>();
  router.use((req, res, next) => {
    const now = Date.now();
    const key = `${req.ip || 'unknown'}:${req.path}`;
    const current = windows.get(key);
    const entry = !current || now - current.started >= 60_000 ? { started: now, count: 0 } : current;
    entry.count += 1;
    windows.set(key, entry);
    if (entry.count > 300) {
      res.status(429).json({ error: 'temporarily_unavailable', error_description: 'OAuth endpoint rate limit exceeded' });
      return;
    }
    next();
  });
}

export function oauthProtectedResourceMetadataUrl(resourceUrl: URL): string {
  const rsPath = resourceUrl.pathname && resourceUrl.pathname !== '/' ? resourceUrl.pathname : '';
  return new URL(`/.well-known/oauth-protected-resource${rsPath}`, resourceUrl).href;
}

export function createOAuthRouter(options: OAuthRouterOptions): express.Router {
  const { provider, issuerUrl, resourceUrl } = options;
  const router = express.Router();
  installRateLimit(router);

  const metadata = {
    issuer: issuerUrl.href,
    authorization_endpoint: new URL('/authorize', issuerUrl).href,
    token_endpoint: new URL('/token', issuerUrl).href,
    registration_endpoint: new URL('/register', issuerUrl).href,
    revocation_endpoint: new URL('/revoke', issuerUrl).href,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    scopes_supported: [...SUPPORTED_SCOPES],
    authorization_response_iss_parameter_supported: true,
    client_id_metadata_document_supported: true
  };

  const protectedResource = {
    resource: resourceUrl.href,
    authorization_servers: [issuerUrl.href],
    scopes_supported: [REQUIRED_RESOURCE_SCOPE, OFFLINE_ACCESS_SCOPE],
    resource_name: 'DEX//REACH'
  };

  router.get('/.well-known/oauth-authorization-server', (_req, res) => res.json(metadata));
  const prmPath = new URL(oauthProtectedResourceMetadataUrl(resourceUrl)).pathname;
  router.get(prmPath, (_req, res) => res.json(protectedResource));
  if (prmPath !== '/.well-known/oauth-protected-resource') {
    router.get('/.well-known/oauth-protected-resource', (_req, res) => res.json(protectedResource));
  }

  router.post('/register', express.json({ limit: '16kb' }), async (req, res) => {
    try {
      const client = await provider.clientsStore.registerClient(registrationMetadata(req.body ?? {}));
      res.status(201).json(client);
    } catch (error) {
      if (error instanceof OAuthError) return oauthJson(res, oauthStatus(error), error);
      console.error('DEX//REACH OAuth registration failed:', error);
      oauthJson(res, 500, new OAuthError(OAuthErrorCode.ServerError, 'client registration failed'));
    }
  });

  router.get('/authorize', async (req, res) => {
    const redirectUri = typeof req.query.redirect_uri === 'string' ? req.query.redirect_uri : null;
    const state = typeof req.query.state === 'string' ? req.query.state : undefined;
    try {
      const clientId = String(req.query.client_id || '');
      if (!clientId) throw new InvalidClientError('client_id is required');
      const client = await resolveClient(clientId, options);
      if (!redirectUri || !client.redirect_uris.map(String).includes(redirectUri)) throw new InvalidGrantError('unregistered redirect_uri');
      if (req.query.response_type !== 'code') throw new InvalidRequestError('response_type must be code');
      if (req.query.code_challenge_method !== 'S256') throw new InvalidRequestError('code_challenge_method must be S256');
      const codeChallenge = String(req.query.code_challenge || '');
      if (!codeChallenge) throw new InvalidRequestError('code_challenge is required');
      const resource = parseResource(req.query.resource);
      if (resource && resource.toString() !== resourceUrl.toString()) throw new InvalidGrantError('invalid resource');
      const scopes = parseScopes(req.query.scope);
      await provider.authorize(client, {
        redirectUri,
        codeChallenge,
        scopes,
        state,
        resource,
        issuer: issuerUrl.href
      }, res);
    } catch (error) {
      if (error instanceof OAuthError) return authorizeError(res, redirectUri, state, issuerUrl, error);
      console.error('DEX//REACH OAuth authorization failed:', error);
      authorizeError(res, redirectUri, state, issuerUrl, new OAuthError(OAuthErrorCode.ServerError, 'authorization failed'));
    }
  });

  router.post('/token', express.urlencoded({ extended: false, limit: '16kb' }), async (req, res) => {
    let status = 500;
    let errorCode: string | null = OAuthErrorCode.ServerError;
    let payload: unknown = { error: OAuthErrorCode.ServerError, error_description: 'token exchange failed' };
    try {
      const grantType = String(req.body?.grant_type || '');
      const clientId = String(req.body?.client_id || '');
      if (!clientId) throw new InvalidClientError('client_id is required');
      const client = await resolveClient(clientId, options);
      const resource = parseResource(req.body?.resource);
      if (grantType === 'authorization_code') {
        const code = String(req.body?.code || '');
        const verifier = String(req.body?.code_verifier || '');
        const redirectUri = String(req.body?.redirect_uri || '');
        if (!code || !verifier || !redirectUri) throw new InvalidGrantError('code, code_verifier, and redirect_uri are required');
        payload = await provider.exchangeAuthorizationCode(client, code, verifier, redirectUri, resource);
      } else if (grantType === 'refresh_token') {
        const refreshToken = String(req.body?.refresh_token || '');
        if (!refreshToken) throw new InvalidGrantError('refresh_token is required');
        payload = await provider.exchangeRefreshToken(client, refreshToken, parseScopes(req.body?.scope), resource);
      } else {
        throw new UnsupportedGrantTypeError('unsupported grant_type');
      }
      status = 200;
      errorCode = null;
    } catch (error) {
      if (error instanceof OAuthError) {
        status = oauthStatus(error);
        errorCode = String(error.code);
        payload = {
          error: error.code,
          error_description: error.message,
          ...(error.errorUri ? { error_uri: error.errorUri } : {})
        };
      } else {
        console.error('DEX//REACH OAuth token exchange failed:', error);
        status = 500;
        errorCode = OAuthErrorCode.ServerError;
        payload = { error: OAuthErrorCode.ServerError, error_description: 'token exchange failed' };
      }
    }
    await options.health?.record(status, errorCode).catch(error => console.error('DEX//REACH OAuth health write failed:', error));
    res.status(status).json(payload);
  });

  router.post('/revoke', express.urlencoded({ extended: false, limit: '16kb' }), async (req, res) => {
    try {
      const clientId = String(req.body?.client_id || '');
      if (!clientId) throw new InvalidClientError('client_id is required');
      const client = await resolveClient(clientId, options);
      const token = String(req.body?.token || '');
      if (!token) throw new InvalidRequestError('token is required');
      await provider.revokeToken(client, { token, token_type_hint: req.body?.token_type_hint });
      res.status(200).end();
    } catch (error) {
      if (error instanceof OAuthError) return oauthJson(res, oauthStatus(error), error);
      console.error('DEX//REACH OAuth revocation failed:', error);
      oauthJson(res, 500, new OAuthError(OAuthErrorCode.ServerError, 'revocation failed'));
    }
  });

  return router;
}
