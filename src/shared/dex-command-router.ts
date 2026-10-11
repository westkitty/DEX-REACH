import { SAFETY_CLASSES, classifyOperationSafety, type SafetyClass } from './durable-execution.js';
import { isKnownOperation } from './operations.js';
import { hashValue } from './hash.js';
import {
  DEX_CONTRACT_MAJOR,
  DEX_MODIFIERS,
  DEX_MUTATION_LEVELS,
  DEX_PRODUCT_IDS,
  isPlainObject,
  isSemver,
  loadCanonicalManifest,
  productForScope,
  semverMajor,
  type CanonicalManifest,
  type ContractRefusalCode,
  type DexModifier,
  type DexMutationLevel,
  type DexProductId,
  type DexScope
} from './dex-canonical-contract.js';

export { DEX_CONTRACT_MAJOR, DEX_MODIFIERS, DEX_PRODUCT_IDS, semverMajor };
export type { DexModifier, DexProductId };

/**
 * The DEX command router on the REACH boundary (docs/architecture/decisions/0004-dex-command-router.md).
 *
 * DEX owns command semantics (`dex-canonical-contract.ts`). REACH owns the mapping from a DEX command to a
 * REACH operation, and that mapping is explicit data: a command with no authoritative mapping is
 * unroutable, never guessed. Pure functions only: no I/O, no registry access, no MCP registration and no
 * dispatch. A route decision is a plan naming at most one node and at most one existing REACH operation.
 */

export const DEX_ROUTER_CAPABILITY = 'dex_command_router';
export const DATA_CLASSES = ['PUBLIC', 'PRIVATE', 'SEALED'] as const;
export type DataClass = (typeof DATA_CLASSES)[number];
export const INPUT_ORIGINS = ['owner', 'dropzone'] as const;
export type InputOrigin = (typeof INPUT_ORIGINS)[number];

export const ROUTER_REFUSAL_CODES = [
  'MANIFEST_INVALID', 'DEX_CONTRACT_MAJOR_MISMATCH', 'COMMAND_MAJOR_MISMATCH', 'UNKNOWN_COMMAND',
  'NODE_ID_REQUIRED', 'NODE_NOT_FOUND', 'NODE_NOT_ONLINE', 'CAPABILITY_UNSUPPORTED_ON_NODE',
  'ADAPTER_MAJOR_MISMATCH', 'INPUT_NOT_ACCEPTED', 'DATA_NOT_PROMOTED', 'OPERATION_NOT_IN_CATALOGUE',
  'HANDOFF_INVALID', 'WITNESS_REMIX_EDGE_FORBIDDEN',
  'SYNTHETIC_MANIFEST_IN_PRODUCTION', 'MODIFIER_UNKNOWN', 'MODIFIER_MUTATION_FORBIDDEN',
  'REFERENCE_VERIFIER_UNAVAILABLE', 'REFERENCE_NOT_FOUND', 'REFERENCE_WRONG_BINDING', 'REFERENCE_REVOKED_OR_INAPPLICABLE',
  'REACH_MAPPING_ABSENT'
] as const;
export type RouterRefusalCode = (typeof ROUTER_REFUSAL_CODES)[number];

export type RouterRefusal = {
  ok: false;
  code: RouterRefusalCode;
  message: string;
  details?: Record<string, string | number | boolean | null>;
};

function refuse(code: RouterRefusalCode, message: string, details?: RouterRefusal['details']): RouterRefusal {
  return { ok: false, code, message, ...(details ? { details } : {}) };
}

// ---------------------------------------------------------------------------------------------------
// REACH-owned mapping: which DEX commands may reach which REACH operation, under which gates.
// ---------------------------------------------------------------------------------------------------

export const REACH_MAPPING_SCHEMA = 'reach.dex-command-mappings';
export const REACH_MAPPING_VERSION = '1.0.0';

