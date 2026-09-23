import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { ReachOAuthProvider, OFFLINE_ACCESS_SCOPE, REQUIRED_RESOURCE_SCOPE } from '../src/gateway/auth.js';
import { CHATGPT_STABLE_CIMD_CLIENT_ID, createOAuthRouter, oauthProtectedResourceMetadataUrl } from '../src/gateway/oauth-server.js';
import { OAuthHealthRecorder, readOAuthRuntimeHealth } from '../src/shared/oauth-diagnostics.js';

async function withServer(run: (ctx: {
  base: URL;
  resource: URL;
  provider: ReachOAuthProvider;
  dir: string;
}) => Promise<void>, fetchClientMetadata?: typeof fetch): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dex-oauth-http-'));
  const app = express();
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const port = (server.address() as AddressInfo).port;
  const base = new URL(`http://127.0.0.1:${port}/`);
  const resource = new URL('/mcp', base);
  const provider = new ReachOAuthProvider(dir, 'owner', '0123456789abcdef', resource, base, {
    accessTokenMs: 80,
    refreshTokenMs: 60_000
  });
  const health = new OAuthHealthRecorder(dir);
  await provider.initialize();
  await health.initialize();
  app.use(createOAuthRouter({ provider, issuerUrl: base, resourceUrl: resource, health, fetchClientMetadata }));
  try {
    await run({ base, resource, provider, dir });
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await fs.rm(dir, { recursive: true, force: true });
  }
}

async function register(base: URL, redirectUri = 'http://127.0.0.1:49152/callback'): Promise<string> {
  const response = await fetch(new URL('/register', base), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_name: 'DEX OAuth HTTP Test',
      redirect_uris: [redirectUri],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none'
    })
  });
  assert.equal(response.status, 201);
  return String((await response.json() as { client_id: string }).client_id);
}

async function authorize(base: URL, resource: URL, provider: ReachOAuthProvider, clientId: string, verifier: string, redirectUri = 'http://127.0.0.1:49152/callback'): Promise<string> {
  const url = new URL('/authorize', base);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('code_challenge', crypto.createHash('sha256').update(verifier).digest('base64url'));
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('scope', `${REQUIRED_RESOURCE_SCOPE} ${OFFLINE_ACCESS_SCOPE}`);
  url.searchParams.set('resource', resource.href);
  url.searchParams.set('state', 'state-1');
  const page = await fetch(url);
  assert.equal(page.status, 200);
  const html = await page.text();
  const ticket = html.match(/name="ticket" value="([^"]+)"/)?.[1];
  assert.ok(ticket);
  const redirect = new URL(await provider.approve(ticket, 'owner', '0123456789abcdef'));
  assert.equal(redirect.searchParams.get('iss'), base.href);
  assert.equal(redirect.searchParams.get('state'), 'state-1');
  const code = redirect.searchParams.get('code');
  assert.ok(code);
  return code;
}

test('OAuth HTTP metadata advertises CIMD, DCR, PKCE, refresh, and path-specific protected resource metadata', async () => {
  await withServer(async ({ base, resource }) => {
    const metadata = await fetch(new URL('/.well-known/oauth-authorization-server', base));
    assert.equal(metadata.status, 200);
    const body = await metadata.json() as Record<string, unknown>;
    assert.equal(body.client_id_metadata_document_supported, true);
    assert.equal(body.authorization_response_iss_parameter_supported, true);
    assert.deepEqual(body.code_challenge_methods_supported, ['S256']);
    assert.deepEqual(body.token_endpoint_auth_methods_supported, ['none']);
    assert.match(String(body.registration_endpoint), /\/register$/);
    assert.deepEqual(body.scopes_supported, [REQUIRED_RESOURCE_SCOPE, OFFLINE_ACCESS_SCOPE]);

    const prm = await fetch(oauthProtectedResourceMetadataUrl(resource));
    assert.equal(prm.status, 200);
    const prmBody = await prm.json() as { resource: string; authorization_servers: string[] };
    assert.equal(prmBody.resource, resource.href);
    assert.deepEqual(prmBody.authorization_servers, [base.href]);
  });
});

