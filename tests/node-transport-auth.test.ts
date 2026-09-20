import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { NodeAuthStore } from '../src/gateway/node-auth.js';
import {
  encodeNodeProof,
  expectedProofDefaults,
  generateTransportKeyPair,
  signNodeProof
} from '../src/shared/node-transport-auth.js';
import { loadOrCreateTransportKeys, receiptPrivateKeyFile, transportPrivateKeyFile } from '../src/node/transport-keys.js';
import { REACH_PROTOCOL_VERSION } from '../src/shared/protocol.js';

async function isolatedStore(): Promise<{ dir: string; store: NodeAuthStore; restore: () => Promise<void> }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dex-reach-transport-'));
  const store = new NodeAuthStore(dir);
  await store.initialize();
  return { dir, store, restore: async () => fs.rm(dir, { recursive: true, force: true }) };
}

function proofFor(privateKey: string, nodeId: string, extra: Partial<Parameters<typeof signNodeProof>[1]> = {}) {
  return signNodeProof(privateKey, { ...expectedProofDefaults(nodeId), ...extra });
}

test('valid transport key authenticates and a different key is refused', async () => {
  const ctx = await isolatedStore();
  try {
    await ctx.store.enroll('node-a');
    const keys = generateTransportKeyPair();
    const other = generateTransportKeyPair();
    const token = await ctx.store.createEnrollmentToken('node-a');
    await ctx.store.consumeEnrollment('node-a', token, keys.publicKey);
    const encoded = encodeNodeProof(proofFor(keys.privateKey, 'node-a'));
    assert.deepEqual(await ctx.store.authenticateProof('node-a', encoded), { ok: true });
    const wrong = encodeNodeProof(proofFor(other.privateKey, 'node-a'));
    assert.equal((await ctx.store.authenticateProof('node-a', wrong)).ok, false);
    assert.equal((await ctx.store.authenticateProof('node-a', wrong) as { reason: string }).reason, 'wrong-key');
  } finally {
    await ctx.restore();
  }
});

test('tampered proof fields, timing, replay, unknown and revoked nodes fail closed', async () => {
  const ctx = await isolatedStore();
  try {
    await ctx.store.enroll('node-a');
    const keys = generateTransportKeyPair();
    await ctx.store.consumeEnrollment('node-a', await ctx.store.createEnrollmentToken('node-a'), keys.publicKey);
    const signed = proofFor(keys.privateKey, 'node-a');

    const wrongId = encodeNodeProof({ ...signed, nodeId: 'node-b' });
    assert.equal((await ctx.store.authenticateProof('node-a', wrongId) as { reason: string }).reason, 'wrong-node-id');

    const wrongPath = encodeNodeProof({ ...signed, path: '/mcp' });
    assert.equal((await ctx.store.authenticateProof('node-a', wrongPath) as { reason: string }).reason, 'wrong-path');

    const wrongProto = encodeNodeProof({ ...signed, protocolVersion: REACH_PROTOCOL_VERSION + 7 });
    assert.equal((await ctx.store.authenticateProof('node-a', wrongProto) as { reason: string }).reason, 'incompatible-protocol');

    const stale = encodeNodeProof(proofFor(keys.privateKey, 'node-a', { timestamp: Date.now() - 10 * 60_000 }));
    assert.equal((await ctx.store.authenticateProof('node-a', stale) as { reason: string }).reason, 'stale-timestamp');

    const future = encodeNodeProof(proofFor(keys.privateKey, 'node-a', { timestamp: Date.now() + 5 * 60_000 }));
    assert.equal((await ctx.store.authenticateProof('node-a', future) as { reason: string }).reason, 'future-timestamp');

    const once = encodeNodeProof(proofFor(keys.privateKey, 'node-a'));
    assert.equal((await ctx.store.authenticateProof('node-a', once)).ok, true);
    assert.equal((await ctx.store.authenticateProof('node-a', once) as { reason: string }).reason, 'replay');

    const ghost = encodeNodeProof(proofFor(keys.privateKey, 'nope'));
    assert.equal((await ctx.store.authenticateProof('nope', ghost) as { reason: string }).reason, 'unknown-node');

    await ctx.store.revoke('node-a');
    const afterRevoke = encodeNodeProof(proofFor(keys.privateKey, 'node-a'));
    assert.equal((await ctx.store.authenticateProof('node-a', afterRevoke) as { reason: string }).reason, 'revoked');
    assert.equal(await ctx.store.authenticate('node-a', 'anything'), false);
  } finally {
    await ctx.restore();
  }
});

