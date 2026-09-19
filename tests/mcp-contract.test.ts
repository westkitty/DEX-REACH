import test from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { Client } from '@modelcontextprotocol/client';
import { createReachMcpServer } from '../src/gateway/mcp.js';
import type { AuditLog } from '../src/shared/audit.js';
import type { NodeRegistry } from '../src/shared/../gateway/registry.js';
import { DEX_REACH_VERSION } from '../src/shared/version.js';

/**
 * The published MCP surface is a contract with every already-connected client. These tests list the
 * tools through a real MCP client over an in-memory transport, so they prove what is served rather
 * than what the source file happens to say.
 */
async function connectedClient(): Promise<{ client: Client; close: () => Promise<void> }> {
  // Tool handlers are never invoked here; only the advertised surface is read.
  const registry = { request: async () => ({}), listNodes: () => [] } as unknown as NodeRegistry;
  const audit = { append: async () => undefined } as unknown as AuditLog;

  const server = createReachMcpServer(registry, audit, 'contract-test', { kind: 'smoke', clientId: 'contract-test', clientName: 'DEX contract test' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'dex-contract-test', version: DEX_REACH_VERSION });

  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return {
    client,
    close: async () => {
      await client.close().catch(() => undefined);
      await server.close().catch(() => undefined);
    }
  };
}

const EXPECTED_TOOLS = [
  'reach_list_nodes', 'reach_list_tools', 'reach_call', 'reach_fingerprint', 'reach_trust_report',
  'reach_repo_info', 'reach_adb_devices', 'reach_checkpoint', 'reach_file_read', 'reach_file_write',
  'reach_process_run', 'reach_plan', 'reach_commit_plan', 'reach_receipts', 'reach_result_read', 'reach_revoke_node'
];

test('the served MCP surface is exactly the 16 expected actions, in a deterministic order', async () => {
  const { client, close } = await connectedClient();
  try {
    const first = await client.listTools();
    assert.deepEqual(first.tools.map(tool => tool.name), EXPECTED_TOOLS);
    assert.equal(first.tools.length, 16);

    // A second server instance must advertise the same surface in the same order: registration is
    // deterministic and free of order-dependent side effects.
    const second = await connectedClient();
    try {
      const again = await second.client.listTools();
      assert.deepEqual(again.tools.map(tool => tool.name), first.tools.map(tool => tool.name));
    } finally {
      await second.close();
    }
  } finally {
    await close();
  }
});

test('every served tool carries a description and annotations', async () => {
  const { client, close } = await connectedClient();
  try {
    const { tools } = await client.listTools();
    for (const tool of tools) {
      assert.ok(tool.description && tool.description.length > 20, `${tool.name} has no usable description`);
      assert.ok(tool.annotations, `${tool.name} has no annotations`);
      assert.equal(typeof tool.annotations?.readOnlyHint, 'boolean', `${tool.name} does not declare readOnlyHint`);
      assert.ok(tool.inputSchema, `${tool.name} has no input schema`);
    }
  } finally {
    await close();
  }
});

test('mutating actions are annotated as mutating and inspections as read-only', async () => {
  const { client, close } = await connectedClient();
  try {
    const byName = new Map((await client.listTools()).tools.map(tool => [tool.name, tool]));
    for (const name of ['reach_fingerprint', 'reach_trust_report', 'reach_repo_info', 'reach_adb_devices', 'reach_file_read', 'reach_receipts', 'reach_result_read', 'reach_list_nodes', 'reach_list_tools']) {
      assert.equal(byName.get(name)?.annotations?.readOnlyHint, true, `${name} should be annotated read-only`);
    }
    for (const name of ['reach_file_write', 'reach_process_run', 'reach_checkpoint', 'reach_commit_plan', 'reach_revoke_node']) {
      assert.equal(byName.get(name)?.annotations?.readOnlyHint, false, `${name} should be annotated as mutating`);
    }
  } finally {
    await close();
  }
});

test('node-targeted actions require an explicit node_id and reach_plan keeps its target enum', async () => {
  const { client, close } = await connectedClient();
  try {
    const byName = new Map((await client.listTools()).tools.map(tool => [tool.name, tool]));

    // Explicit machine selection is a published schema property, not only a runtime check.
    for (const name of EXPECTED_TOOLS.filter(tool => tool !== 'reach_list_nodes')) {
      const schema = byName.get(name)!.inputSchema as unknown as { properties?: Record<string, unknown>; required?: string[] };
      assert.ok(schema.properties?.node_id, `${name} does not accept node_id`);
      assert.ok(schema.required?.includes('node_id'), `${name} does not require node_id`);
    }

    const plan = byName.get('reach_plan')!.inputSchema as unknown as { properties: { operation: { enum?: string[] } } };
    assert.deepEqual(plan.properties.operation.enum, ['dex.file.write', 'dex.process.run', 'dex.checkpoint', 'dc.call']);

    const write = byName.get('reach_file_write')!.inputSchema as unknown as { required?: string[] };
    assert.ok(write.required?.includes('path'));
    assert.ok(write.required?.includes('text'));
  } finally {
    await close();
  }
});

test('the server reports the DEX version it was built from', async () => {
  const { client, close } = await connectedClient();
  try {
    const info = client.getServerVersion();
    assert.equal(info?.name, 'DEX//REACH');
    assert.equal(info?.version, DEX_REACH_VERSION);
  } finally {
    await close();
  }
});
