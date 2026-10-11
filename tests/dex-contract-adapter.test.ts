import test from 'node:test';
import assert from 'node:assert/strict';
import { loadCanonicalManifest, productForScope, DEX_MODIFIERS, DEX_SCOPES, DEX_PRODUCT_SCOPES, DEX_NON_PRODUCT_SCOPES, DEX_PRODUCT_IDS } from '../src/shared/dex-canonical-contract.js';
import { loadRoutableManifest, routeCommand } from '../src/shared/dex-command-router.js';
import { REACH_AUTHORITATIVE_MAPPINGS } from '../src/shared/dex-reach-mappings.js';
import { canonicalRaw, cloneCanonical, cloneMappings, loadFixture, node, refusalOf } from './dex-router-fixtures.js';

// The REACH-side versioned adapter over the canonical DEX command manifest (DEX ADR-0013, manifest 1.0.0).
// Most manifests here are SYNTHETIC but have the real DexCommandManifestEntry shape; the last tests load the
// owner-approved snapshot of the real DEX roster. Behavioural proof of REACH logic uses the synthetic ones.

const load = (canonical: unknown) => loadCanonicalManifest(canonical);
const refusal = (canonical: unknown) => refusalOf(load(canonical));
const patchEntry = (index: number, patch: Record<string, unknown>) => {
  const raw = cloneCanonical();
  raw.commands[index] = { ...raw.commands[index], ...patch };
  return raw;
};

test('the contract vocabulary is the one DEX ADR-0013 declares: ten plus-prefixed modifiers, twelve scopes, eight lowercase products', () => {
  assert.deepEqual([...DEX_MODIFIERS], ['+LOG', '+PROVE', '+AWE', '+PERF', '+DEEP', '+FAST', '+DRY', '+NO-REGRESS', '+MOBILE', '+SHIP']);
  assert.equal(DEX_SCOPES.length, 12);
  assert.equal(DEX_PRODUCT_SCOPES.length + DEX_NON_PRODUCT_SCOPES.length, 12);
  assert.deepEqual([...DEX_NON_PRODUCT_SCOPES], ['REACH', 'MAINT', 'CONTROL_ROOM', 'GLOBAL']);
  assert.deepEqual([...DEX_PRODUCT_IDS], ['session', 'capsule', 'museum', 'remix', 'sidequest', 'dropzone', 'pair', 'witness']);
});

test('scopes map to products only for the eight product scopes; control-plane scopes are never products', () => {
  for (const scope of DEX_PRODUCT_SCOPES) assert.equal(productForScope(scope), scope.toLowerCase());
  for (const scope of DEX_NON_PRODUCT_SCOPES) assert.equal(productForScope(scope), null, scope);
});

test('a canonical manifest in the real entry shape loads, keeps DEX order, and preserves every field as data', () => {
  const result = load(canonicalRaw);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.manifest.synthetic, true);
  assert.equal(result.manifest.manifestVersion, '1.0.0');
  assert.equal(result.manifest.commands.size, canonicalRaw.commands.length);
  assert.deepEqual([...result.manifest.commands.keys()], canonicalRaw.commands.map((c: { canonical: string }) => c.canonical));
  const status = result.manifest.commands.get('DEX//FIXTURE_SESSION_STATUS')!;
  assert.equal(status.slash, '/fixture_session_status');
  assert.equal(status.scope, 'SESSION');
  assert.equal(status.trustDomain, 'product');
  assert.equal(status.workflowId, 'workflow_fixture_session_status_v1');
});

