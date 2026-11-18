import crypto from 'node:crypto';
import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { RequestActor } from '../shared/protocol.js';
import { hashValue } from '../shared/hash.js';
import { atomicWriteFile } from '../shared/state-io.js';
import { TASK_ID_PATTERN, type ReachTaskRecord } from './task-store.js';

const MAX_DESCRIPTOR_BYTES = 64 * 1024;
const REPLAYABLE_READS = new Set([
  'dex.fingerprint', 'dex.trustReport', 'dex.repoInfo', 'dex.adbDevices',
  'dex.diagnostic.inspect', 'dex.file.read', 'dex.result.read', 'dex.receipts.list'
]);

export type PrivateReadDescriptor = {
  schemaVersion: 1;
  taskId: string;
  nodeId: string;
  actor: RequestActor;
  operation: string;
  args: Record<string, unknown>;
  payloadSha256: string;
  policyHash: string;
};

export function isReplayableRead(operation: string): boolean {
  return REPLAYABLE_READS.has(operation);
}

function descriptorFile(rootDir: string, taskId: string): string {
  if (!TASK_ID_PATTERN.test(taskId)) throw new Error('invalid recovery task ID');
  return path.join(rootDir, 'tasks', 'private-read-recovery', taskId + '.json');
}

async function privateDirectoryReady(rootDir: string, create: boolean): Promise<boolean> {
  const dir = path.join(rootDir, 'tasks', 'private-read-recovery');
  if (create) await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  let stat;
  try { stat = await fs.lstat(dir); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
  if (!stat.isDirectory() || (stat.mode & 0o077) !== 0 ||
    (typeof process.getuid === 'function' && stat.uid !== process.getuid())) {
    throw new Error('private recovery directory is unsafe or symlinked');
  }
  return true;
}

function actorId(actor: RequestActor): string {
  return 'actor_' + hashValue({ kind: actor.kind, clientId: actor.clientId }).slice(0, 24);
}

function actorValid(value: unknown): value is RequestActor {
  if (!value || typeof value !== 'object') return false;
  const actor = value as Partial<RequestActor>;
  return ['chatgpt', 'claude', 'smoke', 'other'].includes(actor.kind ?? '')
    && typeof actor.clientId === 'string' && actor.clientId.length > 0 && actor.clientId.length <= 256
    && typeof actor.clientName === 'string' && actor.clientName.length <= 256;
}

/** Owner-private request arguments, never embedded in share-safe task records or MCP responses. */
export async function savePrivateReadDescriptor(rootDir: string, value: PrivateReadDescriptor): Promise<void> {
  if (!isReplayableRead(value.operation) || !actorValid(value.actor)) throw new Error('read is not eligible for private recovery');
  if (value.payloadSha256 !== hashValue({ operation: value.operation, args: value.args })) throw new Error('read payload hash mismatch');
  if (!/^[0-9a-f]{64}$/i.test(value.policyHash)) throw new Error('invalid policy hash');
  const file = descriptorFile(rootDir, value.taskId);
  const serialized = JSON.stringify(value) + '\n';
  if (Buffer.byteLength(serialized, 'utf8') > MAX_DESCRIPTOR_BYTES) throw new Error('private recovery descriptor exceeds size limit');
  if (!await privateDirectoryReady(rootDir, true)) throw new Error('private recovery directory missing');
  try {
    await fs.lstat(file);
    throw new Error('private recovery descriptor already exists');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  await atomicWriteFile(file, serialized, 0o600);
}

/** Rejects legacy, missing, malformed, symlinked, misbound or oversized replay input. */
export async function loadVerifiedPrivateReadDescriptor(rootDir: string, task: ReachTaskRecord): Promise<PrivateReadDescriptor | null> {
  if (task.safetyClass !== 'PURE_READ_IDEMPOTENT' || !isReplayableRead(task.operation)) return null;
  const file = descriptorFile(rootDir, task.taskId);
  if (!await privateDirectoryReady(rootDir, false)) return null;
  let handle;
  try { handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_DESCRIPTOR_BYTES || (stat.mode & 0o077) !== 0) throw new Error('private descriptor permissions/type/size invalid');
    const content = await handle.readFile('utf8');
    const item: unknown = JSON.parse(content);
    if (!item || typeof item !== 'object') throw new Error('private descriptor invalid');
    const value = item as Partial<PrivateReadDescriptor>;
    if (value.schemaVersion !== 1 || value.taskId !== task.taskId || value.nodeId !== task.nodeId ||
      value.operation !== task.operation || value.payloadSha256 !== task.payloadSha256 ||
      value.policyHash !== task.policyHash || !actorValid(value.actor) ||
      actorId(value.actor) !== task.actorId || !value.args || typeof value.args !== 'object' ||
      Array.isArray(value.args) || hashValue({ operation: value.operation, args: value.args }) !== task.payloadSha256) {
      throw new Error('private descriptor binding mismatch; automatic replay refused');
    }
    return value as PrivateReadDescriptor;
  } finally {
    await handle.close();
  }
}

/** The descriptor is no longer necessary once the original task is safely terminal. */
export async function discardPrivateReadDescriptor(rootDir: string, taskId: string): Promise<void> {
  try { await fs.unlink(descriptorFile(rootDir, taskId)); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}
