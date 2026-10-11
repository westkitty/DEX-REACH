import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { loadCommandManifest, routeCommand, type ProductReferenceVerifier, type ReferenceQuery, type RouterNodeView, type RouterRefusal } from '../src/shared/dex-command-router.js';

// promotionRef and acceptanceRef are resolved only by the authoritative product interface (ADR-0004 section 6).
// The verifiers here are SYNTHETIC test doubles. None of them reads another product's data.

const fixturePath = path.resolve(import.meta.dirname, 'fixtures/dex-router/command-manifest.synthetic-v1.json');
const loadedFixture = loadCommandManifest(JSON.parse(await fs.readFile(fixturePath, 'utf8')));
if (!loadedFixture.ok) throw new Error('fixture failed to load');
const manifest = loadedFixture.manifest;

const node: RouterNodeView = {
  nodeId: 'node-a', enrolled: true, online: true, capabilities: { dex_command_router: true },
  productAdapters: { SESSION: '1.2.0', DROPZONE: '1.0.0', PAIR: '1.0.0' }
};
const refusalOf = (value: unknown): RouterRefusal => {
  assert.equal((value as { ok: boolean }).ok, false, 'expected a refusal');
  return value as RouterRefusal;
};

/** A registry of what the synthetic product interface actually holds. Anything not listed does not exist. */
function registry(entries: Array<{ kind: 'promotion' | 'acceptance'; ref: string; product: string; targetId: string; revoked?: boolean; scopes?: string[] }>): ProductReferenceVerifier & { calls: ReferenceQuery[] } {
  const calls: ReferenceQuery[] = [];
  return {
    calls,
    verify(query) {
      calls.push(query);
      const hit = entries.find(entry => entry.kind === query.kind && entry.ref === query.ref);
      if (!hit) return { status: 'NOT_FOUND' };
      if (hit.product !== query.product || hit.targetId !== query.targetId) return { status: 'WRONG_BINDING' };
      if (hit.revoked) return { status: 'REVOKED' };
      if (hit.scopes && !hit.scopes.includes(query.command)) return { status: 'INAPPLICABLE' };
      return { status: 'VERIFIED' };
    }
  };
}
const pairOk = registry([{ kind: 'promotion', ref: 'promo-pair-1', product: 'PAIR', targetId: 'obj-1' }]);

test('a present promotionRef with no product interface available is refused: presence proves nothing', async () => {
  const refusal = refusalOf(await routeCommand({ manifest, request: { command: 'FIXTURE//PAIR_READ', nodeId: 'node-a', targetId: 'obj-1', promotionRef: 'promo-pair-1' }, nodes: [node] }));
  assert.equal(refusal.code, 'REFERENCE_VERIFIER_UNAVAILABLE');
});

test('a fabricated reference that the product does not hold is refused', async () => {
  const refusal = refusalOf(await routeCommand({ manifest, request: { command: 'FIXTURE//PAIR_READ', nodeId: 'node-a', targetId: 'obj-1', promotionRef: 'promo-invented' }, nodes: [node], verifier: pairOk }));
  assert.equal(refusal.code, 'REFERENCE_NOT_FOUND');
});

test('a reference to another object is refused', async () => {
  const refusal = refusalOf(await routeCommand({ manifest, request: { command: 'FIXTURE//PAIR_READ', nodeId: 'node-a', targetId: 'obj-2', promotionRef: 'promo-pair-1' }, nodes: [node], verifier: pairOk }));
  assert.equal(refusal.code, 'REFERENCE_WRONG_BINDING');
});

test('a reference cannot be bound without a target, so it is refused', async () => {
  const refusal = refusalOf(await routeCommand({ manifest, request: { command: 'FIXTURE//PAIR_READ', nodeId: 'node-a', promotionRef: 'promo-pair-1' }, nodes: [node], verifier: pairOk }));
  assert.equal(refusal.code, 'REFERENCE_WRONG_BINDING');
});

test('a reference promoted for another product is refused: wrong product binding', async () => {
  const sessionPromo = registry([{ kind: 'promotion', ref: 'promo-session-1', product: 'SESSION', targetId: 'obj-1' }]);
  const refusal = refusalOf(await routeCommand({ manifest, request: { command: 'FIXTURE//PAIR_READ', nodeId: 'node-a', targetId: 'obj-1', promotionRef: 'promo-session-1' }, nodes: [node], verifier: sessionPromo }));
  assert.equal(refusal.code, 'REFERENCE_WRONG_BINDING');
});