/**
 * One explicit, authoritative statement that a DEX command may reach REACH. `authority` names the document
 * that grants it (an accepted ADR or contract), so a mapping cannot appear without a stated source.
 * Nothing here is inferred from a command name, scope or workflow id.
 */
export type ReachMappingDeclaration = {
  command: string;
  authority: string;
  invokesReach: boolean;
  reachOperation: string | null;
  /** Null for control-plane scopes (REACH, MAINT, CONTROL_ROOM, GLOBAL), which are not products. */
  product: DexProductId | null;
  safetyClass: SafetyClass;
  dataClass: DataClass;
  inputOrigin: InputOrigin;
};

export type ReachMappingTable = {
  schema: typeof REACH_MAPPING_SCHEMA;
  version: string;
  synthetic?: boolean;
  mappings: readonly ReachMappingDeclaration[];
};

const MAPPING_TABLE_KEYS = new Set(['schema', 'version', 'synthetic', 'mappings']);
const MAPPING_KEYS = new Set(['command', 'authority', 'invokesReach', 'reachOperation', 'product', 'safetyClass', 'dataClass', 'inputOrigin']);

/** A routable command: DEX's declaration joined to REACH's explicit mapping. Modifiers come from DEX alone. */
export type DexCommandEntry = {
  id: string;
  version: string;
  scope: DexScope;
  mutationLevel: DexMutationLevel;
  product: DexProductId | null;
  safetyClass: SafetyClass;
  dataClass: DataClass;
  inputOrigin: InputOrigin;
  /** Declared by the mapping. A command that does not invoke REACH has no node requirement and no REACH operation. */
  invokesReach: boolean;
  modifiers: readonly DexModifier[];
  reachOperation: string | null;
};

export type LoadedManifest = {
  contractVersion: string;
  synthetic: boolean;
  /** Only commands with an explicit, validated REACH mapping. */
  commands: ReadonlyMap<string, DexCommandEntry>;
  /** Every other canonical command. They are preserved, listed, and never routable. */
  unroutable: ReadonlyMap<string, { scope: DexScope; reason: 'NO_AUTHORITATIVE_REACH_MAPPING' }>;
  canonicalCount: number;
};

export type ManifestLoadResult = { ok: true; manifest: LoadedManifest } | RouterRefusal;

/** Worst-case consequence of each REACH safety class, on the same scale as DEX mutation levels. */
const SAFETY_CEILING: Record<SafetyClass, number> = {
  PURE_READ_IDEMPOTENT: 0,
  SIDE_EFFECTING_IDEMPOTENT: 1,
  PLAN_COMMIT: 2,
  // An unknown effect cannot be bounded, so only a command DEX already marks DESTRUCTIVE may carry one.
  PROCESS_UNKNOWN_EFFECT: 3,
  DESTRUCTIVE: 3
};

const nonEmpty = (value: unknown): value is string => typeof value === 'string' && value.length > 0;

