import express from 'express';
import { randomUUID } from 'node:crypto';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import { loadLocalSecrets } from '../shared/local-env.js';
import { AuditLog } from '../shared/audit.js';
import { loadGatewayConfig } from './config.js';
import { ReachOAuthProvider } from './auth.js';
import { NodeRegistry } from './registry.js';
import { NodeAuthStore } from './node-auth.js';
import { createReachMcpServer } from './mcp.js';
import { classifyClient } from '../shared/access.js';
import type { RequestActor } from '../shared/protocol.js';

loadLocalSecrets();
const config = loadGatewayConfig();
const issuerUrl = new URL('/', config.publicBaseUrl);
const resourceUrl = new URL('/mcp', config.publicBaseUrl);
const audit = new AuditLog();
const oauth = new ReachOAuthProvider(config.stateDir, config.ownerUser, config.ownerPassword, resourceUrl);
const nodeAuth = new NodeAuthStore(config.stateDir);
await oauth.initialize();
await nodeAuth.initialize();
if (config.legacyNodeId && config.legacyNodeToken) await nodeAuth.importLegacy(config.legacyNodeId, config.legacyNodeToken);
const registry = new NodeRegistry(nodeAuth, config.stateDir);
await registry.initialize();

const allowedHosts = [config.publicBaseUrl.host, config.publicBaseUrl.hostname, 'localhost', '127.0.0.1'];
const app = createMcpExpressApp({ host: config.host, allowedHosts: [...new Set(allowedHosts)] });
// The public HTTPS ingress (Tailscale Funnel) proxies from loopback and sets X-Forwarded-For;
// trusting loopback lets the SDK rate limiters key on the real client instead of failing validation.
app.set('trust proxy', 'loopback');
app.use(express.urlencoded({ extended: false }));

// Handshake diagnostics: method, path, status, timing, client UA, JSON-RPC method, MCP protocol version.
// Never logs query strings, bodies, cookies, or Authorization headers.
app.use((req, res, next) => {
  if (req.path === '/healthz') return next();
  const started = Date.now();
  const route = req.originalUrl.split('?')[0];
  res.on('finish', () => {
    const body = req.body as Record<string, unknown> | undefined;
    const rpc = body && typeof body === 'object' && typeof body.method === 'string' ? body.method : '';
    const dcrName = route === '/register' && body && typeof body.client_name === 'string' ? body.client_name : '';
    const parts = [
      `[http] ${req.method} ${route} ${res.statusCode} ${Date.now() - started}ms`,
      `ua=${JSON.stringify(String(req.headers['user-agent'] || '').slice(0, 96))}`,
      rpc ? `rpc=${rpc}` : '',
      req.headers['mcp-protocol-version'] ? `mcpv=${String(req.headers['mcp-protocol-version'])}` : '',
      req.headers['mcp-session-id'] ? 'session=yes' : '',
      route === '/mcp' ? `accept=${JSON.stringify(String(req.headers.accept || ''))}` : '',
      dcrName ? `client_name=${JSON.stringify(dcrName)}` : '',
      route === '/authorize' && typeof req.query.scope === 'string' ? `scope=${JSON.stringify(req.query.scope)}` : '',
      route === '/authorize' && typeof req.query.resource === 'string' ? `resource=${JSON.stringify(req.query.resource)}` : '',
      res.statusCode >= 300 && res.statusCode < 400 && route === '/authorize' ? `redirect_error=${JSON.stringify(new URL(String(res.getHeader('location') || 'http://x/'), 'http://x/').searchParams.get('error') || '')}` : ''
    ].filter(Boolean);
    console.log(parts.join(' '));
  });
  next();
});

app.get('/healthz', (_req, res) => {
  res.json({ ok: true, service: 'DEX//REACH', version: '0.2.0', onlineNodes: registry.listNodes().length });
});