test('enrollment tokens are one-use and concurrent consumers cannot double-spend', async () => {
  const ctx = await isolatedStore();
  try {
    await ctx.store.enroll('node-a');
    const keys = generateTransportKeyPair();
    const token = await ctx.store.createEnrollmentToken('node-a');
    await ctx.store.consumeEnrollment('node-a', token, keys.publicKey);
    await assert.rejects(ctx.store.consumeEnrollment('node-a', token, keys.publicKey), /invalid or expired/);

    const token2 = await ctx.store.createEnrollmentToken('node-a');
    const a = new NodeAuthStore(ctx.dir);
    const b = new NodeAuthStore(ctx.dir);
    await Promise.all([a.initialize(), b.initialize()]);
    const extra = generateTransportKeyPair();
    const settled = await Promise.allSettled([
      a.consumeEnrollment('node-a', token2, keys.publicKey),
      b.consumeEnrollment('node-a', token2, extra.publicKey)
    ]);
    assert.equal(settled.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(settled.filter(result => result.status === 'rejected').length, 1);
  } finally {
    await ctx.restore();
  }
});

test('legacy bearer remains valid during migration and cannot silently downgrade after asymmetric activation', async () => {
  const ctx = await isolatedStore();
  try {
    const bearer = await ctx.store.enroll('node-a');
    assert.equal(await ctx.store.authenticate('node-a', bearer), true);
    const keys = generateTransportKeyPair();
    await ctx.store.consumeEnrollment('node-a', await ctx.store.createEnrollmentToken('node-a'), keys.publicKey);
    assert.equal(ctx.store.authMode('node-a'), 'migrating');
    assert.equal(await ctx.store.authenticate('node-a', bearer), true);
    const encoded = encodeNodeProof(proofFor(keys.privateKey, 'node-a'));
    assert.equal((await ctx.store.authenticateProof('node-a', encoded)).ok, true);
    await ctx.store.completeMigration('node-a');
    assert.equal(ctx.store.authMode('node-a'), 'asymmetric');
    assert.equal(await ctx.store.authenticate('node-a', bearer), false);
    await assert.rejects(ctx.store.rotate('node-a'), /asymmetric node cannot rotate a bearer token/);
  } finally {
    await ctx.restore();
  }
});

test('transport key rotation refuses the old key after grace and never stores private keys on the gateway', async () => {
  const ctx = await isolatedStore();
  try {
    await ctx.store.enroll('node-a');
    const first = generateTransportKeyPair();
    const second = generateTransportKeyPair();
    await ctx.store.consumeEnrollment('node-a', await ctx.store.createEnrollmentToken('node-a'), first.publicKey);
    await ctx.store.rotateTransportKey('node-a', second.publicKey, 0);
    const oldProof = encodeNodeProof(proofFor(first.privateKey, 'node-a'));
    assert.equal((await ctx.store.authenticateProof('node-a', oldProof)).ok, false);
    const newProof = encodeNodeProof(proofFor(second.privateKey, 'node-a'));
    assert.equal((await ctx.store.authenticateProof('node-a', newProof)).ok, true);
    const raw = await fs.readFile(path.join(ctx.dir, 'node-auth.json'), 'utf8');
    assert.equal(/BEGIN (?:.*)?PRIVATE KEY/.test(raw), false);
    assert.equal(raw.includes(first.privateKey), false);
    assert.equal(raw.includes(second.privateKey), false);
    assert.match(raw, /BEGIN PUBLIC KEY/);
  } finally {
    await ctx.restore();
  }
});

test('transport keys are not receipt keys and live in a 0600 node-local file', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dex-reach-tkeys-'));
  try {
    const created = await loadOrCreateTransportKeys('mac', dir);
    assert.equal(created.created, true);
    assert.notEqual(transportPrivateKeyFile('mac', dir), receiptPrivateKeyFile('mac', dir));
    const stat = await fs.stat(transportPrivateKeyFile('mac', dir));
    assert.equal(stat.mode & 0o777, 0o600);
    const again = await loadOrCreateTransportKeys('mac', dir);
    assert.equal(again.created, false);
    assert.equal(again.privateKey, created.privateKey);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('forgetting a revoked node drops its transport key so re-enrollment starts clean', async () => {
  const ctx = await isolatedStore();
  try {
    await ctx.store.enroll('node-a');
    const keys = generateTransportKeyPair();
    await ctx.store.consumeEnrollment('node-a', await ctx.store.createEnrollmentToken('node-a'), keys.publicKey);
    await ctx.store.completeMigration('node-a');
    const encoded = encodeNodeProof(proofFor(keys.privateKey, 'node-a'));
    assert.equal((await ctx.store.authenticateProof('node-a', encoded)).ok, true);

    await ctx.store.revoke('node-a');
    await ctx.store.forget('node-a');
    const fresh = await ctx.store.enroll('node-a');

    // The node host still holds the old private key file. The gateway must not remember the
    // matching public key, or a revoked credential would survive the revocation that removed it.
    assert.equal(ctx.store.authMode('node-a'), 'bearer');
    assert.equal(ctx.store.list().find(row => row.nodeId === 'node-a')?.transportKey, false);
    const replayed = encodeNodeProof(proofFor(keys.privateKey, 'node-a'));
    assert.equal((await ctx.store.authenticateProof('node-a', replayed)).ok, false);
    // And the freshly issued credential is the one that works, so recovery is actually possible.
    assert.equal(await ctx.store.authenticate('node-a', fresh), true);
  } finally {
    await ctx.restore();
  }
});
