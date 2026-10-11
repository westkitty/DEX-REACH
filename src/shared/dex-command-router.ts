import { SAFETY_CLASSES, type SafetyClass } from './durable-execution.js';
import { isKnownOperation } from './operations.js';
import { hashValue } from './hash.js';

/**
 * Skeleton for the DEX command router described in docs/architecture/decisions/0004-dex-command-router.md.
 *
 * Pure functions only: no I/O, no registry access, no MCP registration and no dispatch. A route
 * decision is a plan naming exactly one node and one existing REACH operation. Anything the ADR
 * does not allow is refused with a code from the closed list in ADR section 7.
 */

export const DEX_CONTRACT_MAJOR = 1;
export const DEX_ROUTER_CAPABILITY = 'dex_command_router';
export const DEX_PRODUCT_IDS = ['SESSION', 'DROPZONE', 'PAIR', 'CAPSULE', 'MUSEUM', 'REMIX', 'SIDEQUEST', 'WITNESS'] as const;
export type DexProductId = (typeof DEX_PRODUCT_IDS)[number];
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
  'REFERENCE_VERIFIER_UNAVAILABLE', 'REFERENCE_NOT_FOUND', 'REFERENCE_WRONG_BINDING', 'REFERENCE_REVOKED_OR_INAPPLICABLE'
] as const;
/** Modifiers are DEX-owned labels. REACH enforces their monotonicity whatever the manifest says. */
export const DEX_MODIFIERS = ['DRY', 'SHIP', 'FAST'] as const;
export type DexModifier = (typeof DEX_MODIFIERS)[number];
export type RouterRefusalCode = (typeof ROUTER_REFUSAL_CODES)[number];

export type RouterRefusal = {
  ok: false;
  code: RouterRefusalCode;
  message: string;
  details?: Record<string, string | number | boolean | null>;
};

export type DexCommandEntry = {
  id: string;
  version: string;
  product: DexProductId;
  safetyClass: SafetyClass;
  dataClass: DataClass;
  inputOrigin: InputOrigin;
  /** Declared by DEX. A command that does not invoke REACH has no node requirement and no REACH operation. */
  invokesReach: boolean;
  modifiers: readonly DexModifier[];
  reachOperation: string | null;
};

export type LoadedManifest = {
  contractVersion: string;
  synthetic: boolean;
  commands: ReadonlyMap<string, DexCommandEntry>;
};

export type ManifestLoadResult = { ok: true; manifest: LoadedManifest } | RouterRefusal;

const TOP_LEVEL_KEYS = new Set(['schema', 'contractVersion', 'synthetic', 'commands']);
const COMMAND_KEYS = new Set(['id', 'version', 'product', 'safetyClass', 'dataClass', 'inputOrigin', 'invokesReach', 'modifiers', 'reachOperation']);
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const COMMAND_ID = /^[A-Z][A-Z0-9_]{1,31}\/\/[A-Z][A-Z0-9_]{1,31}$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;

