import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import type { ClientKind } from './protocol.js';
import type { ReachCapability } from './capabilities.js';
import { REACH_CAPABILITIES } from './capabilities.js';
import type { OperationRiskClass } from './operations.js';
import { classifyRequestedRisk } from './operations.js';
import { stateDir } from './local-env.js';
import { atomicWriteFile, withFileLock } from './state-io.js';
import { hashValue } from './hash.js';
import { looksLikeSecretMaterial } from './work-coordinator.js';
import { createGrant, updateAccessState } from './access.js';

/**
 * AI may request authority. AI may never grant itself authority. A request is not a grant:
 * owner approval creates an ordinary CapabilityGrant. This module never writes AccessState.
 *
 * Lock order when composed with owner policy: access lock, then this request lock.
 */

export const REQUEST_STATUSES = ['pending', 'approved', 'denied', 'expired'] as const;
export type RequestStatus = (typeof REQUEST_STATUSES)[number];

export type CapabilityRequest = {
  id: string;
  client: ClientKind;
  capabilities: ReachCapability[];
  roots: string[];
  durationMs: number;
  maxUses: number | null;
  operation: string | null;
  requestHash: string | null;
  justification: string;
  risk: OperationRiskClass;
  status: RequestStatus;
  createdAt: string;
  expiresAt: string;
  decidedAt: string | null;
  grantId: string | null;
  narrowed: boolean;
};

export type CapabilityRequestFile = {
  version: 1;
  requests: CapabilityRequest[];
};

export type RequestNarrowing = {
  capabilities?: ReachCapability[];
  roots?: string[];
  durationMs?: number;
  maxUses?: number | null;
};

const CLIENT_KINDS: readonly ClientKind[] = ['chatgpt', 'claude', 'smoke', 'other'];
const MAX_JUSTIFICATION = 240;
const MAX_PENDING_MS = 24 * 3_600_000;

export function capabilityRequestFile(nodeId: string, dir = stateDir()): string {
  return path.join(dir, 'nodes', `${nodeId}.capability-requests.json`);
}

export function capabilityRequestLockFile(nodeId: string, dir = stateDir()): string {
  return `${capabilityRequestFile(nodeId, dir)}.lock`;
}

function emptyFile(): CapabilityRequestFile {
  return { version: 1, requests: [] };
}

export function sanitizeJustification(value: string): string {
  const trimmed = value.trim().replace(/\s+/g, ' ');
  if (!trimmed) throw new Error('justification is required and must not be empty');
  if (trimmed.length > MAX_JUSTIFICATION) throw new Error(`justification must be at most ${MAX_JUSTIFICATION} characters`);
  if (looksLikeSecretMaterial(trimmed)) throw new Error('justification looks like credential material; store a safe reason only');
  return trimmed;
}

function decodeRequest(value: unknown): CapabilityRequest | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Partial<CapabilityRequest>;
  if (typeof raw.id !== 'string' || !raw.id) return null;
  if (!CLIENT_KINDS.includes(raw.client as ClientKind)) return null;
  if (!Array.isArray(raw.capabilities) || !raw.capabilities.every(cap => (REACH_CAPABILITIES as readonly string[]).includes(cap))) return null;
  if (!raw.capabilities.length) return null;
  if (!Array.isArray(raw.roots) || !raw.roots.every(root => typeof root === 'string' && path.isAbsolute(root))) return null;
  if (!raw.roots.length) return null;
  if (!Number.isInteger(raw.durationMs) || Number(raw.durationMs) <= 0) return null;
  if (!(raw.maxUses === null || (Number.isInteger(raw.maxUses) && Number(raw.maxUses) > 0))) return null;
  if (!(raw.operation === null || typeof raw.operation === 'string')) return null;
  if (!(raw.requestHash === null || typeof raw.requestHash === 'string')) return null;
  if (typeof raw.justification !== 'string') return null;
  if (!['inspect', 'typed-mutate', 'shell', 'network', 'privileged', 'destructive'].includes(String(raw.risk))) return null;
  if (!(REQUEST_STATUSES as readonly string[]).includes(String(raw.status))) return null;
  if (typeof raw.createdAt !== 'string' || typeof raw.expiresAt !== 'string') return null;
  if (!(raw.decidedAt === null || typeof raw.decidedAt === 'string')) return null;
  if (!(raw.grantId === null || typeof raw.grantId === 'string')) return null;
  if (typeof raw.narrowed !== 'boolean') return null;
  return raw as CapabilityRequest;
}

