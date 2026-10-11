import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { loadCommandManifest, routeCommand, ROUTER_REFUSAL_CODES, type LoadedManifest, type RouterNodeView, type RouterRefusal } from '../src/shared/dex-command-router.js';

// REACH-side versioned adapter over DEX-owned manifest data (ADR-0004 sections 3 and 5). The fixture is
// SYNTHETIC. DEX's real manifest was not readable (HTTP 403), so no test here proves DEX behaviour.

const fixturePath = path.resolve(import.meta.dirname, 'fixtures/dex-router/command-manifest.synthetic-v1.json');
const raw = JSON.parse(await fs.readFile(fixturePath, 'utf8')) as Record<string, unknown>;
const clone = (): Record<string, any> => JSON.parse(JSON.stringify(raw));
const loaded = (value: unknown = raw): LoadedManifest => {
  const result = loadCommandManifest(value);
  if (!result.ok) throw new Error(`fixture failed to load: ${result.code}`);
  return result.manifest;
};
const refusalOf = (value: unknown): RouterRefusal => {
  assert.equal((value as { ok: boolean }).ok, false, 'expected a refusal');
  return value as RouterRefusal;
};
const onlineNode: RouterNodeView = {
  nodeId: 'node-a', enrolled: true, online: true,
  capabilities: { dex_command_router: true },
  productAdapters: { SESSION: '1.2.0', DROPZONE: '1.0.0', PAIR: '1.0.0', WITNESS: '1.0.0', REMIX: '1.0.0', CAPSULE: '1.0.0' }
};

test('a synthetic manifest is refused as production configuration and accepted only as test data', () => {
  assert.equal(refusalOf(loadCommandManifest(raw, { production: true })).code, 'SYNTHETIC_MANIFEST_IN_PRODUCTION');
  assert.equal(loadCommandManifest(raw).ok, true);
});

test('a command that does not invoke REACH has no node requirement and no REACH operation', async () => {
  const decision = await routeCommand({ manifest: loaded(), request: { command: 'FIXTURE//DEX_LOCAL_HELP' }, nodes: [] });
  assert.equal(decision.ok, true);
  if (!decision.ok) return;
  assert.equal(decision.nodeId, null);
  assert.equal(decision.reachOperation, null);
});

test('a REACH-invoking command still requires an exact node, even when a single node is online', async () => {
  assert.equal(refusalOf(await routeCommand({ manifest: loaded(), request: { command: 'FIXTURE//SESSION_STATUS' }, nodes: [onlineNode] })).code, 'NODE_ID_REQUIRED');
});

test('no REACH mapping is fabricated: invokesReach must be declared, and reachOperation must match it', () => {
  const missingFlag = clone(); delete missingFlag.commands[0].invokesReach;
  assert.equal(refusalOf(loadCommandManifest(missingFlag)).code, 'MANIFEST_INVALID');
  const reachWithoutOp = clone(); delete reachWithoutOp.commands[0].reachOperation;
  assert.equal(refusalOf(loadCommandManifest(reachWithoutOp)).code, 'MANIFEST_INVALID');
  const nonReachWithOp = clone(); nonReachWithOp.commands[6].reachOperation = 'dex.trustReport';
  assert.equal(refusalOf(loadCommandManifest(nonReachWithOp)).code, 'MANIFEST_INVALID');
});

test('modifiers are declared by DEX and validated: unknown names and undeclared modifiers are refused', async () => {
  const badName = clone(); badName.commands[0].modifiers = ['GO'];
  assert.equal(refusalOf(loadCommandManifest(badName)).code, 'MANIFEST_INVALID');
  const duplicate = clone(); duplicate.commands[0].modifiers = ['DRY', 'DRY'];
  assert.equal(refusalOf(loadCommandManifest(duplicate)).code, 'MANIFEST_INVALID');
  const manifest = loaded();
  assert.equal(refusalOf(await routeCommand({ manifest, request: { command: 'FIXTURE//DROPZONE_INGEST', nodeId: 'node-a', acceptanceRef: 'x', modifiers: ['DRY'] }, nodes: [onlineNode] })).code, 'MODIFIER_UNKNOWN');
  assert.equal(refusalOf(await routeCommand({ manifest, request: { command: 'FIXTURE//SESSION_STATUS', nodeId: 'node-a', modifiers: ['ADMIN'] }, nodes: [onlineNode] })).code, 'MODIFIER_UNKNOWN');
});

