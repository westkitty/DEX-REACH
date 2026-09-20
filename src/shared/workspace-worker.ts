import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

export const WORKSPACE_WORKER_PROTOCOL_VERSION = 1;
export const WORKSPACE_WORKER_MAX_FRAME_BYTES = 32 * 1024;
export const WORKSPACE_WORKER_OPERATIONS = ['dex.fingerprint', 'dex.repoInfo', 'dex.file.read'] as const;
export type WorkspaceWorkerOperation = (typeof WORKSPACE_WORKER_OPERATIONS)[number];

export type WorkspaceWorkerConfig = {
  version: 1;
  nodeId: string;
  allowedRoots: string[];
  rootsHash: string;
};

type WorkerResponse =
  | { ok: true; value: unknown }
  | { ok: false; error: string; code?: 'config-mismatch' | 'refused' | 'invalid' };

export class WorkspaceWorkerUnavailableError extends Error {
  constructor(message: string) { super(message); this.name = 'WorkspaceWorkerUnavailableError'; }
}

export function workspaceWorkerDir(): string {
  const configured = process.env.DEX_WORKSPACE_WORKER_DIR?.trim();
  return configured ? path.resolve(configured) : path.join(os.homedir(), '.dex-reach-worker');
}
export function workspaceWorkerConfigFile(): string { return path.join(workspaceWorkerDir(), 'config.json'); }
export function workspaceWorkerSocketPath(): string { return path.join(workspaceWorkerDir(), 'worker.sock'); }

export function workspaceWorkerRootsHash(roots: readonly string[]): string {
  const normalized = [...roots].map(root => path.resolve(root)).sort();
  return crypto.createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
}

export function workspaceWorkerEligible(operation: string, args: Record<string, unknown>): operation is WorkspaceWorkerOperation {
  if (!(WORKSPACE_WORKER_OPERATIONS as readonly string[]).includes(operation)) return false;
  if (Object.prototype.hasOwnProperty.call(args, 'secrets')) return false;
  return true;
}

/** Minimal environment for the credential-free worker. No provider, DEX, SSH-agent or secret variables survive. */
export function scrubWorkspaceWorkerEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const keep = new Set(['PATH', 'HOME', 'USER', 'LOGNAME', 'TMPDIR', 'LANG', 'LC_ALL', 'LC_CTYPE', 'SHELL', 'DEX_WORKSPACE_WORKER_DIR']);
  return Object.fromEntries(Object.entries(source).filter(([key, value]) => keep.has(key) && value !== undefined));
}

async function socketPresent(): Promise<boolean> {
  try {
    const stat = await fs.lstat(workspaceWorkerSocketPath());
    if (!stat.isSocket()) throw new WorkspaceWorkerUnavailableError('workspace worker socket path is not a socket');
    const uid = process.getuid?.();
    if (uid !== undefined && stat.uid !== uid) throw new WorkspaceWorkerUnavailableError('workspace worker socket is owned by another account');
    if ((stat.mode & 0o777) !== 0o600) throw new WorkspaceWorkerUnavailableError('workspace worker socket is not owner-only');
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function callWorker(payload: Record<string, unknown>): Promise<WorkerResponse | null> {
  if (!(await socketPresent())) return null;
  const request = JSON.stringify({ version: WORKSPACE_WORKER_PROTOCOL_VERSION, command: 'execute', payload }) + '\n';
  if (Buffer.byteLength(request) > WORKSPACE_WORKER_MAX_FRAME_BYTES) throw new WorkspaceWorkerUnavailableError('workspace worker request exceeds protocol limit');
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ path: workspaceWorkerSocketPath() });
    let received = '';
    const timer = setTimeout(() => socket.destroy(new WorkspaceWorkerUnavailableError('workspace worker did not respond in time')), 5_000);
    socket.setEncoding('utf8');
    socket.once('error', error => reject(new WorkspaceWorkerUnavailableError(`workspace worker unavailable: ${error.message}`)));
    socket.on('data', chunk => {
      received += chunk;
      if (Buffer.byteLength(received) > WORKSPACE_WORKER_MAX_FRAME_BYTES) {
        socket.destroy(new WorkspaceWorkerUnavailableError('workspace worker response exceeds protocol limit'));
        return;
      }
      const newline = received.indexOf('\n');
      if (newline < 0) return;
      try {
        const response = JSON.parse(received.slice(0, newline)) as WorkerResponse;
        if (!response || typeof response !== 'object' || typeof response.ok !== 'boolean') throw new Error('malformed workspace worker response');
        resolve(response);
      } catch (error) { reject(error); }
      socket.end();
    });
    socket.once('close', () => clearTimeout(timer));
    socket.once('connect', () => socket.write(request));
  });
}

export async function workspaceWorkerExecute(
  nodeId: string,
  operation: string,
  args: Record<string, unknown>,
  expectedRootsHash: string
): Promise<unknown | null> {
  if (!workspaceWorkerEligible(operation, args)) return null;
  const response = await callWorker({ nodeId, operation, args, expectedRootsHash });
  if (response === null) return null;
  if (!response.ok) {
    if (response.code === 'config-mismatch') return null;
    throw new WorkspaceWorkerUnavailableError(response.error);
  }
  return response.value;
}
