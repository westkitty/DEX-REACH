import type { ReachCapability } from './capabilities.js';
import { REACH_CAPABILITIES } from './capabilities.js';
import type { CheckpointStrategy, CompatibilityToolDescriptor, OperationRiskClass } from './operations.js';
import { COMPATIBILITY_TOOLS, OPERATION_RISK_ORDER, describeCompatibilityTool } from './operations.js';

/**
 * The DEX Capability Adapter contract.
 *
 * An adapter is third-party code that DEX may route a call to. It is not a peer of the authority
 * layer and it never decides what it is allowed to do. The contract here is deliberately one-way:
 *
 *   - An adapter *declares* what each of its tools is, in a manifest.
 *   - DEX holds its own authority catalog for those tools (`COMPATIBILITY_TOOLS`).
 *   - Admission requires the declaration and the catalog to agree on every authority fact.
 *   - A declaration that is absent, incomplete, or disagrees with the catalog is REFUSED.
 *
 * So a manifest can only ever *fail* to admit a tool. It cannot raise a tool's privileges, invent a
 * capability, mark a shell tool workspace-safe, or introduce a tool DEX has not classified. That is
 * what "the adapter does not determine its own effective DEX authority" means in code: the manifest
 * is a claim to be checked, and the catalog is the answer.
 *
 * Nothing here evaluates owner mode, client ceilings, grants, roots or budgets. Admission by this
 * contract is not authorization; it only decides whether a tool is describable at all.
 */

/** Semantics for undoing an adapter tool's effect, declared per tool rather than assumed. */
export type AdapterReversibility =
  /** Observation only. Nothing to undo. */
  | 'none'
  /** Effect is confined to declared roots and a checkpoint can capture the prior state. */
  | 'checkpoint'
  /** Effect cannot be undone by DEX once it has happened. */
  | 'irreversible';

export type AdapterToolDeclaration = {
  tool: string;
  capability: ReachCapability;
  risk: OperationRiskClass;
  mutation: boolean;
  network: boolean;
  /** Argument field names that carry filesystem paths, so boundary checks know where to look. */
  pathArguments: readonly string[];
  workspaceSafeAllowed: boolean;
  supportsPlan: boolean;
  remoteBlocked: boolean;
  reversibility: AdapterReversibility;
  checkpointStrategy: CheckpointStrategy;
};

export type AdapterManifest = {
  /** Stable adapter identity, used in refusals and evidence. */
  adapter: string;
  /** The adapter's own version, as DEX observed it rather than as the adapter advertises it. */
  version: string;
  /** Package or module identity the adapter was resolved from. */
  source: string;
  /** Hash of the adapter entry point at load time, or null when it could not be read. */
  sourceHash: string | null;
  tools: readonly AdapterToolDeclaration[];
};

export type AdapterAdmission = {
  manifest: AdapterManifest;
  /** Tools whose declaration matched the DEX catalog exactly. */
  admitted: readonly AdapterToolDeclaration[];
  /** One refusal line per rejected tool or structural problem. Non-empty means do not install. */
  refusals: readonly string[];
};

const REVERSIBILITY: readonly AdapterReversibility[] = ['none', 'checkpoint', 'irreversible'];
const CHECKPOINT_STRATEGIES: readonly CheckpointStrategy[] = ['none', 'git-if-available', 'required'];

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string' && item.length > 0);
}

/**
 * Structural validation of one tool declaration.
 *
 * Every field is required. An absent field is not defaulted, because a default is DEX guessing on
 * the adapter's behalf, and the safe-looking guess (`network: false`, `mutation: false`) is exactly
 * the one an incomplete manifest would benefit from.
 */
export function decodeAdapterToolDeclaration(value: unknown): AdapterToolDeclaration | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  if (!isNonEmptyString(raw.tool)) return null;
  if (!(REACH_CAPABILITIES as readonly string[]).includes(String(raw.capability))) return null;
  if (!(OPERATION_RISK_ORDER as readonly string[]).includes(String(raw.risk))) return null;
  if (typeof raw.mutation !== 'boolean') return null;
  if (typeof raw.network !== 'boolean') return null;
  if (!isStringArray(raw.pathArguments)) return null;
  if (typeof raw.workspaceSafeAllowed !== 'boolean') return null;
  if (typeof raw.supportsPlan !== 'boolean') return null;
  if (typeof raw.remoteBlocked !== 'boolean') return null;
  if (!(REVERSIBILITY as readonly string[]).includes(String(raw.reversibility))) return null;
  if (!(CHECKPOINT_STRATEGIES as readonly string[]).includes(String(raw.checkpointStrategy))) return null;
  return {
    tool: raw.tool,
    capability: raw.capability as ReachCapability,
    risk: raw.risk as OperationRiskClass,
    mutation: raw.mutation,
    network: raw.network,
    pathArguments: [...raw.pathArguments],
    workspaceSafeAllowed: raw.workspaceSafeAllowed,
    supportsPlan: raw.supportsPlan,
    remoteBlocked: raw.remoteBlocked,
    reversibility: raw.reversibility as AdapterReversibility,
    checkpointStrategy: raw.checkpointStrategy as CheckpointStrategy
  };
}