test('short-lived access tokens expire, refresh succeeds repeatedly, and invalid refresh is a 4xx invalid_grant rather than 500', async () => {
  await withServer(async ({ base, resource, provider, dir }) => {
    const clientId = await register(base);
    const verifier = 'dex-http-verifier-abcdefghijklmnopqrstuvwxyz0123456789';
    const code = await authorize(base, resource, provider, clientId, verifier);

    const first = await fetch(new URL('/token', base), {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: clientId,
        code,
        code_verifier: verifier,
        redirect_uri: 'http://127.0.0.1:49152/callback',
        resource: resource.href
      })
    });
    assert.equal(first.status, 200);
    const initial = await first.json() as { access_token: string; refresh_token: string; scope: string };
    assert.ok(initial.access_token);
    assert.ok(initial.refresh_token);
    assert.match(initial.scope, /offline_access/);
    await provider.verifyAccessToken(initial.access_token);

    await new Promise(resolve => setTimeout(resolve, 120));
    await assert.rejects(provider.verifyAccessToken(initial.access_token));

    const refreshBody = new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: clientId,
      refresh_token: initial.refresh_token,
      resource: resource.href
    });
    const [a, b] = await Promise.all([
      fetch(new URL('/token', base), { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: refreshBody }),
      fetch(new URL('/token', base), { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(refreshBody) })
    ]);
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    const aTokens = await a.json() as { access_token: string; refresh_token: string };
    const bTokens = await b.json() as { access_token: string; refresh_token: string };
    assert.equal(aTokens.refresh_token, initial.refresh_token);
    assert.equal(bTokens.refresh_token, initial.refresh_token);
    assert.notEqual(aTokens.access_token, bTokens.access_token);
    await provider.verifyAccessToken(aTokens.access_token);
    await provider.verifyAccessToken(bTokens.access_token);

    const invalid = await fetch(new URL('/token', base), {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', client_id: clientId, refresh_token: 'not-a-token', resource: resource.href })
    });
    assert.equal(invalid.status, 400);
    const invalidBody = await invalid.json() as { error: string };
    assert.equal(invalidBody.error, 'invalid_grant');

    const health = await readOAuthRuntimeHealth(dir);
    assert.ok(health);
    assert.equal(health.tokenRequests, 4);
    assert.equal(health.token2xx, 3);
    assert.equal(health.token4xx, 1);
    assert.equal(health.token5xx, 0);
    assert.equal(health.lastFailureCode, 'invalid_grant');
  });
});

test('ChatGPT stable CIMD client id is accepted without DCR only when metadata is fetched from the exact chatgpt.com identity document', async () => {
  const redirectUri = 'https://chatgpt.com/connector_platform_oauth_redirect';
  let fetched = '';
  const fakeFetch: typeof fetch = async (input) => {
    fetched = String(input);
    return new Response(JSON.stringify({
      client_name: 'ChatGPT',
      redirect_uris: [redirectUri],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_methods_supported: ['none', 'private_key_jwt'],
      token_endpoint_auth_method: 'none'
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  await withServer(async ({ base, resource, provider }) => {
    const verifier = 'dex-cimd-verifier-abcdefghijklmnopqrstuvwxyz0123456789';
    const code = await authorize(base, resource, provider, CHATGPT_STABLE_CIMD_CLIENT_ID, verifier, redirectUri);
    assert.equal(fetched, CHATGPT_STABLE_CIMD_CLIENT_ID);
    assert.equal(provider.getClient(CHATGPT_STABLE_CIMD_CLIENT_ID)?.client_name, 'ChatGPT');

    const token = await fetch(new URL('/token', base), {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: CHATGPT_STABLE_CIMD_CLIENT_ID,
        code,
        code_verifier: verifier,
        redirect_uri: redirectUri,
        resource: resource.href
      })
    });
    assert.equal(token.status, 200);
  }, fakeFetch);
});