test('all fifty identities of a fifty-command manifest are preserved, and with no mapping none is routable', async () => {
  const commands = Array.from({ length: 50 }, (_, i) => {
    const name = `FIXTURE_CMD_${String(i + 1).padStart(2, '0')}`;
    return {
      name, canonical: `DEX//${name}`, slash: `/${name.toLowerCase()}`, aliases: [`synthetic alias ${i}`], commandClass: 'WORKFLOW',
      scope: DEX_SCOPES[i % DEX_SCOPES.length], mutationLevel: ['NONE', 'STAGED', 'COMMIT', 'DESTRUCTIVE'][i % 4], objectKinds: ['task'],
      supportedModifiers: [...DEX_MODIFIERS], workflowId: `workflow_${name.toLowerCase()}_v1`, outputs: ['structured-result'],
      skillBinding: null, effect: 'Synthetic.', appCommand: null, trustDomain: 'control'
    };
  });
  const raw = { manifestVersion: '1.0.0', synthetic: true, commands };
  const empty = { schema: 'reach.dex-command-mappings', version: '1.0.0', synthetic: true, mappings: [] };
  const result = loadRoutableManifest({ canonical: raw, mappings: empty });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.manifest.canonicalCount, 50);
  assert.equal(result.manifest.commands.size, 0);
  assert.equal(result.manifest.unroutable.size, 50);
  for (const command of commands) {
    const decision = refusalOf(await routeCommand({ manifest: result.manifest, request: { command: command.canonical, nodeId: 'node-a' }, nodes: [node({ nodeId: 'node-a' })] }));
    assert.equal(decision.code, 'REACH_MAPPING_ABSENT', command.canonical);
  }
  // Every scope occurs, including the four that are not products.
  assert.deepEqual(new Set(commands.map(c => c.scope)), new Set(DEX_SCOPES));
});

test('the shipped authoritative mapping table is empty, so no DEX command is routable until a decision grants one', async () => {
  assert.equal(REACH_AUTHORITATIVE_MAPPINGS.mappings.length, 0);
  // Production loading of a non-synthetic manifest with the shipped table succeeds and routes nothing.
  const real: Record<string, any> = { ...cloneCanonical(), synthetic: false };
  const result = loadRoutableManifest({ canonical: real, mappings: REACH_AUTHORITATIVE_MAPPINGS, production: true });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.manifest.commands.size, 0);
  assert.equal(result.manifest.unroutable.size, real.commands.length);
  assert.equal(refusalOf(await routeCommand({ manifest: result.manifest, request: { command: 'DEX//FIXTURE_SESSION_STATUS', nodeId: 'node-a' }, nodes: [node({ nodeId: 'node-a' })] })).code, 'REACH_MAPPING_ABSENT');
});

test('a command is never made routable by its name, scope, workflow id or app command', async () => {
  const raw = cloneCanonical();
  raw.commands.push({
    ...raw.commands[0], name: 'FIXTURE_REACH_SCOPE_UNMAPPED', canonical: 'DEX//FIXTURE_REACH_SCOPE_UNMAPPED', slash: '/fixture_reach_scope_unmapped',
    scope: 'REACH', trustDomain: 'remote-control', workflowId: 'dex.fingerprint', appCommand: 'dex.file.write && curl http://invalid.example'
  });
  const manifest = loadFixture(raw);
  assert.equal(manifest.commands.has('DEX//FIXTURE_REACH_SCOPE_UNMAPPED'), false);
  assert.equal(manifest.unroutable.get('DEX//FIXTURE_REACH_SCOPE_UNMAPPED')?.reason, 'NO_AUTHORITATIVE_REACH_MAPPING');
  assert.equal(refusalOf(await routeCommand({ manifest, request: { command: 'DEX//FIXTURE_REACH_SCOPE_UNMAPPED', nodeId: 'node-a' }, nodes: [node({ nodeId: 'node-a' })] })).code, 'REACH_MAPPING_ABSENT');
});

test('descriptive DEX fields are inert: a mapped plan never carries appCommand, aliases or workflow text', async () => {
  const raw = cloneCanonical();
  Object.assign(raw.commands[0], { appCommand: 'pnpm dev:session && echo owned', aliases: ['synthetic alias'], workflowId: 'workflow_owned_v1', effect: 'owned' });
  const decision = await routeCommand({ manifest: loadFixture(raw), request: { command: 'DEX//FIXTURE_SESSION_STATUS', nodeId: 'node-a' }, nodes: [node({ nodeId: 'node-a' })] });
  assert.equal(decision.ok, true);
  const serialized = JSON.stringify(decision);
  for (const text of ['pnpm', 'owned', 'synthetic alias', 'workflow_']) assert.ok(!serialized.includes(text), text);
});

