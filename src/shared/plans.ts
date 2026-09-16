import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { stateDir } from './local-env.js';
import type { RequestActor } from './protocol.js';

export type ExecutionPlan = {
  version: 1; id: string; nodeId: string; actor: RequestActor | null; operation: string; args: Record<string, unknown>;
  requestHash: string; policyHash: string; createdAt: string; expiresAt: string; checkpointId: string | null; used: boolean;
};

function planDir(): string { return path.join(stateDir(), 'plans'); }
function file(id: string): string { return path.join(planDir(), `${id}.json`); }
export function hashValue(value: unknown): string { return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex'); }

export async function createPlan(input: Omit<ExecutionPlan, 'version'|'id'|'requestHash'|'createdAt'|'expiresAt'|'used'>, ttlMs = 5 * 60_000): Promise<ExecutionPlan> {
  const plan: ExecutionPlan = { version: 1, id: crypto.randomUUID(), ...input, requestHash: hashValue({ operation: input.operation, args: input.args }), createdAt: new Date().toISOString(), expiresAt: new Date(Date.now()+ttlMs).toISOString(), used: false };
  await fs.mkdir(planDir(), { recursive: true, mode: 0o700 });
  await fs.writeFile(file(plan.id), JSON.stringify(plan, null, 2), { mode: 0o600 });
  return plan;
}

export async function loadPlan(id: string): Promise<ExecutionPlan> { return JSON.parse(await fs.readFile(file(id), 'utf8')) as ExecutionPlan; }
export async function consumePlan(id: string): Promise<ExecutionPlan> {
  const plan = await loadPlan(id);
  if (plan.used) throw new Error('execution plan already used');
  if (Date.parse(plan.expiresAt) <= Date.now()) throw new Error('execution plan expired');
  const next = { ...plan, used: true };
  await fs.writeFile(file(id), JSON.stringify(next, null, 2), { mode: 0o600 });
  return next;
}
