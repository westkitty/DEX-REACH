import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { MemoryStore } from 'express-rate-limit';
import type { AddressInfo } from 'node:net';
import { MAX_DYNAMIC_CLIENTS, ReachOAuthProvider, OFFLINE_ACCESS_SCOPE, REQUIRED_RESOURCE_SCOPE } from '../src/gateway/auth.js';
import { createOAuthRouter, oauthRateLimit, OAUTH_RATE_LIMITS, type OAuthRateLimitedRoute } from '../src/gateway/oauth-server.js';

/** A real MemoryStore that also remembers every distinct key it was asked to count. */
class CountingStore extends MemoryStore {
  readonly keys = new Set<string>();
  override async increment(key: string) {
    this.keys.add(key);
    return super.increment(key);
  }
}

type Harness = { base: URL; resource: URL; provider: ReachOAuthProvider; dir: string; stores: Map<string, CountingStore> };

/** The production router behind the same proxy trust the gateway sets for Tailscale Funnel. */
async function withGateway(run: (h: Harness) => Promise<void>, seed?: (dir: string) => Promise<void>): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dex-oauth-admission-'));
  await seed?.(dir);
  const app = express();
  app.set('trust proxy', 'loopback');
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  const base = new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}/`);
  const resource = new URL('/mcp', base);
  const provider = new ReachOAuthProvider(dir, 'owner', '0123456789abcdef', resource, base, { accessTokenMs: 60_000, refreshTokenMs: 600_000 });
  await provider.initialize();
  const stores = new Map<string, CountingStore>();
  const rateLimitStore = (route: OAuthRateLimitedRoute, tier: 'client' | 'route') => {
    const store = new CountingStore();
    stores.set(`${route}:${tier}:${stores.size}`, store);
    return store;
  };
  app.use(createOAuthRouter({ provider, issuerUrl: base, resourceUrl: resource, rateLimitStore }));
  try { await run({ base, resource, provider, dir, stores }); }
  finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await fs.rm(dir, { recursive: true, force: true });
  }
}

const registration = JSON.stringify({ client_name: 'admission test', redirect_uris: ['http://127.0.0.1:49152/callback'], token_endpoint_auth_method: 'none' });

/** One request per route, shaped so the handler runs; status codes beyond 429 do not matter here. */
function hit(h: Harness, route: OAuthRateLimitedRoute, ip: string): Promise<Response> {
  const headers = { 'x-forwarded-for': ip };
  switch (route) {
    case 'discovery': return fetch(new URL('/.well-known/oauth-authorization-server', h.base), { headers });
    case 'register': return fetch(new URL('/register', h.base), { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: registration });
    case 'authorize': return fetch(new URL('/authorize?client_id=unknown', h.base), { headers, redirect: 'manual' });
    case 'token': return fetch(new URL('/token', h.base), { method: 'POST', headers: { ...headers, 'content-type': 'application/x-www-form-urlencoded' }, body: 'grant_type=refresh_token&client_id=unknown&refresh_token=x' });
    case 'revoke': return fetch(new URL('/revoke', h.base), { method: 'POST', headers: { ...headers, 'content-type': 'application/x-www-form-urlencoded' }, body: 'client_id=unknown&token=x' });
    case 'approve': throw new Error('approve is mounted by the gateway, not the OAuth router');
  }
}

function keysFor(h: Harness, route: OAuthRateLimitedRoute, tier: 'client' | 'route'): number {
  return [...h.stores].filter(([name]) => name.startsWith(`${route}:${tier}:`)).reduce((sum, [, store]) => sum + store.keys.size, 0);
}

test('every public OAuth route admits its per-client budget and then answers 429 temporarily_unavailable', async () => {
  for (const route of ['discovery', 'register', 'authorize', 'token', 'revoke'] as const) {
    await withGateway(async h => {
      const budget = OAUTH_RATE_LIMITS[route].client;
      for (let i = 0; i < budget; i++) assert.notEqual((await hit(h, route, '198.51.100.7')).status, 429, `${route} request ${i + 1} is within budget`);
      const refused = await hit(h, route, '198.51.100.7');
      assert.equal(refused.status, 429, route);
      assert.deepEqual(await refused.json(), { error: 'temporarily_unavailable', error_description: 'OAuth endpoint rate limit exceeded; retry later' });
      assert.ok(refused.headers.get('ratelimit'), `${route} advertises standard rate-limit headers`);
      assert.ok(refused.headers.get('retry-after'), `${route} tells clients when to retry`);
      assert.notEqual((await hit(h, route, '198.51.100.8')).status, 429, `${route}: another client keeps its own budget`);
    });
  }
});

test('the route-wide cap holds against many client addresses and bounds limiter keys', async () => {
  await withGateway(async h => {
    const cap = OAUTH_RATE_LIMITS.token.route;
    const statuses: number[] = [];
    for (let i = 0; i < cap + 200; i++) statuses.push((await hit(h, 'token', `10.${(i >> 16) & 255}.${(i >> 8) & 255}.${i & 255}`)).status);
    assert.equal(statuses.filter(status => status !== 429).length, cap, 'only the route budget is admitted');
    assert.ok(keysFor(h, 'token', 'client') <= cap, 'per-client keys never exceed the route budget in a window');
    assert.equal(keysFor(h, 'token', 'route'), 1, 'the route tier uses one fixed key');
  });
  await withGateway(async h => {
    const cap = OAUTH_RATE_LIMITS.register.route;
    let created = 0;
    for (let i = 0; i < cap + 30; i++) if ((await hit(h, 'register', `192.0.2.${i}`)).status === 201) created += 1;
    assert.equal(created, cap, 'distributed registration cannot exceed the route cap');
  });
});

test('arbitrary request paths create no limiter state', async () => {
  await withGateway(async h => {
    for (let i = 0; i < 300; i++) await fetch(new URL(`/${crypto.randomUUID()}/${i}`, h.base), { method: i % 2 ? 'POST' : 'GET', headers: { 'x-forwarded-for': `203.0.113.${i % 250}` } });
    const total = [...h.stores.values()].reduce((sum, store) => sum + store.keys.size, 0);
    assert.equal(total, 0, 'only the six fixed OAuth routes are counted, never the request path');
  });
});

test('spoofed X-Forwarded-For entries cannot mint a new client identity behind the trusted ingress hop', async () => {
  await withGateway(async h => {
    const budget = OAUTH_RATE_LIMITS.register.client;
    // Funnel appends the real peer; anything to its left is caller-controlled and must be ignored.
    for (let i = 0; i < budget; i++) assert.equal((await hit(h, 'register', `${i}.${i}.${i}.${i}, 203.0.113.9`)).status, 201);
    assert.equal((await hit(h, 'register', '9.9.9.9, 203.0.113.9')).status, 429);
    assert.equal((await hit(h, 'register', '203.0.113.10')).status, 201, 'a different appended peer is a different client');
  });
});

test('IPv6 clients are grouped by /56 so one allocation cannot multiply its budget', async () => {
  await withGateway(async h => {
    const budget = OAUTH_RATE_LIMITS.register.client;
    for (let i = 0; i < budget; i++) assert.equal((await hit(h, 'register', `2001:db8:0:1::${i + 1}`)).status, 201);
    assert.equal((await hit(h, 'register', '2001:db8:0:2::99')).status, 429, 'same /56');
    assert.equal((await hit(h, 'register', '2001:db8:0:100::1')).status, 201, 'different /56');
  });
});

test('concurrent requests from one client admit exactly the budget', async () => {
  await withGateway(async h => {
    const budget = OAUTH_RATE_LIMITS.register.client;
    const statuses = await Promise.all(Array.from({ length: budget * 4 }, () => hit(h, 'register', '198.51.100.20').then(r => r.status)));
    assert.equal(statuses.filter(status => status === 201).length, budget);
    assert.equal(statuses.filter(status => status === 429).length, budget * 3);
    const stored = JSON.parse(await fs.readFile(path.join(h.dir, 'oauth.json'), 'utf8')) as { clients: Record<string, unknown> };
    assert.equal(Object.keys(stored.clients).length, budget);
  });
});

test('dynamic registration fails closed at its persistent capacity without pruning existing clients', async () => {
  const seedClients = async (dir: string) => {
    const clients: Record<string, unknown> = {
      'https://chatgpt.com/oauth/client.json': { client_id: 'https://chatgpt.com/oauth/client.json', redirect_uris: ['https://chatgpt.com/cb'] }
    };
    for (let i = 0; i < MAX_DYNAMIC_CLIENTS - 1; i++) clients[crypto.randomUUID()] = { client_id: `seed-${i}`, redirect_uris: ['http://127.0.0.1:1/cb'] };
    await fs.writeFile(path.join(dir, 'oauth.json'), JSON.stringify({ clients, access: {}, refresh: {} }));
  };
  await withGateway(async h => {
    assert.equal(h.provider.dynamicClientCount(), MAX_DYNAMIC_CLIENTS - 1, 'CIMD clients do not consume dynamic capacity');
    assert.equal((await hit(h, 'register', '198.51.100.30')).status, 201, 'the last slot is admitted');
    const refused = await hit(h, 'register', '198.51.100.31');
    assert.equal(refused.status, 503);
    assert.deepEqual(await refused.json(), { error: 'temporarily_unavailable', error_description: 'dynamic client registration capacity reached' });
    const stored = JSON.parse(await fs.readFile(path.join(h.dir, 'oauth.json'), 'utf8')) as { clients: Record<string, unknown> };
    assert.equal(Object.keys(stored.clients).length, MAX_DYNAMIC_CLIENTS + 1, 'nothing was pruned and nothing more was added');
  }, seedClients);
});

test('the consent route limiter refuses repeated owner-password attempts', async () => {
  const app = express();
  app.set('trust proxy', 'loopback');
  let attempts = 0;
  app.post('/dex/approve', ...oauthRateLimit('approve'), (_req, res) => { attempts += 1; res.status(401).send('Authorization denied.'); });
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  try {
    const url = new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}/dex/approve`);
    const budget = OAUTH_RATE_LIMITS.approve.client;
    for (let i = 0; i < budget + 5; i++) await fetch(url, { method: 'POST', headers: { 'x-forwarded-for': '198.51.100.40' } });
    assert.equal(attempts, budget, 'password checks stop at the per-client budget');
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  const gateway = await fs.readFile('src/gateway/main.ts', 'utf8');
  assert.match(gateway, /app\.post\('\/dex\/approve', \.\.\.oauthRateLimit\('approve'\), async/);
  assert.match(gateway, /app\.set\('trust proxy', 'loopback'\)/, 'client identity derivation matches the tested proxy trust');
});

