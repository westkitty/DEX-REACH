import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { nativeCall } from '../node/native.js';
import {
  WORKSPACE_WORKER_MAX_FRAME_BYTES,
  WORKSPACE_WORKER_OPERATIONS,
  WORKSPACE_WORKER_PROTOCOL_VERSION,
  scrubWorkspaceWorkerEnvironment,
  workspaceWorkerConfigFile,
  workspaceWorkerDir,
  workspaceWorkerRootsHash,
  workspaceWorkerSocketPath,
  type WorkspaceWorkerConfig,
  type WorkspaceWorkerOperation
} from '../shared/workspace-worker.js';

const preservedDir = process.env.DEX_WORKSPACE_WORKER_DIR;
const cleanEnv = scrubWorkspaceWorkerEnvironment(process.env);
for (const key of Object.keys(process.env)) delete process.env[key];
Object.assign(process.env, cleanEnv);
if (preservedDir) process.env.DEX_WORKSPACE_WORKER_DIR = preservedDir;

const MAX_INFLIGHT = 2;
const MAX_QUEUE = 16;
type Task = { run: () => Promise<void> };
const queue: Task[] = [];
let inflight = 0;

function safeError(error: unknown): string {
  return (error instanceof Error ? error.message : 'workspace worker request failed').replace(/[\r\n]+/g, ' ').slice(0, 300);
}

async function loadConfig(): Promise<WorkspaceWorkerConfig> {
  const dir = workspaceWorkerDir();
  const file = workspaceWorkerConfigFile();
  const [dirStat, fileStat, raw] = await Promise.all([fs.stat(dir), fs.stat(file), fs.readFile(file, 'utf8')]);
  const uid = process.getuid?.();
  if (uid !== undefined && (dirStat.uid !== uid || fileStat.uid !== uid)) throw new Error('workspace worker config is not owned by this account');
  if ((dirStat.mode & 0o777) !== 0o700) throw new Error('workspace worker directory must be mode 0700');
  if ((fileStat.mode & 0o777) !== 0o600) throw new Error('workspace worker config must be mode 0600');
  const parsed = JSON.parse(raw) as WorkspaceWorkerConfig;
  if (parsed.version !== 1 || typeof parsed.nodeId !== 'string' || !parsed.nodeId) throw new Error('workspace worker config is invalid');
  if (!Array.isArray(parsed.allowedRoots) || !parsed.allowedRoots.length || parsed.allowedRoots.some(root => typeof root !== 'string' || !path.isAbsolute(root))) {
    throw new Error('workspace worker roots are invalid');
  }
  if (parsed.rootsHash !== workspaceWorkerRootsHash(parsed.allowedRoots)) throw new Error('workspace worker root hash is invalid');
  return parsed;
}

async function activeSocket(): Promise<boolean> {
  return new Promise(resolve => {
    const socket = net.createConnection({ path: workspaceWorkerSocketPath() });
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', () => resolve(false));
  });
}

async function prepareSocket(): Promise<void> {
  await fs.mkdir(workspaceWorkerDir(), { recursive: true, mode: 0o700 });
  await fs.chmod(workspaceWorkerDir(), 0o700);
  try {
    const stat = await fs.lstat(workspaceWorkerSocketPath());
    if (!stat.isSocket()) throw new Error('workspace worker socket path exists but is not a socket');
    if (stat.uid !== process.getuid?.()) throw new Error('workspace worker socket is not owned by this account');
    if (await activeSocket()) throw new Error('another workspace worker is already listening');
    await fs.unlink(workspaceWorkerSocketPath());
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

function drain(): void {
  while (inflight < MAX_INFLIGHT && queue.length) {
    const task = queue.shift()!;
    inflight += 1;
    void task.run().finally(() => { inflight -= 1; drain(); });
  }
}

const config = await loadConfig();
await prepareSocket();
const server = net.createServer(socket => {
  socket.setEncoding('utf8');
  let input = '';
  let handled = false;
  socket.on('data', chunk => {
    if (handled) return;
    input += chunk;
    const newline = input.indexOf('\n');
    if (Buffer.byteLength(input) > WORKSPACE_WORKER_MAX_FRAME_BYTES) { socket.destroy(); return; }
    if (newline < 0) return;
    if (input.slice(newline + 1).trim()) { socket.destroy(); return; }
    handled = true;

    const task: Task = { run: async () => {
      let response: Record<string, unknown>;
      try {
        const request = JSON.parse(input.slice(0, newline)) as { version?: number; command?: string; payload?: Record<string, unknown> };
        if (request.version !== WORKSPACE_WORKER_PROTOCOL_VERSION || request.command !== 'execute' || !request.payload || typeof request.payload !== 'object') {
          throw new Error('invalid workspace worker request');
        }
        const nodeId = request.payload.nodeId;
        const operation = request.payload.operation;
        const args = request.payload.args;
        const expectedRootsHash = request.payload.expectedRootsHash;
        if (nodeId !== config.nodeId) throw new Error('workspace worker node identity mismatch');
        if (expectedRootsHash !== config.rootsHash) {
          response = { ok: false, code: 'config-mismatch', error: 'workspace worker roots no longer match the node; use normal node execution' };
          socket.end(JSON.stringify(response) + '\n');
          return;
        }
        if (typeof operation !== 'string' || !(WORKSPACE_WORKER_OPERATIONS as readonly string[]).includes(operation)) {
          response = { ok: false, code: 'refused', error: 'operation is not in the workspace worker allowlist' };
          socket.end(JSON.stringify(response) + '\n');
          return;
        }
        if (!args || typeof args !== 'object' || Array.isArray(args) || Object.prototype.hasOwnProperty.call(args, 'secrets')) {
          response = { ok: false, code: 'refused', error: 'workspace worker arguments are not eligible' };
          socket.end(JSON.stringify(response) + '\n');
          return;
        }
        const value = await nativeCall(config.nodeId, operation as WorkspaceWorkerOperation, args as Record<string, unknown>, config.allowedRoots, 'workspace-safe');
        response = { ok: true, value };
      } catch (error) {
        response = { ok: false, code: 'invalid', error: safeError(error) };
      }
      socket.end(JSON.stringify(response) + '\n');
    } };

    if (queue.length + inflight >= MAX_QUEUE + MAX_INFLIGHT) {
      socket.end(JSON.stringify({ ok: false, code: 'refused', error: 'workspace worker queue is full' }) + '\n');
      return;
    }
    queue.push(task);
    drain();
  });
});

const umask = process.umask(0o177);
try {
  await new Promise<void>((resolve, reject) => server.once('error', reject).listen({ path: workspaceWorkerSocketPath(), readableAll: false, writableAll: false }, resolve));
} finally {
  process.umask(umask);
}
await fs.chmod(workspaceWorkerSocketPath(), 0o600);
console.log(`DEX//REACH credential-free workspace worker ready for ${os.userInfo().username}`);

const stop = () => server.close(() => void fs.rm(workspaceWorkerSocketPath(), { force: true }).finally(() => process.exit(0)));
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
