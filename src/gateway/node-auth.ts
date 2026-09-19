import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { timingSafeEqualText } from '../shared/security.js';
import { atomicWriteFile, withFileLock } from '../shared/state-io.js';
import {
  NODE_PROOF_PATH,
  checkProofTiming,
  decodeNodeProof,
  type ProofFailure,
  verifyNodeProofSignature
} from '../shared/node-transport-auth.js';
import { REACH_PROTOCOL_VERSION } from '../shared/protocol.js';

type CredentialSlot = { hash: string; createdAt: number; validUntil?: number };
type TransportKeySlot = { publicKey: string; createdAt: number; validUntil?: number };
export type NodeAuthMode = 'bearer' | 'migrating' | 'asymmetric';

type NodeCredentialRecord = {
  authMode: NodeAuthMode;
  active: CredentialSlot | null;
  previous: CredentialSlot[];
  transport: TransportKeySlot | null;
  previousTransport: TransportKeySlot[];
  revoked: boolean;
  updatedAt: number;
};

type EnrollmentRecord = { nodeId: string; expiresAt: number; consumed: boolean };
type NonceRecord = { nodeId: string; expiresAt: number };

type PersistedNodeAuth = {
  version: 2;
  nodes: Record<string, NodeCredentialRecord>;
  enrollment: Record<string, EnrollmentRecord>;
  nonces: Record<string, NonceRecord>;
};

type LegacyPersisted = { version: 1; nodes: Record<string, { active: CredentialSlot; previous: CredentialSlot[]; revoked: boolean; updatedAt: number }> };

const EMPTY_STATE: PersistedNodeAuth = { version: 2, nodes: {}, enrollment: {}, nonces: {} };
const MAX_NONCES = 4096;
const DEFAULT_ENROLL_TTL_MS = 15 * 60_000;
const MAX_ENROLL_TTL_MS = 60 * 60_000;

function tokenHash(token: string): string { return crypto.createHash('sha256').update(token).digest('hex'); }
function issueToken(): string { return crypto.randomBytes(32).toString('base64url'); }

function defaultRecord(now: number): NodeCredentialRecord {
  return { authMode: 'bearer', active: null, previous: [], transport: null, previousTransport: [], revoked: false, updatedAt: now };
}

export class NodeAuthStore {
  private state: PersistedNodeAuth = structuredClone(EMPTY_STATE);
  private readonly stateFile: string;
  private readonly lockFile: string;

  constructor(stateDir: string) {
    this.stateFile = path.join(stateDir, 'node-auth.json');
    this.lockFile = `${this.stateFile}.lock`;
  }

  async initialize(): Promise<void> {
    await this.reload();
    this.prune();
  }

  /** Legacy bearer-token authentication. Asymmetric-only nodes never succeed here. */
  async authenticate(nodeId: string, token: string): Promise<boolean> {
    await this.reload();
    this.prune();
    const record = this.state.nodes[nodeId];
    if (!record || record.revoked || !token) return false;
    if (record.authMode === 'asymmetric') return false;
    if (!record.active) return false;
    const candidate = tokenHash(token);
    if (timingSafeEqualText(candidate, record.active.hash)) return true;
    const now = Date.now();
    return record.previous.some(slot => Boolean(slot.validUntil && slot.validUntil > now) && timingSafeEqualText(candidate, slot.hash));
  }

