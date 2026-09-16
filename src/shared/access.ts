import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import type { AccessMode, AccessSnapshot, ClientKind, ReachProfile, RequestActor } from './protocol.js';
import { stateDir } from './local-env.js';
import { operationCapability, requestPaths, rootsCover, type CapabilityGrant, type ReachCapability } from './capabilities.js';
import { atomicWriteFile, withFileLock } from './state-io.js';
import { hashValue } from './hash.js';

export type AccessState = {
  version: 3;
  revision: number;
  mode: AccessMode;
  until: string | null;
  revertTo: AccessMode | null;
  clients: Partial<Record<ClientKind, AccessMode>>;
  grantRequired: Partial<Record<ClientKind, boolean>>;
  grants: CapabilityGrant[];
  updatedAt: string;
};

export const ACCESS_MODES: readonly AccessMode[] = ['off', 'read-only', 'on'];
const RANK: Record<AccessMode, number> = { off: 0, 'read-only': 1, on: 2 };
const READ_OPERATIONS = new Set(['dex.fingerprint', 'dex.repoInfo', 'dex.adbDevices', 'dex.file.read', 'dex.result.read', 'dex.receipts.list']);

export function isAccessMode(value: unknown): value is AccessMode {
  return typeof value === 'string' && (ACCESS_MODES as string[]).includes(value);
}
export function minMode(a: AccessMode, b: AccessMode): AccessMode { return RANK[a] <= RANK[b] ? a : b; }
export function accessFile(nodeId: string, dir = stateDir()): string { return path.join(dir, 'nodes', `${nodeId}.access.json`); }
function accessLockFile(nodeId: string, dir = stateDir()): string { return `${accessFile(nodeId, dir)}.lock`; }

export function defaultAccessState(now = new Date()): AccessState {
  const initial = process.env.DEX_REACH_INITIAL_ACCESS;
  return {
    version: 3,
    revision: 0,
    mode: isAccessMode(initial) ? initial : 'off',
    until: null,
    revertTo: null,
    clients: {},
    grantRequired: {},
    grants: [],
    updatedAt: now.toISOString()
  };
}

function sanitizeClients(value: unknown): Partial<Record<ClientKind, AccessMode>> {
  const out: Partial<Record<ClientKind, AccessMode>> = {};
  if (!value || typeof value !== 'object') return out;
  for (const [kind, mode] of Object.entries(value as Record<string, unknown>)) {
    if (['chatgpt','claude','smoke','other'].includes(kind) && isAccessMode(mode)) out[kind as ClientKind] = mode;
  }
  return out;
}
function sanitizeGrantRequired(value: unknown): Partial<Record<ClientKind, boolean>> {
  const out: Partial<Record<ClientKind, boolean>> = {};
  if (!value || typeof value !== 'object') return out;
  for (const [kind, enabled] of Object.entries(value as Record<string, unknown>)) {
    if (['chatgpt','claude','smoke','other'].includes(kind) && typeof enabled === 'boolean') out[kind as ClientKind] = enabled;
  }
  return out;
}
function sanitizeGrants(value: unknown): CapabilityGrant[] {
  if (!Array.isArray(value)) return [];
  return value.filter((grant): grant is CapabilityGrant => {
    if (!grant || typeof grant !== 'object') return false;
    const g = grant as Partial<CapabilityGrant>;
    return typeof g.id === 'string' && typeof g.client === 'string' && Array.isArray(g.capabilities) &&
      Array.isArray(g.roots) && typeof g.until === 'string' && typeof g.uses === 'number' &&
      (g.maxUses === null || typeof g.maxUses === 'number') && typeof g.createdAt === 'string';
  });
}