function decodeFile(parsed: unknown): CapabilityRequestFile | null {
  if (!parsed || typeof parsed !== 'object') return null;
  const raw = parsed as Partial<CapabilityRequestFile>;
  if (Number(raw.version) !== 1 || !Array.isArray(raw.requests)) return null;
  const requests: CapabilityRequest[] = [];
  for (const entry of raw.requests) {
    const decoded = decodeRequest(entry);
    if (!decoded) return null;
    requests.push(decoded);
  }
  return { version: 1, requests };
}

async function readUnlocked(nodeId: string, dir: string): Promise<CapabilityRequestFile> {
  try {
    const parsed = JSON.parse(await fs.readFile(capabilityRequestFile(nodeId, dir), 'utf8')) as unknown;
    return decodeFile(parsed) ?? emptyFile();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyFile();
    return emptyFile();
  }
}

async function writeUnlocked(nodeId: string, file: CapabilityRequestFile, dir: string): Promise<void> {
  await atomicWriteFile(capabilityRequestFile(nodeId, dir), JSON.stringify({ version: 1, requests: file.requests }, null, 2) + '\n', 0o600);
}

export function refreshRequestStatus(request: CapabilityRequest, now = Date.now()): CapabilityRequest {
  if (request.status === 'pending' && Date.parse(request.expiresAt) <= now) {
    return { ...request, status: 'expired', decidedAt: new Date(now).toISOString() };
  }
  return request;
}

export async function withRequestLock<T>(nodeId: string, fn: () => Promise<T>, dir = stateDir()): Promise<T> {
  return withFileLock(capabilityRequestLockFile(nodeId, dir), fn);
}

export async function listCapabilityRequests(nodeId: string, dir = stateDir()): Promise<CapabilityRequest[]> {
  return withRequestLock(nodeId, async () => {
    const file = await readUnlocked(nodeId, dir);
    const now = Date.now();
    const requests = file.requests.map(request => refreshRequestStatus(request, now));
    if (requests.some((request, index) => request.status !== file.requests[index]!.status)) {
      await writeUnlocked(nodeId, { version: 1, requests }, dir);
    }
    return requests;
  }, dir);
}

export type NewCapabilityRequest = {
  client: ClientKind;
  capabilities: ReachCapability[];
  roots: string[];
  durationMs: number;
  maxUses: number | null;
  justification: string;
  operation?: string;
  args?: Record<string, unknown>;
};

export async function createCapabilityRequest(nodeId: string, input: NewCapabilityRequest, dir = stateDir()): Promise<CapabilityRequest> {
  if (!input.capabilities.length) throw new Error('capability request requires at least one capability');
  if (input.capabilities.some(cap => !(REACH_CAPABILITIES as readonly string[]).includes(cap))) throw new Error('capability request has an invalid capability');
  const roots = input.roots.map(root => path.resolve(root));
  if (!roots.length || roots.some(root => !path.isAbsolute(root))) throw new Error('capability request requires absolute roots');
  if (!Number.isInteger(input.durationMs) || input.durationMs <= 0 || input.durationMs > 7 * 86_400_000) {
    throw new Error('capability request duration must be between 1s and 7d');
  }
  if (input.maxUses !== null && (!Number.isInteger(input.maxUses) || input.maxUses <= 0)) {
    throw new Error('maxUses must be a positive integer or null');
  }
  const justification = sanitizeJustification(input.justification);
  const operation = input.operation ? String(input.operation) : null;
  const risk = classifyRequestedRisk(input.capabilities, operation, input.args ?? {});
  // Never persist raw target arguments. A hash is enough to bind an exact later plan.
  const requestHash = input.args ? hashValue({ operation, args: input.args }) : null;
  const now = Date.now();
  const pendingMs = Math.min(input.durationMs, MAX_PENDING_MS);
  const created: CapabilityRequest = {
    id: crypto.randomUUID(),
    client: input.client,
    capabilities: [...input.capabilities],
    roots,
    durationMs: input.durationMs,
    maxUses: input.maxUses,
    operation,
    requestHash,
    justification,
    risk,
    status: 'pending',
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + pendingMs).toISOString(),
    decidedAt: null,
    grantId: null,
    narrowed: false
  };
  await withRequestLock(nodeId, async () => {
    const file = await readUnlocked(nodeId, dir);
    await writeUnlocked(nodeId, { version: 1, requests: [...file.requests, created] }, dir);
  }, dir);
  return created;
}