function bindMappings(canonical: CanonicalManifest, table: unknown, options: { production?: boolean }): ManifestLoadResult {
  const invalid = (reason: string) => refuse('MANIFEST_INVALID', `mapping table: ${reason}`);
  if (!isPlainObject(table)) return invalid('must be an object');
  if (table.schema !== REACH_MAPPING_SCHEMA) return invalid(`schema must be ${REACH_MAPPING_SCHEMA}`);
  if (!isSemver(table.version)) return invalid('version must be semver');
  if (semverMajor(table.version) !== semverMajor(REACH_MAPPING_VERSION)) return invalid('mapping table major version is not supported');
  for (const key of Object.keys(table)) {
    if (!MAPPING_TABLE_KEYS.has(key)) return invalid(`unknown field ${key}`);
  }
  if (table.synthetic !== undefined && typeof table.synthetic !== 'boolean') return invalid('synthetic must be a boolean');
  if (options.production && table.synthetic === true) {
    return refuse('SYNTHETIC_MANIFEST_IN_PRODUCTION', 'a synthetic mapping table cannot be loaded as production configuration');
  }
  if (!Array.isArray(table.mappings)) return invalid('mappings must be an array');

  const commands = new Map<string, DexCommandEntry>();
  for (const [index, mapping] of table.mappings.entries()) {
    const bad = (reason: string) => invalid(`mappings[${index}]: ${reason}`);
    if (!isPlainObject(mapping)) return bad('must be an object');
    for (const key of Object.keys(mapping)) {
      if (!MAPPING_KEYS.has(key)) return bad(`unknown field ${key}`);
    }
    if (typeof mapping.command !== 'string') return bad('command must be a string');
    const dex = canonical.commands.get(mapping.command);
    // A mapping cannot create a command: DEX owns the roster.
    if (!dex) return bad('maps a command that is not in the canonical DEX manifest');
    if (commands.has(mapping.command)) return bad('duplicate mapping');
    if (!nonEmpty(mapping.authority) || mapping.authority.length > 200) return bad('authority must name the document that grants this mapping');
    if (typeof mapping.invokesReach !== 'boolean') return bad('invokesReach must be declared true or false');
    if (mapping.invokesReach) {
      if (!nonEmpty(mapping.reachOperation)) return bad('reachOperation is required when invokesReach is true');
    } else if (mapping.reachOperation !== undefined && mapping.reachOperation !== null) {
      return bad('reachOperation must be absent when invokesReach is false');
    }
    if (!SAFETY_CLASSES.includes(mapping.safetyClass as SafetyClass)) return bad('safetyClass is not a REACH safety class');
    if (!DATA_CLASSES.includes(mapping.dataClass as DataClass)) return bad('dataClass must be PUBLIC, PRIVATE or SEALED');
    if (!INPUT_ORIGINS.includes(mapping.inputOrigin as InputOrigin)) return bad('inputOrigin must be owner or dropzone');
    const safetyClass = mapping.safetyClass as SafetyClass;
    const dataClass = mapping.dataClass as DataClass;
    const inputOrigin = mapping.inputOrigin as InputOrigin;

    // The product comes from the mapping but must agree with DEX's scope. Control-plane scopes are not products.
    const scopeProduct = productForScope(dex.scope);
    if ((mapping.product ?? null) !== scopeProduct) {
      return bad(`product must be ${scopeProduct === null ? 'null' : scopeProduct} for scope ${dex.scope}`);
    }
    // A mapped operation can never be riskier than DEX says the command is.
    if (SAFETY_CEILING[safetyClass] > DEX_MUTATION_LEVELS.indexOf(dex.mutationLevel)) {
      return bad(`safetyClass ${safetyClass} exceeds the DEX mutation level ${dex.mutationLevel}`);
    }
    if (mapping.invokesReach && isKnownOperation(mapping.reachOperation as string) && classifyOperationSafety(mapping.reachOperation as string) !== safetyClass) {
      return bad('safetyClass does not match the catalogued safety class of the operation');
    }
    // Scope floors tighten only: a scope can demand more gates but never grants fewer.
    if (dex.scope === 'DROPZONE' && inputOrigin !== 'dropzone') return bad('a DROPZONE command must declare inputOrigin dropzone');
    if (dex.scope === 'PAIR' && dataClass === 'PUBLIC') return bad('a PAIR command must declare PRIVATE or SEALED data until DEX defines a public PAIR contract');

    commands.set(dex.canonical, {
      id: dex.canonical,
      version: canonical.manifestVersion,
      scope: dex.scope,
      mutationLevel: dex.mutationLevel,
      product: scopeProduct,
      safetyClass,
      dataClass,
      inputOrigin,
      invokesReach: mapping.invokesReach,
      modifiers: [...dex.supportedModifiers],
      reachOperation: mapping.invokesReach ? (mapping.reachOperation as string) : null
    });
  }

  const unroutable = new Map<string, { scope: DexScope; reason: 'NO_AUTHORITATIVE_REACH_MAPPING' }>();
  for (const dex of canonical.commands.values()) {
    if (!commands.has(dex.canonical)) unroutable.set(dex.canonical, { scope: dex.scope, reason: 'NO_AUTHORITATIVE_REACH_MAPPING' });
  }
  return {
    ok: true,
    manifest: {
      contractVersion: canonical.manifestVersion,
      synthetic: canonical.synthetic || table.synthetic === true,
      commands,
      unroutable,
      canonicalCount: canonical.commands.size
    }
  };
}