function decodeAccessState(parsed: unknown): AccessState {
  if (!parsed || typeof parsed !== 'object') throw new Error('unsupported access state');
  const value = parsed as Partial<AccessState> & { version?: number };
  const version = Number(value.version ?? 1);
  if (![1, 2, 3].includes(version) || !isAccessMode(value.mode)) throw new Error('unsupported access state');
  return {
    version: 3,
    revision: Number.isInteger(value.revision) && Number(value.revision) >= 0 ? Number(value.revision) : 0,
    mode: value.mode,
    until: typeof value.until === 'string' ? value.until : null,
    revertTo: isAccessMode(value.revertTo) ? value.revertTo : null,
    clients: sanitizeClients(value.clients),
    grantRequired: sanitizeGrantRequired(value.grantRequired),
    grants: sanitizeGrants(value.grants),
    updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : new Date(0).toISOString()
  };
}

type AccessRead = { state: AccessState; exists: boolean; valid: boolean };
async function readAccessStateUnlocked(nodeId: string, dir: string): Promise<AccessRead> {
  try {
    const parsed = JSON.parse(await fs.readFile(accessFile(nodeId, dir), 'utf8')) as unknown;
    return { state: decodeAccessState(parsed), exists: true, valid: true };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { state: defaultAccessState(), exists: false, valid: true };
    return { state: { ...defaultAccessState(), mode: 'off' }, exists: true, valid: false };
  }
}

export async function loadAccessState(nodeId: string, dir = stateDir()): Promise<AccessState> {
  return (await readAccessStateUnlocked(nodeId, dir)).state;
}

export async function inspectAccessPolicyFile(nodeId: string, dir = stateDir()): Promise<{ valid: boolean; exists: boolean; state: AccessState; errors: string[] }> {
  const read = await readAccessStateUnlocked(nodeId, dir);
  const errors = read.exists && read.valid ? policyCheck(read.state) : [read.exists ? 'policy file is corrupt and therefore fails closed' : 'policy file is missing and therefore fails closed'];
  return { valid: read.exists && read.valid && errors.length === 0, exists: read.exists, state: read.state, errors };
}

async function writeAccessStateUnlocked(nodeId: string, state: AccessState, revision: number, dir: string): Promise<AccessState> {
  const next: AccessState = { ...state, version: 3, revision, updatedAt: new Date().toISOString() };
  const errors = policyCheck(next);
  if (errors.length) throw new Error(`policy assertions failed: ${errors.join('; ')}`);
  await atomicWriteFile(accessFile(nodeId, dir), JSON.stringify(next, null, 2) + '\n', 0o600);
  return next;
}

/**
 * Save a state that was previously loaded. Revision comparison prevents a stale writer from restoring
 * an older mode after the machine owner changed policy in another process.
 */
export async function saveAccessState(nodeId: string, state: AccessState, dir = stateDir()): Promise<void> {
  await withFileLock(accessLockFile(nodeId, dir), async () => {
    const current = await readAccessStateUnlocked(nodeId, dir);
    if (current.exists && !current.valid) throw new Error('access policy is corrupt; use an owner update command to repair it from the fail-closed state');
    if (current.exists && state.revision !== current.state.revision) {
      throw new Error('access policy changed since it was loaded; reload before saving');
    }
    await writeAccessStateUnlocked(nodeId, state, current.exists ? current.state.revision + 1 : Math.max(1, state.revision + 1), dir);
  });
}

/** Owner-safe read/modify/write mutation under one cross-process lock. */
export async function updateAccessState(
  nodeId: string,
  mutate: (current: AccessState) => AccessState | Promise<AccessState>,
  dir = stateDir()
): Promise<AccessState> {
  return withFileLock(accessLockFile(nodeId, dir), async () => {
    const current = (await readAccessStateUnlocked(nodeId, dir)).state;
    const proposed = await mutate(current);
    return writeAccessStateUnlocked(nodeId, proposed, current.revision + 1, dir);
  });
}

export function resolveMode(state: AccessState, now = Date.now()): AccessMode {
  return state.until && Date.parse(state.until) <= now ? (state.revertTo ?? 'off') : state.mode;
}
export function snapshot(state: AccessState, now = Date.now()): AccessSnapshot {
  return { mode: state.mode, effectiveMode: resolveMode(state, now), until: state.until, revertTo: state.revertTo, clients: { ...state.clients } };
}
export function modeForActor(state: AccessState, actor: RequestActor | undefined, now = Date.now()): AccessMode {
  const base = resolveMode(state, now);
  const kind: ClientKind = actor?.kind ?? 'other';
  const ceiling = state.clients[kind];
  return ceiling ? minMode(base, ceiling) : base;
}

