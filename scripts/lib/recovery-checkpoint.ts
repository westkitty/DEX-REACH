import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { hashValue } from '../../src/shared/hash.js';
import { withFileLock } from '../../src/shared/state-io.js';
import { CHECKPOINT_PROTOCOL, GATEWAY_PARTICIPANT_GROUPS, NODE_PARTICIPANT_GROUPS, WRITER_GROUPS, assertControlDirectory, controlSocket, verifySigned, type ParticipantRole, type WriterGroup } from '../../src/shared/checkpoint.js';
import { taskStoreLockFile } from '../../src/node/task-store.js';
import { taskEventLockFile } from '../../src/shared/task-events.js';
import { accessLockFile } from '../../src/shared/access.js';
import { budgetLockFile } from '../../src/shared/budget-policy.js';
import { capabilityRequestLockFile } from '../../src/shared/capability-requests.js';
import { policyAssertionFile } from '../../src/shared/policy-assertions.js';
// The secret broker is deliberately not imported here (node-only resolve path); its lock path is
// spelled out and pinned to the broker's own helper by tests/c14-checkpoint-evidence.test.ts.
import { inspectCoverage, withFencedLocks } from './recovery-coverage.js';
import { registerBoundary, boundaryFingerprintMatches, type BoundaryOwner, type SnapshotBoundary } from './recovery-consistency.js';
import { assertOwned, type SyntheticWorkspace } from './recovery-rehearsal.js';
import { captureSynthetic } from './recovery-capture.js';
import { inspectTasks } from './recovery-reconciliation.js';
import type { DestinationFacts } from './recovery-destination.js';
import type { LinkPolicy } from './recovery-symlinks.js';
import { installLockFile } from './runtime-release.js';
import { artifactDigest, type ExpectationStore, type TransactionEvidenceLog } from './recovery-evidence.js';

/**
 * Writer ownership matrix, as implemented. `participant` groups are drained inside their owning
 * process; `locks` fence every other process that mutates through the shared file locks. A group
 * whose only quiescence is process absence is refused unless that absence is proven.
 */
export type WriterOwnership = { group: WriterGroup; participants: ParticipantRole[]; locks: (state: string, nodeId: string) => string[]; processAbsence?: RegExp; undetectable: string[] };
export const WRITER_OWNERSHIP: readonly WriterOwnership[] = [
  { group: 'tasks-results-events', participants: ['node'], locks: (s) => [path.join(s, 'tasks', 'admission.lock'), taskStoreLockFile(s), taskEventLockFile(s), path.join(s, 'results', 'results.lock')], undetectable: [] },
  { group: 'receipts', participants: ['node'], locks: (s, n) => [path.join(s, 'receipts', `${n}.lock`)], undetectable: [] },
  { group: 'coordinator', participants: [], locks: (s) => [path.join(s, 'coordinator', 'coordinator.lock'), path.join(s, 'coordinator', 'history', 'events.lock'), path.join(s, 'coordinator', 'capacity-profile.lock')], undetectable: [] },
  { group: 'policy-grants-budgets-plans', participants: ['node'], locks: (s, n) => [accessLockFile(n, s), budgetLockFile(n, s), capabilityRequestLockFile(n, s), `${policyAssertionFile(n, s)}.lock`, path.join(s, 'nodes', `${n}.secrets.json.lock`)], undetectable: ['plan claim files use exclusive create without a shared lock; changes are detected, not prevented'] },
  { group: 'enrollment-revocation', participants: ['gateway'], locks: (s) => [path.join(s, 'node-auth.json.lock'), path.join(s, 'revoked-nodes.json.lock')], undetectable: [] },
  { group: 'oauth', participants: ['gateway'], locks: () => [], undetectable: [] },
  { group: 'runtime-installer', participants: [], locks: (s) => [installLockFile(s)], processAbsence: /scripts\/(?:install-macos|rollback-macos|reload-launchagents|uninstall-macos)\.(?:ts|js)(?:\s|$)/m, undetectable: ['install and rollback are fenced by install.lock; the detached launchd reload helper and uninstall take no lock, so their quiescence is process absence plus unchanged content'] },
  { group: 'activity-audit-trace-checkpoints', participants: ['node', 'gateway'], locks: (s) => [path.join(s, 'activity', 'processes.lock')], undetectable: ['asynchronous trace span flushes and per-trace locks are detected by content comparison, not prevented'] }
];
/** Every documented group must be owned exactly once; an unknown or duplicated owner refuses. */
export function ownershipBlockers(matrix: readonly WriterOwnership[] = WRITER_OWNERSHIP): string[] {
  const issues: string[] = [];
  for (const group of WRITER_GROUPS) if (matrix.filter(m => m.group === group).length !== 1) issues.push(`WRITER_OWNERSHIP_UNKNOWN:${group}`);
  for (const m of matrix) {
    if (!WRITER_GROUPS.includes(m.group)) issues.push('WRITER_OWNERSHIP_UNREGISTERED');
    for (const role of m.participants) if (!(role === 'node' ? NODE_PARTICIPANT_GROUPS : GATEWAY_PARTICIPANT_GROUPS).includes(m.group)) issues.push(`PARTICIPANT_DOES_NOT_OWN:${role}:${m.group}`);
    if (!m.participants.length && !m.locks('/x', 'n').length && !m.processAbsence) issues.push(`WRITER_QUIESCENCE_UNDEFINED:${m.group}`);
  }
  return issues;
}