export function decodeAdapterManifest(value: unknown): AdapterManifest | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  if (!isNonEmptyString(raw.adapter)) return null;
  if (!isNonEmptyString(raw.version)) return null;
  if (!isNonEmptyString(raw.source)) return null;
  if (!(raw.sourceHash === null || isNonEmptyString(raw.sourceHash))) return null;
  if (!Array.isArray(raw.tools)) return null;
  const tools: AdapterToolDeclaration[] = [];
  const seen = new Set<string>();
  for (const entry of raw.tools) {
    const decoded = decodeAdapterToolDeclaration(entry);
    // One malformed declaration invalidates the manifest rather than being skipped. Skipping would
    // silently install a partial adapter whose missing tools then look like tools it does not have.
    if (!decoded) return null;
    if (seen.has(decoded.tool)) return null;
    seen.add(decoded.tool);
    tools.push(decoded);
  }
  return {
    adapter: raw.adapter,
    version: raw.version,
    source: raw.source,
    sourceHash: raw.sourceHash === null ? null : (raw.sourceHash as string),
    tools
  };
}

/** The authority facts DEX compares a declaration against. Order is the refusal message order. */
const AUTHORITY_FACTS: readonly (keyof CompatibilityToolDescriptor)[] = [
  'capability', 'risk', 'mutation', 'network', 'workspaceSafeAllowed', 'supportsPlan', 'remoteBlocked', 'checkpointStrategy'
];

function factsDisagree(declared: AdapterToolDeclaration, known: CompatibilityToolDescriptor): string[] {
  const mismatches: string[] = [];
  for (const fact of AUTHORITY_FACTS) {
    const ours = known[fact];
    const theirs = declared[fact as keyof AdapterToolDeclaration];
    if (ours !== theirs) mismatches.push(`${String(fact)} declared ${JSON.stringify(theirs)} but DEX classifies it ${JSON.stringify(ours)}`);
  }
  const knownPaths = [...known.pathArguments].sort();
  const declaredPaths = [...declared.pathArguments].sort();
  if (knownPaths.length !== declaredPaths.length || knownPaths.some((name, index) => name !== declaredPaths[index])) {
    mismatches.push(`pathArguments declared ${JSON.stringify(declaredPaths)} but DEX classifies them ${JSON.stringify(knownPaths)}`);
  }
  // Reversibility is the adapter's to state and DEX's to sanity-check: a tool that mutates cannot
  // honestly be `none`, and one that DEX requires a checkpoint for cannot be `none` either.
  if (declared.mutation && declared.reversibility === 'none') {
    mismatches.push('reversibility "none" is not possible for a tool that mutates');
  }
  if (known.checkpointStrategy === 'required' && declared.reversibility === 'none') {
    mismatches.push('reversibility "none" contradicts a required checkpoint');
  }
  return mismatches;
}

/**
 * Check a manifest against DEX's own catalog and return what may be installed.
 *
 * Refusal, not repair: a tool DEX cannot corroborate is left out of `admitted` and the reason is
 * recorded. A manifest with any refusal must not be installed, because a partially admitted adapter
 * is an adapter whose surface DEX and its operator disagree about.
 */
export function admitAdapterManifest(manifest: AdapterManifest): AdapterAdmission {
  const refusals: string[] = [];
  const admitted: AdapterToolDeclaration[] = [];
  const declaredTools = new Set(manifest.tools.map(tool => tool.tool));

  for (const declared of manifest.tools) {
    const known = describeCompatibilityTool(declared.tool);
    if (!known) {
      refusals.push(`${manifest.adapter}: tool "${declared.tool}" is not classified by DEX; an undeclared tool is refused`);
      continue;
    }
    if (known.adapter !== manifest.adapter) {
      refusals.push(`${manifest.adapter}: tool "${declared.tool}" belongs to adapter "${known.adapter}"; an adapter cannot claim another adapter's tool`);
      continue;
    }
    const mismatches = factsDisagree(declared, known);
    if (mismatches.length) {
      for (const mismatch of mismatches) refusals.push(`${manifest.adapter}: tool "${declared.tool}" ${mismatch}`);
      continue;
    }
    admitted.push(declared);
  }

  // A tool DEX classifies for this adapter but the manifest omits is also a disagreement. Without
  // this the adapter could quietly drop a tool from its manifest and DEX's remote surface count,
  // which is what proves no widening, would silently shrink to match.
  //
  // Scoped to the tools DEX attributes to *this* adapter. Comparing against the whole catalog would
  // refuse every second adapter for failing to declare the first adapter's tools.
  for (const known of COMPATIBILITY_TOOLS) {
    if (known.adapter !== manifest.adapter) continue;
    if (!declaredTools.has(known.tool)) {
      refusals.push(`${manifest.adapter}: DEX classifies tool "${known.tool}" but the manifest does not declare it`);
    }
  }

  return { manifest, admitted, refusals };
}