test('PKCE authorization, refresh and the canary revoke-then-refresh cycle stay well inside every budget', async () => {
  await withGateway(async h => {
    const register = await hit(h, 'register', '127.0.0.1');
    assert.equal(register.status, 201);
    const clientId = String((await register.json() as { client_id: string }).client_id);
    let refresh = '';
    // A full connect, then six canary cycles: more than a day of scheduled traffic in one window.
    const verifier = crypto.randomBytes(32).toString('base64url');
    const url = new URL('/authorize', h.base);
    for (const [key, value] of Object.entries({
      response_type: 'code', client_id: clientId, redirect_uri: 'http://127.0.0.1:49152/callback',
      code_challenge: crypto.createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256',
      scope: `${REQUIRED_RESOURCE_SCOPE} ${OFFLINE_ACCESS_SCOPE}`, resource: h.resource.href, state: 's'
    })) url.searchParams.set(key, value);
    const page = await fetch(url);
    assert.equal(page.status, 200);
    const ticket = (await page.text()).match(/name="ticket" value="([^"]+)"/)?.[1];
    assert.ok(ticket);
    const code = new URL(await h.provider.approve(ticket, 'owner', '0123456789abcdef')).searchParams.get('code');
    const form = (body: Record<string, string>) => ({ method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body) });
    const exchanged = await fetch(new URL('/token', h.base), form({ grant_type: 'authorization_code', client_id: clientId, code: code!, code_verifier: verifier, redirect_uri: 'http://127.0.0.1:49152/callback', resource: h.resource.href }));
    assert.equal(exchanged.status, 200);
    let tokens = await exchanged.json() as { access_token: string; refresh_token: string };
    refresh = tokens.refresh_token;
    for (let cycle = 0; cycle < 6; cycle++) {
      assert.equal((await fetch(new URL('/revoke', h.base), form({ client_id: clientId, token: tokens.access_token }))).status, 200);
      const refreshed = await fetch(new URL('/token', h.base), form({ grant_type: 'refresh_token', client_id: clientId, refresh_token: refresh }));
      assert.equal(refreshed.status, 200, `canary cycle ${cycle + 1}`);
      tokens = await refreshed.json() as { access_token: string; refresh_token: string };
      refresh = tokens.refresh_token;
    }
  });
});
