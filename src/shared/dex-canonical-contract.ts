/**
 * REACH-side consumer of the canonical DEX command manifest (DEX ADR-0013, `@dex/router` manifest 1.0.0).
 *
 * DEX owns command semantics: identities, scopes, mutation levels, modifiers and workflows. This module
 * validates the shape DEX publishes and keeps it as inert data. It never derives a REACH operation,
 * permission or node requirement from a command name, scope or workflow id; those come only from an
 * explicit REACH-owned mapping (see `dex-command-router.ts`).
 *
 * No DEX command roster is stored in this file; it holds only the contract vocabulary (enumerations) that the
 * shape is validated against. The owner-approved roster snapshot lives in tests/fixtures/dex-router.
 */

export const DEX_CONTRACT_MAJOR = 1;

/** The ten plus-prefixed modifiers declared by DEX ADR-0013 section 5. */
export const DEX_MODIFIERS = ['+LOG', '+PROVE', '+AWE', '+PERF', '+DEEP', '+FAST', '+DRY', '+NO-REGRESS', '+MOBILE', '+SHIP'] as const;
export type DexModifier = (typeof DEX_MODIFIERS)[number];

export const DEX_COMMAND_CLASSES = ['READ', 'WORKFLOW', 'MUTATE', 'CONTROL', 'ADMIN'] as const;
export type DexCommandClass = (typeof DEX_COMMAND_CLASSES)[number];

/** Ordered from least to most consequential. The order is what makes a monotonic comparison possible. */
export const DEX_MUTATION_LEVELS = ['NONE', 'STAGED', 'COMMIT', 'DESTRUCTIVE'] as const;
export type DexMutationLevel = (typeof DEX_MUTATION_LEVELS)[number];

/** Product adapter ids as DEX publishes them (lowercase, `DexProductId` in `productAdapter.ts`). */
export const DEX_PRODUCT_IDS = ['session', 'capsule', 'museum', 'remix', 'sidequest', 'dropzone', 'pair', 'witness'] as const;
export type DexProductId = (typeof DEX_PRODUCT_IDS)[number];

/** Command scopes. Eight name a product; the other four are control-plane scopes and are not products. */
export const DEX_PRODUCT_SCOPES = ['SESSION', 'DROPZONE', 'PAIR', 'CAPSULE', 'MUSEUM', 'REMIX', 'SIDEQUEST', 'WITNESS'] as const;
export const DEX_NON_PRODUCT_SCOPES = ['REACH', 'MAINT', 'CONTROL_ROOM', 'GLOBAL'] as const;
export const DEX_SCOPES = [...DEX_PRODUCT_SCOPES, ...DEX_NON_PRODUCT_SCOPES] as const;
export type DexScope = (typeof DEX_SCOPES)[number];

export const DEX_OBJECT_KINDS = ['task', 'room', 'artifact', 'case', 'quest'] as const;
export const DEX_TRUST_DOMAINS = ['remote-control', 'maintenance', 'product', 'evidence', 'control'] as const;
export type DexTrustDomain = (typeof DEX_TRUST_DOMAINS)[number];

/** The shape of one entry in DEX's `DEX_COMMAND_MANIFEST`. `appCommand`, `aliases` and `effect` are descriptive only. */
export type CanonicalCommand = {
  readonly name: string;
  readonly canonical: string;
  readonly slash: string;
  readonly aliases: readonly string[];
  readonly commandClass: DexCommandClass;
  readonly scope: DexScope;
  readonly mutationLevel: DexMutationLevel;
  readonly objectKinds: readonly string[];
  readonly supportedModifiers: readonly DexModifier[];
  readonly workflowId: string;
  readonly outputs: readonly string[];
  readonly skillBinding: string | null;
  readonly effect: string;
  readonly appCommand: string | null;
  readonly trustDomain: DexTrustDomain;
};

export type CanonicalManifest = {
  /** DEX's `DEX_COMMAND_MANIFEST_VERSION`. */
  readonly manifestVersion: string;
  readonly synthetic: boolean;
  /** Insertion order is DEX's order. Keyed by `DEX//NAME`. */
  readonly commands: ReadonlyMap<string, CanonicalCommand>;
};

export type ContractRefusalCode = 'MANIFEST_INVALID' | 'DEX_CONTRACT_MAJOR_MISMATCH' | 'SYNTHETIC_MANIFEST_IN_PRODUCTION';
export type ContractRefusal = {
  ok: false;
  code: ContractRefusalCode;
  message: string;
  details?: Record<string, string | number | boolean | null>;
};
export type CanonicalLoadResult = { ok: true; manifest: CanonicalManifest } | ContractRefusal;

const ENVELOPE_KEYS = new Set(['manifestVersion', 'synthetic', 'commands']);
const ENTRY_KEYS = new Set<string>([
  'name', 'canonical', 'slash', 'aliases', 'commandClass', 'scope', 'mutationLevel', 'objectKinds',
  'supportedModifiers', 'workflowId', 'outputs', 'skillBinding', 'effect', 'appCommand', 'trustDomain'
]);
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const COMMAND_NAME = /^[A-Z][A-Z0-9_]{1,31}$/;

export function semverMajor(version: string): number | null {
  const match = SEMVER.exec(version);
  return match ? Number(match[1]) : null;
}

