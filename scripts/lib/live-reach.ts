import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { Client, StreamableHTTPClientTransport, UnauthorizedError, type OAuthClientProvider, type OAuthDiscoveryState } from '@modelcontextprotocol/client';
import type { OAuthClientInformationFull, OAuthClientMetadata, OAuthTokens } from '@modelcontextprotocol/server';
import { DEX_REACH_VERSION } from '../../src/shared/version.js';

/**
 * Bring up a real DEX//REACH gateway and one or more real node agents, as separate OS processes
 * talking over a real socket, and drive them through the public MCP path as a client would.
 *
 * Why this exists rather than more unit tests: every module in this repository is covered by tests
 * that construct its inputs directly, and those tests cannot see an integration that is wrong at
 * the seams. The RFC 9207 defect this harness first found is the type case -- every unit passed,
 * the gateway served traffic, its own metadata contradicted its own redirect, and no source test
 * could have noticed because no source test speaks OAuth to a running server.
 *
 * Everything here is confined to a temporary state directory and a loopback port. It never reads
 * or writes the owner's real ~/.dex-reach, and it never contacts a deployed gateway.
 */

const execFileAsync = promisify(execFile);

export type LiveNode = {
  nodeId: string;
  child: ChildProcess;
  envFile: string;
  logFile: string;
};

export type LiveCallResult = { ok: boolean; text: string; traceId?: string };

export type LivePairOptions = {
  repoRoot: string;
  /** Where the isolated state directory is created. Defaults to a fresh mkdtemp. */
  workspace?: string;
  /** Node ids to enroll and start. The first is the one most proofs address. */
  nodeIds?: string[];
  profile?: string;
  /** How long to wait for the gateway and for each node to come online. */
  timeoutMs?: number;
};

export type LivePair = {
  baseUrl: URL;
  stateDir: string;
  workspace: string;
  roots: string;
  nodes: Map<string, LiveNode>;
  client: Client;
  /** Call an MCP tool through the authorized client. An MCP error is a result, not an exception. */
  call(tool: string, args: Record<string, unknown>): Promise<LiveCallResult>;
  /** Run the owner credential CLI exactly as an owner would, in a child process. */
  nodeCli(args: string[]): Promise<string>;
  /** Run the owner policy CLI (`dex ...`) against the node's own state directory. */
  dexCli(args: string[]): Promise<string>;
  onlineNodeCount(): Promise<number>;
  /** Resolves once the gateway reports the expected count, or throws after the timeout. */
  waitForNodeCount(expected: number, timeoutMs?: number): Promise<void>;
  startNode(nodeId: string): Promise<LiveNode>;
  stopNode(nodeId: string): Promise<void>;
  /** Perform the full asymmetric enrollment ceremony for a node and restart it onto its key. */
  migrateNodeToAsymmetric(nodeId: string): Promise<{ authMode: string; privateKeyRefused: boolean }>;
  /** Connect a raw websocket with a bearer token, to show what the gateway now refuses. */
  bearerConnectRefused(nodeId: string): Promise<string>;
  /** Complete the owner-approval leg for an external real client without exposing owner credentials. */
  approveAuthorizationUrl(url: URL | string): Promise<string>;
  /** Run the literal repository golden gate against this isolated pair without exporting owner credentials. */
  runGoldenVerification(): Promise<string>;
  stop(): Promise<void>;
};

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (typeof address === 'string' || !address) return reject(new Error('could not reserve a loopback port'));
      const port = address.port;
      server.close(() => resolve(port));
    });
  });
}

async function readEnvFile(file: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const line of (await fs.readFile(file, 'utf8')).split(/\r?\n/)) {
    if (!line || line.startsWith('#') || !line.includes('=')) continue;
    const [key, ...rest] = line.split('=');
    if (key) out[key] = rest.join('=');
  }
  return out;
}

