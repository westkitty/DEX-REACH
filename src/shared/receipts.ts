import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { stateDir } from './local-env.js';
import { redact } from './security.js';
import type { RequestActor } from './protocol.js';
import { atomicWriteFile, withFileLock } from './state-io.js';
import { canonicalJson, hashValue } from './hash.js';

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

function shaPrivate(value: unknown): string {
  const safe = typeof value === 'string' ? redact(value) : redact(value);
  return crypto.createHash('sha256').update(JSON.stringify(safe)).digest('hex');
}
function assertNodeId(nodeId: string): void {
  if (!/^[a-z0-9._-]+$/i.test(nodeId)) throw new Error('invalid receipt node id');
}
function dir(): string { return path.join(stateDir(), 'receipts'); }
function logFile(nodeId: string): string { assertNodeId(nodeId); return path.join(dir(), `${nodeId}.jsonl`); }
function keyFile(nodeId: string): string { assertNodeId(nodeId); return path.join(dir(), `${nodeId}.ed25519.pem`); }
function pubFile(nodeId: string): string { assertNodeId(nodeId); return path.join(dir(), `${nodeId}.ed25519.pub.pem`); }
function lockFile(nodeId: string): string { assertNodeId(nodeId); return path.join(dir(), `${nodeId}.lock`); }

async function keysUnlocked(nodeId: string): Promise<{ privateKey: string; publicKey: string }> {
  await fs.mkdir(dir(), { recursive: true, mode: 0o700 });
  try {
    const privateKey = await fs.readFile(keyFile(nodeId), 'utf8');
    const publicKey = crypto.createPublicKey(privateKey).export({ type: 'spki', format: 'pem' }).toString();
    const existingPublic = await fs.readFile(pubFile(nodeId), 'utf8').catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    });
    if (existingPublic !== publicKey) await atomicWriteFile(pubFile(nodeId), publicKey, 0o644);
    return { privateKey, publicKey };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const pair = crypto.generateKeyPairSync('ed25519', {
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' }
    });
    await atomicWriteFile(keyFile(nodeId), pair.privateKey, 0o600);
    await atomicWriteFile(pubFile(nodeId), pair.publicKey, 0o644);
    return pair;
  }
}

async function previousHashUnlocked(nodeId: string): Promise<string | null> {
  try {
    const lines = (await fs.readFile(logFile(nodeId), 'utf8')).trim().split('\n').filter(Boolean);
    if (!lines.length) return null;
    return (JSON.parse(lines[lines.length - 1]!) as ExecutionReceipt).receiptHash;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

export async function appendReceipt(input: {
  nodeId: string;
  actor?: RequestActor;
  operation: string;
  args: Record<string, unknown>;
  ok: boolean;
  result?: unknown;
  error?: string;
  durationMs: number;
  policy: unknown;
  checkpointId?: string | null;
}): Promise<ExecutionReceipt> {
  return withFileLock(lockFile(input.nodeId), async () => {
    const { privateKey, publicKey } = await keysUnlocked(input.nodeId);
    const base = {
      version: 1 as const,
      receiptId: crypto.randomUUID(),
      previousHash: await previousHashUnlocked(input.nodeId),
      at: new Date().toISOString(),
      nodeId: input.nodeId,
      actor: input.actor ?? null,
      operation: input.operation,
      ok: input.ok,
      durationMs: input.durationMs,
      requestHash: shaPrivate({ operation: input.operation, args: input.args }),
      resultHash: shaPrivate(input.ok ? input.result : input.error || ''),
      policyHash: shaPrivate(input.policy),
      checkpointId: input.checkpointId ?? null,
      publicKey
    };
    const signature = crypto.sign(null, Buffer.from(canonicalJson(base)), privateKey).toString('base64');
    const receiptHash = hashValue({ ...base, signature });
    const receipt: ExecutionReceipt = { ...base, signature, receiptHash };
    await fs.appendFile(logFile(input.nodeId), JSON.stringify(receipt) + '\n', { encoding: 'utf8', mode: 0o600 });
    return receipt;
  });
}

export function verifyReceipt(receipt: ExecutionReceipt): boolean {
  try {
    const { signature, receiptHash, ...base } = receipt;
    if (hashValue({ ...base, signature }) !== receiptHash) return false;
    return crypto.verify(null, Buffer.from(canonicalJson(base)), receipt.publicKey, Buffer.from(signature, 'base64'));
  } catch {
    return false;
  }
}

export function verifyReceiptChain(receipts: ExecutionReceipt[]): boolean {
  return receipts.every((receipt, index) => verifyReceipt(receipt) && receipt.previousHash === (index === 0 ? null : receipts[index - 1]!.receiptHash));
}

export async function listReceipts(nodeId: string, limit = 20): Promise<ExecutionReceipt[]> {
  try {
    return (await fs.readFile(logFile(nodeId), 'utf8')).trim().split('\n').filter(Boolean)
      .slice(-Math.max(1, Math.min(limit, 100))).map(line => JSON.parse(line) as ExecutionReceipt);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}
