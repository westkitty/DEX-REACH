import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { NodeRegistry } from '../src/gateway/registry.js';
import { NodeAuthStore } from '../src/gateway/node-auth.js';
import { REACH_PROTOCOL_VERSION, type GatewayRequest, type NodeHello } from '../src/shared/protocol.js';

class FakeSocket extends EventEmitter {
  readyState: number = WebSocket.OPEN;
  sent: GatewayRequest[] = [];
  closed: { code: number; reason: string } | null = null;
  send(data: string, cb?: (error?: Error) => void): void { this.sent.push(JSON.parse(data) as GatewayRequest); cb?.(); }
  close(code: number, reason: string): void { this.closed = { code, reason }; this.readyState = WebSocket.CLOSED; }
  terminate(): void { this.readyState = WebSocket.CLOSED; }
}

function hello(nodeId: string): NodeHello {
  return {
    type: 'hello', protocolVersion: REACH_PROTOCOL_VERSION, nodeId, profile: 'development',
    fingerprint: { nodeId, hostname: nodeId, platform: 'test', arch: 'test', user: 'u', home: '/', cwd: '/', repositoryRoot: null, branch: null, remote: null, nodeVersion: 'v0', pythonVersion: null },
    tools: [], allowedRoots: ['/'], agentVersion: 'test',
    access: { mode: 'on', effectiveMode: 'on', until: null, revertTo: null, clients: {} }
  };
}

test('routing is explicit: unknown, blank, offline, and revoked nodes fail and never fall back', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dex-reach-routing-'));
  try {
    const auth = new NodeAuthStore(dir);
    await auth.initialize();
    await auth.enroll('primary-mac');
    await auth.enroll('second-laptop');
    const registry = new NodeRegistry(auth, dir);
    await registry.initialize();
    const primary = new FakeSocket();
    const second = new FakeSocket();
    registry.registerForTest(hello('primary-mac'), primary as unknown as WebSocket);
    registry.registerForTest(hello('second-laptop'), second as unknown as WebSocket);
    assert.deepEqual(registry.listNodes().map(n => n.nodeId).sort(), ['primary-mac', 'second-laptop']);

    // Explicit routing reaches exactly the named node, carrying the actor identity.
    const pending = registry.request('second-laptop', 'dex.file.write', { path: '/x' }, { kind: 'chatgpt', clientId: 'c', clientName: 'ChatGPT' });
    assert.equal(second.sent.length, 1);
    assert.equal(primary.sent.length, 0);
    assert.equal(second.sent[0]!.actor?.kind, 'chatgpt');
    registry.deliverForTest({ type: 'response', id: second.sent[0]!.id, ok: true, result: 'done-on-second' });
    assert.equal(await pending, 'done-on-second');

    // Unknown / blank IDs fail without touching any socket.
    await assert.rejects(registry.request('second-laptp', 'dex.fingerprint', {}), /not enrolled or not online: second-laptp/);
    await assert.rejects(registry.request('', 'dex.fingerprint', {}), /node_id is required/);
    await assert.rejects(registry.request(undefined as unknown as string, 'dex.fingerprint', {}), /node_id is required/);
    assert.equal(primary.sent.length, 0);

    // Second node going offline does not redirect his work to Primary node.
    second.readyState = WebSocket.CLOSED;
    await assert.rejects(registry.request('second-laptop', 'dex.process.run', { command: 'pwd' }), /not online: second-laptop/);
    assert.equal(primary.sent.length, 0);

    // Revoking Second node disconnects only Second node; Primary node keeps working and Second node can no longer authenticate.
    const secondToken = await auth.rotate('second-laptop', 0);
    second.readyState = WebSocket.OPEN;
    assert.equal(await registry.revoke('second-laptop'), true);
    assert.equal(second.closed?.code, 4001);
    assert.equal(primary.closed, null);
    await assert.rejects(registry.request('second-laptop', 'dex.fingerprint', {}), /revoked: second-laptop/);
    assert.equal(await auth.authenticate('second-laptop', secondToken), false);
    const again = registry.request('primary-mac', 'dex.fingerprint', {});
    assert.equal(primary.sent.length, 1);
    registry.deliverForTest({ type: 'response', id: primary.sent[0]!.id, ok: true, result: 'primary-ok' });
    assert.equal(await again, 'primary-ok');

    // Trace metadata survives the gateway registry boundary while the legacy request() API
    // continues to return only the operation result.
    const traceId = '1'.repeat(32);
    const traced = registry.requestWithTrace(
      'primary-mac',
      'dex.fingerprint',
      {},
      { kind: 'chatgpt', clientId: 'trace', clientName: 'Trace test' },
      { traceparent: `00-${traceId}-2222222222222222-01` }
    );
    const tracedRequest = primary.sent.at(-1)!;
    assert.equal(tracedRequest.traceparent, `00-${traceId}-2222222222222222-01`);
    registry.deliverForTest({ type: 'response', id: tracedRequest.id, ok: true, result: 'primary-traced', traceId });
    assert.deepEqual(await traced, { result: 'primary-traced', traceId });

    // An out-of-process CLI revoke (credential store only) is enforced by the sweep, without touching Primary node.
    const carol = new FakeSocket();
    await auth.enroll('carol-pc');
    registry.registerForTest(hello('carol-pc'), carol as unknown as WebSocket);
    const cli = new NodeAuthStore(dir);
    await cli.initialize();
    await cli.revoke('carol-pc');
    assert.equal(await registry.sweepRevoked(), 1);
    assert.equal(carol.closed?.code, 4001);
    assert.equal(primary.closed, null);
    await assert.rejects(registry.request('carol-pc', 'dex.fingerprint', {}), /revoked: carol-pc/);
    registry.shutdown();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