/**
 * Load the canonical DEX manifest and join it to the REACH mapping table. Every canonical command is
 * preserved; those without an explicit mapping land in `unroutable`. Production loading refuses synthetic
 * inputs. Nothing in the running node selects production loading yet, so this stays inert.
 */
export function loadRoutableManifest(input: { canonical: unknown; mappings: unknown; production?: boolean }): ManifestLoadResult {
  const loaded = loadCanonicalManifest(input.canonical, { production: input.production });
  if (!loaded.ok) return refuse(loaded.code satisfies ContractRefusalCode, loaded.message, loaded.details);
  return bindMappings(loaded.manifest, input.mappings, { production: input.production });
}

/** What a node advertises. Plain data, so the router never reaches into the live registry. */
export type RouterNodeView = {
  nodeId: string;
  enrolled: boolean;
  online: boolean;
  capabilities: Record<string, unknown>;
  /** Keyed by DEX product id (lowercase), valued by the adapter semver. */
  productAdapters?: Partial<Record<DexProductId, string>>;
};

export type RouteRequest = {
  /** Exact canonical id, `DEX//NAME`. Slash forms, aliases and prose are DEX's parser's concern, not REACH's. */
  command: string;
  commandVersion?: string;
  /** Exact node identity. Required only when the command invokes REACH; never defaulted or selected. */
  nodeId?: string;
  /** The object the command acts on. A reference must be bound to it, or it proves nothing. */
  targetId?: string;
  acceptanceRef?: string;
  promotionRef?: string;
  /** Plus-prefixed DEX modifiers, e.g. `+DRY`. */
  modifiers?: readonly string[];
};

export type RoutePlan = {
  ok: true;
  /** Null when the command does not invoke REACH: there is no node to select and no REACH operation. */
  nodeId: string | null;
  command: DexCommandEntry;
  /**
   * The REACH operation the existing executor will be asked to run. Null for non-REACH commands, and null
   * for a +DRY plan whose operation is not a pure read: that plan is a preview and dispatches nothing.
   */
  reachOperation: string | null;
  /** The operation a preview-only plan stands in for. Informational; never dispatched. */
  previewOf: string | null;
  /** Effective modifier outcome. Monotonic: nothing here grants authority or skips a gate. */
  effective: {
    modifiers: readonly DexModifier[];
    dryRun: boolean;
    previewOnly: boolean;
    effectiveMutationLevel: DexMutationLevel;
    requiresHumanConfirmation: boolean;
    authorityFromModifiers: false;
    gatesSkipped: false;
  };
  /** Every supplied reference was verified by the authoritative product interface before this plan was returned. */
  referencesVerified: boolean;
};

export type RouteDecision = RoutePlan | RouterRefusal;

export type ReferenceKind = 'promotion' | 'acceptance';
export type ReferenceQuery = {
  kind: ReferenceKind;
  ref: string;
  product: DexProductId;
  command: string;
  targetId: string;
  nodeId: string | null;
  dataClass: DataClass;
};
export type ReferenceVerdict =
  | { status: 'VERIFIED' }
  | { status: 'NOT_FOUND' | 'WRONG_BINDING' | 'REVOKED' | 'INAPPLICABLE' | 'UNAVAILABLE'; reason?: string };

/**
 * The authoritative product interface that resolves promotionRef and acceptanceRef. REACH never reads
 * another product's database and never trusts the presence of a string. With no verifier, dispatch is refused.
 */
