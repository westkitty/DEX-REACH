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

test('C14 Protocol v2 loopback fixtures negotiate current and historical peers', async () => {
  const state = await fs.mkdtemp(path.join(os.tmpdir(), 'dex-c14-v2-loopback-'));
  const auth = new NodeAuthStore(state);
  await auth.initialize();
  const token = await auth.enroll('current-v2');
  const legacyToken = await auth.enroll('historical-v1');
  const server = http.createServer();
  const registry = new NodeRegistry(auth, state);
  await registry.initialize();
  registry.attach(server);
  const port = await listen(server);
  const socket = new WebSocket(`ws://127.0.0.1:${port}/node?nodeId=current-v2`, { headers: { Authorization: `Bearer ${token}` } });
  let legacySocket: WebSocket | null = null;
  try {
    await new Promise<void>((resolve, reject) => { socket.once('open', () => resolve()); socket.once('error', reject); });
    socket.send(JSON.stringify(hello('current-v2', 'v2')));
    const ack = await nextMessage(socket) as ProtocolHelloAck;
    assert.deepEqual(ack, { type: 'hello_ack', protocolVersion: REACH_PROTOCOL_V2, capabilities: ['durable_tasks', 'task_event_stream', 'two_phase_plan'] });
    assert.equal(registry.supportsDurableTasks('current-v2'), true);
    const sync = registry.requestWithTrace('current-v2', 'dex.fingerprint', {});
    const syncRequest = await nextMessage(socket) as GatewayRequest;
    assert.equal(syncRequest.task, undefined);
    socket.send(JSON.stringify({ type: 'response', id: syncRequest.id, ok: true, result: { mode: 'sync_legacy' } } satisfies GatewayResponse));
    assert.deepEqual((await sync).result, { mode: 'sync_legacy' });
    const durable = registry.requestWithTrace('current-v2', 'dex.task', {}, undefined, undefined, 1000, { action: 'start', operation: 'dex.fingerprint', args: {} });
    const durableRequest = await nextMessage(socket) as GatewayRequest;
    assert.equal(durableRequest.task?.action, 'start');
    socket.send(JSON.stringify({ type: 'response', id: durableRequest.id, ok: true, result: { taskId: 'rtsk_loopback', durable: true } } satisfies GatewayResponse));
    assert.deepEqual((await durable).result, { taskId: 'rtsk_loopback', durable: true });
    legacySocket = new WebSocket(`ws://127.0.0.1:${port}/node?nodeId=historical-v1`, { headers: { Authorization: `Bearer ${legacyToken}` } });
    await new Promise<void>((resolve, reject) => { legacySocket!.once('open', () => resolve()); legacySocket!.once('error', reject); });
    legacySocket.send(JSON.stringify(hello('historical-v1', 'v1')));
    const legacyAck = await nextMessage(legacySocket) as ProtocolHelloAck;
    assert.deepEqual(legacyAck, { type: 'hello_ack', protocolVersion: REACH_PROTOCOL_V1, capabilities: [] });
    assert.equal(registry.supportsDurableTasks('historical-v1'), false);
  } finally {
    socket.close();
    legacySocket?.close();
    registry.shutdown();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await fs.rm(state, { recursive: true, force: true });
  }
});

test('C14 Protocol v2 loopback fixture preserves v1 gateway compatibility and refuses durable ingress', async () => {
  const state = await fs.mkdtemp(path.join(os.tmpdir(), 'dex-c14-v1-gateway-'));
  const auth = new NodeAuthStore(state);
  await auth.initialize();
  const token = await auth.enroll('historical-v1');
  const server = http.createServer();
  const registry = new NodeRegistry(auth, state, { supportedProtocols: [REACH_PROTOCOL_V1], capabilities: [] });
  await registry.initialize();
  registry.attach(server);
  const port = await listen(server);
  const socket = new WebSocket(`ws://127.0.0.1:${port}/node?nodeId=historical-v1`, { headers: { Authorization: `Bearer ${token}` } });
  try {
    await new Promise<void>((resolve, reject) => { socket.once('open', () => resolve()); socket.once('error', reject); });
    socket.send(JSON.stringify(hello('historical-v1', 'v2')));
    const ack = await nextMessage(socket) as ProtocolHelloAck;
    assert.deepEqual(ack, { type: 'hello_ack', protocolVersion: REACH_PROTOCOL_V1, capabilities: [] });
    assert.equal(registry.supportsDurableTasks('historical-v1'), false);
    await assert.rejects(
      registry.requestWithTrace('historical-v1', 'dex.task', {}, undefined, undefined, 1000, { action: 'start', operation: 'dex.fingerprint', args: {} }),
      /CAPABILITY_UNSUPPORTED_ON_NODE.*1\.0/
    );
  } finally {
    socket.close();
    registry.shutdown();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await fs.rm(state, { recursive: true, force: true });
  }
});
