import WebSocket from 'ws';
import { DesktopCommanderBackend } from './backend.js';
import { loadNodeConfig } from './config.js';
import { ResultStore } from './result-store.js';
import { nativeCall } from './native.js';
import { executionFingerprint } from '../shared/fingerprint.js';
import { toolGuard } from '../shared/security.js';
import { AuditLog } from '../shared/audit.js';
import { REACH_PROTOCOL_VERSION, type AccessSnapshot, type GatewayRequest, type GatewayResponse, type NodeHello, type NodeStatus } from '../shared/protocol.js';
import { loadLocalSecrets, stateDir } from '../shared/local-env.js';
import { authorizeOperation, loadAccessState, snapshot } from '../shared/access.js';
import { writeRuntimeStatus } from './runtime-status.js';

loadLocalSecrets();
const config = loadNodeConfig();
const backend = new DesktopCommanderBackend();
const results = new ResultStore();
const audit = new AuditLog();
let stopped = false;
let reconnectMs = 1000;
let activeSocket: WebSocket | null = null;
let lastAccessJson = '';

await backend.start(config.allowedRoots);
console.log(`DEX//REACH node ${config.nodeId} started with ${backend.listTools().length} compatibility tools (state dir ${stateDir()})`);

/** Always read the owner's policy file fresh: the local switch must win even if this process is stale. */
async function currentAccess(): Promise<AccessSnapshot> {
  return snapshot(await loadAccessState(config.nodeId));
}

async function handleRequest(request: GatewayRequest): Promise<GatewayResponse> {
  const started = Date.now();
  const actor = request.actor;
  try {
    // Node-local authorization happens before anything else; the gateway cannot bypass it.
    const decision = authorizeOperation(await loadAccessState(config.nodeId), actor, request.operation, config.profile);
    if (!decision.allowed) throw new Error(decision.reason);
    const profile = decision.effectiveProfile;
    let value: unknown;
    if (request.operation === 'dc.call') {
      const tool = String(request.args.tool || '');
      const toolArgs = (request.args.arguments || {}) as Record<string, unknown>;
      if (!backend.listTools().some(candidate => candidate.name === tool)) throw new Error(`unknown backend tool: ${tool}`);
      if (tool === 'set_config_value' && profile !== 'full-local') {
        throw new Error('remote mutation of Desktop Commander safety configuration requires full-local profile');
      }
      const blocked = toolGuard(tool, toolArgs, profile, config.allowedRoots);
      if (blocked) throw new Error(blocked);
      value = await backend.callTool(tool, toolArgs);
    } else if (request.operation === 'dex.result.read') {
      value = results.read(String(request.args.handle || ''), Number(request.args.offset || 0), Number(request.args.length || 65536));
    } else {
      value = await nativeCall(config.nodeId, request.operation, request.args, config.allowedRoots, profile);
    }
    const result = results.bound(value);
    await audit.append({
      at: new Date().toISOString(), source: 'node', nodeId: config.nodeId, actor, operation: request.operation,
      ok: true, durationMs: Date.now() - started, args: request.args
    });
    return { type: 'response', id: request.id, ok: true, result };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await audit.append({
      at: new Date().toISOString(), source: 'node', nodeId: config.nodeId, actor, operation: request.operation,
      ok: false, durationMs: Date.now() - started, args: request.args, error: message
    });
    return { type: 'response', id: request.id, ok: false, error: message };
  }
}

/** Publishes policy changes to the gateway (for display) and to the local runtime file (for `dex-reach status`). */
async function publishStatus(): Promise<void> {
  const access = await currentAccess();
  const json = JSON.stringify(access);
  const connected = activeSocket?.readyState === WebSocket.OPEN;
  await writeRuntimeStatus(config.nodeId, { pid: process.pid, connected, gateway: new URL(config.gatewayWs).origin, access, updatedAt: new Date().toISOString() });
  if (json !== lastAccessJson && connected && activeSocket) {
    const status: NodeStatus = { type: 'status', access };
    activeSocket.send(JSON.stringify(status));
  }
  lastAccessJson = json;
}
const statusTimer = setInterval(() => void publishStatus().catch(() => undefined), 2000);
statusTimer.unref();
async function connect(): Promise<void> {
  if (stopped) return;
  const url = new URL(config.gatewayWs);
  url.searchParams.set('nodeId', config.nodeId);
  const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${config.token}` } });
  let lastAliveAt = Date.now();
  ws.on('pong', () => { lastAliveAt = Date.now(); });

  ws.on('open', async () => {
    reconnectMs = 1000;
    lastAliveAt = Date.now();
    activeSocket = ws;
    lastAccessJson = '';
    const hello: NodeHello = {
      type: 'hello',
      protocolVersion: REACH_PROTOCOL_VERSION,
      nodeId: config.nodeId,
      profile: config.profile,
      fingerprint: await executionFingerprint(config.nodeId),
      tools: backend.listTools(),
      allowedRoots: config.allowedRoots,
      agentVersion: '0.2.0',
      access: await currentAccess()
    };
    ws.send(JSON.stringify(hello));
    void publishStatus().catch(() => undefined);
    console.log(`DEX//REACH node connected to ${url.origin}`);
  });

  ws.on('message', async data => {
    lastAliveAt = Date.now();
    let parsed: unknown;
    try {
      parsed = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (!parsed || typeof parsed !== 'object' || (parsed as { type?: string }).type !== 'request') return;
    const response = await handleRequest(parsed as GatewayRequest);
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(response));
  });

  const heartbeat = setInterval(() => {
    if (ws.readyState !== WebSocket.OPEN) return;
    if (Date.now() - lastAliveAt > 12000) {
      ws.terminate();
      return;
    }
    ws.ping();
    ws.send(JSON.stringify({ type: 'heartbeat', at: Date.now() }));
  }, 5000);
  heartbeat.unref();

  ws.on('close', () => {
    clearInterval(heartbeat);
    if (activeSocket === ws) activeSocket = null;
    void publishStatus().catch(() => undefined);
    if (stopped) return;
    const delay = reconnectMs;
    reconnectMs = Math.min(reconnectMs * 2, 30000);
    console.warn(`DEX//REACH gateway disconnected; reconnecting in ${delay}ms`);
    setTimeout(() => void connect(), delay).unref();
  });

  ws.on('error', error => {
    console.error('DEX//REACH node websocket error:', error.message);
  });
}

async function shutdown(): Promise<void> {
  if (stopped) return;
  stopped = true;
  await backend.close();
  process.exit(0);
}

process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
await connect();