app.post('/dex/approve', async (req, res) => {
  try {
    const redirect = await oauth.approve(String(req.body.ticket || ''), String(req.body.username || ''), String(req.body.password || ''));
    res.redirect(redirect);
  } catch {
    res.status(401).type('text').send('Authorization denied.');
  }
});

app.use(mcpAuthRouter({
  provider: oauth,
  issuerUrl,
  baseUrl: issuerUrl,
  scopesSupported: ['mcp:tools'],
  resourceServerUrl: resourceUrl,
  resourceName: 'DEX//REACH'
}));

const resourceMetadataUrl = getOAuthProtectedResourceMetadataUrl(resourceUrl);
const bearer = requireBearerAuth({
  verifier: oauth,
  requiredScopes: ['mcp:tools'],
  resourceMetadataUrl
});

type McpSession = { transport: StreamableHTTPServerTransport; mcp: ReturnType<typeof createReachMcpServer>; clientId: string };
const sessions = new Map<string, McpSession>();

app.post('/mcp', bearer, async (req, res) => {
  const clientId = req.auth?.clientId || 'unknown';
  const header = req.headers['mcp-session-id'];
  const sessionId = typeof header === 'string' ? header : undefined;
  try {
    if (sessionId) {
      const session = sessions.get(sessionId);
      // MCP Streamable HTTP: an unknown/expired session is 404 so well-behaved clients re-initialize
      // transparently (e.g. after a gateway restart) instead of surfacing a dead session forever.
      if (!session || session.clientId !== clientId) return void res.status(404).json({ jsonrpc: '2.0', error: { code: -32001, message: 'MCP session not found; send a new initialize request' }, id: null });
      await session.transport.handleRequest(req, res, req.body);
      return;
    }
    if (!isInitializeRequest(req.body)) return void res.status(400).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Initialization request required' }, id: null });
    let transport!: StreamableHTTPServerTransport;
    // Actor identity comes from the OAuth client registration the owner approved; no token material is forwarded.
    const clientName = oauth.getClient(clientId)?.client_name || clientId;
    const actor: RequestActor = { kind: classifyClient(clientName), clientId, clientName };
    const mcp = createReachMcpServer(registry, audit, clientId, actor);
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      enableJsonResponse: true,
      onsessioninitialized: id => { sessions.set(id, { transport, mcp, clientId }); },
      onsessionclosed: id => { sessions.delete(id); }
    });
    transport.onclose = () => {
      if (transport.sessionId) sessions.delete(transport.sessionId);
      void mcp.close().catch(() => undefined);
    };
    await mcp.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.error('DEX//REACH MCP request failed:', error);
    if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null });
  }
});

async function handleSessionRequest(req: express.Request, res: express.Response): Promise<void> {
  const header = req.headers['mcp-session-id'];
  const sessionId = typeof header === 'string' ? header : '';
  const clientId = req.auth?.clientId || 'unknown';
  const session = sessions.get(sessionId);
  if (!session || session.clientId !== clientId) {
    res.status(404).json({ jsonrpc: '2.0', error: { code: -32001, message: 'MCP session not found; send a new initialize request' }, id: null });
    return;
  }
  await session.transport.handleRequest(req, res);
}

app.get('/mcp', bearer, (req, res) => void handleSessionRequest(req, res));
app.delete('/mcp', bearer, (req, res) => void handleSessionRequest(req, res));

const httpServer = app.listen(config.port, config.host, () => {
  console.log(`DEX//REACH gateway listening on ${config.host}:${config.port}`);
  console.log(`DEX//REACH public MCP resource: ${resourceUrl}`);
});
registry.attach(httpServer);
registry.startRevocationSweep();

async function shutdown(): Promise<void> {
  for (const session of sessions.values()) await session.transport.close().catch(() => undefined);
  sessions.clear();
  registry.shutdown();
  const fallback = setTimeout(() => process.exit(0), 2000);
  fallback.unref();
  httpServer.close(error => {
    if (error) console.error(error);
    process.exit(error ? 1 : 0);
  });
}

process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