/** Evidence and outcomes carry fixed codes only; raw error text can embed paths or parsed content. */
export function refusalCode(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  if (/^[A-Z][A-Z0-9_]{2,80}(?::[a-z][a-z-]{0,40}(?::[A-Z0-9_]{1,80})?)?$/.test(message)) return message;
  const code = (error as NodeJS.ErrnoException)?.code;
  return typeof code === 'string' && /^E[A-Z]{2,20}$/.test(code) ? `CHECKPOINT_FAILED:${code}` : 'CHECKPOINT_FAILED';
}
type Hello = { role: ParticipantRole; nodeId: string; groups: WriterGroup[]; pid: number; bootId: string; publicKey: string; stateRoot: { path: string; dev: number; ino: number } };
class ParticipantChannel {
  private buffer = ''; private waiting: Array<(line: string) => void> = []; private lines: string[] = []; private closed = false;
  hello!: Hello;
  private constructor(private readonly socket: net.Socket, readonly role: ParticipantRole, private readonly responseMs: number) {
    socket.setEncoding('utf8');
    socket.on('data', chunk => {
      this.buffer += chunk;
      let i: number;
      while ((i = this.buffer.indexOf('\n')) >= 0) { const line = this.buffer.slice(0, i); this.buffer = this.buffer.slice(i + 1); const wake = this.waiting.shift(); if (wake) wake(line); else this.lines.push(line); }
    });
    socket.on('close', () => { this.closed = true; });
    socket.on('error', () => undefined);
  }
  static async open(socketPath: string, role: ParticipantRole, responseMs: number): Promise<ParticipantChannel> {
    const socket = await new Promise<net.Socket>((resolve, reject) => {
      const s = net.connect(socketPath); const t = setTimeout(() => { s.destroy(); reject(new Error(`WRITER_UNRESPONSIVE:${role}`)); }, responseMs);
      s.once('connect', () => { clearTimeout(t); resolve(s); }); s.once('error', () => { clearTimeout(t); reject(new Error(`WRITER_MISSING:${role}`)); });
    });
    return new ParticipantChannel(socket, role, responseMs);
  }
  /** Exactly one reply per request. Silence is UNKNOWN, never evidence that the writer stopped. */
  async request(body: Record<string, unknown>, timeoutMs = this.responseMs): Promise<unknown> {
    if (this.closed) throw new Error(`WRITER_CONNECTION_LOST:${this.role}`);
    if (this.lines.length) throw new Error(`WRITER_PROTOCOL_UNSOLICITED:${this.role}`);
    this.socket.write(JSON.stringify(body) + '\n');
    const line = await new Promise<string>((resolve, reject) => {
      const t = setTimeout(() => { this.waiting = this.waiting.filter(w => w !== wake); reject(new Error(`WRITER_UNRESPONSIVE:${this.role}`)); }, timeoutMs);
      const wake = (l: string) => { clearTimeout(t); resolve(l); }; this.waiting.push(wake);
      this.socket.once('close', () => { clearTimeout(t); reject(new Error(`WRITER_CONNECTION_LOST:${this.role}`)); });
    });
    return JSON.parse(line) as unknown;
  }
  unsolicited(): boolean { return this.lines.length > 0 || this.buffer.length > 0; }
  close(): void { this.socket.destroy(); }
}