  async authenticateProof(nodeId: string, encodedProof: string, requestPath = NODE_PROOF_PATH): Promise<{ ok: true } | { ok: false; reason: ProofFailure }> {
    return this.mutate(async () => {
      const proof = decodeNodeProof(encodedProof);
      if (!proof) return { ok: false as const, reason: 'malformed' as const };
      if (proof.nodeId !== nodeId) return { ok: false as const, reason: 'wrong-node-id' as const };
      if (proof.path !== requestPath) return { ok: false as const, reason: 'wrong-path' as const };
      if (proof.protocolVersion !== REACH_PROTOCOL_VERSION) return { ok: false as const, reason: 'incompatible-protocol' as const };
      const timing = checkProofTiming(proof.timestamp);
      if (timing) return { ok: false as const, reason: timing };
      const record = this.state.nodes[nodeId];
      if (!record) return { ok: false as const, reason: 'unknown-node' as const };
      if (record.revoked) return { ok: false as const, reason: 'revoked' as const };
      if (record.authMode === 'bearer' || !record.transport) return { ok: false as const, reason: 'unknown-node' as const };
      if (this.state.nonces[proof.nonce]) return { ok: false as const, reason: 'replay' as const };
      // Expired entries are already gone; if the cache is still full every slot is a live nonce, and
      // admitting this proof would mean forgetting one that can still be replayed. Refuse instead.
      this.pruneNonces();
      if (this.nonceCacheFull()) return { ok: false as const, reason: 'nonce-capacity' as const };
      const keys = [record.transport, ...record.previousTransport.filter(slot => slot.validUntil && slot.validUntil > Date.now())];
      const matched = keys.some(slot => slot && verifyNodeProofSignature(slot.publicKey, proof));
      if (!matched) return { ok: false as const, reason: 'wrong-key' as const };
      this.state.nonces[proof.nonce] = { nodeId, expiresAt: proof.timestamp + 5 * 60_000 };
      this.pruneNonces();
      return { ok: true as const };
    });
  }

  async importLegacy(nodeId: string, token: string): Promise<boolean> {
    if (!nodeId || token.length < 24) throw new Error('legacy node credential is invalid');
    return this.mutate(async () => {
      if (this.state.nodes[nodeId]) return false;
      const now = Date.now();
      this.state.nodes[nodeId] = { ...defaultRecord(now), active: { hash: tokenHash(token), createdAt: now } };
      return true;
    });
  }

  async enroll(nodeId: string): Promise<string> {
    if (!nodeId) throw new Error('node id is required');
    return this.mutate(async () => {
      const existing = this.state.nodes[nodeId];
      if (existing && !existing.revoked) throw new Error(`node already enrolled: ${nodeId}`);
      const token = issueToken();
      const now = Date.now();
      this.state.nodes[nodeId] = { ...defaultRecord(now), active: { hash: tokenHash(token), createdAt: now } };
      return token;
    });
  }

  async rotate(nodeId: string, graceMs = 10 * 60 * 1000): Promise<string> {
    if (!Number.isFinite(graceMs) || graceMs < 0) throw new Error('grace period must be non-negative');
    return this.mutate(async () => {
      const record = this.state.nodes[nodeId];
      if (!record || record.revoked) throw new Error(`node is not actively enrolled: ${nodeId}`);
      if (record.authMode === 'asymmetric') throw new Error('asymmetric node cannot rotate a bearer token; rotate the transport key');
      if (!record.active) throw new Error(`node is not actively enrolled: ${nodeId}`);
      const now = Date.now();
      const token = issueToken();
      record.previous.push({ ...record.active, validUntil: now + graceMs });
      record.active = { hash: tokenHash(token), createdAt: now };
      record.updatedAt = now;
      this.prune();
      return token;
    });
  }

  async createEnrollmentToken(nodeId: string, ttlMs = DEFAULT_ENROLL_TTL_MS): Promise<string> {
    if (!nodeId) throw new Error('node id is required');
    if (!Number.isFinite(ttlMs) || ttlMs <= 0 || ttlMs > MAX_ENROLL_TTL_MS) throw new Error('enrollment ttl must be between 1ms and 1h');
    return this.mutate(async () => {
      const record = this.state.nodes[nodeId];
      if (record?.revoked) throw new Error(`node is revoked: ${nodeId}`);
      const token = issueToken();
      this.state.enrollment[tokenHash(token)] = { nodeId, expiresAt: Date.now() + ttlMs, consumed: false };
      return token;
    });
  }

