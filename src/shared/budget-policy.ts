import fs from 'node:fs/promises';
import path from 'node:path';
import type { ClientKind } from './protocol.js';
import { stateDir } from './local-env.js';
import { atomicWriteFile, withFileLock } from './state-io.js';

/**
 * Owner-configured rolling execution budgets. A budget is a restriction, never a grant: it can only
 * subtract remaining capacity from whatever owner mode, client ceilings, grants, roots, profile and
 * plan rules already allow. Missing or corrupt budget *policy* is unrestricted because owner
 * authority still lives in the access policy; this file is not a second source of authority.
 *
 * Lock order (canonical, do not reverse):
 *   1. owner policy / access lock
 *   2. budget lock (this module and budget-usage.ts share one lock per node)
 *
 * This module never imports access.ts and never acquires the access lock.
 */

export const BUDGET_SCOPES = ['shared', 'chatgpt', 'claude', 'smoke', 'other'] as const;
export type BudgetScope = (typeof BUDGET_SCOPES)[number];

export type BudgetRule = {
  id: string;
  windowMs: number;
  maxOperations: number | null;
  maxMutations: number | null;
  maxShellCalls: number | null;
  maxRequestedWriteBytes: number | null;
  maxRequestedProcessMs: number | null;
  maxConcurrent: number | null;
};

export type BudgetPolicy = {
  version: 1;
  revision: number;
  shared: BudgetRule | null;
  clients: Partial<Record<ClientKind, BudgetRule>>;
  updatedAt: string;
};

export type BudgetPolicyInspection = {
  exists: boolean;
  valid: boolean;
  unrestricted: boolean;
  policy: BudgetPolicy;
  errors: string[];
};

const CLIENT_KINDS: readonly ClientKind[] = ['chatgpt', 'claude', 'smoke', 'other'];

export function isBudgetScope(value: unknown): value is BudgetScope {
  return typeof value === 'string' && (BUDGET_SCOPES as readonly string[]).includes(value);
}

export function budgetPolicyFile(nodeId: string, dir = stateDir()): string {
  return path.join(dir, 'nodes', `${nodeId}.budget-policy.json`);
}

export function budgetUsageFile(nodeId: string, dir = stateDir()): string {
  return path.join(dir, 'nodes', `${nodeId}.budget-usage.json`);
}

/** One lock covers policy and usage so a reservation cannot evaluate a half-updated pair. */
export function budgetLockFile(nodeId: string, dir = stateDir()): string {
  return path.join(dir, 'nodes', `${nodeId}.budget.lock`);
}

export function emptyBudgetPolicy(now = new Date()): BudgetPolicy {
  return { version: 1, revision: 0, shared: null, clients: {}, updatedAt: now.toISOString() };
}

export function budgetRuleRestricts(rule: BudgetRule | null | undefined): boolean {
  if (!rule) return false;
  return [
    rule.maxOperations, rule.maxMutations, rule.maxShellCalls,
    rule.maxRequestedWriteBytes, rule.maxRequestedProcessMs, rule.maxConcurrent
  ].some(value => value !== null);
}

export function policyRestricts(policy: BudgetPolicy): boolean {
  return budgetRuleRestricts(policy.shared) || CLIENT_KINDS.some(kind => budgetRuleRestricts(policy.clients[kind]));
}

function nonNegativeIntOrNull(value: unknown): number | null | undefined {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) return undefined;
  return value;
}

function decodeRule(value: unknown, fallbackId: string): BudgetRule | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Partial<BudgetRule>;
  const windowMs = typeof raw.windowMs === 'number' && Number.isInteger(raw.windowMs) && raw.windowMs > 0 ? raw.windowMs : 0;
  if (!windowMs) return null;
  const maxOperations = nonNegativeIntOrNull(raw.maxOperations);
  const maxMutations = nonNegativeIntOrNull(raw.maxMutations);
  const maxShellCalls = nonNegativeIntOrNull(raw.maxShellCalls);
  const maxRequestedWriteBytes = nonNegativeIntOrNull(raw.maxRequestedWriteBytes);
  const maxRequestedProcessMs = nonNegativeIntOrNull(raw.maxRequestedProcessMs);
  const maxConcurrent = nonNegativeIntOrNull(raw.maxConcurrent);
  if ([maxOperations, maxMutations, maxShellCalls, maxRequestedWriteBytes, maxRequestedProcessMs, maxConcurrent].includes(undefined)) {
    return null;
  }
  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id : fallbackId,
    windowMs,
    maxOperations: maxOperations ?? null,
    maxMutations: maxMutations ?? null,
    maxShellCalls: maxShellCalls ?? null,
    maxRequestedWriteBytes: maxRequestedWriteBytes ?? null,
    maxRequestedProcessMs: maxRequestedProcessMs ?? null,
    maxConcurrent: maxConcurrent ?? null
  };
}

function decodePolicy(parsed: unknown): BudgetPolicy | null {
  if (!parsed || typeof parsed !== 'object') return null;
  const raw = parsed as Partial<BudgetPolicy> & { version?: number };
  if (Number(raw.version) !== 1) return null;
  const clients: Partial<Record<ClientKind, BudgetRule>> = {};
  if (raw.clients && typeof raw.clients === 'object') {
    for (const kind of CLIENT_KINDS) {
      const rule = decodeRule((raw.clients as Record<string, unknown>)[kind], kind);
      if ((raw.clients as Record<string, unknown>)[kind] !== undefined && !rule) return null;
      if (rule) clients[kind] = rule;
    }
  }
  const sharedPresent = raw.shared !== undefined && raw.shared !== null;
  const shared = sharedPresent ? decodeRule(raw.shared, 'shared') : null;
  if (sharedPresent && !shared) return null;
  return {
    version: 1,
    revision: Number.isInteger(raw.revision) && Number(raw.revision) >= 0 ? Number(raw.revision) : 0,
    shared,
    clients,
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : new Date(0).toISOString()
  };
}

