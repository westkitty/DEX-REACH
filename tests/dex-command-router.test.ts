import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEX_MODIFIERS,
  ROUTER_REFUSAL_CODES,
  projectSearchEntries,
  routeCommand,
  validateHandoff,
  type HandoffReceiver,
  type ProductReferenceVerifier
} from '../src/shared/dex-command-router.js';
import { capableAdapters, loadFixture, node, refusalOf } from './dex-router-fixtures.js';

// Tests for the ADR-0004 router against SYNTHETIC canonical-shape fixtures (see dex-router-fixtures.ts).
// They prove REACH's routing logic. They do not prove any DEX product integration.

const syntheticVerifier: ProductReferenceVerifier = {
  verify: query => {
    if (query.ref !== 'accepted-input-1' && query.ref !== 'promotion-1') return { status: 'NOT_FOUND' };
    return query.targetId === 'target-1' ? { status: 'VERIFIED' } : { status: 'WRONG_BINDING' };
  }
};

const onlineNode = node({ nodeId: 'node-a' });
const STATUS = 'DEX//FIXTURE_SESSION_STATUS';

test('a known command routes to exactly the node that was named', async () => {
  const decision = await routeCommand({ manifest: loadFixture(), request: { command: STATUS, nodeId: 'node-a' }, nodes: [onlineNode] });
  assert.equal(decision.ok, true);
  if (!decision.ok) return;
  assert.equal(decision.nodeId, 'node-a');
  assert.equal(decision.reachOperation, 'dex.trustReport');
  assert.equal(decision.command.product, 'session');
  assert.equal(decision.previewOf, null);
});

test('a command with a declared REACH-free mapping has no node requirement and no REACH operation', async () => {
  const decision = await routeCommand({ manifest: loadFixture(), request: { command: 'DEX//FIXTURE_LOCAL_HELP' }, nodes: [] });
  assert.equal(decision.ok, true);
  if (!decision.ok) return;
  assert.equal(decision.nodeId, null);
  assert.equal(decision.reachOperation, null);
});

test('a canonical command with no authoritative REACH mapping is unroutable, and is not reported as unknown', async () => {
  const refusal = refusalOf(await routeCommand({ manifest: loadFixture(), request: { command: 'DEX//FIXTURE_UNMAPPED', nodeId: 'node-a' }, nodes: [onlineNode] }));
  assert.equal(refusal.code, 'REACH_MAPPING_ABSENT');
  assert.deepEqual(refusal.details, { command: 'DEX//FIXTURE_UNMAPPED', scope: 'GLOBAL' });
});

test('unknown commands are refused, including slash forms, aliases, prose, case and whitespace variants', async () => {
  for (const command of ['DEX//FIXTURE_NOPE', 'dex//fixture_session_status', `${STATUS} `, '/fixture_session_status', 'check the session status', '']) {
    const refusal = refusalOf(await routeCommand({ manifest: loadFixture(), request: { command, nodeId: 'node-a' }, nodes: [onlineNode] }));
    assert.equal(refusal.code, 'UNKNOWN_COMMAND', JSON.stringify(command));
  }
});

test('a pinned command major must match the manifest version major', async () => {
  const manifest = loadFixture();
  assert.equal((await routeCommand({ manifest, request: { command: STATUS, commandVersion: '1.4.0', nodeId: 'node-a' }, nodes: [onlineNode] })).ok, true);
  const refusal = refusalOf(await routeCommand({ manifest, request: { command: STATUS, commandVersion: '2.0.0', nodeId: 'node-a' }, nodes: [onlineNode] }));
  assert.equal(refusal.code, 'COMMAND_MAJOR_MISMATCH');
  assert.equal(refusal.details?.actualVersion, '1.0.0');
});

test('a missing node_id is refused even when exactly one node is online', async () => {
  assert.equal(refusalOf(await routeCommand({ manifest: loadFixture(), request: { command: STATUS }, nodes: [onlineNode] })).code, 'NODE_ID_REQUIRED');
});

