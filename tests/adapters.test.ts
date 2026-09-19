import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AdapterInstallRefused,
  AdapterRegistry,
  admitAdapterManifest,
  decodeAdapterManifest,
  decodeAdapterToolDeclaration,
  remoteAdapterToolRefusal,
  type AdapterManifest
} from '../src/shared/adapter-contract.js';
import { DESKTOP_COMMANDER_MANIFEST_DATA } from '../src/node/adapters/desktop-commander.manifest.js';
import { COMPATIBILITY_TOOLS, describeCompatibilityTool, remoteCompatibilityTools } from '../src/shared/operations.js';
import { REACH_CAPABILITIES, requiredCapabilities } from '../src/shared/capabilities.js';
import { authorizeOperation, type AccessState } from '../src/shared/access.js';
import { workspaceSafeToolRefusal } from '../src/shared/profiles.js';
import { toolGuard } from '../src/shared/security.js';
import type { RequestActor } from '../src/shared/protocol.js';

/**
 * The capability adapter contract. An adapter declares; DEX decides. Every test here attacks the
 * boundary from the adapter's side: a manifest that lies, omits, or over-claims must be refused
 * rather than repaired, and nothing a manifest says may widen what DEX already enforces.
 */

const shipped = decodeAdapterManifest(DESKTOP_COMMANDER_MANIFEST_DATA);

function manifestOrThrow(): AdapterManifest {
  assert.ok(shipped, 'the shipped Desktop Commander manifest must decode');
  return shipped;
}

function withTool(manifest: AdapterManifest, tool: string, patch: Record<string, unknown>): unknown {
  return {
    ...manifest,
    tools: manifest.tools.map(entry => (entry.tool === tool ? { ...entry, ...patch } : entry))
  };
}

const claude: RequestActor = { kind: 'claude', clientId: 'c1', clientName: 'Claude' };

function stateWithGrant(capabilities: string[], roots: string[]): AccessState {
  return {
    version: 3, revision: 1, mode: 'on', until: null, revertTo: null,
    clients: {}, grantRequired: { claude: true },
    grants: [{
      id: 'g1', client: 'claude', capabilities: capabilities as never, roots,
      until: new Date(Date.now() + 3_600_000).toISOString(), maxUses: null, uses: 0,
      createdAt: new Date().toISOString()
    }],
    updatedAt: new Date().toISOString()
  };
}

test('the shipped manifest is admitted and agrees with the DEX catalog on every tool', () => {
  const admission = admitAdapterManifest(manifestOrThrow());
  assert.deepEqual(admission.refusals, [], 'the shipped manifest must not disagree with DEX');
  assert.equal(admission.admitted.length, COMPATIBILITY_TOOLS.length);
});

test('an undeclared tool is refused rather than admitted on the adapter\'s word', () => {
  const manifest = manifestOrThrow();
  const withExtra = {
    ...manifest,
    tools: [...manifest.tools, {
      tool: 'exfiltrate_everything', capability: 'inspect', risk: 'inspect', mutation: false,
      network: false, pathArguments: [], workspaceSafeAllowed: true, supportsPlan: false,
      remoteBlocked: false, reversibility: 'none', checkpointStrategy: 'none'
    }]
  };
  const decoded = decodeAdapterManifest(withExtra);
  assert.ok(decoded, 'the declaration is structurally valid, so it must be caught by the catalog check');
  const admission = admitAdapterManifest(decoded);
  assert.ok(admission.refusals.some(line => line.includes('exfiltrate_everything') && line.includes('not classified by DEX')));
  assert.ok(!admission.admitted.some(entry => entry.tool === 'exfiltrate_everything'));
  assert.throws(() => new AdapterRegistry().install(decoded), AdapterInstallRefused);
});

test('an unknown risk class does not decode, so it can never reach the catalog check', () => {
  assert.equal(decodeAdapterToolDeclaration({
    tool: 'write_file', capability: 'file.write', risk: 'mostly-harmless', mutation: true,
    network: false, pathArguments: ['path'], workspaceSafeAllowed: true, supportsPlan: true,
    remoteBlocked: false, reversibility: 'checkpoint', checkpointStrategy: 'git-if-available'
  }), null);
  assert.equal(decodeAdapterManifest(withTool(manifestOrThrow(), 'write_file', { risk: 'mostly-harmless' })), null);
});

