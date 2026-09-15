import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import type { Server } from 'node:http';
import WebSocket, { WebSocketServer } from 'ws';
import { timingSafeEqualText } from '../shared/security.js';
import { REACH_PROTOCOL_VERSION, type GatewayRequest, type GatewayResponse, type NodeHello } from '../shared/protocol.js';

export type NodeRecord = {
  hello: NodeHello;
  socket: WebSocket;
  connectedAt: number;
  lastSeenAt: number;
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
  private readonly revokedFile: string;

  constructor(private readonly nodeToken: string, stateDir: string) {
    this.revokedFile = path.join(stateDir, 'revoked-nodes.json');
  }

  async initialize(): Promise<void> {
    try {
      const raw = JSON.parse(await fs.readFile(this.revokedFile, 'utf8')) as string[];
      for (const nodeId of raw) this.revoked.add(nodeId);
    } catch {
      // First launch has no revocation file.
    }
  }

  attach(server: Server): void {
    server.on('upgrade', (req, socket, head) => {
      const url = new URL(req.url || '/', 'http://localhost');
      if (url.pathname !== '/node') return socket.destroy();
      const auth = req.headers.authorization || '';
      const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
      const nodeId = url.searchParams.get('nodeId') || '';
      if (!nodeId || this.revoked.has(nodeId) || !timingSafeEqualText(token, this.nodeToken)) return socket.destroy();
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
      toolCount: record.hello.tools.length,
      agentVersion: record.hello.agentVersion,
      connectedAt: new Date(record.connectedAt).toISOString(),
      lastSeenAt: new Date(record.lastSeenAt).toISOString()
    }));
  }

  listTools(nodeId: string): unknown[] {
    const record = this.requireNode(nodeId);
    return record.hello.tools;
  }

  async request(nodeId: string, operation: string, args: Record<string, unknown>, timeoutMs = 60000): Promise<unknown> {
    const record = this.requireNode(nodeId);
    const id = crypto.randomUUID();
    const request: GatewayRequest = { type: 'request', id, operation, args };
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
    const record = this.nodes.get(nodeId);
    if (record) record.socket.close(4001, 'node revoked');
    await fs.mkdir(path.dirname(this.revokedFile), { recursive: true, mode: 0o700 });
    await fs.writeFile(this.revokedFile, JSON.stringify([...this.revoked].sort(), null, 2), { mode: 0o600 });
    return Boolean(record);
  }

  shutdown(): void {
    for (const record of this.nodes.values()) record.socket.terminate();
    this.nodes.clear();
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error('gateway shutting down'));
      this.pending.delete(id);
    }
  }

  private requireNode(nodeId: string): NodeRecord {
    const record = this.nodes.get(nodeId);
    if (!record || record.socket.readyState !== WebSocket.OPEN) throw new Error(`node is not online: ${nodeId}`);
    return record;
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
        this.nodes.set(hello.nodeId, { hello, socket: ws, connectedAt: Date.now(), lastSeenAt: Date.now() });
        registered = true;
        return;
      }
      const record = this.nodes.get(expectedNodeId);
      if (record) record.lastSeenAt = Date.now();
      if (typed.type === 'response') this.finishResponse(message as GatewayResponse);
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