test('node selection is exact: no case folding, prefix match or fallback to a capable online node', async () => {
  const nodes = [node({ nodeId: 'node-a' }), node({ nodeId: 'node-b', online: false })];
  const manifest = loadFixture();
  // Offline requested node: refused, and the refusal must not offer the capable node-a.
  const offline = refusalOf(await routeCommand({ manifest, request: { command: STATUS, nodeId: 'node-b' }, nodes }));
  assert.equal(offline.code, 'NODE_NOT_ONLINE');
  assert.doesNotMatch(JSON.stringify(offline), /node-a/);
  for (const nodeId of ['NODE-A', 'node', 'node-a ', 'node-a.local']) {
    assert.equal(refusalOf(await routeCommand({ manifest, request: { command: STATUS, nodeId }, nodes })).code, 'NODE_NOT_FOUND', nodeId);
  }
});

test('a node that is not enrolled is not routable, even when it reports online', async () => {
  const refusal = refusalOf(await routeCommand({ manifest: loadFixture(), request: { command: STATUS, nodeId: 'node-a' }, nodes: [node({ nodeId: 'node-a', enrolled: false })] }));
  assert.equal(refusal.code, 'NODE_NOT_ONLINE');
});

test('a node without the router capability or with a different adapter major is refused, never downgraded', async () => {
  const manifest = loadFixture();
  const request = { command: STATUS, nodeId: 'node-a' };
  assert.equal(refusalOf(await routeCommand({ manifest, request, nodes: [node({ nodeId: 'node-a', capabilities: {} })] })).code, 'CAPABILITY_UNSUPPORTED_ON_NODE');
  assert.equal(refusalOf(await routeCommand({ manifest, request, nodes: [node({ nodeId: 'node-a', productAdapters: {} })] })).code, 'CAPABILITY_UNSUPPORTED_ON_NODE');
  const wrongMajor = refusalOf(await routeCommand({ manifest, request, nodes: [node({ nodeId: 'node-a', productAdapters: { ...capableAdapters, session: '2.0.0' } })] }));
  assert.equal(wrongMajor.code, 'ADAPTER_MAJOR_MISMATCH');
  assert.equal(wrongMajor.details?.expectedMajor, 1);
  // The old uppercase ids are not DEX product ids and are not an adapter advertisement.
  const uppercase = node({ nodeId: 'node-a', productAdapters: { SESSION: '1.0.0' } as never });
  assert.equal(refusalOf(await routeCommand({ manifest, request, nodes: [uppercase] })).code, 'CAPABILITY_UNSUPPORTED_ON_NODE');
});

test('control-plane scopes are not products: a REACH-scope command needs the router capability but no product adapter', async () => {
  const manifest = loadFixture();
  const bare = node({ nodeId: 'node-a', productAdapters: {} });
  const decision = await routeCommand({ manifest, request: { command: 'DEX//FIXTURE_REACH_PROBE', nodeId: 'node-a' }, nodes: [bare] });
  assert.equal(decision.ok, true);
  if (decision.ok) assert.equal(decision.command.product, null);
  assert.equal(refusalOf(await routeCommand({ manifest, request: { command: 'DEX//FIXTURE_REACH_PROBE', nodeId: 'node-a' }, nodes: [node({ nodeId: 'node-a', capabilities: {} })] })).code, 'CAPABILITY_UNSUPPORTED_ON_NODE');
  // A scope is never a reference-binding product either.
  const refusal = refusalOf(await routeCommand({ manifest, request: { command: 'DEX//FIXTURE_REACH_PROBE', nodeId: 'node-a', targetId: 'target-1', promotionRef: 'promotion-1' }, nodes: [bare], verifier: syntheticVerifier }));
  assert.equal(refusal.code, 'REFERENCE_WRONG_BINDING');
});

test('DROPZONE input is untrusted until an accepted input reference is supplied', async () => {
  const manifest = loadFixture();
  const request = { command: 'DEX//FIXTURE_DROPZONE_INGEST', nodeId: 'node-a' };
  assert.equal(refusalOf(await routeCommand({ manifest, request, nodes: [onlineNode] })).code, 'INPUT_NOT_ACCEPTED');
  assert.equal((await routeCommand({ manifest, request: { ...request, acceptanceRef: 'accepted-input-1', targetId: 'target-1' }, nodes: [onlineNode], verifier: syntheticVerifier })).ok, true);
});