export type CheckpointConfig = {
  workspace: SyntheticWorkspace; nodeId: string; controlDirectory: string; destination: DestinationFacts;
  log: TransactionEvidenceLog; expectations: ExpectationStore;
  holdMs: number; drainMs: number; responseMs: number; lockTimeoutMs: number; linkPolicy?: LinkPolicy;
  processTable: () => Promise<string>;
  /** Test-only fault seams between protocol steps; production callers pass nothing. */
  hooks?: Partial<Record<'afterAcks' | 'afterFence' | 'beforeCapture' | 'afterCapture', () => Promise<void>>>;
};
export type CheckpointOutcome = Readonly<{ status: 'CERTIFIED_SYNTHETIC' | 'REFUSED' | 'FAILED_UNCERTAIN'; transactionId: string; reason?: string; manifestDigest?: string; artifactDigest?: string; preservedUnresolvedTasks: number; replayAuthorized: false; installationAuthority: false }>;

async function nestedLocks<T>(files: string[], timeoutMs: number, fn: () => Promise<T>): Promise<T> {
  if (!files.length) return fn();
  const [first, ...rest] = files;
  try { return await withFileLock(first!, () => nestedLocks(rest, timeoutMs, fn), { timeoutMs }); }
  catch (error) { if (error instanceof Error && /timed out waiting for DEX state lock/.test(error.message)) throw new Error("WRITER_LOCK_UNAVAILABLE"); throw error; }
}

/**
 * PREPARE → CLOSE ADMISSION → DRAIN → COLLECT CHECKPOINTS → VALIDATE GENERATION → CAPTURE →
 * VERIFY INDEPENDENT EXPECTATIONS → RELEASE OR RECONCILE. Synthetic workspaces only: the capture is
 * `captureSynthetic`, and nothing here can reach live owner state or mint installation authority.
 */