test('a different contract major is refused before any field validation, identically each time', () => {
  const future = { ...cloneCanonical(), manifestVersion: '2.0.0', newTopLevelField: true };
  const first = refusal(future);
  assert.equal(first.code, 'DEX_CONTRACT_MAJOR_MISMATCH');
  assert.deepEqual(first.details, { expectedMajor: 1, actualVersion: '2.0.0' });
  assert.deepEqual(refusal(future), first);
  assert.equal(refusal({ ...cloneCanonical(), manifestVersion: '0.9.0' }).code, 'DEX_CONTRACT_MAJOR_MISMATCH');
});

test('the loader fails closed on malformed manifests and entries, including unknown fields', () => {
  const dropped = (key: string) => {
    const raw = cloneCanonical();
    delete raw.commands[0][key];
    return raw;
  };
  const cases: Array<[string, unknown]> = [
    ['not an object', []],
    ['non-semver version', { ...cloneCanonical(), manifestVersion: 'one' }],
    ['missing version', (() => { const raw = cloneCanonical(); delete raw.manifestVersion; return raw; })()],
    ['unknown top-level field', { ...cloneCanonical(), extra: 1 }],
    ['commands not an array', { ...cloneCanonical(), commands: {} }],
    ['no commands', { ...cloneCanonical(), commands: [] }],
    ['synthetic not boolean', { ...cloneCanonical(), synthetic: 'yes' }],
    ['entry not an object', patchEntryRaw('not-an-object')],
    ['unknown entry field', patchEntry(0, { executable: '/bin/sh' })],
    ['REACH-consumer field smuggled into a DEX entry', patchEntry(0, { reachOperation: 'dex.file.write' })],
    ['REACH-consumer field invokesReach', patchEntry(0, { invokesReach: true })],
    ['lowercase name', patchEntry(0, { name: 'fixture_x', canonical: 'DEX//fixture_x', slash: '/fixture_x' })],
    ['canonical does not match name', patchEntry(0, { canonical: 'DEX//SOMETHING_ELSE' })],
    ['canonical prefix is not DEX//', patchEntry(0, { canonical: 'FIXTURE//FIXTURE_SESSION_STATUS' })],
    ['slash does not match name', patchEntry(0, { slash: '/Fixture_Session_Status' })],
    ['unknown command class', patchEntry(0, { commandClass: 'RUN' })],
    ['unknown scope', patchEntry(0, { scope: 'EVERYWHERE' })],
    ['product id used as a scope', patchEntry(0, { scope: 'session' })],
    ['unknown mutation level', patchEntry(0, { mutationLevel: 'MAYBE' })],
    ['unknown object kind', patchEntry(0, { objectKinds: ['planet'] })],
    ['unknown trust domain', patchEntry(0, { trustDomain: 'open' })],
    ['empty workflow id', patchEntry(0, { workflowId: '' })],
    ['non-string output', patchEntry(0, { outputs: [1] })],
    ['aliases not an array', patchEntry(0, { aliases: 'verify' })],
    ['skillBinding not string-or-null', patchEntry(0, { skillBinding: 3 })],
    ['appCommand not string-or-null', patchEntry(0, { appCommand: ['pnpm'] })]
  ];
  for (const key of ['name', 'canonical', 'slash', 'aliases', 'commandClass', 'scope', 'mutationLevel', 'objectKinds', 'supportedModifiers', 'workflowId', 'outputs', 'skillBinding', 'effect', 'appCommand', 'trustDomain']) {
    cases.push([`missing ${key}`, dropped(key)]);
  }
  for (const [label, raw] of cases) {
    assert.equal(refusal(raw).code, 'MANIFEST_INVALID', label);
  }
  const duplicate = cloneCanonical();
  duplicate.commands.push(structuredClone(duplicate.commands[0]));
  assert.equal(refusal(duplicate).code, 'MANIFEST_INVALID', 'duplicate command');
});