test('PRIVATE and SEALED data is not routable remotely without an explicit promotion', async () => {
  const manifest = loadFixture();
  const pair = { command: 'DEX//FIXTURE_PAIR_READ', nodeId: 'node-a' };
  assert.equal(refusalOf(await routeCommand({ manifest, request: pair, nodes: [onlineNode] })).code, 'DATA_NOT_PROMOTED');
  assert.equal((await routeCommand({ manifest, request: { ...pair, promotionRef: 'promotion-1', targetId: 'target-1' }, nodes: [onlineNode], verifier: syntheticVerifier })).ok, true);
  assert.equal(refusalOf(await routeCommand({ manifest, request: { command: 'DEX//FIXTURE_WITNESS_EXPORT', nodeId: 'node-a' }, nodes: [onlineNode] })).code, 'DATA_NOT_PROMOTED');
});

test('a mapping cannot route a command to an operation REACH does not catalogue', async () => {
  const refusal = refusalOf(await routeCommand({ manifest: loadFixture(), request: { command: 'DEX//FIXTURE_NOT_CATALOGUED', nodeId: 'node-a' }, nodes: [onlineNode] }));
  assert.equal(refusal.code, 'OPERATION_NOT_IN_CATALOGUE');
});

// --- Modifiers: DEX ADR-0013 section 5 and the monotonicity law --------------------------------------

test('only plus-prefixed DEX modifiers that the command supports are accepted, once each', async () => {
  const manifest = loadFixture();
  assert.equal(DEX_MODIFIERS.length, 10);
  for (const modifiers of [['DRY'], ['+dry'], ['+GO'], ['+MOBILE'], ['+FAST', '+FAST']]) {
    const refusal = refusalOf(await routeCommand({ manifest, request: { command: STATUS, nodeId: 'node-a', modifiers }, nodes: [onlineNode] }));
    assert.equal(refusal.code, 'MODIFIER_UNKNOWN', JSON.stringify(modifiers));
  }
  const ok = await routeCommand({ manifest, request: { command: STATUS, nodeId: 'node-a', modifiers: ['+LOG', '+PROVE', '+FAST'] }, nodes: [onlineNode] });
  assert.equal(ok.ok, true);
  if (ok.ok) assert.deepEqual(ok.effective.modifiers, ['+LOG', '+PROVE', '+FAST']);
});

test('+DRY on a read narrows the mutation level to NONE and still reads', async () => {
  const decision = await routeCommand({ manifest: loadFixture(), request: { command: STATUS, nodeId: 'node-a', modifiers: ['+DRY'] }, nodes: [onlineNode] });
  assert.equal(decision.ok, true);
  if (!decision.ok) return;
  assert.equal(decision.effective.dryRun, true);
  assert.equal(decision.effective.previewOnly, true);
  assert.equal(decision.effective.effectiveMutationLevel, 'NONE');
  assert.equal(decision.reachOperation, 'dex.trustReport');
});

test('+DRY on a mutating command is a preview: DEX narrows it to NONE, and REACH dispatches nothing', async () => {
  // This is the DEX ADR-0013 semantic. REACH previously refused it; DEX owns command semantics.
  const manifest = loadFixture();
  const mutating = await routeCommand({ manifest, request: { command: 'DEX//FIXTURE_REMIX_APPLY', nodeId: 'node-a', modifiers: ['+DRY'] }, nodes: [onlineNode] });
  assert.equal(mutating.ok, true);
  if (mutating.ok) {
    assert.equal(mutating.reachOperation, null, 'no operation may be dispatched');
    assert.equal(mutating.previewOf, 'dex.file.write');
    assert.equal(mutating.effective.effectiveMutationLevel, 'NONE');
    assert.equal(mutating.effective.previewOnly, true);
    assert.equal(mutating.command.mutationLevel, 'STAGED', 'the command itself is unchanged');
  }
  for (const command of ['DEX//FIXTURE_COMMIT_PLAN', 'DEX//FIXTURE_MAINT_WIPE']) {
    const decision = await routeCommand({ manifest, request: { command, nodeId: 'node-a', modifiers: ['+DRY'] }, nodes: [onlineNode] });
    assert.equal(decision.ok, true, command);
    if (decision.ok) {
      assert.equal(decision.reachOperation, null, command);
      assert.notEqual(decision.previewOf, null, command);
    }
  }
  // Without +DRY the same command dispatches its operation.
  const live = await routeCommand({ manifest, request: { command: 'DEX//FIXTURE_REMIX_APPLY', nodeId: 'node-a' }, nodes: [onlineNode] });
  assert.equal(live.ok && live.reachOperation, 'dex.file.write');
});