export type AccessDecision = { allowed: true; effectiveProfile: ReachProfile; grantId?: string } | { allowed: false; reason: string };

function activeGrant(state: AccessState, actor: RequestActor | undefined, operation: string, args: Record<string, unknown>, now = Date.now()): CapabilityGrant | null {
  const kind = actor?.kind ?? 'other';
  const capability = operationCapability(operation);
  const paths = requestPaths(args);
  return state.grants.find(grant => grant.client === kind && Date.parse(grant.until) > now &&
    (grant.maxUses === null || grant.uses < grant.maxUses) && grant.capabilities.includes(capability) && rootsCover(paths, grant.roots)) ?? null;
}

export function authorizeOperation(state: AccessState, actor: RequestActor | undefined, operation: string, profile: ReachProfile, now = Date.now(), args: Record<string, unknown> = {}): AccessDecision {
  const mode = modeForActor(state, actor, now);
  const who = actor ? `${actor.clientName} (${actor.kind})` : 'an unidentified client';
  const base = resolveMode(state, now);
  const scope = state.clients[actor?.kind ?? 'other'] && RANK[mode] < RANK[base] ? `for ${actor?.kind ?? 'other'} clients` : 'on this node';
  if (mode === 'off') return { allowed: false, reason: `NODE OWNER has disabled remote AI execution ${scope}; ${operation} from ${who} was refused locally` };
  if (mode === 'read-only') {
    if (READ_OPERATIONS.has(operation)) return { allowed: true, effectiveProfile: 'read-only' };
    if (operation === 'dex.process.run' || operation === 'dc.call') return { allowed: true, effectiveProfile: 'read-only' };
    return { allowed: false, reason: `NODE OWNER limited remote AI access to read-only ${scope}; ${operation} from ${who} is a mutation and was refused locally` };
  }
  const kind = actor?.kind ?? 'other';
  if (operation === 'dex.plan' || operation === 'dex.commitPlan') return { allowed: true, effectiveProfile: profile };
  if (state.grantRequired[kind]) {
    const grant = activeGrant(state, actor, operation, args, now);
    if (!grant) return { allowed: false, reason: `NODE OWNER requires an active capability grant for ${kind}; ${operation} from ${who} was refused locally` };
    return { allowed: true, effectiveProfile: profile, grantId: grant.id };
  }
  return { allowed: true, effectiveProfile: profile };
}

/**
 * Final authorization reservation immediately before execution. The policy and optional max-use grant
 * are evaluated and reserved under the same lock, so a concurrent local OFF switch cannot be overwritten.
 */
export async function reserveOperation(
  nodeId: string,
  actor: RequestActor | undefined,
  operation: string,
  profile: ReachProfile,
  args: Record<string, unknown> = {},
  options: { expectedPolicyHash?: string; dir?: string } = {}
): Promise<{ decision: Extract<AccessDecision, { allowed: true }>; policy: AccessState }> {
  const dir = options.dir ?? stateDir();
  return withFileLock(accessLockFile(nodeId, dir), async () => {
    const state = (await readAccessStateUnlocked(nodeId, dir)).state;
    if (options.expectedPolicyHash && hashValue(state) !== options.expectedPolicyHash) {
      throw new Error('node policy changed after planning; create a new plan');
    }
    const decision = authorizeOperation(state, actor, operation, profile, Date.now(), args);
    if (!decision.allowed) throw new Error(decision.reason);
    if (decision.grantId) {
      const grant = state.grants.find(candidate => candidate.id === decision.grantId);
      if (!grant || Date.parse(grant.until) <= Date.now() || (grant.maxUses !== null && grant.uses >= grant.maxUses)) {
        throw new Error('capability grant expired or exhausted before execution');
      }
      const grants = state.grants.map(candidate => candidate.id === grant.id ? { ...candidate, uses: candidate.uses + 1 } : candidate);
      await writeAccessStateUnlocked(nodeId, { ...state, grants }, state.revision + 1, dir);
    }
    return { decision, policy: state };
  });
}

