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
  readWorkEvents,
  recordWorkEvent,
  type CapacitySnapshot,
  type ObservationCacheMetrics,
  type WorkRequest
} from '../shared/work-coordinator.js';
import { pathToFileURL } from 'node:url';

const PROTOCOL_VERSION = 1;
const MAX_FRAME_BYTES = 16 * 1024;
const OBSERVATION_TTL_MS = 2_000;
type Command = 'status' | 'acquire' | 'heartbeat' | 'release' | 'cancel' | 'events';
type Request = { version: number; command: Command; payload?: Record<string, unknown> };
type Response = { ok: true; value: unknown } | { ok: false; error: string };
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

/** Internal sampler seam: status caches observations; admission always measures afresh. */
export function createCoordinatorHandler(sample = snapshotCapacity, elapsed = () => performance.now()) {
  let cachedObservation: { at: number; sampledAt: string; snapshot: CapacitySnapshot } | null = null;
  let inFlight: Promise<CapacitySnapshot> | null = null;
  let generation = 0;
  let hits = 0;
  let misses = 0;
  function observationCacheMetrics(): ObservationCacheMetrics {
    return { hits, misses, hitRate: hits + misses ? hits / (hits + misses) : 0,
      sampledAt: cachedObservation?.sampledAt ?? null,
      ageMs: cachedObservation ? Math.max(0, elapsed() - cachedObservation.at) : null };
  }
  function invalidateObservation(): void { generation += 1; cachedObservation = null; inFlight = null; }
  async function observedSnapshot(fresh = false): Promise<CapacitySnapshot> {
    if (fresh) invalidateObservation();
    const cached = cachedObservation;
    if (!fresh && ((cached && elapsed() - cached.at < OBSERVATION_TTL_MS) || inFlight)) {
      const reuse = cached && elapsed() - cached.at < OBSERVATION_TTL_MS ? Promise.resolve(cached.snapshot) : inFlight!;
      hits += 1;
      await recordWorkEvent({ event: 'cache-hit' }).catch(() => undefined);
      return reuse;
    }
    misses += 1;
    const startedGeneration = generation;
    // Install the promise before any awaited event write so concurrent status requests coalesce.
    const pending = (async () => {
      await recordWorkEvent({ event: 'cache-miss' }).catch(() => undefined);
      const snapshot = await sample();
      const at = elapsed();
      const sampledAt = new Date().toISOString();
      await recordWorkEvent({ event: 'classifier-result', observedUncoordinatedHeavy: snapshot.observed.uncoordinatedHeavy, dexServices: snapshot.observed.dexServices }).catch(() => undefined);
      if (!fresh && generation === startedGeneration) cachedObservation = { at, sampledAt, snapshot };
      return snapshot;
    })();
    if (!fresh) inFlight = pending;
    try { return await pending; } finally { if (inFlight === pending) inFlight = null; }
  }
  async function execute(request: Request): Promise<unknown> {
    const payload = request.payload || {};
    if (request.command === 'status') {
      return { ...(await workStatus({ snapshot: await observedSnapshot() })), observationCache: observationCacheMetrics() };
    }
    if (request.command === 'events') {
      const cursor = payload.cursor === undefined ? 0 : Number(payload.cursor);
      const limit = payload.limit === undefined ? 100 : Number(payload.limit);
      if (!Number.isInteger(cursor) || cursor < 0) throw new Error('events cursor must be a non-negative integer');
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('events limit must be between 1 and 100');
      return readWorkEvents(cursor, limit);
    }
    if (request.command === 'acquire') {
      const raw = payload.request;
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('acquire requires a request object');
      const next = { ...(raw as WorkRequest), snapshot: await observedSnapshot(true) };
      try { return await acquireWork(next); } finally { invalidateObservation(); }
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

  return execute;
}

const execute = createCoordinatorHandler();

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
        catch (error) {
          await recordWorkEvent({ event: 'request-rejected', reason: 'invalid-request' }).catch(() => undefined);
          response = { ok: false, error: safeError(error) };
        }
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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