test('+DRY still meets every gate and still needs an exact node', async () => {
  const manifest = loadFixture();
  assert.equal(refusalOf(await routeCommand({ manifest, request: { command: 'DEX//FIXTURE_PAIR_READ', nodeId: 'node-a', modifiers: ['+DRY'] }, nodes: [onlineNode] })).code, 'DATA_NOT_PROMOTED');
  assert.equal(refusalOf(await routeCommand({ manifest, request: { command: 'DEX//FIXTURE_REMIX_APPLY', modifiers: ['+DRY'] }, nodes: [onlineNode] })).code, 'NODE_ID_REQUIRED');
  assert.equal(refusalOf(await routeCommand({ manifest, request: { command: 'DEX//FIXTURE_REMIX_APPLY', nodeId: 'node-z', modifiers: ['+DRY'] }, nodes: [onlineNode] })).code, 'NODE_NOT_FOUND');
});

test('+SHIP grants no authority: the plan records none, asks for confirmation, and still meets every gate', async () => {
  const manifest = loadFixture();
  const shipped = await routeCommand({ manifest, request: { command: STATUS, nodeId: 'node-a', modifiers: ['+SHIP'] }, nodes: [onlineNode] });
  assert.equal(shipped.ok, true);
  if (shipped.ok) {
    assert.equal(shipped.effective.authorityFromModifiers, false);
    assert.equal(shipped.effective.requiresHumanConfirmation, true);
  }
  assert.equal(refusalOf(await routeCommand({ manifest, request: { command: 'DEX//FIXTURE_DROPZONE_INGEST', nodeId: 'node-a', modifiers: ['+SHIP'] }, nodes: [onlineNode] })).code, 'INPUT_NOT_ACCEPTED');
});

test('commands DEX marks COMMIT or DESTRUCTIVE require human confirmation whatever the modifiers', async () => {
  const manifest = loadFixture();
  for (const command of ['DEX//FIXTURE_COMMIT_PLAN', 'DEX//FIXTURE_MAINT_WIPE']) {
    const decision = await routeCommand({ manifest, request: { command, nodeId: 'node-a' }, nodes: [onlineNode] });
    assert.equal(decision.ok && decision.effective.requiresHumanConfirmation, true, command);
  }
  const read = await routeCommand({ manifest, request: { command: STATUS, nodeId: 'node-a' }, nodes: [onlineNode] });
  assert.equal(read.ok && read.effective.requiresHumanConfirmation, false);
});

test('+FAST cannot skip a gate: promotion, acceptance and exact node are still required', async () => {
  const manifest = loadFixture();
  assert.equal(refusalOf(await routeCommand({ manifest, request: { command: 'DEX//FIXTURE_PAIR_READ', nodeId: 'node-a', modifiers: ['+FAST'] }, nodes: [onlineNode] })).code, 'DATA_NOT_PROMOTED');
  assert.equal(refusalOf(await routeCommand({ manifest, request: { command: 'DEX//FIXTURE_DROPZONE_INGEST', nodeId: 'node-a', modifiers: ['+FAST'] }, nodes: [onlineNode] })).code, 'INPUT_NOT_ACCEPTED');
  assert.equal(refusalOf(await routeCommand({ manifest, request: { command: STATUS, modifiers: ['+FAST'] }, nodes: [onlineNode] })).code, 'NODE_ID_REQUIRED');
  const fast = await routeCommand({ manifest, request: { command: STATUS, nodeId: 'node-a', modifiers: ['+FAST'] }, nodes: [onlineNode] });
  assert.equal(fast.ok && fast.effective.gatesSkipped, false);
});

