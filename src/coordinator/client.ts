import fs from 'node:fs/promises';
import net from 'node:net';
import {
  acquireWork,
  cancelTicket,
  coordinatorSocketPath,
  heartbeat,
  releaseWork,
  workStatus,
  type AdmissionResult,
  type ReleaseResult,
  type WorkRequest,
  type WorkStatus,
  type WorkEventWindow
} from '../shared/work-coordinator.js';

const PROTOCOL_VERSION = 1;
const MAX_FRAME_BYTES = 16 * 1024;

type Command = 'status' | 'acquire' | 'heartbeat' | 'release' | 'cancel' | 'events';
type WireRequest = { version: number; command: Command; payload?: Record<string, unknown> };
type WireResponse = { ok: true; value: unknown } | { ok: false; error: string };

export class CoordinatorUnavailableError extends Error {
  constructor(message: string) { super(message); this.name = 'CoordinatorUnavailableError'; }
}

async function socketPresent(): Promise<boolean> {
  try {
    const stat = await fs.lstat(coordinatorSocketPath());
    if (!stat.isSocket()) throw new CoordinatorUnavailableError('coordinator socket path is not a socket; refusing direct coordination fallback');
    // The daemon refuses to take over a socket another account owns; a client has to make the same
    // check before trusting one. The path is a digest of a non-secret state directory, so where the
    // temporary directory is shared between accounts another local user can create it first. A
    // forged answer cannot widen what any request may do -- admission grants no execution authority
    // (DEX-INV-022) -- but it could make DEX oversubscribe the machine or refuse all work, so this
    // refuses rather than falling back silently: a foreign socket means coordination is ambiguous,
    // and direct mode would then run beside a scheduler we cannot see.
    const uid = process.getuid?.();
    if (uid !== undefined && stat.uid !== uid) throw new CoordinatorUnavailableError('coordinator socket is owned by another account; refusing to coordinate through it');
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function callDaemon(command: Command, payload?: Record<string, unknown>): Promise<unknown | null> {
  if (!(await socketPresent())) return null;
  const request = JSON.stringify({ version: PROTOCOL_VERSION, command, ...(payload ? { payload } : {}) } satisfies WireRequest) + '\n';
  if (Buffer.byteLength(request) > MAX_FRAME_BYTES) throw new CoordinatorUnavailableError('coordinator request exceeds the local protocol limit');
  return new Promise<unknown>((resolve, reject) => {
    const socket = net.createConnection({ path: coordinatorSocketPath() });
    let received = '';
    const timer = setTimeout(() => socket.destroy(new CoordinatorUnavailableError('coordinator daemon did not respond in time')), 5_000);
    socket.setEncoding('utf8');
    socket.once('error', error => reject(new CoordinatorUnavailableError(`coordinator daemon unavailable: ${error.message}`)));
    socket.on('data', chunk => {
      received += chunk;
      if (Buffer.byteLength(received) > MAX_FRAME_BYTES) socket.destroy(new CoordinatorUnavailableError('coordinator response exceeds the local protocol limit'));
      const newline = received.indexOf('\n');
      if (newline < 0) return;
      try {
        const response = JSON.parse(received.slice(0, newline)) as WireResponse;
        if (!response || typeof response !== 'object' || typeof response.ok !== 'boolean') throw new Error('malformed coordinator response');
        if (!response.ok) throw new CoordinatorUnavailableError(response.error);
        resolve(response.value);
      } catch (error) { reject(error); }
      socket.end();
    });
    socket.once('close', () => clearTimeout(timer));
    socket.once('connect', () => socket.write(request));
  });
}

function object<T>(value: unknown): T { return value as T; }

/** Production callers prefer the single-writer daemon. Direct mode is bootstrap/test-only. */
export async function coordinatedAcquire(request: WorkRequest): Promise<AdmissionResult> {
  const value = await callDaemon('acquire', { request: request as unknown as Record<string, unknown> });
  return value === null ? acquireWork(request) : object<AdmissionResult>(value);
}

export async function coordinatedRelease(id: string, options: { pid?: number; force?: boolean } = {}): Promise<ReleaseResult> {
  const value = await callDaemon('release', { id, options });
  return value === null ? releaseWork(id, options) : object<ReleaseResult>(value);
}

export async function coordinatedHeartbeat(id: string): Promise<boolean> {
  const value = await callDaemon('heartbeat', { id });
  return value === null ? heartbeat(id) : Boolean(value);
}

export async function coordinatedCancel(id: string): Promise<boolean> {
  const value = await callDaemon('cancel', { id });
  return value === null ? cancelTicket(id) : Boolean(value);
}

export async function coordinatedStatus(): Promise<WorkStatus> {
  const value = await callDaemon('status');
  return value === null ? workStatus() : object<WorkStatus>(value);
}

export async function coordinatedEvents(cursor = 0, limit = 100): Promise<WorkEventWindow> {
  const value = await callDaemon('events', { cursor, limit });
  if (value === null) {
    const { readWorkEvents } = await import('../shared/work-coordinator.js');
    return readWorkEvents(cursor, limit);
  }
  return object<WorkEventWindow>(value);
}
