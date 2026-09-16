import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { stateDir } from './local-env.js';
import type { RequestActor } from './protocol.js';
import { atomicWriteFile } from './state-io.js';
import { hashValue } from './hash.js';

export { hashValue } from './hash.js';

export type ExecutionPlan = {
  version: 1;
  id: string;
  nodeId: string;
  actor: RequestActor | null;
  operation: string;
  args: Record<string, unknown>;
  requestHash: string;
  policyHash: string;
  createdAt: string;
  expiresAt: string;
  checkpointId: string | null;
  used: boolean;
};

function planDir(): string { return path.join(stateDir(), 'plans'); }
function assertPlanId(id: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) throw new Error('invalid execution plan id');
}
function file(id: string): string { assertPlanId(id); return path.join(planDir(), `${id}.json`); }
function claimFile(id: string): string { assertPlanId(id); return path.join(planDir(), `${id}.claim`); }

export async function createPlan(
  input: Omit<ExecutionPlan, 'version'|'id'|'requestHash'|'createdAt'|'expiresAt'|'used'>,
  ttlMs = 5 * 60_000
): Promise<ExecutionPlan> {
  if (!Number.isFinite(ttlMs) || ttlMs <= 0 || ttlMs > 10 * 60_000) throw new Error('execution plan ttl must be between 1ms and 10m');
  await sweepExpiredPlans();
  const plan: ExecutionPlan = {
    version: 1,
    id: crypto.randomUUID(),
    ...input,
    requestHash: hashValue({ operation: input.operation, args: input.args }),
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + ttlMs).toISOString(),
    used: false
  };
  await fs.mkdir(planDir(), { recursive: true, mode: 0o700 });
  await atomicWriteFile(file(plan.id), JSON.stringify(plan, null, 2) + '\n', 0o600);
  return plan;
}

export async function loadPlan(id: string): Promise<ExecutionPlan> {
  return JSON.parse(await fs.readFile(file(id), 'utf8')) as ExecutionPlan;
}

/**
 * Atomically claim a plan across processes. The on-disk copy is immediately scrubbed of raw arguments,
 * while the exact in-memory copy is returned to the claimant for this one execution.
 */
export async function consumePlan(id: string): Promise<ExecutionPlan> {
  await fs.mkdir(planDir(), { recursive: true, mode: 0o700 });
  let claim: fs.FileHandle;
  try {
    claim = await fs.open(claimFile(id), 'wx', 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('execution plan already used or claimed');
    throw error;
  }
  try {
    await claim.writeFile(JSON.stringify({ pid: process.pid, claimedAt: new Date().toISOString() }) + '\n');
    const plan = await loadPlan(id);
    if (plan.used) throw new Error('execution plan already used');
    if (Date.parse(plan.expiresAt) <= Date.now()) {
      await sanitizePlan(plan, 'expired');
      throw new Error('execution plan expired');
    }
    const execution: ExecutionPlan = { ...plan, used: true };
    await sanitizePlan(execution, 'consumed');
    return execution;
  } finally {
    await claim.close().catch(() => undefined);
  }
}

async function sanitizePlan(plan: ExecutionPlan, reason: 'consumed' | 'expired'): Promise<void> {
  const stored: ExecutionPlan = {
    ...plan,
    used: true,
    args: { redacted: true, reason, requestHash: plan.requestHash }
  };
  await atomicWriteFile(file(plan.id), JSON.stringify(stored, null, 2) + '\n', 0o600);
}

/** Scrub abandoned expired plan arguments. Safe to run at startup and periodically. */
export async function sweepExpiredPlans(now = Date.now()): Promise<number> {
  let names: string[];
  try { names = await fs.readdir(planDir()); } catch { return 0; }
  let scrubbed = 0;
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const id = name.slice(0, -5);
    if (!/^[0-9a-f-]{36}$/i.test(id)) continue;
    try {
      const plan = await loadPlan(id);
      if (!plan.used && Date.parse(plan.expiresAt) <= now) {
        await sanitizePlan(plan, 'expired');
        scrubbed += 1;
      }
    } catch {
      // Malformed plan files remain unreadable and therefore fail closed if referenced.
    }
  }
  return scrubbed;
}