export class AdapterInstallRefused extends Error {
  readonly refusals: readonly string[];
  constructor(adapter: string, refusals: readonly string[]) {
    super(`adapter ${adapter} refused: ${refusals.join('; ')}`);
    this.name = 'AdapterInstallRefused';
    this.refusals = refusals;
  }
}

/**
 * Installed adapters and the tools DEX will route to them.
 *
 * The registry is node-local and owner-installed. There is deliberately no remote install, update,
 * manifest edit or policy mutation path: a remote client can ask what is installed and can call an
 * admitted tool, and that is the whole of its reach into this object.
 */
export class AdapterRegistry {
  private readonly adapters = new Map<string, AdapterAdmission>();

  /** Install an already-decoded manifest. Any refusal aborts the whole install. */
  install(manifest: AdapterManifest): AdapterAdmission {
    const admission = admitAdapterManifest(manifest);
    const refusals = [...admission.refusals];
    // Two adapters providing one tool name would make `resolveTool` answer from whichever was
    // installed first, so the same call would route somewhere that depends on install order.
    // Ambiguous provenance is refused rather than resolved by a tiebreak. With per-tool attribution
    // in the catalog this is defence in depth and currently unreachable: a tool belongs to exactly
    // one adapter, so a second claimant is already refused above. It stays because the cost is a
    // loop and the failure it guards against is silent misrouting.
    for (const declared of admission.admitted) {
      const existing = this.providerOf(declared.tool);
      if (existing && existing.adapter !== manifest.adapter) {
        refusals.push(`${manifest.adapter}: tool "${declared.tool}" is already provided by adapter "${existing.adapter}"`);
      }
    }
    if (refusals.length) throw new AdapterInstallRefused(manifest.adapter, refusals);
    this.adapters.set(manifest.adapter, admission);
    return admission;
  }

  /** Install from untrusted manifest data. A manifest that does not decode is refused outright. */
  installFrom(value: unknown): AdapterAdmission {
    const manifest = decodeAdapterManifest(value);
    if (!manifest) throw new AdapterInstallRefused('unknown', ['manifest is malformed or incomplete; adapter installation fails closed']);
    return this.install(manifest);
  }

  installed(): AdapterManifest[] {
    return [...this.adapters.values()].map(admission => admission.manifest);
  }

  /**
   * The DEX-side authority for one tool, or null when no installed adapter declares it.
   *
   * This returns the catalog entry rather than the manifest declaration. They were proven equal at
   * install time; returning the catalog means a later mutation of a manifest object in memory still
   * cannot change what DEX enforces.
   */
  resolveTool(tool: string): CompatibilityToolDescriptor | null {
    for (const admission of this.adapters.values()) {
      if (admission.admitted.some(declared => declared.tool === tool)) {
        return describeCompatibilityTool(tool) ?? null;
      }
    }
    return null;
  }

  /** Which adapter provides a tool, for refusals and evidence. */
  providerOf(tool: string): AdapterManifest | null {
    for (const admission of this.adapters.values()) {
      if (admission.admitted.some(declared => declared.tool === tool)) return admission.manifest;
    }
    return null;
  }

  /** Tool names a remote client may name. Remote-blocked tools are absent, not merely refused. */
  remoteToolSurface(): string[] {
    const names = new Set<string>();
    for (const admission of this.adapters.values()) {
      for (const declared of admission.admitted) {
        if (!declared.remoteBlocked) names.add(declared.tool);
      }
    }
    return [...names].sort();
  }

  /** Identity evidence for the trust report and evidence bundles. Carries no tool arguments. */
  identityEvidence(): Array<{ adapter: string; version: string; source: string; sourceHash: string | null; tools: number; remoteTools: number }> {
    return [...this.adapters.values()].map(admission => ({
      adapter: admission.manifest.adapter,
      version: admission.manifest.version,
      source: admission.manifest.source,
      sourceHash: admission.manifest.sourceHash,
      tools: admission.admitted.length,
      remoteTools: admission.admitted.filter(declared => !declared.remoteBlocked).length
    }));
  }
}

/**
 * Refusal for a tool a remote client named, or null when the tool may be routed.
 *
 * Fails closed in both directions: a tool no installed adapter provides is refused, and a tool that
 * is provided but remote-blocked is refused with the same shape, so probing cannot distinguish
 * "blocked" from "absent" by message alone.
 */
export function remoteAdapterToolRefusal(registry: AdapterRegistry, tool: string): string | null {
  const descriptor = registry.resolveTool(tool);
  if (!descriptor) return `no installed adapter provides the tool "${tool}"`;
  if (descriptor.remoteBlocked) return `no installed adapter provides the tool "${tool}"`;
  return null;
}