export type ProductReferenceVerifier = {
  verify(query: ReferenceQuery): Promise<ReferenceVerdict> | ReferenceVerdict;
};

function verdictRefusal(kind: ReferenceKind, verdict: Exclude<ReferenceVerdict, { status: 'VERIFIED' }>): RouterRefusal {
  switch (verdict.status) {
    case 'NOT_FOUND': return refuse('REFERENCE_NOT_FOUND', `${kind} reference does not resolve in the authoritative product interface`);
    case 'WRONG_BINDING': return refuse('REFERENCE_WRONG_BINDING', `${kind} reference is bound to another object, product or target`);
    case 'REVOKED':
    case 'INAPPLICABLE': return refuse('REFERENCE_REVOKED_OR_INAPPLICABLE', `${kind} reference is revoked or does not apply to this command`);
    default: return refuse('REFERENCE_VERIFIER_UNAVAILABLE', `${kind} reference could not be verified; dispatch is refused`);
  }
}

/** Resolve every supplied reference through the product interface. Returns the first refusal, or null. */
async function verifyReferences(
  refs: ReadonlyArray<[ReferenceKind, string]>,
  base: Omit<ReferenceQuery, 'kind' | 'ref'>,
  verifier: ProductReferenceVerifier | undefined
): Promise<RouterRefusal | null> {
  for (const [kind, ref] of refs) {
    let verdict: ReferenceVerdict;
    try {
      verdict = await verifier!.verify({ ...base, kind, ref });
    } catch {
      verdict = { status: 'UNAVAILABLE' };
    }
    if (verdict.status !== 'VERIFIED') return verdictRefusal(kind, verdict);
  }
  return null;
}

/**
 * Route one command. The checks run in ADR-0004 section 5 order and the first failure is the refusal.
 * Node selection is exact and applies only where the command invokes REACH. Supplied references are
 * verified by the product interface; a reference that is merely present is never enough.
 */
