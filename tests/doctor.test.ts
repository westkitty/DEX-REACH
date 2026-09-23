import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { saveAccessState, type AccessState } from '../src/shared/access.js';
import { collectDoctorReport } from '../src/shared/doctor.js';
import { hashValue } from '../src/shared/hash.js';
import { loadAccessState } from '../src/shared/access.js';

test('doctor is read-only and --share omits local repository paths', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dex-reach-doctor-'));
  const previous = process.env.DEX_REACH_STATE_DIR;
  try {
    process.env.DEX_REACH_STATE_DIR = dir;
    const state: AccessState = {
      version: 3, revision: 0, mode: 'off', until: null, revertTo: null, clients: {}, grantRequired: {}, grants: [],
      updatedAt: new Date(0).toISOString()
    };
    await saveAccessState('n', state, dir);
    const now = Date.now();
    await fs.writeFile(path.join(dir, 'oauth.json'), JSON.stringify({
      clients: { 'sensitive-client-id': { client_id: 'sensitive-client-id' } },
      access: { 'sensitive-access-hash': { expiresAt: now + 60_000 } },
      refresh: { 'sensitive-refresh-hash': { expiresAt: now + 120_000 } }
    }));
    await fs.writeFile(path.join(dir, 'oauth-health.json'), JSON.stringify({
      version: 1,
      startedAt: new Date(now - 1000).toISOString(),
      tokenRequests: 3,
      token2xx: 2,
      token4xx: 1,
      token5xx: 0,
      lastSuccessAt: new Date(now).toISOString(),
      lastFailureAt: new Date(now - 500).toISOString(),
      lastFailureCode: 'invalid_grant'
    }));
    await fs.writeFile(path.join(dir, 'oauth-canary-status.json'), JSON.stringify({
      version: 1,
      checkedAt: new Date(now).toISOString(),
      ok: true,
      publicBaseUrl: 'https://sensitive-tailnet-name.example',
      nodeOnline: true,
      refreshCredentialPresent: true,
      refreshRecoveryVerified: true,
      postRefreshMcpVerified: true,
      accessTokenChanged: true,
      failureClass: null
    }));
    const before = hashValue(await loadAccessState('n', dir));
    const full = await collectDoctorReport({ repoRoot: process.cwd(), nodeId: 'n', dir });
    const share = await collectDoctorReport({ repoRoot: process.cwd(), nodeId: 'n', dir, share: true });
    assert.equal(hashValue(await loadAccessState('n', dir)), before);
    assert.equal(full.readOnly, true);
    const source = full.source as { repoRoot: string };
    assert.ok(typeof source.repoRoot === 'string' && source.repoRoot.length > 0);
    const sharedSource = share.source as { repoRoot?: string; upstream?: string };
    assert.equal(sharedSource.repoRoot, undefined);
    assert.equal(sharedSource.upstream, undefined);
    assert.equal(share.hostname, 'redacted');
    assert.ok(JSON.stringify(share).includes('16'));
    const oauth = share.oauth as {
      discovery: { cimd: boolean; dcr: boolean; pkce: string; scopes: string[] };
      state: { clients: number; activeAccessTokens: number; activeRefreshTokens: number };
      tokenEndpoint: { token2xx: number; token4xx: number; token5xx: number; lastFailureCode: string };
      canary: { ok: boolean; publicBaseUrl?: string; refreshCredentialPresent: boolean; refreshRecoveryVerified: boolean; postRefreshMcpVerified: boolean; accessTokenChanged: boolean };
    };
    assert.equal(oauth.discovery.cimd, true);
    assert.equal(oauth.discovery.dcr, true);
    assert.equal(oauth.discovery.pkce, 'S256');
    assert.deepEqual(oauth.discovery.scopes, ['mcp:tools', 'offline_access']);
    assert.equal(oauth.state.clients, 1);
    assert.equal(oauth.state.activeAccessTokens, 1);
    assert.equal(oauth.state.activeRefreshTokens, 1);
    assert.equal(oauth.tokenEndpoint.token2xx, 2);
    assert.equal(oauth.tokenEndpoint.token4xx, 1);
    assert.equal(oauth.tokenEndpoint.token5xx, 0);
    const canary = oauth.canary as { ok: boolean; publicBaseUrl?: string; refreshCredentialPresent: boolean; refreshRecoveryVerified: boolean; postRefreshMcpVerified: boolean; accessTokenChanged: boolean };
    assert.equal(canary.ok, true);
    assert.equal(canary.refreshCredentialPresent, true);
    assert.equal(canary.refreshRecoveryVerified, true);
    assert.equal(canary.postRefreshMcpVerified, true);
    assert.equal(canary.accessTokenChanged, true);
    assert.equal(canary.publicBaseUrl, undefined);
    const sharedJson = JSON.stringify(share);
    assert.doesNotMatch(sharedJson, /sensitive-client-id|sensitive-access-hash|sensitive-refresh-hash|sensitive-tailnet-name/);
  } finally {
    if (previous === undefined) delete process.env.DEX_REACH_STATE_DIR;
    else process.env.DEX_REACH_STATE_DIR = previous;
    await fs.rm(dir, { recursive: true, force: true });
  }
});
