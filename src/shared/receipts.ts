import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { stateDir } from './local-env.js';
import { redact } from './security.js';
import type { RequestActor } from './protocol.js';

export type ExecutionReceipt = {
  version: 1;
  receiptId: string;
  previousHash: string | null;
  at: string;
  nodeId: string;
  actor: RequestActor | null;
  operation: string;
  ok: boolean;
  durationMs: number;
  requestHash: string;
  resultHash: string;
  policyHash: string;
  checkpointId: string | null;
  publicKey: string;
  signature: string;
  receiptHash: string;
};

function canonical(value: unknown): string {
  const normalize = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(normalize);
    if (input && typeof input === 'object') return Object.fromEntries(Object.entries(input as Record<string, unknown>).sort(([a],[b]) => a.localeCompare(b)).map(([k,v]) => [k, normalize(v)]));
    return input;
  };
  return JSON.stringify(normalize(value));
}
function sha(value: unknown): string { return crypto.createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(redact(value))).digest('hex'); }
function dir(): string { return path.join(stateDir(), 'receipts'); }
function logFile(nodeId: string): string { return path.join(dir(), `${nodeId}.jsonl`); }
function keyFile(nodeId: string): string { return path.join(dir(), `${nodeId}.ed25519.pem`); }
function pubFile(nodeId: string): string { return path.join(dir(), `${nodeId}.ed25519.pub.pem`); }

async function keys(nodeId: string): Promise<{ privateKey: string; publicKey: string }> {
  await fs.mkdir(dir(), { recursive: true, mode: 0o700 });
  try { return { privateKey: await fs.readFile(keyFile(nodeId), 'utf8'), publicKey: await fs.readFile(pubFile(nodeId), 'utf8') }; }
  catch {
    const pair = crypto.generateKeyPairSync('ed25519', { privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
    await fs.writeFile(keyFile(nodeId), pair.privateKey, { mode: 0o600 });
    await fs.writeFile(pubFile(nodeId), pair.publicKey, { mode: 0o644 });
    return pair;
  }
}

async function previousHash(nodeId: string): Promise<string | null> {
  try {
    const lines = (await fs.readFile(logFile(nodeId), 'utf8')).trim().split('\n').filter(Boolean);
    if (!lines.length) return null;
    return (JSON.parse(lines[lines.length - 1]!) as ExecutionReceipt).receiptHash;
  } catch { return null; }
}

export async function appendReceipt(input: {
  nodeId: string; actor?: RequestActor; operation: string; args: Record<string, unknown>; ok: boolean;
  result?: unknown; error?: string; durationMs: number; policy: unknown; checkpointId?: string | null;
}): Promise<ExecutionReceipt> {
  const { privateKey, publicKey } = await keys(input.nodeId);
  const base = {
    version: 1 as const,
    receiptId: crypto.randomUUID(), previousHash: await previousHash(input.nodeId), at: new Date().toISOString(), nodeId: input.nodeId,
    actor: input.actor ?? null, operation: input.operation, ok: input.ok, durationMs: input.durationMs,
    requestHash: sha({ operation: input.operation, args: input.args }), resultHash: sha(input.ok ? input.result : input.error || ''),
    policyHash: sha(input.policy), checkpointId: input.checkpointId ?? null, publicKey
  };
  const payload = canonical(base);
  const signature = crypto.sign(null, Buffer.from(payload), privateKey).toString('base64');
  const receiptHash = sha({ ...base, signature });
  const receipt: ExecutionReceipt = { ...base, signature, receiptHash };
  await fs.appendFile(logFile(input.nodeId), JSON.stringify(receipt) + '\n', { encoding: 'utf8', mode: 0o600 });
  return receipt;
}

export async function listReceipts(nodeId: string, limit = 20): Promise<ExecutionReceipt[]> {
  try { return (await fs.readFile(logFile(nodeId), 'utf8')).trim().split('\n').filter(Boolean).slice(-Math.max(1, Math.min(limit, 100))).map(line => JSON.parse(line) as ExecutionReceipt); }
  catch { return []; }
}
