import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import type { ClientKind } from './protocol.js';
import type { AuthorityCost } from './operations.js';
import { stateDir } from './local-env.js';
import { atomicWriteFile } from './state-io.js';
import {
  type BudgetPolicy,
  type BudgetRule,
  budgetUsageFile,
  inspectBudgetPolicy,
  policyRestricts,
  rulesForClient,
  withBudgetLock
} from './budget-policy.js';

/**
 * Rolling usage counters for execution budgets. These counters are *not* owner policy: updating
 * them must not change the access-policy hash or invalidate unrelated plans.
 *
 * Lock order (canonical, do not reverse):
 *   1. owner policy / access lock
 *   2. budget lock
 *
 * This module never imports access.ts and never acquires the access lock. Callers that compose
 * authorization with reservation (reserveOperation) must hold the access lock first.
 *
 * Semantics:
 *   - A denied preauthorization consumes nothing.
 *   - A successful reservation consumes its authority cost even if later execution fails.
 *   - releaseBudgetConcurrency() releases only the inflight slot; it does not refund rolling cost.
 */

export type BudgetSample = {
  at: number;
  client: ClientKind;
  operations: number;
  mutations: number;
  shellCalls: number;
  requestedWriteBytes: number;
  requestedProcessMs: number;
};

export type BudgetInflight = {
  id: string;
  client: ClientKind;
  at: number;
  /** Process holding the slot, so a crashed holder can be reclaimed without guessing from age. */
  pid?: number;
};

export type BudgetUsage = {
  version: 1;
  samples: BudgetSample[];
  inflight: BudgetInflight[];
};

export type BudgetReserveResult =
  | { allowed: true; id?: string; usage: BudgetUsage }
  | { allowed: false; reason: string; usage: BudgetUsage };

export class BudgetUsageCorruptError extends Error {
  constructor(message = 'budget usage is corrupt; refusing to invent remaining capacity') {
    super(message);
    this.name = 'BudgetUsageCorruptError';
  }
}

function emptyUsage(): BudgetUsage {
  return { version: 1, samples: [], inflight: [] };
}

function decodeUsage(parsed: unknown): BudgetUsage | null {
  if (!parsed || typeof parsed !== 'object') return null;
  const raw = parsed as Partial<BudgetUsage> & { version?: number };
  if (Number(raw.version) !== 1) return null;
  if (!Array.isArray(raw.samples) || !Array.isArray(raw.inflight)) return null;
  const samples: BudgetSample[] = [];
  for (const sample of raw.samples) {
    if (!sample || typeof sample !== 'object') return null;
    const s = sample as Partial<BudgetSample>;
    if (typeof s.at !== 'number' || !Number.isFinite(s.at)) return null;
    if (!['chatgpt', 'claude', 'smoke', 'other'].includes(String(s.client))) return null;
    if ([s.operations, s.mutations, s.shellCalls, s.requestedWriteBytes, s.requestedProcessMs].some(n => typeof n !== 'number' || !Number.isFinite(n) || n < 0)) {
      return null;
    }
    samples.push({
      at: s.at,
      client: s.client as ClientKind,
      operations: s.operations as number,
      mutations: s.mutations as number,
      shellCalls: s.shellCalls as number,
      requestedWriteBytes: s.requestedWriteBytes as number,
      requestedProcessMs: s.requestedProcessMs as number
    });
  }
  const inflight: BudgetInflight[] = [];
  for (const entry of raw.inflight) {
    if (!entry || typeof entry !== 'object') return null;
    const item = entry as Partial<BudgetInflight>;
    if (typeof item.id !== 'string' || !item.id) return null;
    if (typeof item.at !== 'number' || !Number.isFinite(item.at)) return null;
    if (!['chatgpt', 'claude', 'smoke', 'other'].includes(String(item.client))) return null;
    if (item.pid !== undefined && (typeof item.pid !== 'number' || !Number.isInteger(item.pid) || item.pid <= 0)) return null;
    inflight.push({
      id: item.id, client: item.client as ClientKind, at: item.at,
      ...(item.pid === undefined ? {} : { pid: item.pid })
    });
  }
  return { version: 1, samples, inflight };
}

