import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { Client } from '@modelcontextprotocol/client';
import WebSocket from 'ws';
import { createReachMcpServer } from '../src/gateway/mcp.js';
import { NodeAuthStore } from '../src/gateway/node-auth.js';
import { NodeRegistry } from '../src/gateway/registry.js';
import { DEX_REACH_VERSION } from '../src/shared/version.js';
import { REACH_PROTOCOL_V1, REACH_PROTOCOL_V2, REACH_PROTOCOL_VERSION, type GatewayRequest, type NodeHello } from '../src/shared/protocol.js';
import { negotiateProtocol } from '../src/shared/protocol-negotiation.js';

class FakeSocket extends EventEmitter {
  readyState: number = WebSocket.OPEN;
  sent: GatewayRequest[] = [];
  send(data: string, callback?: (error?: Error) => void): void {
    this.sent.push(JSON.parse(data) as GatewayRequest);
    callback?.();
  }
  close(): void { this.readyState = WebSocket.CLOSED; }
  terminate(): void { this.readyState = WebSocket.CLOSED; }
}

function hello(nodeId: string, capabilities?: NodeHello['capabilities']): NodeHello {
  return {
    type: 'hello', protocolVersion: REACH_PROTOCOL_VERSION, nodeId, profile: 'development',
    ...(capabilities?.durable_tasks === true ? { protocolVersionSemantic: REACH_PROTOCOL_V2, supportedProtocols: [REACH_PROTOCOL_V2, REACH_PROTOCOL_V1] } : {}),
    fingerprint: { nodeId, hostname: nodeId, platform: 'fixture', arch: 'fixture', user: 'fixture', home: '/', cwd: '/', repositoryRoot: null, branch: null, remote: null, nodeVersion: 'v0', pythonVersion: null },
    tools: [], allowedRoots: ['/fixture'], agentVersion: DEX_REACH_VERSION,
    ...(capabilities === undefined ? {} : { capabilities }),
    access: { mode: 'on', effectiveMode: 'on', until: null, revertTo: null, clients: {} }
  };
}

async function taskCall(options: {
  supportsDurable: boolean;
  requestWithTrace?: (...args: unknown[]) => Promise<{ result: unknown }>;
  mode: 'auto' | 'durable';
  nodeId?: string;
}) {
  const calls: unknown[][] = [];
  const registry = {
    requestWithTrace: async (...args: unknown[]) => {
      calls.push(args);
      return options.requestWithTrace ? options.requestWithTrace(...args) : { result: { ok: true, mode: 'sync' } };
    },
    supportsDurableTasks: () => options.supportsDurable,
    listNodes: () => []
  } as unknown as NodeRegistry;
  const audit = { append: async () => undefined };
  const server = createReachMcpServer(registry, audit as never, 'c14-f-fixture', { kind: 'smoke', clientId: 'c14-f', clientName: 'C14-F' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'c14-f-matrix', version: DEX_REACH_VERSION });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const result = await client.callTool({ name: 'reach_task', arguments: {
      node_id: options.nodeId ?? 'fixture-node', action: 'start', operation: 'dex.fingerprint', arguments: {}, mode: options.mode
    } });
    return { result, calls };
  } finally {
    await client.close().catch(() => undefined);
    await server.close().catch(() => undefined);
  }
}

test('C14-F legacy capability refusal is explicit and auto fallback is labeled', async () => {
  const fallback = await taskCall({ supportsDurable: false, mode: 'auto', nodeId: 'legacy-v1' });
  assert.equal(fallback.result.isError, undefined);
  assert.match(String((fallback.result.content as Array<{ text: string }>)[0]?.text), /synchronous-fallback/);
  assert.match(String((fallback.result.content as Array<{ text: string }>)[0]?.text), /no durable handle/);
  assert.equal(fallback.calls.length, 1);
  assert.equal(fallback.calls[0]?.[0], 'legacy-v1');
  assert.equal((fallback.calls[0]?.[6] as unknown), undefined, 'legacy fallback must not dispatch a durable task envelope');

  const refused = await taskCall({ supportsDurable: false, mode: 'durable', nodeId: 'legacy-v1' });
  assert.equal(refused.result.isError, true);
  assert.match(String((refused.result.content as Array<{ text: string }>)[0]?.text), /CAPABILITY_UNSUPPORTED_ON_NODE/);
  assert.equal(refused.calls.length, 0, 'durable refusal must not dispatch or fabricate a task');
});