export function isSemver(value: unknown): value is string {
  return typeof value === 'string' && SEMVER.test(value);
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalid(message: string, details?: ContractRefusal['details']): ContractRefusal {
  return { ok: false, code: 'MANIFEST_INVALID', message, ...(details ? { details } : {}) };
}

const isStringArray = (value: unknown): value is string[] => Array.isArray(value) && value.every(item => typeof item === 'string');
const oneOf = <T extends string>(list: readonly T[], value: unknown): value is T => typeof value === 'string' && (list as readonly string[]).includes(value);

/**
 * Validate a canonical DEX manifest envelope: `{ manifestVersion, commands }`, where `commands` is DEX's
 * `DEX_COMMAND_MANIFEST` and `manifestVersion` is DEX's `DEX_COMMAND_MANIFEST_VERSION`.
 *
 * Fails closed: a different contract major is refused before any field validation, unknown keys are refused
 * at both levels, and nothing is coerced. `dex-command-manifest.v1.json`, named by ADR-0013 as a publication
 * target, is not required to exist; any producer that emits this envelope is accepted.
 */
export function loadCanonicalManifest(raw: unknown, options: { production?: boolean } = {}): CanonicalLoadResult {
  if (!isPlainObject(raw)) return invalid('canonical manifest must be a JSON object');
  if (!isSemver(raw.manifestVersion)) return invalid('manifestVersion must be semver');
  const major = semverMajor(raw.manifestVersion)!;
  if (major !== DEX_CONTRACT_MAJOR) {
    return {
      ok: false,
      code: 'DEX_CONTRACT_MAJOR_MISMATCH',
      message: `manifest contract major ${major} is not the pinned major ${DEX_CONTRACT_MAJOR}`,
      details: { expectedMajor: DEX_CONTRACT_MAJOR, actualVersion: raw.manifestVersion }
    };
  }
  for (const key of Object.keys(raw)) {
    if (!ENVELOPE_KEYS.has(key)) return invalid(`unknown manifest field: ${key}`);
  }
  if (raw.synthetic !== undefined && typeof raw.synthetic !== 'boolean') return invalid('synthetic must be a boolean');
  if (options.production && raw.synthetic === true) {
    return { ok: false, code: 'SYNTHETIC_MANIFEST_IN_PRODUCTION', message: 'a synthetic manifest cannot be loaded as production configuration' };
  }
  if (!Array.isArray(raw.commands) || raw.commands.length === 0) return invalid('commands must be a non-empty array');

  const commands = new Map<string, CanonicalCommand>();
  const slashForms = new Set<string>();
  for (const [index, entry] of raw.commands.entries()) {
    const bad = (reason: string) => invalid(`commands[${index}]: ${reason}`);
    if (!isPlainObject(entry)) return bad('must be an object');
    for (const key of Object.keys(entry)) {
      if (!ENTRY_KEYS.has(key)) return bad(`unknown field ${key}`);
    }
    for (const key of ENTRY_KEYS) {
      if (!(key in entry)) return bad(`missing field ${key}`);
    }
    if (typeof entry.name !== 'string' || !COMMAND_NAME.test(entry.name)) return bad('name is not a canonical command name');
    if (entry.canonical !== `DEX//${entry.name}`) return bad('canonical must be DEX//<name>');
    if (entry.slash !== `/${entry.name.toLowerCase()}`) return bad('slash must be /<name> in lowercase');
    if (commands.has(entry.canonical) || slashForms.has(entry.slash)) return invalid(`duplicate command ${entry.canonical}`);
    if (!isStringArray(entry.aliases)) return bad('aliases must be an array of strings');
    if (!oneOf(DEX_COMMAND_CLASSES, entry.commandClass)) return bad('commandClass is not a DEX command class');
    if (!oneOf(DEX_SCOPES, entry.scope)) return bad('scope is not a DEX scope');
    if (!oneOf(DEX_MUTATION_LEVELS, entry.mutationLevel)) return bad('mutationLevel is not a DEX mutation level');
    if (!isStringArray(entry.objectKinds) || entry.objectKinds.some(kind => !(DEX_OBJECT_KINDS as readonly string[]).includes(kind))) return bad('objectKinds contains an unknown kind');
    const supported = entry.supportedModifiers;
    if (!Array.isArray(supported) || new Set(supported).size !== supported.length || supported.some(m => !oneOf(DEX_MODIFIERS, m))) {
      return bad('supportedModifiers must be a unique list of DEX modifiers');
    }
    if (typeof entry.workflowId !== 'string' || entry.workflowId.length === 0) return bad('workflowId must be a non-empty string');
    if (!isStringArray(entry.outputs)) return bad('outputs must be an array of strings');
    if (entry.skillBinding !== null && typeof entry.skillBinding !== 'string') return bad('skillBinding must be a string or null');
    if (typeof entry.effect !== 'string') return bad('effect must be a string');
    if (entry.appCommand !== null && typeof entry.appCommand !== 'string') return bad('appCommand must be a string or null');
    if (!oneOf(DEX_TRUST_DOMAINS, entry.trustDomain)) return bad('trustDomain is not a DEX trust domain');

    slashForms.add(entry.slash);
    commands.set(entry.canonical, {
      name: entry.name,
      canonical: entry.canonical,
      slash: entry.slash,
      aliases: [...entry.aliases],
      commandClass: entry.commandClass,
      scope: entry.scope,
      mutationLevel: entry.mutationLevel,
      objectKinds: [...entry.objectKinds],
      supportedModifiers: [...(supported as DexModifier[])],
      workflowId: entry.workflowId,
      outputs: [...entry.outputs],
      skillBinding: entry.skillBinding,
      effect: entry.effect,
      appCommand: entry.appCommand,
      trustDomain: entry.trustDomain
    });
  }
  return { ok: true, manifest: { manifestVersion: raw.manifestVersion, synthetic: raw.synthetic === true, commands } };
}

/** The product a scope names, or null for the control-plane scopes (REACH, MAINT, CONTROL_ROOM, GLOBAL). */
export function productForScope(scope: DexScope): DexProductId | null {
  return (DEX_PRODUCT_SCOPES as readonly string[]).includes(scope) ? (scope.toLowerCase() as DexProductId) : null;
}
