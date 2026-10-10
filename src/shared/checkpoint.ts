import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import net from 'node:net';
import { canonicalJson } from './hash.js';

/**
 * Production writer-checkpoint participant.
 *
 * A long-running writer process (node, gateway) owns state mutations that a file lock alone cannot
 * fence: multi-lock operations (task store then event log), lock-free persistence queues (OAuth) and
 * appends (audit). The participant gives such a process an operation-level admission gate that a
 * checkpoint holder can close, drain and acknowledge over an owner-only local socket.
 *
 * It is idle by default. Until a process explicitly enables it, every gate call is a direct call with
 * no bookkeeping, timers, sockets or files: ordinary runtime behaviour is unchanged.
 */
export const WRITER_GROUPS = ['tasks-results-events', 'receipts', 'coordinator', 'policy-grants-budgets-plans', 'enrollment-revocation', 'oauth', 'runtime-installer', 'activity-audit-trace-checkpoints'] as const;
export type WriterGroup = typeof WRITER_GROUPS[number];
export type ParticipantRole = 'node' | 'gateway';
export const CHECKPOINT_PROTOCOL = 'dex-reach-checkpoint/1';

export class CheckpointAdmissionClosedError extends Error {
  readonly code = 'CHECKPOINT_ADMISSION_CLOSED';
  constructor() { super('CHECKPOINT_ADMISSION_CLOSED: refused before execution; no state was changed'); }
}

export type CheckpointGate = {
  readonly enabled: boolean;
  /** New work. Refused, before it starts, while a checkpoint holds admission. */
  admit<T>(fn: () => Promise<T>): Promise<T>;
  /** Continuation of already-admitted work (deferred task execution). Never refused; always drained. */
  track<T>(fn: () => Promise<T>): Promise<T>;
  /** Background persistence (OAuth queue). Waits for release instead of failing; not counted while waiting. */
  defer<T>(fn: () => Promise<T>): Promise<T>;
  /** Periodic best-effort work (status, sweeps). Skipped, not queued, while admission is held. */
  skipWhileHeld(fn: () => Promise<unknown>): Promise<void>;
};
const IDLE: CheckpointGate = Object.freeze({ enabled: false, admit: <T>(fn: () => Promise<T>) => fn(), track: <T>(fn: () => Promise<T>) => fn(), defer: <T>(fn: () => Promise<T>) => fn(), skipWhileHeld: async (fn: () => Promise<unknown>) => { await fn(); } });
let processGate: CheckpointGate = IDLE;
/** The process-wide gate. IDLE unless this process explicitly enabled checkpoint participation. */
export function processCheckpoint(): CheckpointGate { return processGate; }

type Hold = { txn: string; nonce: string; until: number; generationAtClose: number; faultsAtClose: number; timer: NodeJS.Timeout; connection?: object };
export type SignedMessage = { payload: Record<string, unknown>; signature: string };
/**
 * Participant-owned ceilings. A holder may ask for shorter windows, never longer ones: timers armed
 * from a peer's request are bounded by these constants, not by other peer-supplied values.
 */