test('a missing capability is not defaulted; the whole manifest is refused', () => {
  const manifest = manifestOrThrow();
  const stripped = {
    ...manifest,
    tools: manifest.tools.map(entry => {
      if (entry.tool !== 'start_process') return entry;
      const { capability, ...rest } = entry;
      void capability;
      return rest;
    })
  };
  assert.equal(decodeAdapterManifest(stripped), null, 'an incomplete declaration must not be repaired with a default');
  assert.throws(() => new AdapterRegistry().installFrom(stripped), AdapterInstallRefused);
});

test('a manifest cannot quietly claim a narrower capability than DEX requires', () => {
  const understated = decodeAdapterManifest(withTool(manifestOrThrow(), 'start_process', { capability: 'inspect' }));
  assert.ok(understated);
  const admission = admitAdapterManifest(understated);
  assert.ok(admission.refusals.some(line =>
    line.includes('start_process') && line.includes('capability') && line.includes('process.shell')
  ));
});

test('an unsafe path declaration is refused; the adapter cannot hide a path-bearing argument', () => {
  // move_file moves from `source` to `destination`. A manifest that declares only `source` would
  // leave the destination outside whatever a path-aware check consults the declaration for.
  const hidden = decodeAdapterManifest(withTool(manifestOrThrow(), 'move_file', { pathArguments: ['source'] }));
  assert.ok(hidden);
  const admission = admitAdapterManifest(hidden);
  assert.ok(admission.refusals.some(line => line.includes('move_file') && line.includes('pathArguments')));

  // Nor can it invent one DEX does not know about.
  const invented = decodeAdapterManifest(withTool(manifestOrThrow(), 'write_file', { pathArguments: ['path', 'shadow_path'] }));
  assert.ok(invented);
  assert.ok(admitAdapterManifest(invented).refusals.some(line => line.includes('write_file') && line.includes('pathArguments')));
});

test('a network declaration mismatch is refused, and every network-capable tool is accounted for', () => {
  // read_file accepts `isUrl`, so it is network-capable whatever DEX does about it. A manifest that
  // denies that is refused.
  const denied = decodeAdapterManifest(withTool(manifestOrThrow(), 'read_file', { network: false }));
  assert.ok(denied);
  assert.ok(admitAdapterManifest(denied).refusals.some(line => line.includes('read_file') && line.includes('network')));

  // The declaration is load-bearing rather than decorative: a network-capable tool must either be
  // classified `network`, which the risk rules already constrain, or have its network argument
  // refused outright. Otherwise the node is an open fetch proxy behind a read-only-looking tool.
  for (const descriptor of COMPATIBILITY_TOOLS.filter(entry => entry.network)) {
    if (descriptor.risk === 'network') continue;
    assert.equal(descriptor.tool, 'read_file', 'a new network-capable tool needs its network path decided');
    const refusal = toolGuard('read_file', { path: '/tmp/x', isUrl: true }, 'full-local', ['/tmp']);
    assert.ok(refusal, 'read_file must not be usable as a URL fetch proxy');
    assert.match(String(refusal), /URL/i);
  }
});

test('workspace-safe refusal is the catalog\'s answer, not the manifest\'s claim', () => {
  // A manifest that marks a shell tool workspace-safe is refused outright.
  const overclaimed = decodeAdapterManifest(withTool(manifestOrThrow(), 'start_process', { workspaceSafeAllowed: true }));
  assert.ok(overclaimed);
  assert.ok(admitAdapterManifest(overclaimed).refusals.some(line =>
    line.includes('start_process') && line.includes('workspaceSafeAllowed')
  ));
  // And the enforced answer still comes from the catalog.
  assert.ok(workspaceSafeToolRefusal('workspace-safe', 'start_process'));
  assert.equal(workspaceSafeToolRefusal('workspace-safe', 'write_file'), null);
});

