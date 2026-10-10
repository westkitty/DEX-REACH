import crypto from 'node:crypto';
import type { Server } from 'node:http';
import WebSocket, { WebSocketServer } from 'ws';
import { parseNodeAuthorization, type NodeAuthStore } from './node-auth.js';
import { REACH_PROTOCOL_VERSION, REACH_DURABLE_TASK_CAPABILITY, type AccessSnapshot, type DurableTaskRequest, type GatewayRequest, type GatewayResponse, type NodeHello, type NodeStatus, type RequestActor, type SchedulerSnapshot, type ProtocolHelloAck, type ReachCapability, type ReachProtocolVersion, type TaskProgressEvent } from '../shared/protocol.js';
import { addRevokedNode, loadRevokedNodes } from '../shared/revoked-nodes.js';
import { durableCapabilityRefusal, negotiateProtocol, supportsNegotiatedCapability, type NegotiatedProtocol } from '../shared/protocol-negotiation.js';

export type NodeRecord = {
  hello: NodeHello;
  socket: WebSocket;
  connectedAt: number;
  lastSeenAt: number;
  /** Latest node-reported local access policy (display only; the node enforces it). */
  access: AccessSnapshot | null;
  scheduler: SchedulerSnapshot | null;
  negotiated: NegotiatedProtocol;
};

export type NodeRegistryOptions = {
  supportedProtocols?: readonly ReachProtocolVersion[];
  capabilities?: readonly ReachCapability[];
};

export type NodeRequestResult = {
  result: unknown;
  traceId?: string;
};

type Pending = {
  nodeId: string;
  socket: WebSocket;
  resolve: (value: NodeRequestResult) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  responding?: boolean;
};

export class NodeRegistry {
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
  private readonly nodes = new Map<string, NodeRecord>();
  private readonly pending = new Map<string, Pending>();
  private readonly revoked = new Set<string>();
  private sweepTimer: NodeJS.Timeout | null = null;