async function readUsageUnlocked(nodeId: string, dir: string): Promise<{ usage: BudgetUsage; exists: boolean; valid: boolean }> {
  try {
    const parsed = JSON.parse(await fs.readFile(budgetUsageFile(nodeId, dir), 'utf8')) as unknown;
    const usage = decodeUsage(parsed);
    if (!usage) return { usage: emptyUsage(), exists: true, valid: false };
    return { usage, exists: true, valid: true };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { usage: emptyUsage(), exists: false, valid: true };
    return { usage: emptyUsage(), exists: true, valid: false };
  }
}

async function writeUsageUnlocked(nodeId: string, usage: BudgetUsage, dir: string): Promise<void> {
  await atomicWriteFile(budgetUsageFile(nodeId, dir), JSON.stringify({ ...usage, version: 1 }, null, 2) + '\n', 0o600);
}

/**
 * How long an inflight slot may go unreleased before its holder is checked for liveness. A slot is
 * reclaimed only when it is both well past due AND its recorded process is gone, which is the same
 * rule the work coordinator uses (DEX-INV-025). Reclaiming never signals the other process, and a
 * live holder is never evicted for being slow, so the concurrency ceiling still holds for real work.
 */
export const INFLIGHT_STALE_MS = 15 * 60_000;

/** EPERM means the process exists under another user, so it counts as alive. */
export function inflightHolderAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * A slot with no recorded pid predates pid recording and cannot be liveness-checked, so it is
 * reclaimed on age alone once well past due. Leaving it forever would let one crash permanently
 * consume a concurrency slot; the whole budget would then refuse every request until the owner reset
 * usage by hand.
 */
export function inflightIsReclaimable(entry: BudgetInflight, now = Date.now()): boolean {
  if (now - entry.at <= INFLIGHT_STALE_MS) return false;
  return entry.pid === undefined ? true : !inflightHolderAlive(entry.pid);
}

export function pruneUsage(usage: BudgetUsage, policy: BudgetPolicy, now = Date.now()): BudgetUsage {
  const windows = [policy.shared, ...Object.values(policy.clients)]
    .filter((rule): rule is BudgetRule => Boolean(rule))
    .map(rule => rule.windowMs);
  const keepMs = windows.length ? Math.max(...windows) : 0;
  // Samples outside every window are dropped. Samples still inside one are never dropped, however
  // many there are: discarding an in-window sample would refund consumed authority.
  const samples = keepMs > 0 ? usage.samples.filter(sample => now - sample.at < keepMs) : [];
  const inflight = usage.inflight.filter(entry => !inflightIsReclaimable(entry, now));
  return { version: 1, samples, inflight };
}

function sumCost(samples: BudgetSample[]): AuthorityCost {
  return samples.reduce<AuthorityCost>((acc, sample) => ({
    operations: acc.operations + sample.operations,
    mutations: acc.mutations + sample.mutations,
    shellCalls: acc.shellCalls + sample.shellCalls,
    requestedWriteBytes: acc.requestedWriteBytes + sample.requestedWriteBytes,
    requestedProcessMs: acc.requestedProcessMs + sample.requestedProcessMs
  }), { operations: 0, mutations: 0, shellCalls: 0, requestedWriteBytes: 0, requestedProcessMs: 0 });
}

function dimensionLabel(key: keyof AuthorityCost | 'maxConcurrent'): string {
  switch (key) {
    case 'operations': return 'operations';
    case 'mutations': return 'mutations';
    case 'shellCalls': return 'shell calls';
    case 'requestedWriteBytes': return 'requested write bytes';
    case 'requestedProcessMs': return 'requested process ms';
    case 'maxConcurrent': return 'concurrent operations';
  }
}

function wouldExceed(used: number, add: number, max: number | null): boolean {
  return max !== null && used + add > max;
}

