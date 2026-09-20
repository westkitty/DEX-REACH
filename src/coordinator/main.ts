import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import {
  acquireWork,
  cancelTicket,
  coordinatorDir,
  coordinatorSocketPath,
  heartbeat,
  releaseWork,
  snapshotCapacity,
  workStatus,
  type CapacitySnapshot,
  type WorkRequest
} from '../shared/work-coordinator.js';
import { classifyCpuPressure } from '../shared/machine-capacity.js';

const PROTOCOL_VERSION = 1;
const MAX_FRAME_BYTES = 16 * 1024;
const OBSERVATION_TTL_MS = 2_000;
type Command = 'status' | 'acquire' | 'heartbeat' | 'release' | 'cancel' | 'events';
type Request = { version: number; command: Command; payload?: Record<string, unknown> };
type Response = { ok: true; value: unknown } | { ok: false; error: string };
let cachedObservation: { at: number; snapshot: CapacitySnapshot } | null = null;

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : 'coordinator request failed';
  return message.replace(/[\r\n]+/g, ' ').slice(0, 300);
}

function safeRequest(value: unknown): Request {
  if (!value || typeof value !== 'object') throw new Error('request must be an object');
  const raw = value as Record<string, unknown>;
  if (raw.version !== PROTOCOL_VERSION) throw new Error(`unsupported coordinator protocol version`);
  if (!['status', 'acquire', 'heartbeat', 'release', 'cancel', 'events'].includes(String(raw.command))) throw new Error('unknown coordinator command');
  if (raw.payload !== undefined && (!raw.payload || typeof raw.payload !== 'object' || Array.isArray(raw.payload))) throw new Error('payload must be an object');
  return { version: PROTOCOL_VERSION, command: raw.command as Command, ...(raw.payload ? { payload: raw.payload as Record<string, unknown> } : {}) };
}

function invalidateObservation(): void { cachedObservation = null; }

async function observedSnapshot(): Promise<CapacitySnapshot> {
  const cached = cachedObservation;
  if (cached && Date.now() - cached.at < OBSERVATION_TTL_MS) return cached.snapshot;
  const snapshot = await snapshotCapacity();
  // Never reuse a warning/busy sample: only an all-healthy measurement earns the short cache.
  if (snapshot.memory === 'healthy' && snapshot.thermal === 'healthy'
    && classifyCpuPressure(snapshot.loadAverage1m, snapshot.logicalCpuCount) === 'healthy'
    && snapshot.observed.uncoordinatedHeavy === 0) {
    cachedObservation = { at: Date.now(), snapshot };
  } else invalidateObservation();
  return snapshot;
}

async function execute(request: Request): Promise<unknown> {
  const payload = request.payload || {};
  if (request.command === 'status') return workStatus({ snapshot: await observedSnapshot() });
  if (request.command === 'events') return { cursor: null, events: [] };
  if (request.command === 'acquire') {
    const raw = payload.request;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('acquire requires a request object');
    const next = { ...(raw as WorkRequest), snapshot: await observedSnapshot() };
    const result = await acquireWork(next);
    invalidateObservation();
    return result;
  }
  if (request.command === 'heartbeat') {
    if (typeof payload.id !== 'string' || payload.id.length > 128) throw new Error('heartbeat requires a valid id');
    const result = await heartbeat(payload.id); invalidateObservation(); return result;
  }
  if (request.command === 'release') {
    if (typeof payload.id !== 'string' || payload.id.length > 128) throw new Error('release requires a valid id');
    const options = payload.options && typeof payload.options === 'object' ? payload.options as { pid?: number; force?: boolean } : {};
    const result = await releaseWork(payload.id, options); invalidateObservation(); return result;
  }
  if (typeof payload.id !== 'string' || payload.id.length > 128) throw new Error('cancel requires a valid id');
  const result = await cancelTicket(payload.id); invalidateObservation(); return result;
}

async function activeSocket(): Promise<boolean> {
  return new Promise(resolve => {
    const socket = net.createConnection({ path: coordinatorSocketPath() });
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', () => resolve(false));
  });
}

async function prepareSocket(): Promise<void> {
  await fs.mkdir(coordinatorDir(), { recursive: true, mode: 0o700 });
  try {
    const stat = await fs.lstat(coordinatorSocketPath());
    if (!stat.isSocket()) throw new Error('coordinator socket path exists but is not a socket');
    if (stat.uid !== process.getuid?.()) throw new Error('coordinator socket is not owned by this account');
    if (await activeSocket()) throw new Error('another coordinator daemon is already listening');
    await fs.unlink(coordinatorSocketPath());
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

async function main(): Promise<void> {
  await prepareSocket();
  const server = net.createServer(socket => {
    socket.setEncoding('utf8');
    let input = '';
    let handled = false;
    socket.on('data', chunk => {
      if (handled) return;
      input += chunk;
      const newline = input.indexOf('\n');
      if (Buffer.byteLength(input) > MAX_FRAME_BYTES || newline < 0) {
        if (Buffer.byteLength(input) > MAX_FRAME_BYTES) socket.destroy();
        return;
      }
      if (input.slice(newline + 1).trim()) { socket.destroy(); return; }
      handled = true;
      void (async () => {
        let response: Response;
        try { response = { ok: true, value: await execute(safeRequest(JSON.parse(input.slice(0, newline)))) }; }
        catch (error) { response = { ok: false, error: safeError(error) }; }
        socket.end(JSON.stringify(response) + '\n');
      })();
    });
  });
  // The socket lives beneath os.tmpdir() because a Unix socket path has a ~104-character platform
  // limit that the durable state path can exceed. `readableAll`/`writableAll` govern Windows named
  // pipes and do nothing for a Unix socket, so `listen` would otherwise create it with the process
  // umask -- world-connectable on a host whose temporary directory is shared between accounts, which
  // Linux's /tmp is and macOS's per-user /var/folders is not. That left a window between bind and the
  // chmod below in which another local account could connect. Binding under a 0177 umask closes it;
  // the chmod stays as the assertion that the final mode is what we intend.
  const umask = process.umask(0o177);
  try {
    await new Promise<void>((resolve, reject) => server.once('error', reject).listen({ path: coordinatorSocketPath(), readableAll: false, writableAll: false }, resolve));
  } finally {
    process.umask(umask);
  }
  await fs.chmod(coordinatorSocketPath(), 0o600);
  console.log(`DEX//REACH coordinator daemon listening for ${os.userInfo().username}`);
  const stop = () => server.close(() => void fs.rm(coordinatorSocketPath(), { force: true }).finally(() => process.exit(0)));
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
}

await main();