  constructor(private readonly nodeAuth: NodeAuthStore, private readonly stateDir: string, private readonly options: NodeRegistryOptions = {}) {}

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
      if (!(await this.nodeAuth.isRevoked(nodeId)) || this.nodes.get(nodeId) !== record) continue;
      this.revoked.add(nodeId);
      this.rejectConnection(record.socket, 'node revoked; execution outcome may be uncertain');
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
      const parsed = parseNodeAuthorization(auth);
      const nodeId = url.searchParams.get('nodeId') || '';
      if (!nodeId) return socket.destroy();
      try {
        // A revoked node can be explicitly forgotten and re-enrolled. Reconcile the in-memory tombstone
        // with the authoritative credential store so a gateway restart is not required for that recovery.
        if (this.revoked.has(nodeId)) {
          if (await this.nodeAuth.isRevoked(nodeId)) return socket.destroy();
          this.revoked.delete(nodeId);
        }
        if (parsed.kind === 'proof') {
          const result = await this.nodeAuth.authenticateProof(nodeId, parsed.encoded, url.pathname);
          if (!result.ok) return socket.destroy();
        } else if (parsed.kind === 'bearer') {
          if (!(await this.nodeAuth.authenticate(nodeId, parsed.token))) return socket.destroy();
        } else {
          return socket.destroy();
        }
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
      scheduler: record.scheduler,
      capabilities: record.hello.capabilities ?? {},
      negotiatedProtocol: record.negotiated.version,
      admittedCapabilities: record.negotiated.capabilities,
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

  /**
   * Routes one operation to exactly the named node. There is deliberately no default node, no
   * "first online" choice, and no fallback: an unknown, offline, or revoked node ID always throws.
   */
  async request(nodeId: string, operation: string, args: Record<string, unknown>, actor?: RequestActor, timeoutMs = 60000): Promise<unknown> {
    return (await this.requestWithTrace(nodeId, operation, args, actor, undefined, timeoutMs)).result;
  }

  async requestWithTrace(
    nodeId: string,
    operation: string,
    args: Record<string, unknown>,
    actor?: RequestActor,
    trace?: { traceparent?: string; tracestate?: string },
    timeoutMs = 60000,
    task?: DurableTaskRequest
  ): Promise<NodeRequestResult> {
    const record = this.requireNode(nodeId);
    if (await this.nodeAuth.isRevoked(nodeId)) throw new Error(`node is revoked: ${nodeId}`);
    if (this.requireNode(nodeId) !== record) throw new Error('node connection changed before dispatch; request was not sent');
    if (task && !supportsNegotiatedCapability(record.negotiated, REACH_DURABLE_TASK_CAPABILITY)) {
      throw durableCapabilityRefusal(nodeId, record.negotiated);
    }
    if (this.pending.size >= 2048) throw new Error('gateway pending request limit reached');
    const id = crypto.randomUUID();
    const request: GatewayRequest = {
      type: 'request',
      id,
      operation,
      args,
      ...(actor ? { actor } : {}),
      ...(trace?.traceparent ? { traceparent: trace.traceparent } : {}),
      ...(trace?.tracestate ? { tracestate: trace.tracestate } : {}),
      ...(task ? { task } : {})
    };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`node request timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      timer.unref();
      this.pending.set(id, { nodeId, socket: record.socket, resolve, reject, timer });
      record.socket.send(JSON.stringify(request), error => {
        if (!error) return;
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      });
    });
  }

  supportsDurableTasks(nodeId: string): boolean {
    const record = this.requireNode(nodeId);
    return supportsNegotiatedCapability(record.negotiated, REACH_DURABLE_TASK_CAPABILITY);
  }

  async revoke(nodeId: string): Promise<boolean> {
    this.revoked.add(nodeId);
    await this.nodeAuth.revoke(nodeId);
    const record = this.nodes.get(nodeId);
    if (record) {
      this.rejectConnection(record.socket, 'node revoked; execution outcome may be uncertain');
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
    const negotiated = negotiateProtocol(hello, { gatewayProtocols: this.options.supportedProtocols, gatewayCapabilities: this.options.capabilities });
    this.nodes.set(hello.nodeId, { hello, socket, connectedAt: Date.now(), lastSeenAt: Date.now(), access: hello.access ?? null, scheduler: hello.scheduler ?? null, negotiated });
  }

  /** Test seam: deliver a node response as if it arrived on the socket. */
  deliverForTest(response: GatewayResponse, nodeId = this.pending.get(response.id)?.nodeId, socket = this.pending.get(response.id)?.socket): void {
    if (nodeId && socket) void this.finishResponse(response, nodeId, socket);
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
        if (!Array.isArray(hello.tools) || !Array.isArray(hello.allowedRoots) || !hello.fingerprint || typeof hello.agentVersion !== 'string') return ws.close(1008, 'malformed hello');
        let negotiated: NegotiatedProtocol;
        try {
          negotiated = negotiateProtocol(hello, { gatewayProtocols: this.options.supportedProtocols, gatewayCapabilities: this.options.capabilities });
        } catch {
          return ws.close(1008, 'incompatible semantic protocol');
        }
        const existing = this.nodes.get(hello.nodeId);
        if (existing && existing.socket !== ws) {
          this.rejectConnection(existing.socket, 'node connection replaced; execution outcome may be uncertain');
          existing.socket.close(4000, 'replaced by newer connection');
        }
        this.nodes.set(hello.nodeId, { hello, socket: ws, connectedAt: Date.now(), lastSeenAt: Date.now(), access: hello.access ?? null, scheduler: hello.scheduler ?? null, negotiated });
        registered = true;
        const ack: ProtocolHelloAck = { type: 'hello_ack', protocolVersion: negotiated.version, capabilities: negotiated.capabilities };
        ws.send(JSON.stringify(ack));
        return;
      }
      const record = this.nodes.get(expectedNodeId);
      if (!record || record.socket !== ws || ws.readyState !== WebSocket.OPEN || this.revoked.has(expectedNodeId)) return;
      record.lastSeenAt = Date.now();
      if (typed.type === 'response') void this.finishResponse(message as GatewayResponse, expectedNodeId, ws).catch(() => ws.close(1008, 'node authorization unavailable'));
      if (typed.type === 'task_event') this.acceptTaskEvent(message as TaskProgressEvent);
      if (typed.type === 'status' && record) {
        const status = message as NodeStatus;
        record.access = status.access ?? null;
        record.scheduler = status.scheduler ?? null;
      }
    });

    ws.on('close', () => {
      this.rejectConnection(ws, 'node disconnected; execution outcome may be uncertain');
      const record = this.nodes.get(expectedNodeId);
      if (record?.socket === ws) this.nodes.delete(expectedNodeId);
    });
  }

  private rejectConnection(socket: WebSocket, reason: string): void {
    for (const [id, pending] of this.pending) {
      if (pending.socket !== socket) continue;
      clearTimeout(pending.timer);
      this.pending.delete(id);
      pending.reject(new Error(reason));
    }
  }

  private async finishResponse(response: GatewayResponse, nodeId: string, socket: WebSocket): Promise<void> {
    if (typeof response.id !== 'string' || typeof response.ok !== 'boolean') return;
    const pending = this.pending.get(response.id);
    if (!pending || pending.nodeId !== nodeId || pending.socket !== socket) return;
    if (pending.responding) return;
    pending.responding = true;
    if (await this.nodeAuth.isRevoked(nodeId)) { this.rejectConnection(socket, 'node revoked; execution outcome may be uncertain'); return; }
    // Recheck after credential-store I/O: timeout, replacement or revocation may have won.
    if (this.pending.get(response.id) !== pending || this.nodes.get(nodeId)?.socket !== socket
      || socket.readyState !== WebSocket.OPEN || this.revoked.has(nodeId)) return;
    clearTimeout(pending.timer);
    this.pending.delete(response.id);
    if (response.ok) {
      pending.resolve({ result: response.result, ...(response.traceId ? { traceId: response.traceId } : {}) });
    } else {
      pending.reject(new Error(response.error || 'node request failed'));
    }
  }

  private acceptTaskEvent(event: TaskProgressEvent): void {
    // The gateway deliberately does not persist progress payloads here. The node owns the durable
    // event log; this validation boundary ensures only content-free lifecycle frames are accepted.
    if (!event.taskId || !event.state || !event.summary || !Number.isFinite(Date.parse(event.at))) return;
  }
}