async function readPolicyUnlocked(nodeId: string, dir: string): Promise<BudgetPolicyInspection> {
  const file = budgetPolicyFile(nodeId, dir);
  try {
    const parsed = JSON.parse(await fs.readFile(file, 'utf8')) as unknown;
    const policy = decodePolicy(parsed);
    if (!policy) {
      return { exists: true, valid: false, unrestricted: true, policy: emptyBudgetPolicy(), errors: ['budget policy is corrupt; treating as unrestricted'] };
    }
    return { exists: true, valid: true, unrestricted: !policyRestricts(policy), policy, errors: [] };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { exists: false, valid: true, unrestricted: true, policy: emptyBudgetPolicy(), errors: [] };
    }
    return { exists: true, valid: false, unrestricted: true, policy: emptyBudgetPolicy(), errors: ['budget policy is unreadable; treating as unrestricted'] };
  }
}

export async function inspectBudgetPolicy(nodeId: string, dir = stateDir()): Promise<BudgetPolicyInspection> {
  return readPolicyUnlocked(nodeId, dir);
}

export async function loadBudgetPolicy(nodeId: string, dir = stateDir()): Promise<BudgetPolicy> {
  return (await readPolicyUnlocked(nodeId, dir)).policy;
}

export function rulesForClient(policy: BudgetPolicy, client: ClientKind): BudgetRule[] {
  const rules: BudgetRule[] = [];
  if (policy.shared && budgetRuleRestricts(policy.shared)) rules.push(policy.shared);
  const perClient = policy.clients[client];
  if (perClient && budgetRuleRestricts(perClient)) rules.push(perClient);
  return rules;
}

export function makeBudgetRule(id: string, windowMs: number, limits: Partial<Omit<BudgetRule, 'id' | 'windowMs'>>): BudgetRule {
  if (!Number.isInteger(windowMs) || windowMs <= 0) throw new Error('budget window must be a positive integer number of milliseconds');
  const rule: BudgetRule = {
    id,
    windowMs,
    maxOperations: limits.maxOperations ?? null,
    maxMutations: limits.maxMutations ?? null,
    maxShellCalls: limits.maxShellCalls ?? null,
    maxRequestedWriteBytes: limits.maxRequestedWriteBytes ?? null,
    maxRequestedProcessMs: limits.maxRequestedProcessMs ?? null,
    maxConcurrent: limits.maxConcurrent ?? null
  };
  if (!budgetRuleRestricts(rule)) throw new Error('budget set requires at least one --max-* ceiling');
  return rule;
}

async function writePolicyUnlocked(nodeId: string, policy: BudgetPolicy, revision: number, dir: string): Promise<BudgetPolicy> {
  const next: BudgetPolicy = { ...policy, version: 1, revision, updatedAt: new Date().toISOString() };
  await atomicWriteFile(budgetPolicyFile(nodeId, dir), JSON.stringify(next, null, 2) + '\n', 0o600);
  return next;
}

export async function withBudgetLock<T>(nodeId: string, fn: () => Promise<T>, dir = stateDir()): Promise<T> {
  return withFileLock(budgetLockFile(nodeId, dir), fn);
}

export async function updateBudgetPolicy(
  nodeId: string,
  mutate: (current: BudgetPolicy) => BudgetPolicy | Promise<BudgetPolicy>,
  dir = stateDir()
): Promise<BudgetPolicy> {
  return withBudgetLock(nodeId, async () => {
    const current = (await readPolicyUnlocked(nodeId, dir)).policy;
    const proposed = await mutate(current);
    return writePolicyUnlocked(nodeId, proposed, current.revision + 1, dir);
  }, dir);
}

export async function upsertBudgetRule(nodeId: string, scope: BudgetScope, rule: BudgetRule, dir = stateDir()): Promise<BudgetPolicy> {
  return updateBudgetPolicy(nodeId, current => {
    if (scope === 'shared') return { ...current, shared: { ...rule, id: 'shared' } };
    return { ...current, clients: { ...current.clients, [scope]: { ...rule, id: scope } } };
  }, dir);
}

export async function clearBudgetRule(nodeId: string, id: string, dir = stateDir()): Promise<BudgetPolicy> {
  return updateBudgetPolicy(nodeId, current => {
    if (id === 'shared' || current.shared?.id === id) return { ...current, shared: null };
    const clients = { ...current.clients };
    for (const kind of CLIENT_KINDS) {
      if (kind === id || clients[kind]?.id === id) {
        delete clients[kind];
        return { ...current, clients };
      }
    }
    throw new Error(`no budget ${id}`);
  }, dir);
}

export function listBudgetRules(policy: BudgetPolicy): BudgetRule[] {
  const rules: BudgetRule[] = [];
  if (policy.shared) rules.push(policy.shared);
  for (const kind of CLIENT_KINDS) {
    const rule = policy.clients[kind];
    if (rule) rules.push(rule);
  }
  return rules;
}