test('+DRY cannot mutate: a DRY request on a command that is not read-only is refused', async () => {
  const mutating = clone(); mutating.commands.find((c: { id: string }) => c.id === 'FIXTURE//REMIX_APPLY').modifiers = ['DRY'];
  const refusal = refusalOf(await routeCommand({ manifest: loaded(mutating), request: { command: 'FIXTURE//REMIX_APPLY', nodeId: 'node-a', modifiers: ['DRY'] }, nodes: [onlineNode] }));
  assert.equal(refusal.code, 'MODIFIER_MUTATION_FORBIDDEN');
  const readOnly = await routeCommand({ manifest: loaded(), request: { command: 'FIXTURE//SESSION_STATUS', nodeId: 'node-a', modifiers: ['DRY'] }, nodes: [onlineNode] });
  assert.equal(readOnly.ok, true);
  if (readOnly.ok) assert.equal(readOnly.effective.dryRun, true);
});

test('+SHIP grants no authority: the plan records none, and a SHIP request still meets every gate', async () => {
  const manifest = loaded();
  const shipped = await routeCommand({ manifest, request: { command: 'FIXTURE//SESSION_STATUS', nodeId: 'node-a', modifiers: ['SHIP'] }, nodes: [onlineNode] });
  assert.equal(shipped.ok, true);
  if (shipped.ok) assert.equal(shipped.effective.authorityFromModifiers, false);
  assert.equal(refusalOf(await routeCommand({ manifest, request: { command: 'FIXTURE//DROPZONE_INGEST', nodeId: 'node-a', modifiers: ['SHIP'] }, nodes: [onlineNode] })).code, 'INPUT_NOT_ACCEPTED');
});

test('+FAST cannot skip a gate: promotion and acceptance are still required', async () => {
  const manifest = loaded();
  assert.equal(refusalOf(await routeCommand({ manifest, request: { command: 'FIXTURE//PAIR_READ', nodeId: 'node-a', modifiers: ['FAST'] }, nodes: [onlineNode] })).code, 'DATA_NOT_PROMOTED');
  assert.equal(refusalOf(await routeCommand({ manifest, request: { command: 'FIXTURE//DROPZONE_INGEST', nodeId: 'node-a', modifiers: ['FAST'] }, nodes: [onlineNode] })).code, 'INPUT_NOT_ACCEPTED');
});

test('the WITNESS to REMIX prohibition holds regardless of modifiers', async () => {
  const { validateHandoff } = await import('../src/shared/dex-command-router.js');
  const handoff = { handoffVersion: '1.0.0', fromProduct: 'WITNESS', toProduct: 'REMIX', command: 'FIXTURE//REMIX_APPLY', schemaId: 'fixture.handoff.v1', payloadSha256: 'a'.repeat(64), dataClass: 'PUBLIC', promotionRef: 'promotion-1' };
  assert.equal(refusalOf(validateHandoff(handoff, loaded())).code, 'WITNESS_REMIX_EDGE_FORBIDDEN');
});

test('version mismatches are deterministic refusals, identical on every attempt', async () => {
  const future = clone(); future.contractVersion = '2.0.0';
  const first = refusalOf(loadCommandManifest(future));
  const second = refusalOf(loadCommandManifest(future));
  assert.equal(first.code, 'DEX_CONTRACT_MAJOR_MISMATCH');
  assert.deepEqual(first, second);
  const adapterOld = refusalOf(await routeCommand({ manifest: loaded(), request: { command: 'FIXTURE//SESSION_STATUS', nodeId: 'node-a' }, nodes: [{ ...onlineNode, productAdapters: { ...onlineNode.productAdapters, SESSION: '2.0.0' } }] }));
  assert.equal(adapterOld.code, 'ADAPTER_MAJOR_MISMATCH');
});

test('every refusal code added by this adapter is in the closed list', () => {
  for (const code of ['SYNTHETIC_MANIFEST_IN_PRODUCTION', 'MODIFIER_UNKNOWN', 'MODIFIER_MUTATION_FORBIDDEN', 'REFERENCE_VERIFIER_UNAVAILABLE', 'REFERENCE_NOT_FOUND', 'REFERENCE_WRONG_BINDING', 'REFERENCE_REVOKED_OR_INAPPLICABLE']) {
    assert.ok((ROUTER_REFUSAL_CODES as readonly string[]).includes(code), code);
  }
});
