import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { NodeAuthStore } from '../src/gateway/node-auth.js';
import { NodeRegistry } from '../src/gateway/registry.js';
import { DEX_REACH_VERSION } from '../src/shared/version.js';
import { REACH_PROTOCOL_V1, REACH_PROTOCOL_V2, REACH_PROTOCOL_VERSION, type GatewayRequest, type GatewayResponse, type NodeHello, type ProtocolHelloAck } from '../src/shared/protocol.js';

function hello(nodeId: string, version: 'v1' | 'v2'): NodeHello {
  return {
    type: 'hello', protocolVersion: REACH_PROTOCOL_VERSION, nodeId, profile: 'development',
    ...(version === 'v2' ? { protocolVersionSemantic: REACH_PROTOCOL_V2, supportedProtocols: [REACH_PROTOCOL_V2, REACH_PROTOCOL_V1] } : {}),
    fingerprint: { nodeId, hostname: nodeId, platform: 'loopback-fixture', arch: 'fixture', user: 'fixture', home: '/', cwd: '/', repositoryRoot: null, branch: null, remote: null, nodeVersion: 'v0', pythonVersion: null },
    tools: [], allowedRoots: ['/fixture'], agentVersion: DEX_REACH_VERSION,
    ...(version === 'v2' ? { capabilities: { durable_tasks: true, task_event_stream: true, task_reconciliation: true, two_phase_plan: true } } : {}),
    access: { mode: 'on', effectiveMode: 'on', until: null, revertTo: null, clients: {} }
  };
}

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => resolve()); });
  return (server.address() as { port: number }).port;
}

function nextMessage(socket: WebSocket): Promise<unknown> {
  return new Promise((resolve, reject) => {
    socket.once('message', data => {
      try { resolve(JSON.parse(data.toString())); } catch (error) { reject(error); }
    });
    socket.once('error', reject);
  });
}

test('only the authenticated current connection can answer pending work', async () => {
  const state = await fs.mkdtemp(path.join(os.tmpdir(), 'dex-provenance-'));
  const auth = new NodeAuthStore(state); await auth.initialize();
  const server = http.createServer(); const registry = new NodeRegistry(auth, state);
  await registry.initialize(); registry.attach(server); const port = await listen(server);
  const sockets: WebSocket[] = [];
  async function connect(id: string) {
    const token = await auth.enroll(id);
    const socket = new WebSocket(`ws://127.0.0.1:${port}/node?nodeId=${id}`, { headers: { Authorization: `Bearer ${token}` } });
    sockets.push(socket);
    await new Promise<void>((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
    socket.send(JSON.stringify(hello(id, 'v2'))); await nextMessage(socket); return socket;
  }
  try {
    const a = await connect('a'); const b = await connect('b');
    const pending = registry.request('a', 'dex.fingerprint', {}, undefined, 1000);
    const request = await nextMessage(a) as GatewayRequest;
    b.send(JSON.stringify({ type: 'response', id: request.id, ok: true, result: 'forged' }));
    await new Promise(resolve => setTimeout(resolve, 40));
    a.send(JSON.stringify({ type: 'response', id: request.id, ok: true, result: 'legitimate' }));
    assert.equal(await pending, 'legitimate');
    const one = registry.request('a', 'dex.fingerprint', {}, undefined, 1000);
    const r1 = await nextMessage(a) as GatewayRequest;
    const two = registry.request('a', 'dex.fingerprint', {}, undefined, 1000);
    const r2 = await nextMessage(a) as GatewayRequest;
    a.send(JSON.stringify({ type: 'response', id: r2.id, ok: 'yes', result: 'malformed' }));
    a.send(JSON.stringify({ type: 'response', id: r2.id, ok: true, result: 2 }));
    a.send(JSON.stringify({ type: 'response', id: r2.id, ok: true, result: 'duplicate' }));
    a.send(JSON.stringify({ type: 'response', id: r1.id, ok: true, result: 1 }));
    assert.deepEqual(await Promise.all([one, two]), [1, 2]);
    const lost = registry.request('a', 'dex.fingerprint', {}, undefined, 1000);
    const lostCheck = assert.rejects(lost, /disconnected.*uncertain/);
    await nextMessage(a); a.terminate(); await lostCheck;
    const a2 = await connect('a');
    const revoked = registry.request('a', 'dex.fingerprint', {}, undefined, 1000);
    const revokedCheck = assert.rejects(revoked, /revoked.*uncertain/);
    const revokedRequest = await nextMessage(a2) as GatewayRequest;
    await registry.revoke('a');
    a2.send(JSON.stringify({ type: 'response', id: revokedRequest.id, ok: true, result: 'revoked' }));
    await revokedCheck;
    const shutdown = registry.request('b', 'dex.fingerprint', {}, undefined, 1000);
    const shutdownCheck = assert.rejects(shutdown, /shutting down/);
    await nextMessage(b); registry.shutdown(); await shutdownCheck;
  } finally {
    sockets.forEach(socket => socket.terminate()); registry.shutdown();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await fs.rm(state, { recursive: true, force: true });
  }
});