/**
 * Kill a child and everything it spawned.
 *
 * Children are started in their own process group precisely so this can happen: `tsx` runs the real
 * entry point as a grandchild, and killing only the direct child leaves a gateway holding the port
 * and a node holding a socket, which then poisons the next run with a failure that has nothing to
 * do with the code under proof.
 */
async function killGroup(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const pid = child.pid;
  if (pid === undefined) return;
  const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
  try { process.kill(-pid, 'SIGTERM'); } catch { try { child.kill('SIGTERM'); } catch { /* already gone */ } }
  const escalate = setTimeout(() => {
    try { process.kill(-pid, 'SIGKILL'); } catch { /* already gone */ }
  }, 4000);
  escalate.unref();
  // A child that exited between the guard above and the signal never emits 'exit' for this
  // listener, and awaiting it alone would hang the whole teardown on a process that is already
  // gone. Shutting down is not worth blocking on.
  let giveUp: NodeJS.Timeout | undefined;
  await Promise.race([exited, new Promise<void>(resolve => { giveUp = setTimeout(resolve, 10_000); giveUp.unref(); })]);
  clearTimeout(escalate);
  if (giveUp) clearTimeout(giveUp);
}

async function waitFor(what: string, timeoutMs: number, probe: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = '';
  while (Date.now() < deadline) {
    try {
      if (await probe()) return;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}${lastError ? `: ${lastError}` : ''}`);
}

class LiveOAuthProvider implements OAuthClientProvider {
  private info?: OAuthClientInformationFull;
  private saved?: OAuthTokens;
  private verifier?: string;
  private discovery?: OAuthDiscoveryState;
  authorizationUrl?: URL;
  constructor(private readonly callback: string) {}
  get redirectUrl(): string { return this.callback; }
  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: 'DEX//REACH proof run',
      redirect_uris: [this.callback],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none'
    };
  }
  clientInformation(): OAuthClientInformationFull | undefined { return this.info; }
  saveClientInformation(value: OAuthClientInformationFull): void { this.info = value; }
  tokens(): OAuthTokens | undefined { return this.saved; }
  saveTokens(value: OAuthTokens): void { this.saved = value; }
  redirectToAuthorization(url: URL): void { this.authorizationUrl = url; }
  saveCodeVerifier(value: string): void { this.verifier = value; }
  saveDiscoveryState(value: OAuthDiscoveryState): void { this.discovery = structuredClone(value); }
  discoveryState(): OAuthDiscoveryState | undefined { return this.discovery ? structuredClone(this.discovery) : undefined; }
  codeVerifier(): string {
    if (!this.verifier) throw new Error('missing PKCE verifier');
    return this.verifier;
  }
}

export async function startLivePair(options: LivePairOptions): Promise<LivePair> {
  const repoRoot = path.resolve(options.repoRoot);
  const timeoutMs = options.timeoutMs ?? 45_000;
  const workspace = options.workspace ?? await fs.mkdtemp(path.join(os.tmpdir(), 'dex-reach-live-'));
  const stateDir = path.join(workspace, 'state');
  const roots = path.join(workspace, 'roots');
  const logs = path.join(workspace, 'logs');
  await fs.mkdir(stateDir, { recursive: true, mode: 0o700 });
  await fs.mkdir(roots, { recursive: true, mode: 0o700 });
  await fs.mkdir(logs, { recursive: true, mode: 0o700 });

  const port = await freePort();
  const baseUrl = new URL(`http://127.0.0.1:${port}`);
  // Generated per run and never written anywhere but this temporary state directory. It exists so
  // the OAuth leg is genuinely exercised, not so anything is protected by it.
  const ownerPassword = crypto.randomBytes(24).toString('base64url');
  const ownerUser = 'proof-owner';

  const baseEnv: NodeJS.ProcessEnv = {
    ...process.env,
    DEX_REACH_STATE_DIR: stateDir,
    DEX_REACH_PUBLIC_BASE_URL: baseUrl.toString(),
    DEX_REACH_GATEWAY_HOST: '127.0.0.1',
    DEX_REACH_GATEWAY_PORT: String(port),
    DEX_REACH_OWNER_USER: ownerUser,
    DEX_REACH_OWNER_PASSWORD: ownerPassword,
    // A stray enrollment in the ambient environment would otherwise be imported as a legacy node
    // and quietly join a run that is supposed to contain only what it created.
    DEX_REACH_NODE_ID: '',
    DEX_REACH_NODE_TOKEN: '',
    DEX_REACH_ENV_FILE: path.join(stateDir, 'secrets.env')
  };

  const children: ChildProcess[] = [];
  async function spawnLogged(name: string, args: string[], env: NodeJS.ProcessEnv): Promise<{ child: ChildProcess; logFile: string }> {
    const logFile = path.join(logs, `${name}.log`);
    const handle = await fs.open(logFile, 'a', 0o600);
    const child = spawn(process.execPath, [path.join(repoRoot, 'node_modules/tsx/dist/cli.mjs'), ...args], {
      cwd: repoRoot,
      env,
      detached: true,
      stdio: ['ignore', handle.fd, handle.fd]
    });
    child.once('exit', () => void handle.close().catch(() => undefined));
    children.push(child);
    return { child, logFile };
  }

  const gateway = await spawnLogged('gateway', ['src/gateway/main.ts'], baseEnv);

  async function health(): Promise<{ ok: boolean; onlineNodes: number }> {
    const response = await fetch(new URL('/healthz', baseUrl));
    if (!response.ok) throw new Error(`healthz ${response.status}`);
    return await response.json() as { ok: boolean; onlineNodes: number };
  }

  const nodes = new Map<string, LiveNode>();
  const provider = new LiveOAuthProvider(`http://127.0.0.1:${await freePort()}/callback`);
  const client = new Client({ name: 'dex-reach-proof-run', version: DEX_REACH_VERSION }, { capabilities: {} });

  async function stop(): Promise<void> {
    try { await client.close(); } catch { /* the transport may already be gone */ }
    for (const child of [...children].reverse()) await killGroup(child);
  }

  try {
    await waitFor('the gateway to answer /healthz', timeoutMs, async () => (await health()).ok);

    async function nodeCli(args: string[]): Promise<string> {
      const { stdout } = await execFileAsync(process.execPath, [path.join(repoRoot, 'node_modules/tsx/dist/cli.mjs'), 'scripts/node-credentials.ts', ...args], { cwd: repoRoot, env: baseEnv, timeout: 120_000 });
      return stdout.trim();
    }
    async function dexCli(args: string[]): Promise<string> {
      const { stdout } = await execFileAsync(process.execPath, [path.join(repoRoot, 'node_modules/tsx/dist/cli.mjs'), 'scripts/dex-reach.ts', ...args], { cwd: repoRoot, env: baseEnv, timeout: 120_000 });
      return stdout.trim();
    }

    async function startNode(nodeId: string): Promise<LiveNode> {
      const envFile = path.join(stateDir, 'nodes', `${nodeId}.env`);
      const values = await readEnvFile(envFile);
      const started = await spawnLogged(`node-${nodeId}-${Date.now()}`, ['src/node/main.ts'], { ...baseEnv, ...values, DEX_REACH_STATE_DIR: stateDir, DEX_REACH_ENV_FILE: envFile });
      const live: LiveNode = { nodeId, child: started.child, envFile, logFile: started.logFile };
      nodes.set(nodeId, live);
      return live;
    }

    async function stopNode(nodeId: string): Promise<void> {
      const live = nodes.get(nodeId);
      if (!live) return;
      await killGroup(live.child);
      nodes.delete(nodeId);
    }

    async function waitForNodeCount(expected: number, waitMs = timeoutMs): Promise<void> {
      await waitFor(`the gateway to report ${expected} online node(s)`, waitMs, async () => (await health()).onlineNodes === expected);
    }

    for (const nodeId of options.nodeIds ?? ['proof-node-a']) {
      await nodeCli(['enroll', nodeId, '--profile', options.profile ?? 'development', '--roots', roots, '--gateway-ws', `ws://127.0.0.1:${port}/node`]);
      await startNode(nodeId);
    }
    await waitForNodeCount((options.nodeIds ?? ['proof-node-a']).length);

    async function approveAuthorizationUrl(input: URL | string): Promise<string> {
      const url = typeof input === 'string' ? new URL(input) : input;
      if (url.origin !== baseUrl.origin || url.pathname !== '/authorize') {
        throw new Error('external authorization URL does not target this live pair');
      }
      const page = await fetch(url);
      const html = await page.text();
      const ticket = html.match(/name="ticket" value="([^"]+)"/)?.[1];
      if (!ticket) throw new Error(`authorization page did not render a ticket (status ${page.status})`);
      const approval = await fetch(new URL('/dex/approve', baseUrl), {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ ticket, username: ownerUser, password: ownerPassword }),
        redirect: 'manual'
      });
      const location = approval.headers.get('location');
      if (!location) throw new Error(`owner approval did not redirect (status ${approval.status})`);
      return location;
    }

    async function authorize(url: URL): Promise<URLSearchParams> {
      // The whole response, so the SDK can apply RFC 9207. Handing it a bare code would silently
      // disable exactly the check that found the defect this harness exists to catch.
      return new URL(await approveAuthorizationUrl(url)).searchParams;
    }

    async function connect(): Promise<void> {
      const transport = new StreamableHTTPClientTransport(new URL('/mcp', baseUrl), { authProvider: provider });
      try {
        await client.connect(transport);
      } catch (error) {
        if (!(error instanceof UnauthorizedError) || !provider.authorizationUrl) throw error;
        await transport.finishAuth(await authorize(provider.authorizationUrl));
        await connect();
      }
    }
    await connect();

    async function call(tool: string, args: Record<string, unknown>): Promise<LiveCallResult> {
      const result = await client.callTool({ name: tool, arguments: args }) as { isError?: boolean; content?: unknown; structuredContent?: unknown; _meta?: Record<string, unknown> };
      const content = Array.isArray(result.content) ? result.content : [];
      const texts = content
        .filter((item): item is { type: 'text'; text: string } => Boolean(item) && (item as { type?: string }).type === 'text' && typeof (item as { text?: unknown }).text === 'string')
        .map(item => item.text);
      let traceId: string | undefined;
      const structured = result.structuredContent as { dex_trace_id?: unknown } | undefined;
      if (typeof structured?.dex_trace_id === 'string' && /^[0-9a-f]{32}$/.test(structured.dex_trace_id)) traceId = structured.dex_trace_id;
      const metaTrace = result._meta?.['dex-reach/trace-id'];
      if (!traceId && typeof metaTrace === 'string' && /^[0-9a-f]{32}$/.test(metaTrace)) traceId = metaTrace;
      for (const extra of texts.slice(1)) {
        try {
          const parsed = JSON.parse(extra) as { dex_trace_id?: unknown };
          if (typeof parsed.dex_trace_id === 'string' && /^[0-9a-f]{32}$/.test(parsed.dex_trace_id)) {
            traceId = parsed.dex_trace_id;
            break;
          }
        } catch {
          // Additional text blocks may be human-readable metadata. The first text block remains payload.
        }
      }
      return { ok: !result.isError, text: texts[0] ?? '', ...(traceId ? { traceId } : {}) };
    }

    async function migrateNodeToAsymmetric(nodeId: string): Promise<{ authMode: string; privateKeyRefused: boolean }> {
      const { loadOrCreateTransportKeys } = await import('../../src/node/transport-keys.js');
      const keys = await loadOrCreateTransportKeys(nodeId, stateDir);
      const token = (await nodeCli(['enroll-token', nodeId])).split('\n').pop()!.trim();
      const offer = async (publicKey: string): Promise<Response> => fetch(new URL('/node/enroll', baseUrl), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ nodeId, token, publicKey })
      });
      // Offer the private key first. It must be refused; doing it before the real enrollment means a
      // gateway that accepted it would also have consumed the one-use token, and the ceremony below
      // would fail loudly instead of the mistake passing unnoticed.
      const rejected = await offer(keys.privateKey);
      const privateKeyRefused = !rejected.ok;
      const accepted = await offer(keys.publicKey);
      if (!accepted.ok) throw new Error(`enrollment of the transport public key failed: ${accepted.status} ${await accepted.text()}`);
      const body = await accepted.json() as { authMode?: string };
      await nodeCli(['complete-migration', nodeId]);
      await stopNode(nodeId);
      await waitForNodeCount(nodes.size);
      await startNode(nodeId);
      await waitForNodeCount(nodes.size);
      return { authMode: body.authMode ?? 'unknown', privateKeyRefused };
    }

    async function runGoldenVerification(): Promise<string> {
      const nodeId = (options.nodeIds ?? ['proof-node-a'])[0]!;
      const ownerFile = path.join(stateDir, 'secrets.env');
      const safeEnv: NodeJS.ProcessEnv = { ...baseEnv, DEX_REACH_NODE_ID: nodeId };
      delete safeEnv.DEX_REACH_OWNER_USER;
      delete safeEnv.DEX_REACH_OWNER_PASSWORD;
      // Keep the proof credential outside argv/logs and out of all verify children. smoke.ts
      // deliberately loads the owner file only when the golden command reaches its smoke stage.
      await fs.writeFile(
        ownerFile,
        'DEX_REACH_OWNER_USER=' + ownerUser + '\n' +
          'DEX_REACH_OWNER_PASSWORD=' + ownerPassword + '\n',
        { mode: 0o600 }
      );
      try {
        const result = await execFileAsync('npm', ['run', 'verify:golden'], {
          cwd: repoRoot,
          env: safeEnv,
          timeout: 15 * 60 * 1000,
          maxBuffer: 32 * 1024 * 1024
        });
        return [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
      } finally {
        await fs.rm(ownerFile, { force: true }).catch(() => undefined);
      }
    }

    async function bearerConnectRefused(nodeId: string): Promise<string> {
      const values = await readEnvFile(path.join(stateDir, 'nodes', `${nodeId}.env`));
      const { default: WebSocket } = await import('ws');
      return new Promise<string>((resolve, reject) => {
        const socket = new WebSocket(`ws://127.0.0.1:${port}/node?nodeId=${encodeURIComponent(nodeId)}`, {
          headers: { Authorization: `Bearer ${values.DEX_REACH_NODE_TOKEN}` }
        });
        const timer = setTimeout(() => { socket.terminate(); reject(new Error('bearer connection neither opened nor closed')); }, 10_000);
        socket.on('open', () => { clearTimeout(timer); socket.close(); reject(new Error('the gateway accepted a bearer token for an asymmetric-only node')); });
        socket.on('error', error => { clearTimeout(timer); resolve(error.message); });
        socket.on('close', () => { clearTimeout(timer); resolve('socket closed by the gateway'); });
      });
    }

    return {
      baseUrl, stateDir, workspace, roots, nodes, client,
      call, nodeCli, dexCli,
      onlineNodeCount: async () => (await health()).onlineNodes,
      waitForNodeCount, startNode, stopNode, migrateNodeToAsymmetric, bearerConnectRefused,
      approveAuthorizationUrl, runGoldenVerification, stop
    };
  } catch (error) {
    await stop();
    const detail = await fs.readFile(gateway.logFile, 'utf8').catch(() => '');
    const tail = detail.split('\n').filter(Boolean).slice(-5).join(' | ');
    throw new Error(`${error instanceof Error ? error.message : String(error)}${tail ? ` (gateway log: ${tail})` : ''}`);
  }
}