test('revoked and inapplicable authorization are refused', async () => {
  const revoked = registry([{ kind: 'promotion', ref: 'promo-pair-1', product: 'PAIR', targetId: 'obj-1', revoked: true }]);
  assert.equal(refusalOf(await routeCommand({ manifest, request: { command: 'FIXTURE//PAIR_READ', nodeId: 'node-a', targetId: 'obj-1', promotionRef: 'promo-pair-1' }, nodes: [node], verifier: revoked })).code, 'REFERENCE_REVOKED_OR_INAPPLICABLE');
  const scoped = registry([{ kind: 'promotion', ref: 'promo-pair-1', product: 'PAIR', targetId: 'obj-1', scopes: ['FIXTURE//SESSION_STATUS'] }]);
  assert.equal(refusalOf(await routeCommand({ manifest, request: { command: 'FIXTURE//PAIR_READ', nodeId: 'node-a', targetId: 'obj-1', promotionRef: 'promo-pair-1' }, nodes: [node], verifier: scoped })).code, 'REFERENCE_REVOKED_OR_INAPPLICABLE');
});

test('missing promotion or acceptance is refused before the product interface is consulted', async () => {
  const verifier = registry([]);
  assert.equal(refusalOf(await routeCommand({ manifest, request: { command: 'FIXTURE//PAIR_READ', nodeId: 'node-a', targetId: 'obj-1' }, nodes: [node], verifier })).code, 'DATA_NOT_PROMOTED');
  assert.equal(refusalOf(await routeCommand({ manifest, request: { command: 'FIXTURE//DROPZONE_INGEST', nodeId: 'node-a', targetId: 'obj-1' }, nodes: [{ ...node, productAdapters: { DROPZONE: '1.0.0' } }], verifier })).code, 'INPUT_NOT_ACCEPTED');
  assert.equal(verifier.calls.length, 0);
});

test('an interface that throws or reports itself unavailable refuses dispatch', async () => {
  const throwing: ProductReferenceVerifier = { verify: () => { throw new Error('connection reset'); } };
  assert.equal(refusalOf(await routeCommand({ manifest, request: { command: 'FIXTURE//PAIR_READ', nodeId: 'node-a', targetId: 'obj-1', promotionRef: 'promo-pair-1' }, nodes: [node], verifier: throwing })).code, 'REFERENCE_VERIFIER_UNAVAILABLE');
  const unavailable: ProductReferenceVerifier = { verify: () => ({ status: 'UNAVAILABLE' }) };
  assert.equal(refusalOf(await routeCommand({ manifest, request: { command: 'FIXTURE//PAIR_READ', nodeId: 'node-a', targetId: 'obj-1', promotionRef: 'promo-pair-1' }, nodes: [node], verifier: unavailable })).code, 'REFERENCE_VERIFIER_UNAVAILABLE');
});

test('a verified reference dispatches, and the query is bound to product, command, target and node', async () => {
  const verifier = registry([{ kind: 'promotion', ref: 'promo-pair-1', product: 'PAIR', targetId: 'obj-1' }]);
  const decision = await routeCommand({ manifest, request: { command: 'FIXTURE//PAIR_READ', nodeId: 'node-a', targetId: 'obj-1', promotionRef: 'promo-pair-1' }, nodes: [node], verifier });
  assert.equal(decision.ok, true);
  if (decision.ok) assert.equal(decision.referencesVerified, true);
  assert.deepEqual(verifier.calls, [{ kind: 'promotion', ref: 'promo-pair-1', product: 'PAIR', command: 'FIXTURE//PAIR_READ', targetId: 'obj-1', nodeId: 'node-a', dataClass: 'PRIVATE' }]);
});

test('an acceptance reference for DROPZONE input is verified the same way', async () => {
  const verifier = registry([{ kind: 'acceptance', ref: 'accept-1', product: 'DROPZONE', targetId: 'obj-9' }]);
  const dropzoneNode = { ...node, productAdapters: { DROPZONE: '1.0.0' } };
  assert.equal((await routeCommand({ manifest, request: { command: 'FIXTURE//DROPZONE_INGEST', nodeId: 'node-a', targetId: 'obj-9', acceptanceRef: 'accept-1' }, nodes: [dropzoneNode], verifier })).ok, true);
  assert.equal(refusalOf(await routeCommand({ manifest, request: { command: 'FIXTURE//DROPZONE_INGEST', nodeId: 'node-a', targetId: 'obj-9', acceptanceRef: 'accept-fabricated' }, nodes: [dropzoneNode], verifier })).code, 'REFERENCE_NOT_FOUND');
});

test('a non-REACH command still verifies any reference it carries', async () => {
  const verifier = registry([]);
  assert.equal(refusalOf(await routeCommand({ manifest, request: { command: 'FIXTURE//DEX_LOCAL_HELP', targetId: 'obj-1', promotionRef: 'promo-x' }, nodes: [], verifier })).code, 'REFERENCE_NOT_FOUND');
});
