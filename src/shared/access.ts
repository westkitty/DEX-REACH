import fs from 'node:fs/promises';
import path from 'node:path';
import type { AccessMode, AccessSnapshot, ClientKind, ReachProfile, RequestActor } from './protocol.js';
import { stateDir } from './local-env.js';

/**
 * Node-local AI access policy. This file is the machine owner's switch: it lives only on the node,
 * is read by the node before every routed request, and never requires the gateway, ChatGPT, or the
 * internet to change. Absent file = `off` (fail closed) unless DEX_REACH_INITIAL_ACCESS says otherwise.
 */
export type AccessState = {
  version: 1;
  mode: AccessMode;
  /** ISO timestamp; when a timed window expires the mode falls back to `revertTo`. */
  until: string | null;
  revertTo: AccessMode | null;
  /** Optional per-client ceilings; the effective mode for a client is min(node mode, client mode). */
  clients: Partial<Record<ClientKind, AccessMode>>;
  updatedAt: string;
};

export const ACCESS_MODES: readonly AccessMode[] = ['off', 'read-only', 'on'];
const RANK: Record<AccessMode, number> = { off: 0, 'read-only': 1, on: 2 };

/** Operations that never change the machine. Everything else is treated as a mutation. */
const READ_OPERATIONS = new Set(['dex.fingerprint', 'dex.repoInfo', 'dex.adbDevices', 'dex.file.read', 'dex.result.read']);

export function isAccessMode(value: unknown): value is AccessMode {
  return typeof value === 'string' && (ACCESS_MODES as string[]).includes(value);
}

export function minMode(a: AccessMode, b: AccessMode): AccessMode {
  return RANK[a] <= RANK[b] ? a : b;
}

export function accessFile(nodeId: string, dir = stateDir()): string {
  return path.join(dir, 'nodes', `${nodeId}.access.json`);
}

export function defaultAccessState(now = new Date()): AccessState {
  const initial = process.env.DEX_REACH_INITIAL_ACCESS;
  return { version: 1, mode: isAccessMode(initial) ? initial : 'off', until: null, revertTo: null, clients: {}, updatedAt: now.toISOString() };
}

export async function loadAccessState(nodeId: string, dir = stateDir()): Promise<AccessState> {
  try {
    const parsed = JSON.parse(await fs.readFile(accessFile(nodeId, dir), 'utf8')) as Partial<AccessState>;
    if (parsed.version !== 1 || !isAccessMode(parsed.mode)) throw new Error('unsupported access state');
    return {
      version: 1,
      mode: parsed.mode,
      until: typeof parsed.until === 'string' ? parsed.until : null,
      revertTo: isAccessMode(parsed.revertTo) ? parsed.revertTo : null,
      clients: sanitizeClients(parsed.clients),
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : new Date(0).toISOString()
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return defaultAccessState();
    // A corrupt policy file must fail closed, not open.
    return { ...defaultAccessState(), mode: 'off' };
  }
}

export async function saveAccessState(nodeId: string, state: AccessState, dir = stateDir()): Promise<void> {
  const file = accessFile(nodeId, dir);
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temp, JSON.stringify({ ...state, updatedAt: new Date().toISOString() }, null, 2) + '\n', { mode: 0o600 });
  await fs.rename(temp, file);
}

function sanitizeClients(value: unknown): Partial<Record<ClientKind, AccessMode>> {
  const out: Partial<Record<ClientKind, AccessMode>> = {};
  if (!value || typeof value !== 'object') return out;
  for (const [kind, mode] of Object.entries(value as Record<string, unknown>)) {
    if (['chatgpt', 'claude', 'smoke', 'other'].includes(kind) && isAccessMode(mode)) out[kind as ClientKind] = mode;
  }
  return out;
}

/** Applies a timed window's expiry. Pure: pass `now` for deterministic tests. */
export function resolveMode(state: AccessState, now = Date.now()): AccessMode {
  if (state.until && Date.parse(state.until) <= now) return state.revertTo ?? 'off';
  return state.mode;
}

export function snapshot(state: AccessState, now = Date.now()): AccessSnapshot {
  return { mode: state.mode, effectiveMode: resolveMode(state, now), until: state.until, revertTo: state.revertTo, clients: { ...state.clients } };
}

/** Mode that applies to one client after the per-client ceiling. Unknown/absent actors get the `other` ceiling. */
export function modeForActor(state: AccessState, actor: RequestActor | undefined, now = Date.now()): AccessMode {
  const base = resolveMode(state, now);
  const kind: ClientKind = actor?.kind ?? 'other';
  const ceiling = state.clients[kind];
  return ceiling ? minMode(base, ceiling) : base;
}

export type AccessDecision = { allowed: true; effectiveProfile: ReachProfile } | { allowed: false; reason: string };

/**
 * The node-side gate. `off` rejects everything; `read-only` forces the read-only execution profile
 * (which rejects mutating tools/commands/writes); `on` applies the node's configured profile.
 */
export function authorizeOperation(state: AccessState, actor: RequestActor | undefined, operation: string, profile: ReachProfile, now = Date.now()): AccessDecision {
  const mode = modeForActor(state, actor, now);
  const who = actor ? `${actor.clientName} (${actor.kind})` : 'an unidentified client';
  const base = resolveMode(state, now);
  const scope = state.clients[actor?.kind ?? 'other'] && RANK[mode] < RANK[base] ? `for ${actor?.kind ?? 'other'} clients` : 'on this node';
  if (mode === 'off') {
    return { allowed: false, reason: `NODE OWNER has disabled remote AI execution ${scope}; ${operation} from ${who} was refused locally` };
  }
  if (mode === 'read-only') {
    if (READ_OPERATIONS.has(operation)) return { allowed: true, effectiveProfile: 'read-only' };
    // Process runs and compatibility calls are still allowed to reach the read-only profile guard,
    // which admits only recognized inspection commands / non-mutating tools.
    if (operation === 'dex.process.run' || operation === 'dc.call') return { allowed: true, effectiveProfile: 'read-only' };
    return { allowed: false, reason: `NODE OWNER limited remote AI access to read-only ${scope}; ${operation} from ${who} is a mutation and was refused locally` };
  }
  return { allowed: true, effectiveProfile: profile };
}

/** Parses "30m", "2h", "90s", "1d" into milliseconds. */
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

/** Derives a stable client kind from the OAuth client registration name. Attribution, not authentication. */
export function classifyClient(clientName: string | undefined): ClientKind {
  const name = (clientName || '').toLowerCase();
  if (/chatgpt|openai/.test(name)) return 'chatgpt';
  if (/claude|anthropic/.test(name)) return 'claude';
  if (/smoke/.test(name)) return 'smoke';
  return 'other';
}