/** Compatibility helper for tests and local callers that need to consume a known grant directly. */
export async function consumeGrant(nodeId: string, grantId: string | undefined, dir = stateDir()): Promise<void> {
  if (!grantId) return;
  await updateAccessState(nodeId, state => {
    const grant = state.grants.find(candidate => candidate.id === grantId);
    if (!grant || Date.parse(grant.until) <= Date.now() || (grant.maxUses !== null && grant.uses >= grant.maxUses)) {
      throw new Error('capability grant expired or exhausted before execution');
    }
    return { ...state, grants: state.grants.map(candidate => candidate.id === grantId ? { ...candidate, uses: candidate.uses + 1 } : candidate) };
  }, dir);
}

export function createGrant(state: AccessState, client: ClientKind, capabilities: ReachCapability[], roots: string[], durationMs: number, maxUses: number | null): AccessState {
  const grant: CapabilityGrant = {
    id: crypto.randomUUID(), client, capabilities, roots: roots.map(root => path.resolve(root)),
    until: new Date(Date.now() + durationMs).toISOString(), maxUses, uses: 0, createdAt: new Date().toISOString()
  };
  return { ...state, grants: [...state.grants, grant], grantRequired: { ...state.grantRequired, [client]: true } };
}

export function policyCheck(state: AccessState): string[] {
  const errors: string[] = [];
  if (!Number.isInteger(state.revision) || state.revision < 0) errors.push('policy revision must be a non-negative integer');
  for (const grant of state.grants) {
    if (!['chatgpt','claude','smoke','other'].includes(grant.client)) errors.push(`grant ${grant.id} has invalid client`);
    if (grant.capabilities.some(capability => !['inspect','file.read','file.write','checkpoint','process.shell','compat'].includes(capability))) errors.push(`grant ${grant.id} has invalid capability`);
    if (!grant.capabilities.length) errors.push(`grant ${grant.id} has no capabilities`);
    if (!grant.roots.length) errors.push(`grant ${grant.id} has no roots`);
    if (!Number.isFinite(Date.parse(grant.until))) errors.push(`grant ${grant.id} has invalid expiry`);
    if (grant.maxUses !== null && (!Number.isInteger(grant.maxUses) || grant.maxUses <= 0)) errors.push(`grant ${grant.id} maxUses must be positive or null`);
  }
  if (authorizeOperation({ ...state, mode: 'off' }, undefined, 'dex.fingerprint', 'full-local').allowed) errors.push('OFF invariant failed');
  if (authorizeOperation({ ...state, mode: 'read-only' }, undefined, 'dex.file.write', 'full-local').allowed) errors.push('READ-ONLY mutation invariant failed');
  return errors;
}

export function parseDuration(text: string): number {
  const match = /^(\d+)\s*([smhd])$/i.exec(text.trim());
  if (!match) throw new Error(`invalid duration "${text}" (use e.g. 30m, 2h, 90s, 1d)`);
  const value = Number(match[1]);
  const unit = match[2]!.toLowerCase();
  const factor = unit === 's' ? 1000 : unit === 'm' ? 60_000 : unit === 'h' ? 3_600_000 : 86_400_000;
  const ms = value * factor;
  if (ms <= 0 || ms > 7 * 86_400_000) throw new Error('duration must be between 1s and 7d');
  return ms;
}
export function classifyClient(clientName: string | undefined): ClientKind {
  const name = (clientName || '').toLowerCase();
  if (/chatgpt|openai/.test(name)) return 'chatgpt';
  if (/claude|anthropic/.test(name)) return 'claude';
  if (/smoke/.test(name)) return 'smoke';
  return 'other';
}