test('requirement-adding modifiers never change the node, the operation or the authority', async () => {
  const manifest = loadFixture();
  const plain = await routeCommand({ manifest, request: { command: 'DEX//FIXTURE_REACH_PROBE', nodeId: 'node-a' }, nodes: [onlineNode] });
  for (const modifier of ['+LOG', '+PROVE', '+AWE', '+PERF', '+DEEP', '+NO-REGRESS', '+MOBILE']) {
    const decision = await routeCommand({ manifest, request: { command: 'DEX//FIXTURE_REACH_PROBE', nodeId: 'node-a', modifiers: [modifier] }, nodes: [onlineNode] });
    assert.equal(decision.ok, true, modifier);
    if (decision.ok && plain.ok) {
      assert.equal(decision.nodeId, plain.nodeId);
      assert.equal(decision.reachOperation, plain.reachOperation);
      assert.equal(decision.effective.authorityFromModifiers, false);
      assert.equal(decision.effective.effectiveMutationLevel, plain.effective.effectiveMutationLevel);
    }
  }
});

// --- Refusal list -----------------------------------------------------------------------------------

test('the refusal list is closed, and every code the router can emit is in it', () => {
  assert.equal(ROUTER_REFUSAL_CODES.length, 22);
  assert.equal(new Set(ROUTER_REFUSAL_CODES).size, ROUTER_REFUSAL_CODES.length);
  for (const code of ['REACH_MAPPING_ABSENT', 'SYNTHETIC_MANIFEST_IN_PRODUCTION', 'MODIFIER_UNKNOWN', 'MODIFIER_MUTATION_FORBIDDEN', 'REFERENCE_VERIFIER_UNAVAILABLE', 'REFERENCE_NOT_FOUND', 'REFERENCE_WRONG_BINDING', 'REFERENCE_REVOKED_OR_INAPPLICABLE']) {
    assert.ok((ROUTER_REFUSAL_CODES as readonly string[]).includes(code), code);
  }
});

// --- Handoffs: DEX descriptor v1.0.0 validated by the receiver ---------------------------------------

const remixReceiver: HandoffReceiver = { productId: 'remix', acceptedContracts: ['dex.artifact.handoff@1.0.0'] };
const validHandoff = {
  sourceProduct: 'session',
  sourceObjectKind: 'room',
  targetProduct: 'remix',
  targetObjectKind: 'artifact',
  contractSchema: 'dex.artifact.handoff',
  contractVersion: '1.0.0',
  availability: 'AVAILABLE',
  reason: 'Synthetic handoff for tests.'
};

test('the receiver accepts a well-formed descriptor for a contract it has declared', async () => {
  const result = await validateHandoff(validHandoff, remixReceiver);
  assert.equal(result.ok, true);
});

test('the receiver refuses a contract or version it does not list, and a receiver that lists none', async () => {
  assert.equal(refusalOf(await validateHandoff({ ...validHandoff, contractVersion: '1.1.0' }, remixReceiver)).code, 'HANDOFF_INVALID');
  assert.equal(refusalOf(await validateHandoff({ ...validHandoff, contractSchema: 'dex.other' }, remixReceiver)).code, 'HANDOFF_INVALID');
  assert.equal(refusalOf(await validateHandoff(validHandoff, { productId: 'remix' })).code, 'HANDOFF_INVALID');
  assert.equal(refusalOf(await validateHandoff(validHandoff, { productId: 'remix', acceptedContracts: [] })).code, 'HANDOFF_INVALID');
});

test('the receiver refuses a descriptor aimed at another product or marked unavailable', async () => {
  assert.equal(refusalOf(await validateHandoff(validHandoff, { productId: 'museum', acceptedContracts: ['dex.artifact.handoff@1.0.0'] })).code, 'HANDOFF_INVALID');
  assert.equal(refusalOf(await validateHandoff({ ...validHandoff, availability: 'UNAVAILABLE' }, remixReceiver)).code, 'HANDOFF_INVALID');
});

test('forged authorization, promotion, acceptance and receiver claims cannot ride on a handoff', async () => {
  for (const forged of [{ authorized: true }, { promoted: true }, { accepted: true }, { promotionRef: 'promotion-1' }, { acceptanceRef: 'accepted-input-1' }, { acceptedContracts: ['dex.artifact.handoff@1.0.0'] }, { receiverAuthorized: true }]) {
    assert.equal(refusalOf(await validateHandoff({ ...validHandoff, ...forged }, remixReceiver)).code, 'HANDOFF_INVALID', JSON.stringify(forged));
  }
  for (const bad of [{ sourceProduct: 'SESSION' }, { sourceProduct: 'nope' }, { contractVersion: '1.0' }, { availability: 'maybe' }, { reason: '' }]) {
    assert.equal(refusalOf(await validateHandoff({ ...validHandoff, ...bad }, remixReceiver)).code, 'HANDOFF_INVALID', JSON.stringify(bad));
  }
});

