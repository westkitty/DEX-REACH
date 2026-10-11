import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  loadCommandManifest,
  projectSearchEntries,
  routeCommand,
  validateHandoff,
  type LoadedManifest,
  type ProductReferenceVerifier,
  type RouterNodeView,
  type RouterRefusal
} from '../src/shared/dex-command-router.js';

// SYNTHETIC verifier: stands in for the product interface in tests only. It resolves two fixture references
// bound to one fixture target. It is not production configuration and proves no DEX behaviour.
const syntheticVerifier: ProductReferenceVerifier = {
  verify: query => {
    if (query.ref !== 'accepted-input-1' && query.ref !== 'promotion-1') return { status: 'NOT_FOUND' };
    return query.targetId === 'target-1' ? { status: 'VERIFIED' } : { status: 'WRONG_BINDING' };
  }
};

// Fixture-only tests for the ADR-0004 router skeleton. They prove the skeleton's logic against a
// SYNTHETIC manifest. They do not prove any DEX product integration.

const fixturePath = path.resolve(import.meta.dirname, 'fixtures/dex-router/command-manifest.synthetic-v1.json');
const rawFixture = JSON.parse(await fs.readFile(fixturePath, 'utf8')) as Record<string, unknown>;

function cloneFixture(): Record<string, unknown> {
  return structuredClone(rawFixture);
}

function loaded(): LoadedManifest {
  const result = loadCommandManifest(cloneFixture());
  assert.equal(result.ok, true, 'fixture must load');
  return (result as { manifest: LoadedManifest }).manifest;
}

function refusalOf(value: unknown): RouterRefusal {
  assert.equal((value as { ok: boolean }).ok, false, 'expected a refusal');
  return value as RouterRefusal;
}

const capableAdapters = { SESSION: '1.0.0', DROPZONE: '1.0.0', PAIR: '1.0.0', WITNESS: '1.0.0', REMIX: '1.0.0', CAPSULE: '1.0.0' } as const;

function node(overrides: Partial<RouterNodeView> & { nodeId: string }): RouterNodeView {
  return {
    enrolled: true,
    online: true,
    capabilities: { dex_command_router: true },
    productAdapters: { ...capableAdapters },
    ...overrides
  };
}

const onlineNode = node({ nodeId: 'node-a' });