export const CHECKPOINT_MAX_HOLD_MS = 15 * 60_000;
export const CHECKPOINT_MAX_DRAIN_MS = 60_000;
function boundedDuration(value: unknown, minimum: number, maximum: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error('CHECKPOINT_REQUEST_INVALID');
  return value;
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const NONCE = /^[a-f0-9]{64}$/;

export class CheckpointParticipant implements CheckpointGate {
  readonly enabled = true;
  readonly bootId = crypto.randomUUID();
  readonly publicKey: string;
  private readonly privateKey: crypto.KeyObject;
  private inFlight = 0;
  private generation = 0;
  private faults = 0;
  private hold: Hold | undefined;
  private drainWaiters: Array<() => void> = [];
  private releaseWaiters: Array<() => void> = [];

  /** stateRoot binds every message to the exact state directory this process writes. */
  constructor(readonly role: ParticipantRole, readonly nodeId: string, readonly groups: readonly WriterGroup[], readonly stateRoot: { path: string; dev: number; ino: number }) {
    if (!stateRoot.path.startsWith('/') || !/^[a-z0-9][a-z0-9.-]{0,127}$/.test(nodeId) || !groups.length || groups.some(g => !WRITER_GROUPS.includes(g))) throw new Error('CHECKPOINT_PARTICIPANT_INVALID');
    const pair = crypto.generateKeyPairSync('ed25519');
    this.privateKey = pair.privateKey;
    this.publicKey = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  }

  private held(): Hold | undefined {
    if (this.hold !== undefined && Date.now() >= this.hold.until) this.releaseHold();
    return this.hold;
  }
  admit<T>(fn: () => Promise<T>): Promise<T> {
    if (this.held()) return Promise.reject(new CheckpointAdmissionClosedError());
    return this.run(fn);
  }
  track<T>(fn: () => Promise<T>): Promise<T> { return this.run(fn); }
  async defer<T>(fn: () => Promise<T>): Promise<T> {
    while (this.held()) await new Promise<void>(resolve => this.releaseWaiters.push(resolve));
    return this.run(fn);
  }
  async skipWhileHeld(fn: () => Promise<unknown>): Promise<void> {
    if (this.held()) return;
    await this.run(fn);
  }
  private async run<T>(fn: () => Promise<T>): Promise<T> {
    this.inFlight++;
    try {
      const value = await fn();
      this.generation++;
      return value;
    } catch (error) {
      this.generation++;
      // An operation that fails while admission is closing may have committed part of its state.
      if (this.hold) this.faults++;
      throw error;
    } finally {
      this.inFlight--;
      if (this.inFlight === 0 && this.drainWaiters.length) for (const wake of this.drainWaiters.splice(0)) wake();
    }
  }
  private sign(payload: Record<string, unknown>): SignedMessage {
    return { payload, signature: crypto.sign(null, Buffer.from(canonicalJson(payload)), this.privateKey).toString('base64') };
  }
  private identity() { return { protocol: CHECKPOINT_PROTOCOL, role: this.role, nodeId: this.nodeId, groups: [...this.groups], pid: process.pid, bootId: this.bootId, stateRoot: { ...this.stateRoot } }; }
  hello(): SignedMessage { return this.sign({ type: 'hello', ...this.identity(), publicKey: this.publicKey }); }

  /** CLOSE ADMISSION, DRAIN IN-FLIGHT, ACKNOWLEDGE. A drain timeout reopens admission and refuses. */
  async prepare(input: { txn: string; nonce: string; holdMs: number; drainMs: number }, connection?: object): Promise<SignedMessage> {
    if (!UUID.test(input.txn) || !NONCE.test(input.nonce)) throw new Error('CHECKPOINT_REQUEST_INVALID');
    const holdMs = boundedDuration(input.holdMs, 1, CHECKPOINT_MAX_HOLD_MS);
    const drainMs = boundedDuration(input.drainMs, 0, CHECKPOINT_MAX_DRAIN_MS);
    if (drainMs > holdMs) throw new Error('CHECKPOINT_REQUEST_INVALID');
    if (this.held()) return this.sign({ type: 'refused', ...this.identity(), txn: input.txn, nonce: input.nonce, reason: 'CHECKPOINT_ALREADY_HELD' });
    const until = Date.now() + holdMs;
    const timer = setTimeout(() => this.releaseHold(), holdMs); timer.unref();
    this.hold = { txn: input.txn, nonce: input.nonce, until, generationAtClose: this.generation, faultsAtClose: this.faults, timer, connection };
    const drained = this.inFlight === 0 || await new Promise<boolean>(resolve => {
      const deadline = setTimeout(() => resolve(false), drainMs); deadline.unref();
      this.drainWaiters.push(() => { clearTimeout(deadline); resolve(true); });
    });
    const hold = this.hold;
    if (!drained || !hold || hold.txn !== input.txn) {
      if (hold?.txn === input.txn) this.releaseHold();
      return this.sign({ type: 'refused', ...this.identity(), txn: input.txn, nonce: input.nonce, reason: drained ? 'CHECKPOINT_HOLD_LOST' : 'DRAIN_TIMEOUT_OPERATION_MAY_CONTINUE', inFlight: this.inFlight });
    }
    return this.sign({ type: 'ack', ...this.identity(), txn: input.txn, nonce: input.nonce, generation: this.generation, inFlight: this.inFlight, faultsDuringDrain: this.faults - hold.faultsAtClose, holdUntil: new Date(until).toISOString() });
  }
  /** Re-attest that the boundary still holds: same boot, same generation, still closed, no new work. */
  verify(input: { txn: string; nonce: string }): SignedMessage {
    const hold = this.held();
    return this.sign({ type: 'verify', ...this.identity(), txn: input.txn, nonce: input.nonce, held: !!hold && hold.txn === input.txn && hold.nonce === input.nonce, generation: this.generation, inFlight: this.inFlight, faults: this.faults });
  }
  release(input: { txn: string }): SignedMessage {
    const matched = this.hold?.txn === input.txn;
    if (matched) this.releaseHold();
    return this.sign({ type: 'released', ...this.identity(), txn: input.txn, matched });
  }
  /** A vanished holder must not keep admission closed: its connection closing releases its hold. */
  connectionClosed(connection: object): void { if (this.hold?.connection === connection) this.releaseHold(); }
  private releaseHold(): void {
    if (!this.hold) return;
    clearTimeout(this.hold.timer); this.hold = undefined;
    for (const wake of this.releaseWaiters.splice(0)) wake();
  }
}

/** Verify a participant message against the key delivered in the hello on the same connection. */
export function verifySigned(message: unknown, publicKey: string): Record<string, unknown> {
  const m = message as SignedMessage;
  if (!m || typeof m !== 'object' || !m.payload || typeof m.payload !== 'object' || typeof m.signature !== 'string') throw new Error('CHECKPOINT_MESSAGE_MALFORMED');
  const ok = crypto.verify(null, Buffer.from(canonicalJson(m.payload)), publicKey, Buffer.from(m.signature, 'base64'));
  if (!ok) throw new Error('CHECKPOINT_SIGNATURE_INVALID');
  return m.payload;
}

/**
 * Explicitly enable participation and serve the owner-only control socket. Not called by default:
 * a main only calls it when its operator configured a socket path for a separately authorized window.
 */
export async function enableProcessCheckpoint(role: ParticipantRole, nodeId: string, groups: readonly WriterGroup[], socketPath: string, stateDirectory: string): Promise<{ participant: CheckpointParticipant; close: () => Promise<void> }> {
  if (processGate.enabled) throw new Error('CHECKPOINT_ALREADY_ENABLED');
  const real = await fs.realpath(stateDirectory), st = await fs.stat(real);
  const participant = new CheckpointParticipant(role, nodeId, groups, { path: real, dev: st.dev, ino: st.ino });
  // Never displace a live endpoint: a second participant on the same control directory refuses.
  const live = await new Promise<boolean>(resolve => { const probe = net.connect(socketPath); probe.once('connect', () => { probe.destroy(); resolve(true); }); probe.once('error', () => resolve(false)); });
  if (live) throw new Error('CHECKPOINT_SOCKET_IN_USE');
  await fs.rm(socketPath, { force: true });
  const server = net.createServer(socket => {
    const connection = {};
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('data', async chunk => {
      buffer += chunk;
      if (buffer.length > 64 * 1024) { socket.destroy(); return; }
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        let reply: unknown;
        try {
          const request = JSON.parse(line) as { op?: string; txn?: string; nonce?: string; holdMs?: number; drainMs?: number };
          if (request.op === 'hello') reply = participant.hello();
          else if (request.op === 'prepare') reply = await participant.prepare(request as { txn: string; nonce: string; holdMs: number; drainMs: number }, connection);
          else if (request.op === 'verify') reply = participant.verify(request as { txn: string; nonce: string });
          else if (request.op === 'release') reply = participant.release(request as { txn: string });
          else reply = { error: 'CHECKPOINT_OP_UNKNOWN' };
        } catch (error) { reply = { error: error instanceof Error ? error.message : 'CHECKPOINT_REQUEST_INVALID' }; }
        if (!socket.destroyed) socket.write(JSON.stringify(reply) + '\n');
      }
    });
    socket.on('close', () => participant.connectionClosed(connection));
    socket.on('error', () => undefined);
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(socketPath, () => { server.off('error', reject); resolve(); }); });
  await fs.chmod(socketPath, 0o600);
  processGate = participant;
  return { participant, close: async () => { processGate = IDLE; await new Promise<void>(resolve => server.close(() => resolve())); await fs.rm(socketPath, { force: true }); } };
}

