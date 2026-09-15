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
import { createReachMcpServer } from './mcp.js';

loadLocalSecrets();
const config = loadGatewayConfig();
const issuerUrl = new URL('/', config.publicBaseUrl);
const resourceUrl = new URL('/mcp', config.publicBaseUrl);
const audit = new AuditLog();
const oauth = new ReachOAuthProvider(config.stateDir, config.ownerUser, config.ownerPassword, resourceUrl);
const registry = new NodeRegistry(config.nodeToken, config.stateDir);
await oauth.initialize();
await registry.initialize();

const allowedHosts = [config.publicBaseUrl.host, config.publicBaseUrl.hostname, 'localhost', '127.0.0.1'];
const app = createMcpExpressApp({ host: config.host, allowedHosts: [...new Set(allowedHosts)] });
app.use(express.urlencoded({ extended: false }));

app.get('/healthz', (_req, res) => {
  res.json({ ok: true, service: 'DEX//REACH', version: '0.1.0', onlineNodes: registry.listNodes().length });
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
      if (!session || session.clientId !== clientId) return void res.status(400).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Invalid MCP session' }, id: null });
      await session.transport.handleRequest(req, res, req.body);
      return;
    }
    if (!isInitializeRequest(req.body)) return void res.status(400).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Initialization request required' }, id: null });
    let transport!: StreamableHTTPServerTransport;
    const mcp = createReachMcpServer(registry, audit, clientId);
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
    res.status(400).send('Invalid or missing MCP session');
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
