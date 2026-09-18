import crypto from 'node:crypto';
import type { Server } from 'node:http';
import WebSocket, { WebSocketServer } from 'ws';
import type { NodeAuthStore } from './node-auth.js';
import { REACH_PROTOCOL_VERSION, type AccessSnapshot, type GatewayRequest, type GatewayResponse, type NodeHello, type NodeStatus, type RequestActor } from '../shared/protocol.js';
import { addRevokedNode, loadRevokedNodes } from '../shared/revoked-nodes.js';
import { familiarForNode } from '../shared/familiar.js';

export type NodeRecord = {
  hello: NodeHello;
  socket: WebSocket;
  connectedAt: number;
  lastSeenAt: number;
  /** Latest node-reported local access policy (display only; the node enforces it). */
  access: AccessSnapshot | null;
};

type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

export class NodeRegistry {
  private readonly wss = new WebSocketServer({ noServer: true });
  private readonly nodes = new Map<string, NodeRecord>();
  private readonly pending = new Map<string, Pending>();
  private readonly revoked = new Set<string>();
  private sweepTimer: NodeJS.Timeout | null = null;

  constructor(private readonly nodeAuth: NodeAuthStore, private readonly stateDir: string) {}

  async initialize(): Promise<void> {
    for (const nodeId of await loadRevokedNodes(this.stateDir)) this.revoked.add(nodeId);
  }

  /**
   * Enforces CLI-side revocation on already-connected nodes: `npm run nodes -- revoke <id>` only edits the
   * credential store, so the gateway re-checks connected nodes against it and drops any that were revoked.
   */
  startRevocationSweep(intervalMs = 5000): void {
    if (this.sweepTimer) return;
    this.sweepTimer = setInterval(() => void this.sweepRevoked().catch(() => undefined), intervalMs);
    this.sweepTimer.unref();
  }

  async sweepRevoked(): Promise<number> {
    let dropped = 0;
    for (const [nodeId, record] of this.nodes) {
      if (!(await this.nodeAuth.isRevoked(nodeId))) continue;
      this.revoked.add(nodeId);
      record.socket.close(4001, 'node revoked');
      this.nodes.delete(nodeId);
      dropped += 1;
    }
    return dropped;
  }

  attach(server: Server): void {
    server.on('upgrade', async (req, socket, head) => {
      const url = new URL(req.url || '/', 'http://localhost');
      if (url.pathname !== '/node') return socket.destroy();
      const auth = req.headers.authorization || '';
      const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
      const nodeId = url.searchParams.get('nodeId') || '';
      if (!nodeId) return socket.destroy();
      try {
        // A revoked node can be explicitly forgotten and re-enrolled. Reconcile the in-memory tombstone
        // with the authoritative credential store so a gateway restart is not required for that recovery.
        if (this.revoked.has(nodeId)) {
          if (await this.nodeAuth.isRevoked(nodeId)) return socket.destroy();
          this.revoked.delete(nodeId);
        }
        if (!(await this.nodeAuth.authenticate(nodeId, token))) return socket.destroy();
      } catch {
        return socket.destroy();
      }
      this.wss.handleUpgrade(req, socket, head, ws => this.accept(ws, nodeId));
    });
  }
  listNodes(): Record<string, unknown>[] {
    return [...this.nodes.values()].map(record => ({
      nodeId: record.hello.nodeId,
      online: record.socket.readyState === WebSocket.OPEN,
      profile: record.hello.profile,
      fingerprint: record.hello.fingerprint,
      allowedRoots: record.hello.allowedRoots,
      aiAccess: record.access ? { mode: record.access.effectiveMode, until: record.access.until, clients: record.access.clients } : 'unknown',
      toolCount: record.hello.tools.length,
      agentVersion: record.hello.agentVersion,
      connectedAt: new Date(record.connectedAt).toISOString(),
      lastSeenAt: new Date(record.lastSeenAt).toISOString(),
      familiar: familiarForNode({
        nodeId: record.hello.nodeId,
        online: record.socket.readyState === WebSocket.OPEN,
        access: record.access,
        sequence: record.lastSeenAt,
        now: record.lastSeenAt
      })
    }));
  }

  listTools(nodeId: string): unknown[] {
    const record = this.requireNode(nodeId);
    return record.hello.tools;
  }