test('the plan wrapper inherits the tool\'s capability instead of laundering it', () => {
  // dc.call names `compat`, but the call it wraps does whatever the tool does. A grant holding only
  // `compat` used to authorize an adapter write; it must not.
  assert.deepEqual(requiredCapabilities('dc.call', { tool: 'write_file' }), ['compat', 'file.write']);
  assert.deepEqual(requiredCapabilities('dc.call', { tool: 'start_process' }), ['compat', 'process.shell']);
  assert.deepEqual(requiredCapabilities('dc.call', { tool: 'get_config' }), ['compat', 'inspect']);
  assert.deepEqual(requiredCapabilities('dex.file.write', { path: '/tmp/x' }), ['file.write']);

  const compatOnly = stateWithGrant(['compat'], ['/tmp']);
  const write = authorizeOperation(compatOnly, claude, 'dc.call', 'development', Date.now(), {
    tool: 'write_file', arguments: { path: '/tmp/x', content: 'x' }
  });
  assert.equal(write.allowed, false, 'a compat-only grant must not authorize an adapter write');

  const bothHeld = stateWithGrant(['compat', 'file.write'], ['/tmp']);
  const allowed = authorizeOperation(bothHeld, claude, 'dc.call', 'development', Date.now(), {
    tool: 'write_file', arguments: { path: '/tmp/x', content: 'x' }
  });
  assert.equal(allowed.allowed, true, 'holding both capabilities still works');

  // A call naming no tool, or one DEX does not classify, demands every capability and so matches
  // no grant at all.
  assert.equal(requiredCapabilities('dc.call', {}).length, REACH_CAPABILITIES.length);
  const unknown = authorizeOperation(bothHeld, claude, 'dc.call', 'development', Date.now(), { tool: 'not_a_tool' });
  assert.equal(unknown.allowed, false);
});

test('blocked compatibility tools stay blocked, and are absent rather than merely refused', () => {
  const registry = new AdapterRegistry();
  registry.install(manifestOrThrow());
  const surface = registry.remoteToolSurface();
  for (const blocked of ['set_config_value', 'get_recent_tool_calls', 'give_feedback_to_desktop_commander', 'get_prompts']) {
    assert.ok(!surface.includes(blocked), `${blocked} must not be in the remote surface`);
    assert.ok(describeCompatibilityTool(blocked), `${blocked} is still classified locally`);
    const refusal = remoteAdapterToolRefusal(registry, blocked);
    assert.ok(refusal);
    // Identical wording, up to the name, as a tool no adapter provides at all. A distinguishable
    // message would let a client enumerate which withheld tools exist.
    assert.equal(
      refusal.replace(blocked, 'NAME'),
      String(remoteAdapterToolRefusal(registry, 'no_such_tool_at_all')).replace('no_such_tool_at_all', 'NAME')
    );
  }
  assert.equal(remoteAdapterToolRefusal(registry, 'write_file'), null);
});

test('adapter identity evidence records what DEX observed and carries no arguments', () => {
  const registry = new AdapterRegistry();
  const manifest: AdapterManifest = { ...manifestOrThrow(), version: '0.2.50', sourceHash: 'a'.repeat(64) };
  registry.install(manifest);
  const evidence = registry.identityEvidence();
  assert.equal(evidence.length, 1);
  assert.equal(evidence[0]?.adapter, 'desktop-commander');
  assert.equal(evidence[0]?.version, '0.2.50');
  assert.equal(evidence[0]?.sourceHash, 'a'.repeat(64));
  assert.equal(evidence[0]?.tools, COMPATIBILITY_TOOLS.length);
  assert.equal(evidence[0]?.remoteTools, remoteCompatibilityTools().length);
  // Evidence is an explicit allowlist of fields. Checking the key set rather than searching the
  // serialized text avoids matching the adapter's own name, which contains "command".
  assert.deepEqual(
    Object.keys(evidence[0] as object).sort(),
    ['adapter', 'remoteTools', 'source', 'sourceHash', 'tools', 'version']
  );
  for (const value of Object.values(evidence[0] as Record<string, unknown>)) {
    assert.ok(value === null || typeof value === 'string' || typeof value === 'number');
  }

  // A null hash is recorded as null rather than invented.
  const noHash = new AdapterRegistry();
  noHash.install({ ...manifestOrThrow(), sourceHash: null });
  assert.equal(noHash.identityEvidence()[0]?.sourceHash, null);
});

