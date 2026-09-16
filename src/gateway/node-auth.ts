import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { timingSafeEqualText } from '../shared/security.js';

type CredentialSlot = {
  hash: string;
  createdAt: number;
  validUntil?: number;
};

type NodeCredentialRecord = {
  active: CredentialSlot;
  previous: CredentialSlot[];
  revoked: boolean;
  updatedAt: number;
};

type PersistedNodeAuth = {
  version: 1;
  nodes: Record<string, NodeCredentialRecord>;
};

const EMPTY_STATE: PersistedNodeAuth = { version: 1, nodes: {} };

function tokenHash(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function issueToken(): string {
  return crypto.randomBytes(32).toString('base64url');
}
export class NodeAuthStore {
  private state: PersistedNodeAuth = structuredClone(EMPTY_STATE);
  private readonly stateFile: string;

  constructor(stateDir: string) {
    this.stateFile = path.join(stateDir, 'node-auth.json');
  }

  async initialize(): Promise<void> {
    try {
      const parsed = JSON.parse(await fs.readFile(this.stateFile, 'utf8')) as PersistedNodeAuth;
      if (parsed.version !== 1 || !parsed.nodes) throw new Error('unsupported node auth state');
      this.state = parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      this.state = structuredClone(EMPTY_STATE);
    }
    this.prune();
  }

  async authenticate(nodeId: string, token: string): Promise<boolean> {
    await this.reload();
    this.prune();
    const record = this.state.nodes[nodeId];
    if (!record || record.revoked || !token) return false;
    const candidate = tokenHash(token);
    if (timingSafeEqualText(candidate, record.active.hash)) return true;
    const now = Date.now();
    return record.previous.some(slot => Boolean(slot.validUntil && slot.validUntil > now) && timingSafeEqualText(candidate, slot.hash));
  }

  async importLegacy(nodeId: string, token: string): Promise<boolean> {
    if (!nodeId || token.length < 24) throw new Error('legacy node credential is invalid');
    if (this.state.nodes[nodeId]) return false;
    const now = Date.now();
    this.state.nodes[nodeId] = {
      active: { hash: tokenHash(token), createdAt: now }, previous: [], revoked: false, updatedAt: now
    };
    await this.persist();
    return true;
  }
  async enroll(nodeId: string): Promise<string> {
    if (!nodeId) throw new Error('node id is required');
    const existing = this.state.nodes[nodeId];
    if (existing && !existing.revoked) throw new Error(`node already enrolled: ${nodeId}`);
    const token = issueToken();
    const now = Date.now();
    this.state.nodes[nodeId] = {
      active: { hash: tokenHash(token), createdAt: now }, previous: [], revoked: false, updatedAt: now
    };
    await this.persist();
    return token;
  }

  async rotate(nodeId: string, graceMs = 10 * 60 * 1000): Promise<string> {
    const record = this.state.nodes[nodeId];
    if (!record || record.revoked) throw new Error(`node is not actively enrolled: ${nodeId}`);
    if (!Number.isFinite(graceMs) || graceMs < 0) throw new Error('grace period must be non-negative');
    const now = Date.now();
    const token = issueToken();
    record.previous.push({ ...record.active, validUntil: now + graceMs });
    record.active = { hash: tokenHash(token), createdAt: now };
    record.updatedAt = now;
    this.prune();
    await this.persist();
    return token;
  }

  async revoke(nodeId: string): Promise<boolean> {
    const record = this.state.nodes[nodeId];
    if (!record) return false;
    record.revoked = true;
    record.previous = [];
    record.updatedAt = Date.now();
    await this.persist();
    return true;
  }

  /** Deletes a revoked node's record entirely (tombstone cleanup). Active nodes must be revoked first. */
  async forget(nodeId: string): Promise<boolean> {
    const record = this.state.nodes[nodeId];
    if (!record) return false;
    if (!record.revoked) throw new Error(`node is still active; revoke it first: ${nodeId}`);
    delete this.state.nodes[nodeId];
    await this.persist();
    return true;
  }

  /** Re-reads persisted state so an out-of-process CLI revoke is honored by the running gateway. */
  async isRevoked(nodeId: string): Promise<boolean> {
    await this.reload();
    const record = this.state.nodes[nodeId];
    return !record || record.revoked;
  }

  list(): Record<string, unknown>[] {
    this.prune();
    return Object.entries(this.state.nodes).sort(([a], [b]) => a.localeCompare(b)).map(([nodeId, record]) => ({
      nodeId,
      revoked: record.revoked,
      activeSince: new Date(record.active.createdAt).toISOString(),
      graceCredentials: record.previous.filter(slot => slot.validUntil && slot.validUntil > Date.now()).length,
      updatedAt: new Date(record.updatedAt).toISOString()
    }));
  }

  private async reload(): Promise<void> {
    try {
      const parsed = JSON.parse(await fs.readFile(this.stateFile, 'utf8')) as PersistedNodeAuth;
      if (parsed.version === 1 && parsed.nodes) this.state = parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  private prune(): void {
    const now = Date.now();
    for (const record of Object.values(this.state.nodes)) {
      record.previous = record.previous.filter(slot => Boolean(slot.validUntil && slot.validUntil > now));
    }
  }

  private async persist(): Promise<void> {
    this.prune();
    await fs.mkdir(path.dirname(this.stateFile), { recursive: true, mode: 0o700 });
    const temp = `${this.stateFile}.${process.pid}.tmp`;
    await fs.writeFile(temp, JSON.stringify(this.state, null, 2) + '\n', { mode: 0o600 });
    await fs.rename(temp, this.stateFile);
  }
}