test('WITNESS-to-REMIX is forbidden in code, even when the receiver lists the contract and the references verify', async () => {
  const edge = { ...validHandoff, sourceProduct: 'witness', sourceObjectKind: 'case' };
  assert.equal(refusalOf(await validateHandoff(edge, remixReceiver, { promotionRef: 'promotion-1', acceptanceRef: 'accepted-input-1', targetId: 'target-1', verifier: syntheticVerifier })).code, 'WITNESS_REMIX_EDGE_FORBIDDEN');
});

test('PAIR content leaves PAIR only with a real, verified promotion', async () => {
  const fromPair = { ...validHandoff, sourceProduct: 'pair' };
  assert.equal(refusalOf(await validateHandoff(fromPair, remixReceiver)).code, 'DATA_NOT_PROMOTED');
  assert.equal(refusalOf(await validateHandoff(fromPair, remixReceiver, { promotionRef: 'promotion-1', targetId: 'target-1' })).code, 'REFERENCE_VERIFIER_UNAVAILABLE');
  assert.equal(refusalOf(await validateHandoff(fromPair, remixReceiver, { promotionRef: 'promotion-invented', targetId: 'target-1', verifier: syntheticVerifier })).code, 'REFERENCE_NOT_FOUND');
  assert.equal(refusalOf(await validateHandoff(fromPair, remixReceiver, { promotionRef: 'promotion-1', targetId: 'target-2', verifier: syntheticVerifier })).code, 'REFERENCE_WRONG_BINDING');
  assert.equal(refusalOf(await validateHandoff(fromPair, remixReceiver, { promotionRef: 'promotion-1', verifier: syntheticVerifier })).code, 'REFERENCE_WRONG_BINDING');
  const accepted = await validateHandoff(fromPair, remixReceiver, { promotionRef: 'promotion-1', targetId: 'target-1', verifier: syntheticVerifier });
  assert.equal(accepted.ok, true);
});

test('DROPZONE content is handed on only after it is accepted and the acceptance verifies', async () => {
  const fromDropzone = { ...validHandoff, sourceProduct: 'dropzone', sourceObjectKind: 'artifact' };
  assert.equal(refusalOf(await validateHandoff(fromDropzone, remixReceiver)).code, 'INPUT_NOT_ACCEPTED');
  assert.equal(refusalOf(await validateHandoff(fromDropzone, remixReceiver, { acceptanceRef: 'accepted-input-9', targetId: 'target-1', verifier: syntheticVerifier })).code, 'REFERENCE_NOT_FOUND');
  assert.equal((await validateHandoff(fromDropzone, remixReceiver, { acceptanceRef: 'accepted-input-1', targetId: 'target-1', verifier: syntheticVerifier })).ok, true);
});

// --- Projections --------------------------------------------------------------------------------------

test('search projections exclude unpromoted PRIVATE and SEALED items and are rebuildable only', () => {
  const sources = [
    { id: 'b-private', product: 'pair' as const, dataClass: 'PRIVATE' as const },
    { id: 'a-public', product: 'session' as const, dataClass: 'PUBLIC' as const },
    { id: 'c-sealed', product: 'witness' as const, dataClass: 'SEALED' as const },
    { id: 'd-private-promoted', product: 'pair' as const, dataClass: 'PRIVATE' as const }
  ];
  const projection = projectSearchEntries(sources, new Set(['d-private-promoted']));
  assert.equal(projection.rebuildable, true);
  assert.equal(projection.authoritative, false);
  assert.deepEqual(projection.entries.map(entry => entry.id), ['a-public', 'd-private-promoted']);
  assert.equal(projection.excludedUnpromoted, 2);

  // Deterministic: input order does not change the output, and the digest tracks the source.
  const reordered = projectSearchEntries([...sources].reverse(), new Set(['d-private-promoted']));
  assert.equal(reordered.sourceDigest, projection.sourceDigest);
  const changed = projectSearchEntries([...sources, { id: 'e-public', product: 'capsule', dataClass: 'PUBLIC' }], new Set(['d-private-promoted']));
  assert.notEqual(changed.sourceDigest, projection.sourceDigest);
});