function evaluateRule(
  rule: BudgetRule,
  samples: BudgetSample[],
  inflight: BudgetInflight[],
  cost: AuthorityCost,
  client: ClientKind,
  now: number
): string | null {
  // A shared rule measures every client together; a per-client rule measures only its own client.
  // Filtering by window alone charged one client's rolling cost against another client's ceiling,
  // which turned a per-client budget into a second, stricter shared budget. `maxConcurrent` below
  // already scoped itself by client; the rolling dimensions now agree with it.
  const scoped = rule.id === 'shared' ? samples : samples.filter(sample => sample.client === client);
  const inWindow = scoped.filter(sample => now - sample.at < rule.windowMs);
  const used = sumCost(inWindow);
  const who = rule.id === 'shared' ? 'this node' : `${rule.id} clients`;
  const checks: Array<[keyof AuthorityCost, number | null, number]> = [
    ['operations', rule.maxOperations, cost.operations],
    ['mutations', rule.maxMutations, cost.mutations],
    ['shellCalls', rule.maxShellCalls, cost.shellCalls],
    ['requestedWriteBytes', rule.maxRequestedWriteBytes, cost.requestedWriteBytes],
    ['requestedProcessMs', rule.maxRequestedProcessMs, cost.requestedProcessMs]
  ];
  for (const [key, max, add] of checks) {
    if (wouldExceed(used[key], add, max)) {
      return `NODE OWNER limited ${who} to ${max} ${dimensionLabel(key)} per rolling window; ${operationWord(key)} would exceed that budget`;
    }
  }
  if (rule.maxConcurrent !== null) {
    const active = rule.id === 'shared' ? inflight.length : inflight.filter(entry => entry.client === client).length;
    if (active >= rule.maxConcurrent) {
      return `NODE OWNER limited ${who} to ${rule.maxConcurrent} concurrent operations; all slots are in use`;
    }
  }
  return null;
}

function operationWord(key: keyof AuthorityCost): string {
  if (key === 'requestedWriteBytes') return 'this write';
  if (key === 'requestedProcessMs') return 'this process request';
  return 'this request';
}

/**
 * Reserve rolling cost and an inflight concurrency slot under the budget lock.
 * Must be called while holding the access lock when composed with authorization.
 */
export async function reserveBudgetUsage(
  nodeId: string,
  client: ClientKind,
  cost: AuthorityCost,
  options: { dir?: string; now?: number } = {}
): Promise<BudgetReserveResult> {
  const dir = options.dir ?? stateDir();
  const now = options.now ?? Date.now();
  return withBudgetLock(nodeId, async () => {
    const inspection = await inspectBudgetPolicy(nodeId, dir);
    const policy = inspection.policy;
    if (!policyRestricts(policy)) {
      return { allowed: true as const, usage: emptyUsage() };
    }
    const read = await readUsageUnlocked(nodeId, dir);
    if (read.exists && !read.valid) throw new BudgetUsageCorruptError();
    const usage = pruneUsage(read.usage, policy, now);
    const rules = rulesForClient(policy, client);
    for (const rule of rules) {
      const reason = evaluateRule(rule, usage.samples, usage.inflight, cost, client, now);
      if (reason) return { allowed: false as const, reason, usage };
    }
    const id = crypto.randomUUID();
    const next: BudgetUsage = {
      version: 1,
      samples: [...usage.samples, { at: now, client, ...cost }],
      inflight: [...usage.inflight, { id, client, at: now, pid: process.pid }]
    };
    await writeUsageUnlocked(nodeId, next, dir);
    return { allowed: true as const, id, usage: next };
  }, dir);
}

/** Release only the inflight concurrency slot. Rolling authority cost is not refunded. */
export async function releaseBudgetConcurrency(
  nodeId: string,
  reservationId: string | undefined,
  dir = stateDir()
): Promise<void> {
  if (!reservationId) return;
  await withBudgetLock(nodeId, async () => {
    const read = await readUsageUnlocked(nodeId, dir);
    if (!read.valid) return;
    if (!read.usage.inflight.some(entry => entry.id === reservationId)) return;
    await writeUsageUnlocked(nodeId, {
      version: 1,
      samples: read.usage.samples,
      inflight: read.usage.inflight.filter(entry => entry.id !== reservationId)
    }, dir);
  }, dir);
}

export async function loadBudgetUsage(nodeId: string, dir = stateDir()): Promise<BudgetUsage> {
  const read = await readUsageUnlocked(nodeId, dir);
  if (read.exists && !read.valid) throw new BudgetUsageCorruptError();
  return read.usage;
}

export async function resetBudgetUsage(nodeId: string, dir = stateDir()): Promise<void> {
  await withBudgetLock(nodeId, async () => {
    await writeUsageUnlocked(nodeId, emptyUsage(), dir);
  }, dir);
}

export function usedInWindow(usage: BudgetUsage, client: ClientKind | 'shared', windowMs: number, now = Date.now()): AuthorityCost {
  const samples = usage.samples.filter(sample => now - sample.at < windowMs && (client === 'shared' || sample.client === client));
  return sumCost(samples);
}