  async consumeEnrollment(nodeId: string, token: string, publicKeyPem: string, graceMs = 10 * 60 * 1000): Promise<void> {
    if (!publicKeyPem.includes('PUBLIC KEY') || publicKeyPem.includes('PRIVATE KEY')) {
      throw new Error('enrollment requires an SPKI public key PEM and must not include private key material');
    }
    await this.mutate(async () => {
      const hashed = tokenHash(token);
      const enrollment = this.state.enrollment[hashed];
      if (!enrollment || enrollment.consumed || enrollment.expiresAt <= Date.now()) throw new Error('enrollment token is invalid or expired');
      if (enrollment.nodeId !== nodeId) throw new Error('enrollment token is for a different node');
      enrollment.consumed = true;
      const now = Date.now();
      const existing = this.state.nodes[nodeId] ?? defaultRecord(now);
      if (existing.revoked) throw new Error(`node is revoked: ${nodeId}`);
      if (existing.authMode === 'asymmetric' && existing.transport) {
        existing.previousTransport.push({ ...existing.transport, validUntil: now + graceMs });
        existing.transport = { publicKey: publicKeyPem, createdAt: now };
        existing.updatedAt = now;
        this.state.nodes[nodeId] = existing;
        return;
      }
      existing.transport = { publicKey: publicKeyPem, createdAt: now };
      existing.authMode = existing.active ? 'migrating' : 'asymmetric';
      existing.updatedAt = now;
      this.state.nodes[nodeId] = existing;
    });
  }

  async completeMigration(nodeId: string): Promise<void> {
    await this.mutate(async () => {
      const record = this.state.nodes[nodeId];
      if (!record || record.revoked) throw new Error(`node is not actively enrolled: ${nodeId}`);
      if (!record.transport) throw new Error('node has no transport public key');
      if (record.authMode === 'bearer') throw new Error('bearer node has not enrolled a transport key');
      record.authMode = 'asymmetric';
      record.active = null;
      record.previous = [];
      record.updatedAt = Date.now();
    });
  }

  async rotateTransportKey(nodeId: string, publicKeyPem: string, graceMs = 10 * 60 * 1000): Promise<void> {
    if (!publicKeyPem.includes('PUBLIC KEY') || publicKeyPem.includes('PRIVATE KEY')) {
      throw new Error('rotation requires an SPKI public key PEM');
    }
    await this.mutate(async () => {
      const record = this.state.nodes[nodeId];
      if (!record || record.revoked || !record.transport) throw new Error(`node is not asymmetrically enrolled: ${nodeId}`);
      if (record.authMode === 'bearer') throw new Error(`node is not asymmetrically enrolled: ${nodeId}`);
      const now = Date.now();
      record.previousTransport.push({ ...record.transport, validUntil: now + graceMs });
      record.transport = { publicKey: publicKeyPem, createdAt: now };
      record.updatedAt = now;
    });
  }

  async revoke(nodeId: string): Promise<boolean> {
    return this.mutate(async () => {
      const record = this.state.nodes[nodeId];
      if (!record) return false;
      record.revoked = true;
      record.previous = [];
      record.previousTransport = [];
      record.updatedAt = Date.now();
      return true;
    });
  }

  async forget(nodeId: string): Promise<boolean> {
    return this.mutate(async () => {
      const record = this.state.nodes[nodeId];
      if (!record) return false;
      if (!record.revoked) throw new Error(`node is still active; revoke it first: ${nodeId}`);
      delete this.state.nodes[nodeId];
      return true;
    });
  }

  async isRevoked(nodeId: string): Promise<boolean> {
    await this.reload();
    const record = this.state.nodes[nodeId];
    return !record || record.revoked;
  }

  authMode(nodeId: string): NodeAuthMode | null {
    const record = this.state.nodes[nodeId];
    return record && !record.revoked ? record.authMode : null;
  }

  persistedSnapshot(): PersistedNodeAuth {
    return structuredClone(this.state);
  }

  list(): Record<string, unknown>[] {
    this.prune();
    return Object.entries(this.state.nodes).sort(([a], [b]) => a.localeCompare(b)).map(([nodeId, record]) => ({
      nodeId,
      revoked: record.revoked,
      authMode: record.authMode,
      activeSince: record.active ? new Date(record.active.createdAt).toISOString() : null,
      transportKey: Boolean(record.transport),
      graceCredentials: record.previous.filter(slot => slot.validUntil && slot.validUntil > Date.now()).length,
      updatedAt: new Date(record.updatedAt).toISOString()
    }));
  }

