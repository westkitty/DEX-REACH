import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Response } from 'express';
import type { AuthorizationParams } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';
import { ReachOAuthProvider } from '../src/gateway/auth.js';

test('OAuth approval page escapes untrusted dynamic client names', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dex-reach-oauth-'));
  try {
    const provider = new ReachOAuthProvider(dir, 'owner', '0123456789abcdef', new URL('https://example.invalid/mcp'));
    await provider.initialize();
    const client = {
      client_id: 'client-1',
      client_id_issued_at: Math.floor(Date.now() / 1000),
      client_name: '<img src=x onerror="alert(1)">',
      redirect_uris: ['https://client.invalid/callback']
    } as OAuthClientInformationFull;
    const params = {
      redirectUri: 'https://client.invalid/callback',
      codeChallenge: 'challenge',
      scopes: ['mcp:tools'],
      state: 's',
      resource: new URL('https://example.invalid/mcp')
    } as AuthorizationParams;
    let body = '';
    const response = {
      type: () => response,
      send: (value: string) => { body = value; return response; }
    } as unknown as Response;

    await provider.authorize(client, params, response);
    assert.doesNotMatch(body, /<img[\s>]/i);
    assert.doesNotMatch(body, /onerror="/i);
    assert.match(body, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
    assert.match(body, /mcp:tools/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('dynamic OAuth registration always assigns the client identity server-side', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dex-reach-oauth-id-'));
  try {
    const provider = new ReachOAuthProvider(dir, 'owner', '0123456789abcdef', new URL('https://example.invalid/mcp'));
    await provider.initialize();
    const malicious = {
      client_name: 'Untrusted client',
      redirect_uris: ['https://client.invalid/callback'],
      client_id: 'chosen-by-client',
      client_id_issued_at: 1
    } as unknown as Omit<OAuthClientInformationFull, 'client_id' | 'client_id_issued_at'>;
    const registered = await provider.clientsStore.registerClient(malicious);
    assert.notEqual(registered.client_id, 'chosen-by-client');
    assert.notEqual(registered.client_id_issued_at, 1);
    assert.equal(provider.getClient('chosen-by-client'), undefined);
    assert.equal(provider.getClient(registered.client_id)?.client_name, 'Untrusted client');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