/** Owner-only control directory: a real directory, owned by this UID, with no group/other access. */
export async function assertControlDirectory(directory: string): Promise<void> {
  if (!directory.startsWith('/')) throw new Error('CHECKPOINT_CONTROL_DIRECTORY_INVALID');
  const st = await fs.lstat(directory);
  if (st.isSymbolicLink() || !st.isDirectory() || st.uid !== process.getuid?.() || (st.mode & 0o077) !== 0) throw new Error('CHECKPOINT_CONTROL_DIRECTORY_UNSAFE');
}
export function controlSocket(directory: string, role: ParticipantRole): string { return `${directory.replace(/\/+$/, '')}/${role}.sock`; }
export const NODE_PARTICIPANT_GROUPS: readonly WriterGroup[] = ['tasks-results-events', 'receipts', 'policy-grants-budgets-plans', 'activity-audit-trace-checkpoints'];
export const GATEWAY_PARTICIPANT_GROUPS: readonly WriterGroup[] = ['oauth', 'enrollment-revocation', 'activity-audit-trace-checkpoints'];
/**
 * Opt-in only. Without DEX_REACH_CHECKPOINT_CONTROL=1 this returns null and the process stays IDLE.
 * Installed LaunchAgents do not set it; enabling it is a separately authorized maintenance change.
 */
export async function checkpointControlFromEnv(role: ParticipantRole, nodeId: string, stateDirectory: string) {
  if (process.env.DEX_REACH_CHECKPOINT_CONTROL !== '1') return null;
  const directory = process.env.DEX_REACH_CHECKPOINT_CONTROL_DIR || `${stateDirectory.replace(/\/+$/, '')}/checkpoint`;
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await assertControlDirectory(directory);
  return enableProcessCheckpoint(role, nodeId, role === 'node' ? NODE_PARTICIPANT_GROUPS : GATEWAY_PARTICIPANT_GROUPS, controlSocket(directory, role), stateDirectory);
}