  /**
   * Routes one operation to exactly the named node. There is deliberately no default node, no
   * "first online" choice, and no fallback: an unknown, offline, or revoked node ID always throws.
   */
  async request(nodeId: string, operation: string, args: Record<string, unknown>, actor?: RequestActor, timeoutMs = 60000): Promise<unknown> {
    const record = this.requireNode(nodeId);
    const id = crypto.randomUUID();
    const request: GatewayRequest = { type: 'request', id, operation, args, ...(actor ? { actor } : {}) };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`node request timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      timer.unref();
      this.pending.set(id, { resolve, reject, timer });
      record.socket.send(JSON.stringify(request), error => {
        if (!error) return;
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      });
    });
  }

  async revoke(nodeId: string): Promise<boolean> {
    this.revoked.add(nodeId);
    await this.nodeAuth.revoke(nodeId);
    const record = this.nodes.get(nodeId);
    if (record) {
      record.socket.close(4001, 'node revoked');
      this.nodes.delete(nodeId);
    }
    this.revoked.clear();
    for (const revokedId of await addRevokedNode(this.stateDir, nodeId)) this.revoked.add(revokedId);
    return Boolean(record);
  }

  shutdown(): void {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    for (const record of this.nodes.values()) record.socket.terminate();
    this.nodes.clear();
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error('gateway shutting down'));
      this.pending.delete(id);
    }
  }

  private requireNode(nodeId: string): NodeRecord {
    if (typeof nodeId !== 'string' || !nodeId.trim()) throw new Error('node_id is required; call reach_list_nodes and choose a node explicitly');
    if (this.revoked.has(nodeId)) throw new Error(`node is revoked: ${nodeId}`);
    const record = this.nodes.get(nodeId);
    if (!record) throw new Error(`node is not enrolled or not online: ${nodeId} (no fallback to another node is ever attempted)`);
    if (record.socket.readyState !== WebSocket.OPEN) throw new Error(`node is not online: ${nodeId}`);
    return record;
  }

  /** Test seam: register an already-authenticated socket-like object as a node. */
  registerForTest(hello: NodeHello, socket: WebSocket): void {
    this.nodes.set(hello.nodeId, { hello, socket, connectedAt: Date.now(), lastSeenAt: Date.now(), access: hello.access ?? null });
  }

  /** Test seam: deliver a node response as if it arrived on the socket. */
  deliverForTest(response: GatewayResponse): void {
    this.finishResponse(response);
  }
  private accept(ws: WebSocket, expectedNodeId: string): void {
    let registered = false;
    ws.on('message', data => {
      let message: unknown;
      try {
        message = JSON.parse(data.toString());
      } catch {
        return ws.close(1003, 'invalid json');
      }
      if (!message || typeof message !== 'object') return;
      const typed = message as { type?: string };
      if (!registered) {
        if (typed.type !== 'hello') return ws.close(1008, 'hello required');
        const hello = message as NodeHello;
        if (hello.nodeId !== expectedNodeId || hello.protocolVersion !== REACH_PROTOCOL_VERSION || this.revoked.has(hello.nodeId)) {
          return ws.close(1008, 'invalid node identity or protocol');
        }
        const existing = this.nodes.get(hello.nodeId);
        if (existing && existing.socket !== ws) existing.socket.close(4000, 'replaced by newer connection');
        this.nodes.set(hello.nodeId, { hello, socket: ws, connectedAt: Date.now(), lastSeenAt: Date.now(), access: hello.access ?? null });
        registered = true;
        return;
      }
      const record = this.nodes.get(expectedNodeId);
      if (record) record.lastSeenAt = Date.now();
      if (typed.type === 'response') this.finishResponse(message as GatewayResponse);
      if (typed.type === 'status' && record) record.access = (message as NodeStatus).access ?? null;
    });

    ws.on('close', () => {
      const record = this.nodes.get(expectedNodeId);
      if (record?.socket === ws) this.nodes.delete(expectedNodeId);
    });
  }

  private finishResponse(response: GatewayResponse): void {
    const pending = this.pending.get(response.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(response.id);
    if (response.ok) pending.resolve(response.result);
    else pending.reject(new Error(response.error || 'node request failed'));
  }
}
