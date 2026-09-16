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
    await auth.enroll('andrew-mac');
    await auth.enroll('bryan-laptop');
    const registry = new NodeRegistry(auth, dir);
    await registry.initialize();
    const andrew = new FakeSocket();
    const bryan = new FakeSocket();
    registry.registerForTest(hello('andrew-mac'), andrew as unknown as WebSocket);
    registry.registerForTest(hello('bryan-laptop'), bryan as unknown as WebSocket);
    assert.deepEqual(registry.listNodes().map(n => n.nodeId).sort(), ['andrew-mac', 'bryan-laptop']);

    // Explicit routing reaches exactly the named node, carrying the actor identity.
    const pending = registry.request('bryan-laptop', 'dex.file.write', { path: '/x' }, { kind: 'chatgpt', clientId: 'c', clientName: 'ChatGPT' });
    assert.equal(bryan.sent.length, 1);
    assert.equal(andrew.sent.length, 0);
    assert.equal(bryan.sent[0]!.actor?.kind, 'chatgpt');
    registry.deliverForTest({ type: 'response', id: bryan.sent[0]!.id, ok: true, result: 'done-on-bryan' });
    assert.equal(await pending, 'done-on-bryan');

    // Unknown / blank IDs fail without touching any socket.
    await assert.rejects(registry.request('bryan-laptp', 'dex.fingerprint', {}), /not enrolled or not online: bryan-laptp/);
    await assert.rejects(registry.request('', 'dex.fingerprint', {}), /node_id is required/);
    await assert.rejects(registry.request(undefined as unknown as string, 'dex.fingerprint', {}), /node_id is required/);
    assert.equal(andrew.sent.length, 0);

    // Bryan going offline does not redirect his work to Andrew.
    bryan.readyState = WebSocket.CLOSED;
    await assert.rejects(registry.request('bryan-laptop', 'dex.process.run', { command: 'pwd' }), /not online: bryan-laptop/);
    assert.equal(andrew.sent.length, 0);

    // Revoking Bryan disconnects only Bryan; Andrew keeps working and Bryan can no longer authenticate.
    const bryanToken = await auth.rotate('bryan-laptop', 0);
    bryan.readyState = WebSocket.OPEN;
    assert.equal(await registry.revoke('bryan-laptop'), true);
    assert.equal(bryan.closed?.code, 4001);
    assert.equal(andrew.closed, null);
    await assert.rejects(registry.request('bryan-laptop', 'dex.fingerprint', {}), /revoked: bryan-laptop/);
    assert.equal(await auth.authenticate('bryan-laptop', bryanToken), false);
    const again = registry.request('andrew-mac', 'dex.fingerprint', {});
    assert.equal(andrew.sent.length, 1);
    registry.deliverForTest({ type: 'response', id: andrew.sent[0]!.id, ok: true, result: 'andrew-ok' });
    assert.equal(await again, 'andrew-ok');
    // An out-of-process CLI revoke (credential store only) is enforced by the sweep, without touching Andrew.
    const carol = new FakeSocket();
    await auth.enroll('carol-pc');
    registry.registerForTest(hello('carol-pc'), carol as unknown as WebSocket);
    const cli = new NodeAuthStore(dir);
    await cli.initialize();
    await cli.revoke('carol-pc');
    assert.equal(await registry.sweepRevoked(), 1);
    assert.equal(carol.closed?.code, 4001);
    assert.equal(andrew.closed, null);
    await assert.rejects(registry.request('carol-pc', 'dex.fingerprint', {}), /revoked: carol-pc/);
    registry.shutdown();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