function refuse(code: RouterRefusalCode, message: string, details?: RouterRefusal['details']): RouterRefusal {
  return { ok: false, code, message, ...(details ? { details } : {}) };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function semverMajor(version: string): number | null {
  const match = SEMVER.exec(version);
  return match ? Number(match[1]) : null;
}

/**
 * Load a manifest as data. The manifest can name only existing REACH operations; it cannot add code.
 * The major-version check runs before field validation so a future major produces a version refusal.
 */
export function loadCommandManifest(raw: unknown, options: { production?: boolean } = {}): ManifestLoadResult {
  if (!isPlainObject(raw)) return refuse('MANIFEST_INVALID', 'manifest must be a JSON object');
  if (raw.schema !== 'dex.command-manifest') return refuse('MANIFEST_INVALID', 'manifest schema must be dex.command-manifest');
  if (typeof raw.contractVersion !== 'string' || !SEMVER.test(raw.contractVersion)) {
    return refuse('MANIFEST_INVALID', 'contractVersion must be semver');
  }
  const major = semverMajor(raw.contractVersion)!;
  if (major !== DEX_CONTRACT_MAJOR) {
    return refuse('DEX_CONTRACT_MAJOR_MISMATCH', `manifest contract major ${major} is not the pinned major ${DEX_CONTRACT_MAJOR}`, {
      expectedMajor: DEX_CONTRACT_MAJOR,
      actualVersion: raw.contractVersion
    });
  }
  for (const key of Object.keys(raw)) {
    if (!TOP_LEVEL_KEYS.has(key)) return refuse('MANIFEST_INVALID', `unknown manifest field: ${key}`);
  }
  if (raw.synthetic !== undefined && typeof raw.synthetic !== 'boolean') return refuse('MANIFEST_INVALID', 'synthetic must be a boolean');
  // Synthetic fixtures are test data. They are never accepted as production configuration.
  if (options.production && raw.synthetic === true) return refuse('SYNTHETIC_MANIFEST_IN_PRODUCTION', 'a synthetic manifest cannot be loaded as production configuration');
  if (!Array.isArray(raw.commands)) return refuse('MANIFEST_INVALID', 'commands must be an array');

  const commands = new Map<string, DexCommandEntry>();
  for (const [index, entry] of raw.commands.entries()) {
    const invalid = (reason: string) => refuse('MANIFEST_INVALID', `commands[${index}]: ${reason}`);
    if (!isPlainObject(entry)) return invalid('must be an object');
    for (const key of Object.keys(entry)) {
      if (!COMMAND_KEYS.has(key)) return invalid(`unknown field ${key}`);
    }
    if (typeof entry.id !== 'string' || !COMMAND_ID.test(entry.id)) return invalid('id is not a canonical command id');
    if (commands.has(entry.id)) return refuse('MANIFEST_INVALID', `duplicate command id ${entry.id}`);
    if (typeof entry.version !== 'string' || !SEMVER.test(entry.version)) return invalid('version must be semver');
    if (!DEX_PRODUCT_IDS.includes(entry.product as DexProductId)) return invalid('product is not a known DEX product');
    if (!SAFETY_CLASSES.includes(entry.safetyClass as SafetyClass)) return invalid('safetyClass is not a REACH safety class');
    if (!DATA_CLASSES.includes(entry.dataClass as DataClass)) return invalid('dataClass must be PUBLIC, PRIVATE or SEALED');
    if (!INPUT_ORIGINS.includes(entry.inputOrigin as InputOrigin)) return invalid('inputOrigin must be owner or dropzone');
    if (typeof entry.invokesReach !== 'boolean') return invalid('invokesReach must be declared true or false by DEX');
    // A REACH operation is mapped only where DEX says the command actually invokes REACH. Nothing is invented.
    if (entry.invokesReach) {
      if (typeof entry.reachOperation !== 'string' || entry.reachOperation.length === 0) return invalid('reachOperation is required when invokesReach is true');
    } else if (entry.reachOperation !== undefined && entry.reachOperation !== null) {
      return invalid('reachOperation must be absent when invokesReach is false; no REACH mapping is fabricated');
    }
    const modifiers = entry.modifiers ?? [];
    if (!Array.isArray(modifiers) || new Set(modifiers).size !== modifiers.length || modifiers.some(m => !DEX_MODIFIERS.includes(m as DexModifier))) {
      return invalid('modifiers must be a unique list of DRY, SHIP or FAST');
    }
    commands.set(entry.id, {
      id: entry.id,
      version: entry.version,
      product: entry.product as DexProductId,
      safetyClass: entry.safetyClass as SafetyClass,
      dataClass: entry.dataClass as DataClass,
      inputOrigin: entry.inputOrigin as InputOrigin,
      invokesReach: entry.invokesReach,
      modifiers: [...(modifiers as DexModifier[])],
      reachOperation: entry.invokesReach ? (entry.reachOperation as string) : null
    });
  }
  return { ok: true, manifest: { contractVersion: raw.contractVersion, synthetic: raw.synthetic === true, commands } };
}

/** What a node advertises. Plain data, so the router never reaches into the live registry. */
export type RouterNodeView = {
  nodeId: string;
  enrolled: boolean;
  online: boolean;
  capabilities: Record<string, unknown>;
  productAdapters?: Partial<Record<DexProductId, string>>;
};

export type RouteRequest = {
  command: string;
  commandVersion?: string;
  /** Exact node identity. Required only when the command invokes REACH; never defaulted or selected. */
  nodeId?: string;
  /** The object the command acts on. A reference must be bound to it, or it proves nothing. */
  targetId?: string;
  acceptanceRef?: string;
  promotionRef?: string;
  modifiers?: readonly string[];
};

export type RoutePlan = {
  ok: true;
  /** Null when the command does not invoke REACH: there is no node to select and no REACH operation. */
  nodeId: string | null;
  command: DexCommandEntry;
  /** The REACH operation the existing executor will be asked to run. Null for non-REACH commands. */
  reachOperation: string | null;
  /** Effective modifier outcome. Monotonic: none of these grants authority or skips a gate. */
  effective: { dryRun: boolean; authorityFromModifiers: false; gatesSkipped: false };
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

const nonEmpty = (value: unknown): value is string => typeof value === 'string' && value.length > 0;

function verdictRefusal(kind: ReferenceKind, verdict: Exclude<ReferenceVerdict, { status: 'VERIFIED' }>): RouterRefusal {
  switch (verdict.status) {
    case 'NOT_FOUND': return refuse('REFERENCE_NOT_FOUND', `${kind} reference does not resolve in the authoritative product interface`);
    case 'WRONG_BINDING': return refuse('REFERENCE_WRONG_BINDING', `${kind} reference is bound to another object, product or target`);
    case 'REVOKED':
    case 'INAPPLICABLE': return refuse('REFERENCE_REVOKED_OR_INAPPLICABLE', `${kind} reference is revoked or does not apply to this command`);
    default: return refuse('REFERENCE_VERIFIER_UNAVAILABLE', `${kind} reference could not be verified; dispatch is refused`);
  }
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
  if (!entry) return refuse('UNKNOWN_COMMAND', 'command is not in the loaded manifest', { command: String(request.command) });

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

  // Modifiers are monotonic. Only a modifier DEX declares for this command is accepted.
  const modifiers = request.modifiers ?? [];
  for (const modifier of modifiers) {
    if (!DEX_MODIFIERS.includes(modifier as DexModifier)) return refuse('MODIFIER_UNKNOWN', `modifier ${String(modifier)} is not a DEX modifier`, { command: entry.id });
    if (!entry.modifiers.includes(modifier as DexModifier)) return refuse('MODIFIER_UNKNOWN', `modifier ${modifier} is not declared for this command`, { command: entry.id });
  }
  // +DRY can never mutate: a dry run of a mutating command would be a mutation by another name.
  if (modifiers.includes('DRY') && entry.safetyClass !== 'PURE_READ_IDEMPOTENT') {
    return refuse('MODIFIER_MUTATION_FORBIDDEN', '+DRY cannot be used on a command that is not read-only', { command: entry.id });
  }

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

  // Gates. +FAST never removes one: every gate below applies to every modifier combination.
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
    for (const [kind, ref] of suppliedRefs) {
      let verdict: ReferenceVerdict;
      try {
        verdict = await verifier.verify({ kind, ref, product: entry.product, command: entry.id, targetId: request.targetId, nodeId: node?.nodeId ?? null, dataClass: entry.dataClass });
      } catch {
        verdict = { status: 'UNAVAILABLE' };
      }
      if (verdict.status !== 'VERIFIED') return verdictRefusal(kind, verdict);
    }
    referencesVerified = true;
  }

  if (entry.invokesReach && !isKnownOperation(entry.reachOperation!)) {
    return refuse('OPERATION_NOT_IN_CATALOGUE', 'manifest names an operation REACH does not catalogue', {
      command: entry.id,
      reachOperation: entry.reachOperation ?? 'none'
    });
  }
  return {
    ok: true,
    nodeId: node?.nodeId ?? null,
    command: entry,
    reachOperation: entry.reachOperation,
    effective: { dryRun: modifiers.includes('DRY'), authorityFromModifiers: false, gatesSkipped: false },
    referencesVerified
  };
}

export type HandoffEnvelope = {
  handoffVersion: string;
  fromProduct: DexProductId;
  toProduct: DexProductId;
  command: string;
  schemaId: string;
  payloadSha256: string;
  dataClass: DataClass;
  promotionRef?: string;
};

const HANDOFF_KEYS = new Set(['handoffVersion', 'fromProduct', 'toProduct', 'command', 'schemaId', 'payloadSha256', 'dataClass', 'promotionRef']);

/**
 * Receiver-side validation. The receiver checks the envelope against its own manifest and policy and
 * never trusts a sender's claim of authorization. Nothing is applied on refusal.
 */
export function validateHandoff(raw: unknown, receiver: LoadedManifest): { ok: true; envelope: HandoffEnvelope } | RouterRefusal {
  const invalid = (reason: string) => refuse('HANDOFF_INVALID', reason);
  if (!isPlainObject(raw)) return invalid('handoff must be an object');
  for (const key of Object.keys(raw)) {
    if (!HANDOFF_KEYS.has(key)) return invalid(`unknown handoff field ${key}`);
  }
  if (typeof raw.handoffVersion !== 'string' || semverMajor(raw.handoffVersion) !== DEX_CONTRACT_MAJOR) {
    return invalid('handoffVersion major does not match the pinned major');
  }
  if (!DEX_PRODUCT_IDS.includes(raw.fromProduct as DexProductId) || !DEX_PRODUCT_IDS.includes(raw.toProduct as DexProductId)) {
    return invalid('fromProduct and toProduct must be known DEX products');
  }
  if (raw.fromProduct === 'WITNESS' && raw.toProduct === 'REMIX') {
    return refuse('WITNESS_REMIX_EDGE_FORBIDDEN', 'WITNESS evidence may never hand off to REMIX');
  }
  if (typeof raw.command !== 'string') return invalid('command must be a string');
  const command = receiver.commands.get(raw.command);
  if (!command) return refuse('UNKNOWN_COMMAND', 'handoff command is not in the receiver manifest', { command: raw.command });
  if (command.product !== raw.toProduct) return invalid('handoff command does not belong to the receiving product');
  if (typeof raw.schemaId !== 'string' || raw.schemaId.length === 0 || raw.schemaId.length > 128) return invalid('schemaId is invalid');
  if (typeof raw.payloadSha256 !== 'string' || !SHA256_HEX.test(raw.payloadSha256)) return invalid('payloadSha256 must be 64 lowercase hex characters');
  if (!DATA_CLASSES.includes(raw.dataClass as DataClass)) return invalid('dataClass is invalid');
  if (raw.dataClass !== 'PUBLIC' && (typeof raw.promotionRef !== 'string' || raw.promotionRef.length === 0)) {
    return refuse('DATA_NOT_PROMOTED', `${raw.dataClass} handoff requires an explicit promotion`, { command: command.id });
  }
  return { ok: true, envelope: raw as unknown as HandoffEnvelope };
}

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