export async function routeCommand(input: {
  manifest: LoadedManifest;
  request: RouteRequest;
  nodes: readonly RouterNodeView[];
  verifier?: ProductReferenceVerifier;
}): Promise<RouteDecision> {
  const { manifest, request, nodes, verifier } = input;
  const entry = manifest.commands.get(request.command);
  if (!entry) {
    // A canonical command with no authoritative REACH mapping is known to DEX but unreachable from REACH.
    const unmapped = manifest.unroutable.get(request.command);
    if (unmapped) {
      return refuse('REACH_MAPPING_ABSENT', 'the command has no authoritative REACH mapping, so REACH will not route it', { command: request.command, scope: unmapped.scope });
    }
    return refuse('UNKNOWN_COMMAND', 'command is not in the loaded manifest', { command: String(request.command) });
  }

  if (request.commandVersion !== undefined) {
    const pinned = semverMajor(request.commandVersion);
    if (pinned === null || pinned !== semverMajor(entry.version)) {
      return refuse('COMMAND_MAJOR_MISMATCH', 'requested command major does not match the manifest', {
        command: entry.id,
        pinnedVersion: String(request.commandVersion),
        actualVersion: entry.version
      });
    }
  }

  // Modifiers are monotonic. Only a modifier DEX declares for this command is accepted, and only once.
  const modifiers = request.modifiers ?? [];
  for (const [position, modifier] of modifiers.entries()) {
    if (!DEX_MODIFIERS.includes(modifier as DexModifier)) return refuse('MODIFIER_UNKNOWN', `modifier ${String(modifier)} is not a DEX modifier`, { command: entry.id });
    if (!entry.modifiers.includes(modifier as DexModifier)) return refuse('MODIFIER_UNKNOWN', `modifier ${modifier} is not supported by this command`, { command: entry.id });
    if (modifiers.indexOf(modifier) !== position) return refuse('MODIFIER_UNKNOWN', `modifier ${modifier} was supplied more than once`, { command: entry.id });
  }
  const dryRun = modifiers.includes('+DRY');

  let node: RouterNodeView | undefined;
  if (entry.invokesReach) {
    if (typeof request.nodeId !== 'string' || request.nodeId.length === 0) {
      return refuse('NODE_ID_REQUIRED', 'an exact node_id is required; the router never selects a node');
    }
    // Exact, case-sensitive equality. No alias, prefix, normalisation or default node.
    node = nodes.find(candidate => candidate.nodeId === request.nodeId);
    if (!node) return refuse('NODE_NOT_FOUND', 'no enrolled node has the requested exact node_id', { nodeId: request.nodeId });
    if (!node.enrolled || !node.online) {
      // The refusal names only the requested node; it never offers another one.
      return refuse('NODE_NOT_ONLINE', 'the requested node is not enrolled and online', { nodeId: request.nodeId });
    }
    if (node.capabilities[DEX_ROUTER_CAPABILITY] !== true) {
      return refuse('CAPABILITY_UNSUPPORTED_ON_NODE', `node does not advertise ${DEX_ROUTER_CAPABILITY}`, { nodeId: node.nodeId });
    }
    // Control-plane scopes name no product, so there is no product adapter to match.
    if (entry.product !== null) {
      const adapterVersion = node.productAdapters?.[entry.product];
      if (adapterVersion === undefined) {
        return refuse('CAPABILITY_UNSUPPORTED_ON_NODE', `node advertises no ${entry.product} adapter`, { nodeId: node.nodeId, product: entry.product });
      }
      if (semverMajor(adapterVersion) !== DEX_CONTRACT_MAJOR) {
        return refuse('ADAPTER_MAJOR_MISMATCH', `node ${entry.product} adapter major does not match the pinned major`, {
          nodeId: node.nodeId,
          product: entry.product,
          expectedMajor: DEX_CONTRACT_MAJOR,
          actualVersion: adapterVersion
        });
      }
    }
  }

  // Gates. +FAST never removes one: every gate below applies to every modifier combination, including +DRY.
  if (entry.inputOrigin === 'dropzone' && !nonEmpty(request.acceptanceRef)) {
    return refuse('INPUT_NOT_ACCEPTED', 'dropzone input is untrusted until an accepted input reference is supplied', { command: entry.id });
  }
  if (entry.dataClass !== 'PUBLIC' && !nonEmpty(request.promotionRef)) {
    return refuse('DATA_NOT_PROMOTED', `${entry.dataClass} data is not routable without an explicit promotion`, { command: entry.id, dataClass: entry.dataClass });
  }

  // A supplied reference must be resolved and bound by the authoritative product interface.
  let referencesVerified = false;
  const suppliedRefs: Array<[ReferenceKind, string]> = [];
  if (nonEmpty(request.acceptanceRef)) suppliedRefs.push(['acceptance', request.acceptanceRef]);
  if (nonEmpty(request.promotionRef)) suppliedRefs.push(['promotion', request.promotionRef]);
  if (suppliedRefs.length) {
    if (!verifier) return refuse('REFERENCE_VERIFIER_UNAVAILABLE', 'no authoritative product interface is available to verify references; dispatch is refused', { command: entry.id });
    if (!nonEmpty(request.targetId)) return refuse('REFERENCE_WRONG_BINDING', 'a reference cannot be bound without a target', { command: entry.id });
    if (entry.product === null) {
      return refuse('REFERENCE_WRONG_BINDING', 'a reference cannot be bound to a command that names no product', { command: entry.id, scope: entry.scope });
    }
    const refusal = await verifyReferences(
      suppliedRefs,
      { product: entry.product, command: entry.id, targetId: request.targetId, nodeId: node?.nodeId ?? null, dataClass: entry.dataClass },
      verifier
    );
    if (refusal) return refusal;
    referencesVerified = true;
  }

  if (entry.invokesReach && !isKnownOperation(entry.reachOperation!)) {
    return refuse('OPERATION_NOT_IN_CATALOGUE', 'manifest names an operation REACH does not catalogue', {
      command: entry.id,
      reachOperation: entry.reachOperation ?? 'none'
    });
  }

  // +DRY narrows the effective mutation to NONE and requests a preview (DEX ADR-0013). REACH honours that
  // by dispatching nothing that is not a pure read: a dry run of a mutating operation is a plan to show,
  // never an operation to run.
  const readOnly = entry.safetyClass === 'PURE_READ_IDEMPOTENT';
  const dispatches = entry.reachOperation !== null && (!dryRun || readOnly);
  const plan: RoutePlan = {
    ok: true,
    nodeId: node?.nodeId ?? null,
    command: entry,
    reachOperation: dispatches ? entry.reachOperation : null,
    previewOf: dryRun && !dispatches ? entry.reachOperation : null,
    effective: {
      modifiers: [...modifiers] as DexModifier[],
      dryRun,
      previewOnly: dryRun,
      effectiveMutationLevel: dryRun ? 'NONE' : entry.mutationLevel,
      requiresHumanConfirmation: entry.mutationLevel === 'DESTRUCTIVE' || entry.mutationLevel === 'COMMIT' || modifiers.includes('+SHIP'),
      authorityFromModifiers: false,
      gatesSkipped: false
    },
    referencesVerified
  };
  // Defensive: whatever the mapping says, a dry run must not carry a dispatchable mutation.
  if (dryRun && plan.reachOperation !== null && !readOnly) {
    return refuse('MODIFIER_MUTATION_FORBIDDEN', '+DRY plan would dispatch a mutating operation', { command: entry.id });
  }
  return plan;
}