export async function runWriterCheckpoint(config: CheckpointConfig): Promise<CheckpointOutcome> {
  await assertOwned(config.workspace);
  await assertControlDirectory(config.controlDirectory);
  const transactionId = crypto.randomUUID(), nonce = crypto.randomBytes(32).toString('hex');
  const state = config.workspace.source.state;
  let preserved = 0;
  const outcome = (status: CheckpointOutcome['status'], extra: Partial<CheckpointOutcome> = {}): CheckpointOutcome => Object.freeze({ status, transactionId, preservedUnresolvedTasks: preserved, replayAuthorized: false, installationAuthority: false, ...extra });
  const ownership = ownershipBlockers();
  if (ownership.length) return outcome('REFUSED', { reason: ownership[0] });
  // Two holders contending for the same writer set: the second cannot obtain the holder lock.
  try {
    return await withFileLock(path.join(config.controlDirectory, 'holder.lock'), () => holdCheckpoint(), { timeoutMs: config.lockTimeoutMs });
  } catch (error) {
    if (error instanceof Error && /timed out waiting for DEX state lock/.test(error.message)) return outcome('REFUSED', { reason: 'CHECKPOINT_CONTENDED' });
    throw error;
  }

  async function holdCheckpoint(): Promise<CheckpointOutcome> {
    const channels: ParticipantChannel[] = [];
    let stage: 'before-capture' | 'capturing' = 'before-capture';
    await config.log.append(transactionId, 'PREPARED', { roster: WRITER_OWNERSHIP.map(m => ({ group: m.group, participants: m.participants })), nonceDigest: hashValue(nonce) });
    const refuse = async (reason: string) => {
      if (stage === 'capturing') { await config.log.append(transactionId, 'FAILED', { reason, artifact: 'UNCERTAIN' }).catch(() => undefined); return outcome('FAILED_UNCERTAIN', { reason }); }
      await config.log.append(transactionId, 'REFUSED', { reason }).catch(() => undefined); return outcome('REFUSED', { reason });
    };
    try {
      // Activity that makes consistency unprovable: live claims, running installers, executing tasks.
      for (const name of ['leases', 'queue']) {
        const entries = await fs.readdir(path.join(state, 'coordinator', name)).catch((e: NodeJS.ErrnoException) => e.code === 'ENOENT' ? [] : Promise.reject(e));
        if (entries.length) return await refuse('COORDINATOR_ACTIVITY_PRESENT');
      }
      const table = await config.processTable();
      for (const m of WRITER_OWNERSHIP) if (m.processAbsence?.test(table)) return await refuse(`WRITER_PROCESS_ACTIVE:${m.group}`);
      const tasks = await inspectTasks({ root: state, expectedRoot: state, nodeId: config.nodeId, processMatches: async () => 'unknown' });
      if (tasks.some(t => t.evidence.activity || t.evidence.lease || t.evidence.ticket || t.evidence.process === 'matching')) return await refuse('TASK_ACTIVITY_PRESENT');
      // Stale nonterminal records are captured exactly as they are; nothing resolves, cancels or replays them.
      preserved = tasks.length;

      const realState = await fs.realpath(state), stateStat = await fs.stat(realState);
      const sameState = (r: unknown) => { const x = r as Hello['stateRoot']; return !!x && x.path === realState && x.dev === stateStat.dev && x.ino === stateStat.ino; };
      for (const role of [...new Set(WRITER_OWNERSHIP.flatMap(m => m.participants))].sort()) {
        const channel = await ParticipantChannel.open(controlSocket(config.controlDirectory, role), role, config.responseMs); channels.push(channel);
        const raw = await channel.request({ op: 'hello' }) as { payload?: { publicKey?: unknown } };
        const key = raw?.payload?.publicKey;
        if (typeof key !== 'string') return await refuse(`WRITER_HELLO_INVALID:${role}`);
        const hello = verifySigned(raw, key) as unknown as Hello & { type: string; protocol: string };
        const expectedGroups = role === 'node' ? NODE_PARTICIPANT_GROUPS : GATEWAY_PARTICIPANT_GROUPS;
        if (hello.type !== 'hello' || hello.protocol !== CHECKPOINT_PROTOCOL || hello.role !== role || hello.nodeId !== config.nodeId || !Number.isSafeInteger(hello.pid) || hello.pid < 1 || JSON.stringify([...hello.groups].sort()) !== JSON.stringify([...expectedGroups].sort())) return await refuse(`WRITER_IDENTITY_MISMATCH:${role}`);
        // The claimed pid must be a live process; a dead or fabricated pid cannot be the owning writer.
        try { process.kill(hello.pid, 0); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EPERM') return await refuse(`WRITER_PROCESS_ABSENT:${role}`); }
        // A participant writing a different state directory cannot vouch for this one.
        if (!sameState(hello.stateRoot)) return await refuse(`WRITER_STATE_MISMATCH:${role}`);
        channel.hello = hello;
      }
      const acks: Array<{ role: ParticipantRole; pid: number; bootId: string; generation: number; publicKey: string; signature: string }> = [];
      for (const channel of channels) {
        const raw = await channel.request({ op: 'prepare', txn: transactionId, nonce, holdMs: config.holdMs, drainMs: config.drainMs }, config.drainMs + config.responseMs) as { signature?: string };
        const ack = verifySigned(raw, channel.hello.publicKey);
        if (ack.type === 'refused') return await refuse(`WRITER_REFUSED:${channel.role}:${String(ack.reason)}`);
        if (ack.type !== 'ack' || ack.txn !== transactionId || ack.nonce !== nonce || ack.bootId !== channel.hello.bootId || ack.pid !== channel.hello.pid || ack.role !== channel.role || ack.nodeId !== config.nodeId || !sameState(ack.stateRoot) || ack.inFlight !== 0 || !Number.isSafeInteger(ack.generation)) return await refuse(`WRITER_ACK_INVALID:${channel.role}`);
        if (ack.faultsDuringDrain !== 0) return await refuse(`WRITER_FAULT_DURING_DRAIN:${channel.role}`);
        acks.push({ role: channel.role, pid: channel.hello.pid, bootId: channel.hello.bootId, generation: ack.generation as number, publicKey: channel.hello.publicKey, signature: raw.signature! });
      }
      if (channels.some(c => c.unsolicited())) return await refuse('WRITER_PROTOCOL_UNSOLICITED');
      await config.log.append(transactionId, 'ACKNOWLEDGED', { acks });
      await config.hooks?.afterAcks?.();

      // Fence lock-serialized writers in other processes (CLIs, coordinator daemon), in canonical order.
      const locks: string[] = [];
      for (const m of WRITER_OWNERSHIP) for (const file of m.locks(state, config.nodeId)) if (await fs.lstat(path.dirname(file)).then(s => s.isDirectory(), () => false)) locks.push(file);
      return await nestedLocks(locks, config.lockTimeoutMs, async () => {
        await config.log.append(transactionId, 'FENCED', { lockCount: locks.length });
        await config.hooks?.afterFence?.();
        // The holder's own lock is fenced too: with the default layout it lives under the state root.
        const heldLocks = new Set([...locks, path.join(config.controlDirectory, 'holder.lock')].map(f => path.resolve(f)));
        return await withFencedLocks(heldLocks, async () => {
        const observe = () => inspectCoverage(config.workspace.source, 'synthetic', config.linkPolicy, { heldLocks });
        const manifest = await observe();
        if (!manifest.consistent || manifest.problems.length) return await refuse('SNAPSHOT_UNPROVEN');
        const generation = hashValue(acks.map(a => ({ role: a.role, bootId: a.bootId, generation: a.generation })));
        // Independent expectation first: the backup can never supply the digest it is checked against.
        await config.expectations.record(transactionId, manifest.digest, generation);
        const reattest = async () => {
          for (const channel of channels) {
            const v = verifySigned(await channel.request({ op: 'verify', txn: transactionId, nonce }), channel.hello.publicKey);
            const ack = acks.find(a => a.role === channel.role)!;
            if (v.type !== 'verify' || !sameState(v.stateRoot) || v.held !== true || v.txn !== transactionId || v.bootId !== ack.bootId || v.pid !== ack.pid || v.generation !== ack.generation || v.inFlight !== 0) throw new Error(`WRITER_BOUNDARY_LOST:${channel.role}`);
          }
        };
        const owner: BoundaryOwner = {
          workspace: config.workspace,
          async validate(b: SnapshotBoundary) {
            await reattest();
            const now = await observe();
            if (!now.consistent || now.problems.length || !boundaryFingerprintMatches(b, now)) throw new Error('SNAPSHOT_GENERATION_CHANGED');
          }
        };
        const boundary = registerBoundary(owner, transactionId, acks.reduce((n, a) => n + a.generation, 0), manifest);
        await config.hooks?.beforeCapture?.();
        await config.log.append(transactionId, 'CAPTURING', { manifestDigest: manifest.digest, generation });
        stage = 'capturing';
        const receipt = await captureSynthetic(config.workspace, boundary, config.destination);
        await config.hooks?.afterCapture?.();
        const artifact = await artifactDigest(path.join(config.destination.root, transactionId));
        await reattest();
        await config.log.append(transactionId, 'CAPTURED', { manifestDigest: receipt.manifestDigest, artifactDigest: artifact });
        const expected = await config.expectations.expected(transactionId);
        if (!expected || expected.manifestDigest !== receipt.manifestDigest || expected.manifestDigest !== manifest.digest || expected.generation !== generation) return await refuse('INDEPENDENT_EXPECTATION_MISMATCH');
        await config.log.append(transactionId, 'RESTORE_VERIFIED', { applicationRestore: receipt.applicationRestore });
        await config.log.append(transactionId, 'CERTIFIED', { scope: 'synthetic', installationAuthority: false });
        return outcome('CERTIFIED_SYNTHETIC', { manifestDigest: receipt.manifestDigest, artifactDigest: artifact });
        });
      });
    } catch (error) {
      return await refuse(refusalCode(error));
    } finally {
      // RELEASE: explicit, then by connection close. A participant whose release is lost reopens on expiry.
      for (const channel of channels) { await channel.request({ op: 'release', txn: transactionId }).catch(() => undefined); channel.close(); }
    }
  }
}
