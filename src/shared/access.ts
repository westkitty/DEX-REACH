import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import type { AccessMode, AccessSnapshot, ClientKind, ReachProfile, RequestActor } from './protocol.js';
import { stateDir } from './local-env.js';
import { operationCapability, requestPaths, rootsCover, type CapabilityGrant, type ReachCapability } from './capabilities.js';

export type AccessState = {
  version: 2;
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
const READ_OPERATIONS = new Set(['dex.fingerprint', 'dex.repoInfo', 'dex.adbDevices', 'dex.file.read', 'dex.result.read', 'dex.receipts.list', 'dex.policy.explain']);

export function isAccessMode(value: unknown): value is AccessMode { return typeof value === 'string' && (ACCESS_MODES as string[]).includes(value); }
export function minMode(a: AccessMode, b: AccessMode): AccessMode { return RANK[a] <= RANK[b] ? a : b; }
export function accessFile(nodeId: string, dir = stateDir()): string { return path.join(dir, 'nodes', `${nodeId}.access.json`); }

export function defaultAccessState(now = new Date()): AccessState {
  const initial = process.env.DEX_REACH_INITIAL_ACCESS;
  return { version: 2, mode: isAccessMode(initial) ? initial : 'off', until: null, revertTo: null, clients: {}, grantRequired: {}, grants: [], updatedAt: now.toISOString() };
}

function sanitizeClients(value: unknown): Partial<Record<ClientKind, AccessMode>> {
  const out: Partial<Record<ClientKind, AccessMode>> = {};
  if (!value || typeof value !== 'object') return out;
  for (const [kind, mode] of Object.entries(value as Record<string, unknown>)) if (['chatgpt','claude','smoke','other'].includes(kind) && isAccessMode(mode)) out[kind as ClientKind] = mode;
  return out;
}
function sanitizeGrantRequired(value: unknown): Partial<Record<ClientKind, boolean>> {
  const out: Partial<Record<ClientKind, boolean>> = {};
  if (!value || typeof value !== 'object') return out;
  for (const [kind, enabled] of Object.entries(value as Record<string, unknown>)) if (['chatgpt','claude','smoke','other'].includes(kind) && typeof enabled === 'boolean') out[kind as ClientKind] = enabled;
  return out;
}
function sanitizeGrants(value: unknown): CapabilityGrant[] {
  if (!Array.isArray(value)) return [];
  return value.filter((g): g is CapabilityGrant => !!g && typeof g === 'object' && typeof g.id === 'string' && typeof g.client === 'string' && Array.isArray(g.capabilities) && Array.isArray(g.roots) && typeof g.until === 'string' && typeof g.uses === 'number');
}

export async function loadAccessState(nodeId: string, dir = stateDir()): Promise<AccessState> {
  try {
    const parsed = JSON.parse(await fs.readFile(accessFile(nodeId, dir), 'utf8')) as Partial<AccessState> & { version?: number };
    if (!isAccessMode(parsed.mode)) throw new Error('unsupported access state');
    return {
      version: 2, mode: parsed.mode, until: typeof parsed.until === 'string' ? parsed.until : null,
      revertTo: isAccessMode(parsed.revertTo) ? parsed.revertTo : null, clients: sanitizeClients(parsed.clients),
      grantRequired: sanitizeGrantRequired(parsed.grantRequired), grants: sanitizeGrants(parsed.grants),
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : new Date(0).toISOString()
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return defaultAccessState();
    return { ...defaultAccessState(), mode: 'off' };
  }
}

export async function saveAccessState(nodeId: string, state: AccessState, dir = stateDir()): Promise<void> {
  const errors = policyCheck(state);
  if (errors.length) throw new Error("policy assertions failed: " + errors.join("; "));
  const file = accessFile(nodeId, dir);
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temp, JSON.stringify({ ...state, version: 2, updatedAt: new Date().toISOString() }, null, 2) + '\n', { mode: 0o600 });
  await fs.rename(temp, file);
}

export function resolveMode(state: AccessState, now = Date.now()): AccessMode { return state.until && Date.parse(state.until) <= now ? (state.revertTo ?? 'off') : state.mode; }
export function snapshot(state: AccessState, now = Date.now()): AccessSnapshot { return { mode: state.mode, effectiveMode: resolveMode(state, now), until: state.until, revertTo: state.revertTo, clients: { ...state.clients } }; }
export function modeForActor(state: AccessState, actor: RequestActor | undefined, now = Date.now()): AccessMode {
  const base = resolveMode(state, now); const kind: ClientKind = actor?.kind ?? 'other'; const ceiling = state.clients[kind]; return ceiling ? minMode(base, ceiling) : base;
}

export type AccessDecision = { allowed: true; effectiveProfile: ReachProfile; grantId?: string } | { allowed: false; reason: string };

function activeGrant(state: AccessState, actor: RequestActor | undefined, operation: string, args: Record<string, unknown>, now = Date.now()): CapabilityGrant | null {
  const kind = actor?.kind ?? 'other';
  const capability = operationCapability(operation);
  const paths = requestPaths(args);
  return state.grants.find(g => g.client === kind && Date.parse(g.until) > now && (g.maxUses === null || g.uses < g.maxUses) && g.capabilities.includes(capability) && rootsCover(paths, g.roots)) ?? null;
}

export function authorizeOperation(state: AccessState, actor: RequestActor | undefined, operation: string, profile: ReachProfile, now = Date.now(), args: Record<string, unknown> = {}): AccessDecision {
  const mode = modeForActor(state, actor, now); const who = actor ? `${actor.clientName} (${actor.kind})` : 'an unidentified client';
  const base = resolveMode(state, now); const scope = state.clients[actor?.kind ?? 'other'] && RANK[mode] < RANK[base] ? `for ${actor?.kind ?? 'other'} clients` : 'on this node';
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

const grantReservations = new Map<string, Promise<void>>();

/** Reserve one grant use before executing the governed operation. Serialized per node/grant so a one-use lease cannot be double-spent by concurrent requests. Failed executions still consume the reserved use. */
export async function consumeGrant(nodeId: string, grantId: string | undefined): Promise<void> {
  if (!grantId) return;
  const lockKey = `${nodeId}:${grantId}`;
  const previous = grantReservations.get(lockKey) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(async () => {
    const state = await loadAccessState(nodeId);
    const grant = state.grants.find(g => g.id === grantId);
    if (!grant || Date.parse(grant.until) <= Date.now() || (grant.maxUses !== null && grant.uses >= grant.maxUses)) throw new Error('capability grant expired or exhausted before execution');
    const grants = state.grants.map(g => g.id === grantId ? { ...g, uses: g.uses + 1 } : g);
    await saveAccessState(nodeId, { ...state, grants });
  });
  grantReservations.set(lockKey, next);
  try { await next; } finally { if (grantReservations.get(lockKey) === next) grantReservations.delete(lockKey); }
}

export function createGrant(state: AccessState, client: ClientKind, capabilities: ReachCapability[], roots: string[], durationMs: number, maxUses: number | null): AccessState {
  const grant: CapabilityGrant = { id: crypto.randomUUID(), client, capabilities, roots: roots.map(r => path.resolve(r)), until: new Date(Date.now()+durationMs).toISOString(), maxUses, uses: 0, createdAt: new Date().toISOString() };
  return { ...state, grants: [...state.grants, grant], grantRequired: { ...state.grantRequired, [client]: true } };
}

export function policyCheck(state: AccessState): string[] {
  const errors: string[] = [];
  for (const grant of state.grants) {
    if (!["chatgpt","claude","smoke","other"].includes(grant.client)) errors.push(`grant ${grant.id} has invalid client`);
    if (grant.capabilities.some(c => !["inspect","file.read","file.write","checkpoint","process.shell","compat"].includes(c))) errors.push(`grant ${grant.id} has invalid capability`);
    if (!grant.capabilities.length) errors.push(`grant ${grant.id} has no capabilities`);
    if (!grant.roots.length) errors.push(`grant ${grant.id} has no roots`);
    if (!Number.isFinite(Date.parse(grant.until))) errors.push(`grant ${grant.id} has invalid expiry`);
    if (grant.maxUses !== null && grant.maxUses <= 0) errors.push(`grant ${grant.id} maxUses must be positive or null`);
  }
  if (authorizeOperation({ ...state, mode: 'off' }, undefined, 'dex.fingerprint', 'full-local').allowed) errors.push('OFF invariant failed');
  if (authorizeOperation({ ...state, mode: 'read-only' }, undefined, 'dex.file.write', 'full-local').allowed) errors.push('READ-ONLY mutation invariant failed');
  return errors;
}

export function parseDuration(text: string): number {
  const match = /^(\d+)\s*([smhd])$/i.exec(text.trim()); if (!match) throw new Error(`invalid duration "${text}" (use e.g. 30m, 2h, 90s, 1d)`);
  const value = Number(match[1]); const unit = match[2]!.toLowerCase(); const factor = unit === 's' ? 1000 : unit === 'm' ? 60_000 : unit === 'h' ? 3_600_000 : 86_400_000; const ms = value * factor;
  if (ms <= 0 || ms > 7 * 86_400_000) throw new Error('duration must be between 1s and 7d'); return ms;
}
export function classifyClient(clientName: string | undefined): ClientKind { const name=(clientName||'').toLowerCase(); if (/chatgpt|openai/.test(name)) return 'chatgpt'; if (/claude|anthropic/.test(name)) return 'claude'; if (/smoke/.test(name)) return 'smoke'; return 'other'; }