// ---------------------------------------------------------------------------------------------------
// Handoffs: DEX descriptor v1.0.0, validated by the receiver against its own accepted contracts.
// ---------------------------------------------------------------------------------------------------

/** DEX `DexHandoffDescriptor`. Every field is sender-supplied and therefore untrusted. */
export type HandoffDescriptor = {
  sourceProduct: DexProductId;
  sourceObjectKind: string;
  targetProduct: DexProductId;
  targetObjectKind: string;
  contractSchema: string;
  contractVersion: string;
  availability: 'AVAILABLE' | 'UNAVAILABLE';
  reason: string;
};

/** The receiving product's own declaration: DEX `Pick<DexProductManifest, 'productId' | 'acceptedContracts'>`. */
export type HandoffReceiver = {
  productId: DexProductId;
  acceptedContracts?: readonly string[];
};

const HANDOFF_KEYS = new Set(['sourceProduct', 'sourceObjectKind', 'targetProduct', 'targetObjectKind', 'contractSchema', 'contractVersion', 'availability', 'reason']);

/**
 * Receiver-side validation, mirroring DEX `validateHandoffReceiver` and adding the REACH-enforced firewalls.
 * The receiver checks the descriptor against its own accepted contracts and never trusts a sender's claim of
 * authorization: the descriptor is closed (no `authorized`, `promoted` or `accepted` fields can ride along),
 * PAIR content leaves only with a verified promotion, DROPZONE content only once accepted, and
 * WITNESS-to-REMIX is refused in code. Nothing is applied on refusal.
 */