function patchEntryRaw(entry: unknown): Record<string, any> {
  const raw = cloneCanonical();
  raw.commands[0] = entry;
  return raw;
}

test('modifiers must be DEX modifiers in plus-prefixed form, unique, with no widening modifier invented', () => {
  for (const supportedModifiers of [['DRY'], ['+dry'], ['+FORCE-WRITE'], ['+DRY', '+DRY'], ['+GO'], 'all']) {
    assert.equal(refusal(patchEntry(0, { supportedModifiers })).code, 'MANIFEST_INVALID', JSON.stringify(supportedModifiers));
  }
  assert.equal(load(patchEntry(0, { supportedModifiers: [...DEX_MODIFIERS] })).ok, true);
});

test('synthetic manifests and mapping tables are refused as production configuration', () => {
  assert.equal(refusalOf(loadCanonicalManifest(canonicalRaw, { production: true })).code, 'SYNTHETIC_MANIFEST_IN_PRODUCTION');
  assert.equal(refusalOf(loadRoutableManifest({ canonical: canonicalRaw, mappings: cloneMappings(), production: true })).code, 'SYNTHETIC_MANIFEST_IN_PRODUCTION');
  const nonSyntheticManifest = { ...cloneCanonical(), synthetic: false };
  assert.equal(refusalOf(loadRoutableManifest({ canonical: nonSyntheticManifest, mappings: cloneMappings(), production: true })).code, 'SYNTHETIC_MANIFEST_IN_PRODUCTION');
  assert.equal(loadRoutableManifest({ canonical: canonicalRaw, mappings: cloneMappings() }).ok, true);
});

test('the synthetic mapping table binds: mapped commands are routable, the rest are listed as unroutable', () => {
  const manifest = loadFixture();
  assert.equal(manifest.canonicalCount, canonicalRaw.commands.length);
  assert.equal(manifest.commands.size + manifest.unroutable.size, manifest.canonicalCount);
  assert.deepEqual([...manifest.unroutable.keys()], ['DEX//FIXTURE_UNMAPPED']);
  // Modifier support comes from DEX alone: the mapping cannot add or remove one.
  assert.deepEqual(manifest.commands.get('DEX//FIXTURE_DROPZONE_INGEST')?.modifiers, ['+SHIP', '+FAST']);
  assert.equal(manifest.commands.get('DEX//FIXTURE_REACH_PROBE')?.product, null);
});