  private async mutate<T>(fn: () => Promise<T>): Promise<T> {
    return withFileLock(this.lockFile, async () => {
      await this.reload();
      const result = await fn();
      await this.persistUnlocked();
      return result;
    });
  }

  private async reload(): Promise<void> {
    try {
      const parsed = JSON.parse(await fs.readFile(this.stateFile, 'utf8')) as PersistedNodeAuth | LegacyPersisted;
      this.state = upgradeState(parsed);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      this.state = structuredClone(EMPTY_STATE);
    }
  }

  private prune(): void {
    const now = Date.now();
    for (const record of Object.values(this.state.nodes)) {
      record.previous = record.previous.filter(slot => Boolean(slot.validUntil && slot.validUntil > now));
      record.previousTransport = record.previousTransport.filter(slot => Boolean(slot.validUntil && slot.validUntil > now));
    }
    for (const [hash, enrollment] of Object.entries(this.state.enrollment)) {
      if (enrollment.consumed || enrollment.expiresAt <= now) delete this.state.enrollment[hash];
    }
    this.pruneNonces();
  }

  /**
   * Drop only nonces whose replay window has closed.
   *
   * This used to evict the oldest entries by expiry once the map exceeded MAX_NONCES, which could
   * delete a nonce that was still inside its five-minute validity window. The replay check is purely
   * presence in this map, so an evicted-but-still-valid nonce became replayable — the eviction policy
   * silently converted a full cache into a replay window. Capacity is now enforced by refusing new
   * proofs (see authenticateProof), which fails closed instead.
   */
  private pruneNonces(): void {
    const now = Date.now();
    for (const [nonce, record] of Object.entries(this.state.nonces)) {
      if (record.expiresAt <= now) delete this.state.nonces[nonce];
    }
  }

  /** True when every slot is held by a nonce that is still replayable. */
  private nonceCacheFull(): boolean {
    return Object.keys(this.state.nonces).length >= MAX_NONCES;
  }

  private async persistUnlocked(): Promise<void> {
    this.prune();
    const serialized = JSON.stringify(this.state, null, 2) + '\n';
    if (/BEGIN (?:.*)?PRIVATE KEY/.test(serialized)) throw new Error('refusing to persist private key material in gateway node-auth state');
    await atomicWriteFile(this.stateFile, serialized, 0o600);
  }
}

function upgradeState(parsed: PersistedNodeAuth | LegacyPersisted): PersistedNodeAuth {
  if (parsed && parsed.version === 2 && 'nodes' in parsed) {
    const current = parsed as PersistedNodeAuth;
    return {
      version: 2,
      nodes: current.nodes || {},
      enrollment: current.enrollment || {},
      nonces: current.nonces || {}
    };
  }
  if (parsed && parsed.version === 1 && 'nodes' in parsed) {
    const legacy = parsed as LegacyPersisted;
    const nodes: Record<string, NodeCredentialRecord> = {};
    for (const [nodeId, record] of Object.entries(legacy.nodes || {})) {
      nodes[nodeId] = {
        authMode: 'bearer',
        active: record.active,
        previous: record.previous || [],
        transport: null,
        previousTransport: [],
        revoked: record.revoked,
        updatedAt: record.updatedAt
      };
    }
    return { version: 2, nodes, enrollment: {}, nonces: {} };
  }
  throw new Error('unsupported node auth state');
}

export function parseNodeAuthorization(header: string): { kind: 'bearer'; token: string } | { kind: 'proof'; encoded: string } | { kind: 'none' } {
  if (header.startsWith('DexNodeEd25519 ')) return { kind: 'proof', encoded: header.slice('DexNodeEd25519 '.length) };
  if (header.startsWith('Bearer ')) return { kind: 'bearer', token: header.slice('Bearer '.length) };
  return { kind: 'none' };
}