test('the remote compatibility surface is exactly the approved 22 tools and does not widen', () => {
  const registry = new AdapterRegistry();
  registry.install(manifestOrThrow());
  const surface = registry.remoteToolSurface();
  assert.equal(surface.length, 22, 'the approved remote surface is 22 tools');
  assert.deepEqual(surface, [...remoteCompatibilityTools()].sort());
  assert.equal(COMPATIBILITY_TOOLS.length, 26, 'the full local surface is 26 tools');

  // A manifest that tries to un-block a withheld tool is refused, so the surface cannot grow by
  // editing the adapter's own declaration.
  const unblocked = decodeAdapterManifest(withTool(manifestOrThrow(), 'set_config_value', { remoteBlocked: false }));
  assert.ok(unblocked);
  assert.ok(admitAdapterManifest(unblocked).refusals.some(line =>
    line.includes('set_config_value') && line.includes('remoteBlocked')
  ));
  assert.throws(() => new AdapterRegistry().install(unblocked), AdapterInstallRefused);
});

test('a manifest that omits a tool DEX classifies is refused, so the surface cannot silently shrink', () => {
  const manifest = manifestOrThrow();
  const dropped = { ...manifest, tools: manifest.tools.filter(entry => entry.tool !== 'kill_process') };
  const decoded = decodeAdapterManifest(dropped);
  assert.ok(decoded);
  assert.ok(admitAdapterManifest(decoded).refusals.some(line =>
    line.includes('kill_process') && line.includes('does not declare it')
  ));
});

test('structural rubbish is refused outright rather than partially installed', () => {
  const registry = new AdapterRegistry();
  for (const rubbish of [null, undefined, 42, 'a manifest', {}, { adapter: 'x' }, { adapter: 'x', version: '1', source: 's', sourceHash: null, tools: 'lots' }]) {
    assert.equal(decodeAdapterManifest(rubbish), null);
    assert.throws(() => registry.installFrom(rubbish), AdapterInstallRefused);
  }
  assert.equal(registry.installed().length, 0, 'nothing may be installed by a refused manifest');

  // A duplicate tool entry is a manifest that disagrees with itself.
  const manifest = manifestOrThrow();
  assert.equal(decodeAdapterManifest({ ...manifest, tools: [...manifest.tools, manifest.tools[0]] }), null);
});

test('a declaration cannot claim a mutating tool needs no undo', () => {
  const lying = decodeAdapterManifest(withTool(manifestOrThrow(), 'write_file', { reversibility: 'none' }));
  assert.ok(lying);
  assert.ok(admitAdapterManifest(lying).refusals.some(line =>
    line.includes('write_file') && line.includes('reversibility')
  ));
});

test('resolveTool answers from the catalog, so mutating an installed manifest changes nothing', () => {
  const registry = new AdapterRegistry();
  const admission = registry.install(manifestOrThrow());
  // Reach into the installed manifest the way a compromised adapter object would.
  const entry = admission.manifest.tools.find(tool => tool.tool === 'start_process') as { risk: string; workspaceSafeAllowed: boolean };
  entry.risk = 'inspect';
  entry.workspaceSafeAllowed = true;
  const resolved = registry.resolveTool('start_process');
  assert.equal(resolved?.risk, 'shell', 'enforcement reads the catalog, not the manifest object');
  assert.equal(resolved?.workspaceSafeAllowed, false);
});

test('a second adapter is judged on its own tools, not on Desktop Commander\'s', () => {
  // The omission check must be scoped per adapter. Comparing every manifest against the whole
  // catalog would refuse any second adapter for failing to declare the first adapter's tools.
  const other = decodeAdapterManifest({
    adapter: 'some-other-adapter', version: '1.0.0', source: 'example', sourceHash: null, tools: []
  });
  assert.ok(other);
  assert.deepEqual(admitAdapterManifest(other).refusals, []);
  assert.doesNotThrow(() => new AdapterRegistry().install(other));
});

test('an adapter cannot claim a tool DEX attributes to a different adapter', () => {
  const impostor = decodeAdapterManifest({
    ...manifestOrThrow(), adapter: 'impostor'
  });
  assert.ok(impostor);
  const refusals = admitAdapterManifest(impostor).refusals;
  assert.ok(refusals.some(line => line.includes('belongs to adapter "desktop-commander"')));
  assert.throws(() => new AdapterRegistry().install(impostor), AdapterInstallRefused);
});