export async function validateHandoff(
  raw: unknown,
  receiver: HandoffReceiver,
  options: { promotionRef?: string; acceptanceRef?: string; targetId?: string; verifier?: ProductReferenceVerifier } = {}
): Promise<{ ok: true; handoff: HandoffDescriptor } | RouterRefusal> {
  const invalid = (reason: string, details?: RouterRefusal['details']) => refuse('HANDOFF_INVALID', reason, details);
  if (!isPlainObject(raw)) return invalid('handoff must be an object');
  for (const key of Object.keys(raw)) {
    if (!HANDOFF_KEYS.has(key)) return invalid(`unknown handoff field ${key}`);
  }
  for (const key of ['sourceObjectKind', 'targetObjectKind', 'contractSchema', 'reason']) {
    if (!nonEmpty(raw[key]) || (raw[key] as string).length > 256) return invalid(`${key} must be a non-empty string`);
  }
  if (!DEX_PRODUCT_IDS.includes(raw.sourceProduct as DexProductId) || !DEX_PRODUCT_IDS.includes(raw.targetProduct as DexProductId)) {
    return invalid('sourceProduct and targetProduct must be known DEX products');
  }
  if (raw.availability !== 'AVAILABLE' && raw.availability !== 'UNAVAILABLE') return invalid('availability must be AVAILABLE or UNAVAILABLE');
  if (!isSemver(raw.contractVersion)) return invalid('contractVersion must be semver');
  const handoff = raw as unknown as HandoffDescriptor;

  // A code check, not manifest data: no declaration, acceptance or promotion reopens this edge.
  if (handoff.sourceProduct === 'witness' && handoff.targetProduct === 'remix') {
    return refuse('WITNESS_REMIX_EDGE_FORBIDDEN', 'WITNESS evidence may never hand off to REMIX');
  }
  if (handoff.targetProduct !== receiver.productId) {
    return invalid(`receiver product ${receiver.productId} does not match ${handoff.targetProduct}`);
  }
  const contract = `${handoff.contractSchema}@${handoff.contractVersion}`;
  if (!receiver.acceptedContracts?.includes(contract)) {
    return invalid(`receiver ${receiver.productId} does not accept contract ${contract}`, { contract });
  }
  if (handoff.availability !== 'AVAILABLE') return invalid('the handoff is not available');

  // Firewalls on the source side. A string proves nothing: each reference is verified by the product interface.
  const refs: Array<[ReferenceKind, string]> = [];
  if (handoff.sourceProduct === 'pair') {
    if (!nonEmpty(options.promotionRef)) return refuse('DATA_NOT_PROMOTED', 'PAIR content leaves PAIR only through an explicit promotion', { contract });
    refs.push(['promotion', options.promotionRef]);
  }
  if (handoff.sourceProduct === 'dropzone') {
    if (!nonEmpty(options.acceptanceRef)) return refuse('INPUT_NOT_ACCEPTED', 'DROPZONE content is untrusted until it is accepted', { contract });
    refs.push(['acceptance', options.acceptanceRef]);
  }
  if (refs.length) {
    if (!options.verifier) return refuse('REFERENCE_VERIFIER_UNAVAILABLE', 'no authoritative product interface is available to verify references; the handoff is refused', { contract });
    if (!nonEmpty(options.targetId)) return refuse('REFERENCE_WRONG_BINDING', 'a reference cannot be bound without a target', { contract });
    const refusal = await verifyReferences(
      refs,
      { product: handoff.sourceProduct, command: `handoff:${contract}`, targetId: options.targetId, nodeId: null, dataClass: 'PRIVATE' },
      options.verifier
    );
    if (refusal) return refusal;
  }
  return { ok: true, handoff };
}

// ---------------------------------------------------------------------------------------------------
// Search projections: derived, rebuildable, privacy-filtered.
// ---------------------------------------------------------------------------------------------------

export type SearchSource = { id: string; product: DexProductId; dataClass: DataClass };

export type SearchProjection = {
  rebuildable: true;
  authoritative: false;
  sourceDigest: string;
  entries: SearchSource[];
  excludedUnpromoted: number;
};

/**
 * A derived, rebuildable projection. PRIVATE and SEALED items are excluded unless their id is in the
 * promoted set. Identical sources give an identical projection and digest. Nothing reads it as evidence.
 */
export function projectSearchEntries(sources: readonly SearchSource[], promotedIds: ReadonlySet<string>): SearchProjection {
  const ordered = [...sources].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const entries = ordered.filter(item => item.dataClass === 'PUBLIC' || promotedIds.has(item.id));
  return {
    rebuildable: true,
    authoritative: false,
    sourceDigest: hashValue(ordered),
    entries,
    excludedUnpromoted: ordered.length - entries.length
  };
}