export function assertNarrowing(request: CapabilityRequest, narrowing: RequestNarrowing): {
  capabilities: ReachCapability[];
  roots: string[];
  durationMs: number;
  maxUses: number | null;
  narrowed: boolean;
} {
  const capabilities = narrowing.capabilities ?? request.capabilities;
  if (capabilities.some(cap => !request.capabilities.includes(cap))) {
    throw new Error('owner approval cannot add capabilities the request did not ask for');
  }
  if (!capabilities.length) throw new Error('owner approval must keep at least one capability');
  const roots = (narrowing.roots ?? request.roots).map(root => path.resolve(root));
  if (!roots.every(candidate => request.roots.some(base => candidate === base || candidate.startsWith(base + path.sep)))) {
    throw new Error('owner approval cannot widen filesystem roots beyond the request');
  }
  const durationMs = narrowing.durationMs ?? request.durationMs;
  if (durationMs > request.durationMs) throw new Error('owner approval cannot extend the requested duration');
  if (!Number.isInteger(durationMs) || durationMs <= 0) throw new Error('approved duration must be a positive integer');
  let maxUses = narrowing.maxUses === undefined ? request.maxUses : narrowing.maxUses;
  if (request.maxUses !== null) {
    if (maxUses === null) throw new Error('owner approval cannot remove a max-uses cap');
    if (maxUses > request.maxUses) throw new Error('owner approval cannot raise max-uses');
  }
  if (maxUses !== null && (!Number.isInteger(maxUses) || maxUses <= 0)) throw new Error('approved max-uses must be a positive integer or null');
  const narrowed = capabilities.length < request.capabilities.length
    || roots.length !== request.roots.length
    || roots.some((root, index) => root !== request.roots[index])
    || durationMs < request.durationMs
    || maxUses !== request.maxUses;
  return { capabilities, roots, durationMs, maxUses, narrowed };
}

export async function loadCapabilityRequest(nodeId: string, id: string, dir = stateDir()): Promise<CapabilityRequest> {
  const requests = await listCapabilityRequests(nodeId, dir);
  const found = requests.find(request => request.id === id);
  if (!found) throw new Error(`no capability request ${id}`);
  return found;
}

export async function denyCapabilityRequest(nodeId: string, id: string, dir = stateDir()): Promise<CapabilityRequest> {
  return decideCapabilityRequest(nodeId, id, 'denied', null, false, dir);
}

/**
 * Owner approval creates an ordinary CapabilityGrant. The request id is reused as the grant id so a
 * retried approval cannot mint a second grant. Approval may narrow; it cannot widen.
 */
export async function approveCapabilityRequest(
  nodeId: string,
  id: string,
  narrowing: RequestNarrowing = {},
  dir = stateDir()
): Promise<{ request: CapabilityRequest; grantId: string }> {
  const request = await loadCapabilityRequest(nodeId, id, dir);
  if (request.status === 'expired') throw new Error('capability request has expired');
  if (request.status !== 'pending') throw new Error(`capability request is already ${request.status}`);
  const approved = assertNarrowing(request, narrowing);
  const grantId = request.id;
  await updateAccessState(nodeId, state => (
    createGrant(state, request.client, approved.capabilities, approved.roots, approved.durationMs, approved.maxUses, grantId)
  ), dir);
  const next = await decideCapabilityRequest(nodeId, id, 'approved', grantId, approved.narrowed, dir);
  return { request: next, grantId };
}

export async function decideCapabilityRequest(
  nodeId: string,
  id: string,
  decision: 'approved' | 'denied',
  grantId: string | null,
  narrowed: boolean,
  dir = stateDir()
): Promise<CapabilityRequest> {
  return withRequestLock(nodeId, async () => {
    const file = await readUnlocked(nodeId, dir);
    const now = Date.now();
    const current = file.requests.find(request => request.id === id);
    if (!current) throw new Error(`no capability request ${id}`);
    const live = refreshRequestStatus(current, now);
    if (live.status === 'expired') {
      await writeUnlocked(nodeId, { version: 1, requests: file.requests.map(request => request.id === id ? live : request) }, dir);
      throw new Error('capability request has expired');
    }
    if (live.status !== 'pending') throw new Error(`capability request is already ${live.status}`);
    const next: CapabilityRequest = {
      ...live,
      status: decision,
      decidedAt: new Date(now).toISOString(),
      grantId,
      narrowed
    };
    await writeUnlocked(nodeId, { version: 1, requests: file.requests.map(request => request.id === id ? next : request) }, dir);
    return next;
  }, dir);
}