test('the mapping table fails closed: it cannot invent a command, a grant, a downgrade or an unsafe pairing', () => {
  const withMapping = (index: number, patch: Record<string, unknown>) => {
    const table = cloneMappings();
    table.mappings[index] = { ...table.mappings[index], ...patch };
    return table;
  };
  const indexOf = (command: string) => cloneMappings().mappings.findIndex((m: { command: string }) => m.command === command);
  const status = indexOf('DEX//FIXTURE_SESSION_STATUS');
  const dropzone = indexOf('DEX//FIXTURE_DROPZONE_INGEST');
  const pair = indexOf('DEX//FIXTURE_PAIR_READ');
  const probe = indexOf('DEX//FIXTURE_REACH_PROBE');
  const wipe = indexOf('DEX//FIXTURE_MAINT_WIPE');
  const duplicate = cloneMappings();
  duplicate.mappings.push(structuredClone(duplicate.mappings[0]));
  const missingTop = cloneMappings();
  delete missingTop.mappings;

  const cases: Array<[string, unknown]> = [
    ['table not an object', []],
    ['wrong schema', { ...cloneMappings(), schema: 'other' }],
    ['non-semver version', { ...cloneMappings(), version: 'one' }],
    ['future mapping major', { ...cloneMappings(), version: '2.0.0' }],
    ['unknown table field', { ...cloneMappings(), grants: ['everything'] }],
    ['missing mappings', missingTop],
    ['phantom command DEX does not declare', withMapping(status, { command: 'DEX//NOT_IN_THE_MANIFEST' })],
    ['duplicate mapping', duplicate],
    ['unknown mapping field', withMapping(status, { shell: 'sh -c x' })],
    ['no stated authority', withMapping(status, { authority: '' })],
    ['invokesReach not declared', withMapping(status, { invokesReach: 'yes' })],
    ['invokesReach without an operation', withMapping(status, { reachOperation: '' })],
    ['REACH-free command carrying an operation', withMapping(indexOf('DEX//FIXTURE_LOCAL_HELP'), { reachOperation: 'dex.trustReport' })],
    ['invented safety class', withMapping(status, { safetyClass: 'MAYBE_SAFE' })],
    ['unknown data class', withMapping(status, { dataClass: 'TOP_SECRET' })],
    ['unknown input origin', withMapping(status, { inputOrigin: 'anyone' })],
    ['uppercase product id', withMapping(status, { product: 'SESSION' })],
    ['product that disagrees with DEX scope', withMapping(status, { product: 'pair' })],
    ['product named for a control-plane scope', withMapping(probe, { product: 'session' })],
    ['mapped operation riskier than the DEX mutation level', withMapping(status, { reachOperation: 'dex.file.write', safetyClass: 'SIDE_EFFECTING_IDEMPOTENT' })],
    ['unknown-effect operation under a non-destructive command', withMapping(indexOf('DEX//FIXTURE_COMMIT_PLAN'), { reachOperation: 'dex.process.run', safetyClass: 'PROCESS_UNKNOWN_EFFECT' })],
    ['safety class that contradicts the catalogue', withMapping(dropzone, { safetyClass: 'PURE_READ_IDEMPOTENT' })],
    ['DROPZONE command with owner input', withMapping(dropzone, { inputOrigin: 'owner' })],
    ['PAIR command declared public', withMapping(pair, { dataClass: 'PUBLIC' })]
  ];
  for (const [label, table] of cases) {
    assert.equal(refusalOf(loadRoutableManifest({ canonical: canonicalRaw, mappings: table })).code, 'MANIFEST_INVALID', label);
  }
  // The one sanctioned pairing for an unknown-effect operation is a command DEX itself marks DESTRUCTIVE.
  assert.equal(cloneMappings().mappings[wipe].safetyClass, 'PROCESS_UNKNOWN_EFFECT');
  assert.equal(loadRoutableManifest({ canonical: canonicalRaw, mappings: cloneMappings() }).ok, true);
});

// --- The real DEX roster (owner-approved snapshot; identity and classification only) -----------------------
// tests/fixtures/dex-router/dex-roster-snapshot-v1.json is generated from DEX 57693daa by
// `npm run conformance:dex -- --dex-checkout <path> --write-snapshot`. See its .provenance.json.

const rosterRaw = JSON.parse(await (await import('node:fs/promises')).readFile(new URL('./fixtures/dex-router/dex-roster-snapshot-v1.json', import.meta.url), 'utf8')) as { manifestVersion: string; commands: Array<Record<string, any>> };

test('the real 50-command DEX roster loads under the production gate with every identity preserved', () => {
  const result = loadCanonicalManifest(rosterRaw, { production: true });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.manifest.synthetic, false);
  assert.equal(result.manifest.commands.size, 50);
  assert.ok(result.manifest.commands.has('DEX//NEXT'));
  assert.deepEqual([...result.manifest.commands.keys()], rosterRaw.commands.map(c => c.canonical));
  for (const command of result.manifest.commands.values()) {
    assert.equal(command.canonical, `DEX//${command.name}`);
    assert.equal(command.slash, `/${command.name.toLowerCase()}`);
    // Descriptive DEX prose and commands are not stored in this repository.
    assert.deepEqual(command.aliases, []);
    assert.equal(command.effect, '');
    assert.equal(command.appCommand, null);
  }
});