test('the synthetic fixture loads, is marked synthetic, and carries seven commands', () => {
  const manifest = loaded();
  assert.equal(manifest.synthetic, true);
  assert.equal(manifest.contractVersion, '1.0.0');
  assert.equal(manifest.commands.size, 7);
  for (const id of manifest.commands.keys()) assert.match(id, /^FIXTURE\/\//, 'fixture ids must not look like DEX commands');
});

test('the loader refuses a different contract major before any field validation', () => {
  const future = { ...cloneFixture(), contractVersion: '2.0.0', newTopLevelField: true };
  const refusal = refusalOf(loadCommandManifest(future));
  assert.equal(refusal.code, 'DEX_CONTRACT_MAJOR_MISMATCH');
  assert.deepEqual(refusal.details, { expectedMajor: 1, actualVersion: '2.0.0' });
});

test('the loader fails closed on malformed manifests', () => {
  const cases: Array<[string, unknown]> = [
    ['not an object', []],
    ['wrong schema', { ...cloneFixture(), schema: 'other' }],
    ['non-semver contract', { ...cloneFixture(), contractVersion: 'one' }],
    ['unknown top-level field', { ...cloneFixture(), extra: 1 }],
    ['commands not an array', { ...cloneFixture(), commands: {} }],
    ['unknown command field', withCommand(0, { executable: '/bin/sh' })],
    ['non-canonical id', withCommand(0, { id: 'fixture-status' })],
    ['id with whitespace', withCommand(0, { id: 'FIXTURE//SESSION_STATUS ' })],
    ['unknown product', withCommand(0, { product: 'CONTRABAND' })],
    ['invented safety class', withCommand(0, { safetyClass: 'MAYBE_SAFE' })],
    ['unknown data class', withCommand(0, { dataClass: 'TOP_SECRET' })],
    ['unknown input origin', withCommand(0, { inputOrigin: 'anyone' })],
    ['missing safety class', withCommandRemoved(0, 'safetyClass')]
  ];
  for (const [label, raw] of cases) {
    assert.equal(refusalOf(loadCommandManifest(raw)).code, 'MANIFEST_INVALID', label);
  }
  const duplicate = cloneFixture();
  (duplicate.commands as unknown[]).push(structuredClone((duplicate.commands as unknown[])[0]));
  assert.equal(refusalOf(loadCommandManifest(duplicate)).code, 'MANIFEST_INVALID');
});

function withCommand(index: number, patch: Record<string, unknown>): Record<string, unknown> {
  const raw = cloneFixture();
  const commands = raw.commands as Array<Record<string, unknown>>;
  commands[index] = { ...commands[index], ...patch };
  return raw;
}

function withCommandRemoved(index: number, key: string): Record<string, unknown> {
  const raw = cloneFixture();
  const commands = raw.commands as Array<Record<string, unknown>>;
  delete commands[index]![key];
  return raw;
}

test('a known command routes to exactly the node that was named', async () => {
  const decision = await routeCommand({
    manifest: loaded(),
    request: { command: 'FIXTURE//SESSION_STATUS', nodeId: 'node-a' },
    nodes: [onlineNode]
  });
  assert.equal(decision.ok, true);
  if (!decision.ok) return;
  assert.equal(decision.nodeId, 'node-a');
  assert.equal(decision.reachOperation, 'dex.trustReport');
  assert.equal(decision.command.product, 'SESSION');
});

test('unknown commands are refused, including case and whitespace variants', async () => {
  for (const command of ['FIXTURE//UNKNOWN', 'fixture//session_status', 'FIXTURE//SESSION_STATUS ', '']) {
    const refusal = refusalOf(await routeCommand({ manifest: loaded(), request: { command, nodeId: 'node-a' }, nodes: [onlineNode] }));
    assert.equal(refusal.code, 'UNKNOWN_COMMAND', JSON.stringify(command));
  }
});

test('a pinned command major must match the manifest command major', async () => {
  const manifest = loaded();
  assert.equal((await routeCommand({ manifest, request: { command: 'FIXTURE//SESSION_STATUS', commandVersion: '1.4.0', nodeId: 'node-a' }, nodes: [onlineNode] })).ok, true);
  const refusal = refusalOf(await routeCommand({ manifest, request: { command: 'FIXTURE//SESSION_STATUS', commandVersion: '2.0.0', nodeId: 'node-a' }, nodes: [onlineNode] }));
  assert.equal(refusal.code, 'COMMAND_MAJOR_MISMATCH');
  assert.equal(refusal.details?.actualVersion, '1.0.0');
});

test('a missing node_id is refused even when exactly one node is online', async () => {
  const refusal = refusalOf(await routeCommand({ manifest: loaded(), request: { command: 'FIXTURE//SESSION_STATUS' }, nodes: [onlineNode] }));
  assert.equal(refusal.code, 'NODE_ID_REQUIRED');
});

test('node selection is exact: no case folding, prefix match or fallback to a capable online node', async () => {
  const nodes = [node({ nodeId: 'node-a' }), node({ nodeId: 'node-b', online: false })];
  const manifest = loaded();
  // Offline requested node: refused, and the refusal must not offer the capable node-a.
  const offline = refusalOf(await routeCommand({ manifest, request: { command: 'FIXTURE//SESSION_STATUS', nodeId: 'node-b' }, nodes }));
  assert.equal(offline.code, 'NODE_NOT_ONLINE');
  assert.doesNotMatch(JSON.stringify(offline), /node-a/);
  for (const nodeId of ['NODE-A', 'node', 'node-a ', 'node-a.local']) {
    const refusal = refusalOf(await routeCommand({ manifest, request: { command: 'FIXTURE//SESSION_STATUS', nodeId }, nodes }));
    assert.equal(refusal.code, 'NODE_NOT_FOUND', nodeId);
  }
});

test('a node that is not enrolled is not routable, even when it reports online', async () => {
  const refusal = refusalOf(await routeCommand({
    manifest: loaded(),
    request: { command: 'FIXTURE//SESSION_STATUS', nodeId: 'node-a' },
    nodes: [node({ nodeId: 'node-a', enrolled: false })]
  }));
  assert.equal(refusal.code, 'NODE_NOT_ONLINE');
});

test('a node without the router capability or with a different adapter major is refused, never downgraded', async () => {
  const manifest = loaded();
  const noCapability = refusalOf(await routeCommand({
    manifest,
    request: { command: 'FIXTURE//SESSION_STATUS', nodeId: 'node-a' },
    nodes: [node({ nodeId: 'node-a', capabilities: {} })]
  }));
  assert.equal(noCapability.code, 'CAPABILITY_UNSUPPORTED_ON_NODE');

  const noAdapter = refusalOf(await routeCommand({
    manifest,
    request: { command: 'FIXTURE//SESSION_STATUS', nodeId: 'node-a' },
    nodes: [node({ nodeId: 'node-a', productAdapters: {} })]
  }));
  assert.equal(noAdapter.code, 'CAPABILITY_UNSUPPORTED_ON_NODE');

  const wrongMajor = refusalOf(await routeCommand({
    manifest,
    request: { command: 'FIXTURE//SESSION_STATUS', nodeId: 'node-a' },
    nodes: [node({ nodeId: 'node-a', productAdapters: { ...capableAdapters, SESSION: '2.0.0' } })]
  }));
  assert.equal(wrongMajor.code, 'ADAPTER_MAJOR_MISMATCH');
  assert.equal(wrongMajor.details?.expectedMajor, 1);
});

test('DROPZONE input is untrusted until an accepted input reference is supplied', async () => {
  const manifest = loaded();
  const request = { command: 'FIXTURE//DROPZONE_INGEST', nodeId: 'node-a' };
  assert.equal(refusalOf(await routeCommand({ manifest, request, nodes: [onlineNode] })).code, 'INPUT_NOT_ACCEPTED');
  assert.equal((await routeCommand({ manifest, request: { ...request, acceptanceRef: 'accepted-input-1', targetId: 'target-1' }, nodes: [onlineNode], verifier: syntheticVerifier })).ok, true);
});

test('PRIVATE and SEALED data is not routable remotely without an explicit promotion', async () => {
  const manifest = loaded();
  const pair = { command: 'FIXTURE//PAIR_READ', nodeId: 'node-a' };
  assert.equal(refusalOf(await routeCommand({ manifest, request: pair, nodes: [onlineNode] })).code, 'DATA_NOT_PROMOTED');
  assert.equal((await routeCommand({ manifest, request: { ...pair, promotionRef: 'promotion-1', targetId: 'target-1' }, nodes: [onlineNode], verifier: syntheticVerifier })).ok, true);
  const witness = { command: 'FIXTURE//WITNESS_EXPORT', nodeId: 'node-a' };
  assert.equal(refusalOf(await routeCommand({ manifest, request: witness, nodes: [onlineNode] })).code, 'DATA_NOT_PROMOTED');
});

test('a manifest cannot route a command to an operation REACH does not catalogue', async () => {
  const refusal = refusalOf(await routeCommand({
    manifest: loaded(),
    request: { command: 'FIXTURE//NOT_CATALOGUED', nodeId: 'node-a' },
    nodes: [onlineNode]
  }));
  assert.equal(refusal.code, 'OPERATION_NOT_IN_CATALOGUE');
});

test('every refusal code is in the closed list of ADR-0004 section 7', async () => {
  const { ROUTER_REFUSAL_CODES } = await import('../src/shared/dex-command-router.js');
  for (const code of ['MANIFEST_INVALID', 'DEX_CONTRACT_MAJOR_MISMATCH', 'COMMAND_MAJOR_MISMATCH', 'UNKNOWN_COMMAND', 'NODE_ID_REQUIRED', 'NODE_NOT_FOUND', 'NODE_NOT_ONLINE', 'CAPABILITY_UNSUPPORTED_ON_NODE', 'ADAPTER_MAJOR_MISMATCH', 'INPUT_NOT_ACCEPTED', 'DATA_NOT_PROMOTED', 'OPERATION_NOT_IN_CATALOGUE', 'HANDOFF_INVALID', 'WITNESS_REMIX_EDGE_FORBIDDEN']) {
    assert.ok(ROUTER_REFUSAL_CODES.includes(code as never), code);
  }
  assert.equal(ROUTER_REFUSAL_CODES.length, 21);
});

const validHandoff = {
  handoffVersion: '1.0.0',
  fromProduct: 'SESSION',
  toProduct: 'REMIX',
  command: 'FIXTURE//REMIX_APPLY',
  schemaId: 'fixture.handoff.v1',
  payloadSha256: 'a'.repeat(64),
  dataClass: 'PUBLIC'
};

test('the receiver accepts a well-formed handoff for its own command', () => {
  const result = validateHandoff(validHandoff, loaded());
  assert.equal(result.ok, true);
});

test('WITNESS-to-REMIX is forbidden in code, even when the manifest and handoff otherwise look valid', () => {
  const edge = { ...validHandoff, fromProduct: 'WITNESS', toProduct: 'REMIX' };
  assert.equal(refusalOf(validateHandoff(edge, loaded())).code, 'WITNESS_REMIX_EDGE_FORBIDDEN');
  // Even a promotion reference does not reopen the edge.
  assert.equal(refusalOf(validateHandoff({ ...edge, dataClass: 'PRIVATE', promotionRef: 'p-1' }, loaded())).code, 'WITNESS_REMIX_EDGE_FORBIDDEN');
});

test('the receiver refuses malformed handoffs and never trusts sender authorization fields', () => {
  const manifest = loaded();
  const cases: Array<[string, Record<string, unknown>]> = [
    ['future handoff major', { ...validHandoff, handoffVersion: '2.0.0' }],
    ['unknown product', { ...validHandoff, fromProduct: 'NOPE' }],
    ['command not in receiver manifest', { ...validHandoff, command: 'FIXTURE//SESSION_STATUS' }],
    ['command belongs to another product', { ...validHandoff, command: 'FIXTURE//DROPZONE_INGEST', toProduct: 'REMIX' }],
    ['bad payload digest', { ...validHandoff, payloadSha256: 'ABC' }],
    ['sender authorization claim smuggled in', { ...validHandoff, authorized: true }]
  ];
  for (const [label, raw] of cases) {
    const refusal = refusalOf(validateHandoff(raw, manifest));
    assert.ok(['HANDOFF_INVALID', 'UNKNOWN_COMMAND'].includes(refusal.code), `${label}: ${refusal.code}`);
  }
  assert.equal(refusalOf(validateHandoff({ ...validHandoff, dataClass: 'PRIVATE' }, manifest)).code, 'DATA_NOT_PROMOTED');
});

test('search projections exclude unpromoted PRIVATE and SEALED items and are rebuildable only', () => {
  const sources = [
    { id: 'b-private', product: 'PAIR' as const, dataClass: 'PRIVATE' as const },
    { id: 'a-public', product: 'SESSION' as const, dataClass: 'PUBLIC' as const },
    { id: 'c-sealed', product: 'WITNESS' as const, dataClass: 'SEALED' as const },
    { id: 'd-private-promoted', product: 'PAIR' as const, dataClass: 'PRIVATE' as const }
  ];
  const projection = projectSearchEntries(sources, new Set(['d-private-promoted']));
  assert.equal(projection.rebuildable, true);
  assert.equal(projection.authoritative, false);
  assert.deepEqual(projection.entries.map(entry => entry.id), ['a-public', 'd-private-promoted']);
  assert.equal(projection.excludedUnpromoted, 2);

  // Deterministic: input order does not change the output, and the digest tracks the source.
  const reordered = projectSearchEntries([...sources].reverse(), new Set(['d-private-promoted']));
  assert.equal(reordered.sourceDigest, projection.sourceDigest);
  const changed = projectSearchEntries([...sources, { id: 'e-public', product: 'CAPSULE', dataClass: 'PUBLIC' }], new Set(['d-private-promoted']));
  assert.notEqual(changed.sourceDigest, projection.sourceDigest);
});