test('C14-F current capability path preserves exact node and durable lifecycle identity', async () => {
  const calls: unknown[][] = [];
  const durable = await taskCall({
    supportsDurable: true,
    mode: 'durable',
    nodeId: 'task-capable-v1',
    requestWithTrace: async (...args) => {
      calls.push(args);
      const task = args[6] as { action?: string; taskId?: string };
      return { result: task.action === 'start' ? { taskId: 'rtsk_19999999999_0123456789abcdef', state: 'RUNNING', durable: true } : { taskId: task.taskId, state: 'RUNNING', durable: true } };
    }
  });
  assert.equal(durable.result.isError, undefined);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.[0], 'task-capable-v1');
  assert.deepEqual(calls[0]?.[3], { kind: 'smoke', clientId: 'c14-f', clientName: 'C14-F' });
  assert.deepEqual(calls[0]?.[6], { action: 'start', operation: 'dex.fingerprint', args: {} });
  assert.match(String((durable.result.content as Array<{ text: string }>)[0]?.text), /RUNNING/);
});

test('C14-F missing, empty, false, and malformed capabilities fail closed', async () => {
  const variants: Array<NodeHello['capabilities']> = [undefined, {}, { durable_tasks: false }, { durable_tasks: 'true' } as unknown as NodeHello['capabilities']];
  for (const capabilities of variants) {
    const durable = await taskCall({ supportsDurable: capabilities?.durable_tasks === true, mode: 'durable', nodeId: 'capability-fixture' });
    assert.equal(durable.result.isError, true);
    assert.match(String((durable.result.content as Array<{ text: string }>)[0]?.text), /CAPABILITY_UNSUPPORTED_ON_NODE/);
    assert.equal(durable.calls.length, 0);
  }
});

test('C14-F reconnect replaces stale capability authority and never crosses nodes', async () => {
  const state = await import('node:fs/promises').then(fs => fs.mkdtemp('/tmp/dex-c14-f-routing-'));
  try {
    const auth = new NodeAuthStore(state);
    await auth.initialize();
    const registry = new NodeRegistry(auth, state);
    await registry.initialize();
    const capableSocket = new FakeSocket();
    const legacySocket = new FakeSocket();
    const otherSocket = new FakeSocket();
    registry.registerForTest(hello('same-node', { durable_tasks: true }), capableSocket as unknown as WebSocket);
    assert.equal(registry.supportsDurableTasks('same-node'), true);
    registry.registerForTest(hello('same-node'), legacySocket as unknown as WebSocket);
    assert.equal(registry.supportsDurableTasks('same-node'), false, 'stale durable capability must be replaced');
    registry.registerForTest(hello('other-node', { durable_tasks: true }), otherSocket as unknown as WebSocket);
    const pending = registry.request('same-node', 'dex.fingerprint', {});
    assert.equal(legacySocket.sent.length, 1);
    assert.equal(otherSocket.sent.length, 0, 'capabilities from another node must not receive this request');
    registry.deliverForTest({ type: 'response', id: legacySocket.sent[0]!.id, ok: true, result: { nodeId: 'same-node' } });
    assert.deepEqual(await pending, { nodeId: 'same-node' });
    registry.shutdown();
  } finally {
    await import('node:fs/promises').then(fs => fs.rm(state, { recursive: true, force: true }));
  }
});

test('C14-F semantic negotiation implements the ADR v1/v2 matrix without downgrade', () => {
  const v1Node = hello('legacy');
  const v2Node = hello('current', { durable_tasks: true, task_reconciliation: true, two_phase_plan: true });
  assert.deepEqual(negotiateProtocol(v2Node), { version: REACH_PROTOCOL_V2, capabilities: ['durable_tasks', 'task_reconciliation', 'two_phase_plan'] });
  assert.deepEqual(negotiateProtocol(v1Node), { version: REACH_PROTOCOL_V1, capabilities: [] });
  assert.equal(negotiateProtocol(v2Node, { gatewayProtocols: [REACH_PROTOCOL_V1] }).version, REACH_PROTOCOL_V1, 'v1 gateway admits only legacy mode');
  assert.throws(() => negotiateProtocol(v1Node, { gatewayProtocols: [REACH_PROTOCOL_V2] as const }), /INCOMPATIBLE_PROTOCOL_VERSION/);
});