test('the real roster uses all ten modifiers and all twelve scopes, and scope decides product only for the eight product scopes', () => {
  const result = loadCanonicalManifest(rosterRaw);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const commands = [...result.manifest.commands.values()];
  assert.deepEqual(new Set(commands.flatMap(c => c.supportedModifiers)), new Set(DEX_MODIFIERS));
  assert.deepEqual(new Set(commands.map(c => c.scope)), new Set(DEX_SCOPES));
  for (const command of commands) {
    const product = productForScope(command.scope);
    assert.equal(product === null, (DEX_NON_PRODUCT_SCOPES as readonly string[]).includes(command.scope), command.canonical);
  }
});

test('with the shipped (empty) mapping table, every command of the real roster is unroutable and refused by name', async () => {
  const result = loadRoutableManifest({ canonical: rosterRaw, mappings: REACH_AUTHORITATIVE_MAPPINGS, production: true });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.manifest.canonicalCount, 50);
  assert.equal(result.manifest.commands.size, 0);
  assert.equal(result.manifest.unroutable.size, 50);
  for (const command of rosterRaw.commands) {
    const decision = refusalOf(await routeCommand({
      manifest: result.manifest,
      request: { command: command.canonical, nodeId: 'node-a', modifiers: ['+DRY'] },
      nodes: [node({ nodeId: 'node-a' })]
    }));
    assert.equal(decision.code, 'REACH_MAPPING_ABSENT', command.canonical);
  }
  // Slash forms, aliases and prose are DEX's parser's job; REACH never resolves them.
  for (const command of ['/next', 'next', 'dex//next', 'use reach']) {
    assert.equal(refusalOf(await routeCommand({ manifest: result.manifest, request: { command }, nodes: [] })).code, 'UNKNOWN_COMMAND', command);
  }
});

test('a mapping cannot be attached to a real command without stating its authority and fitting its DEX scope and mutation level', () => {
  const next = rosterRaw.commands.find(c => c.canonical === 'DEX//NEXT')!;
  assert.equal(next.scope, 'GLOBAL');
  assert.equal(next.mutationLevel, 'NONE');
  const mapping = (patch: Record<string, unknown>) => ({
    schema: 'reach.dex-command-mappings', version: '1.0.0',
    mappings: [{ command: 'DEX//NEXT', authority: 'test only', invokesReach: true, reachOperation: 'dex.trustReport', product: null, safetyClass: 'PURE_READ_IDEMPOTENT', dataClass: 'PUBLIC', inputOrigin: 'owner', ...patch }]
  });
  assert.equal(loadRoutableManifest({ canonical: rosterRaw, mappings: mapping({}) }).ok, true);
  assert.equal(refusalOf(loadRoutableManifest({ canonical: rosterRaw, mappings: mapping({ product: 'session' }) })).code, 'MANIFEST_INVALID', 'GLOBAL is not a product');
  assert.equal(refusalOf(loadRoutableManifest({ canonical: rosterRaw, mappings: mapping({ authority: '' }) })).code, 'MANIFEST_INVALID');
  assert.equal(refusalOf(loadRoutableManifest({ canonical: rosterRaw, mappings: mapping({ reachOperation: 'dex.file.write', safetyClass: 'SIDE_EFFECTING_IDEMPOTENT' }) })).code, 'MANIFEST_INVALID', 'NONE allows only pure reads');
});

test('the roster snapshot carries its provenance and is not mistaken for a newer contract', async () => {
  const provenance = JSON.parse(await (await import('node:fs/promises')).readFile(new URL('./fixtures/dex-router/dex-roster-snapshot-v1.provenance.json', import.meta.url), 'utf8'));
  assert.equal(provenance.repository, 'westkitty/DEX');
  assert.match(provenance.commit, /^[0-9a-f]{40}$/);
  assert.match(provenance.fileSha256, /^[0-9a-f]{64}$/);
  assert.equal(provenance.commandCount, 50);
  assert.equal(provenance.manifestVersion, rosterRaw.manifestVersion);
  assert.equal(refusalOf(loadCanonicalManifest({ ...rosterRaw, manifestVersion: '2.0.0' })).code, 'DEX_CONTRACT_MAJOR_MISMATCH');
});
