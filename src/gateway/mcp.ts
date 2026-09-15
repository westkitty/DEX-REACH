import * as z from 'zod/v4';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { NodeRegistry } from './registry.js';
import type { AuditLog } from '../shared/audit.js';

function text(value: unknown) {
  return { content: [{ type: 'text' as const, text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }] };
}

export function createReachMcpServer(registry: NodeRegistry, audit: AuditLog, clientId = 'unknown'): McpServer {
  const server = new McpServer({ name: 'DEX//REACH', version: '0.2.0' });

  const routed = async (nodeId: string, operation: string, args: Record<string, unknown>) => {
    const started = Date.now();
    try {
      const result = await registry.request(nodeId, operation, args);
      await audit.append({ at: new Date().toISOString(), nodeId, client: clientId, operation, ok: true, durationMs: Date.now() - started, args });
      return text(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await audit.append({ at: new Date().toISOString(), nodeId, client: clientId, operation, ok: false, durationMs: Date.now() - started, args, error: message });
      throw error;
    }
  };

  server.registerTool('reach_list_nodes', {
    description: 'List DEX//REACH nodes, identity fingerprints, profiles, scope, connectivity, and capability counts.',
    inputSchema: {}
  }, async () => text(registry.listNodes()));

  server.registerTool('reach_list_tools', {
    description: 'List the local compatibility tools exposed by one online node.',
    inputSchema: { node_id: z.string().min(1) }
  }, async ({ node_id }) => text(registry.listTools(node_id)));

  server.registerTool('reach_call', {
    description: 'Call any advertised local node tool by exact name. Use reach_list_tools first when the schema is unknown.',
    inputSchema: {
      node_id: z.string().min(1),
      tool: z.string().min(1),
      arguments: z.record(z.string(), z.unknown()).default({})
    }
  }, async ({ node_id, tool, arguments: args }) => routed(node_id, 'dc.call', { tool, arguments: args }));

  server.registerTool('reach_fingerprint', {
    description: 'Return a fresh machine, user, repository, branch, remote, and runtime execution fingerprint.',
    inputSchema: { node_id: z.string().min(1), cwd: z.string().optional() }
  }, async ({ node_id, cwd }) => routed(node_id, 'dex.fingerprint', cwd ? { cwd } : {}));

  server.registerTool('reach_repo_info', {
    description: 'Inspect Git root, branch, remotes, status, and recent commits without mutating the repository.',
    inputSchema: { node_id: z.string().min(1), cwd: z.string().optional() }
  }, async ({ node_id, cwd }) => routed(node_id, 'dex.repoInfo', cwd ? { cwd } : {}));

  server.registerTool('reach_adb_devices', {
    description: 'List Android ADB devices visible to the selected node.',
    inputSchema: { node_id: z.string().min(1) }
  }, async ({ node_id }) => routed(node_id, 'dex.adbDevices', {}));

  server.registerTool('reach_checkpoint', {
    description: 'Capture a reversible Git worktree checkpoint without modifying repository history.',
    inputSchema: { node_id: z.string().min(1), cwd: z.string().optional() }
  }, async ({ node_id, cwd }) => routed(node_id, 'dex.checkpoint', cwd ? { cwd } : {}));

  server.registerTool('reach_file_read', {
    description: 'Read a bounded UTF-8 text file through the DEX-native executor without the compatibility adapter.',
    inputSchema: { node_id: z.string().min(1), path: z.string().min(1), max_bytes: z.number().int().positive().max(1048576).default(1048576) }
  }, async ({ node_id, path, max_bytes }) => routed(node_id, 'dex.file.read', { path, maxBytes: max_bytes }));

  server.registerTool('reach_file_write', {
    description: 'Write or append bounded UTF-8 text through the DEX-native executor.',
    inputSchema: { node_id: z.string().min(1), path: z.string().min(1), text: z.string(), mode: z.enum(['rewrite', 'append']).default('rewrite') }
  }, async ({ node_id, path, text: value, mode }) => routed(node_id, 'dex.file.write', { path, text: value, mode }));

  server.registerTool('reach_process_run', {
    description: 'Run a bounded shell command through the DEX-native executor with REACH Guard and scope enforcement.',
    inputSchema: { node_id: z.string().min(1), command: z.string().min(1), cwd: z.string().optional(), timeout_ms: z.number().int().positive().max(60000).default(15000) }
  }, async ({ node_id, command, cwd, timeout_ms }) => routed(node_id, 'dex.process.run', { command, ...(cwd ? { cwd } : {}), timeoutMs: timeout_ms }));

  server.registerTool('reach_result_read', {
    description: 'Read the next bounded segment of a large result using a continuation handle.',
    inputSchema: {
      node_id: z.string().min(1),
      handle: z.string().uuid(),
      offset: z.number().int().nonnegative().default(0),
      length: z.number().int().positive().max(262144).default(65536)
    }
  }, async ({ node_id, handle, offset, length }) => routed(node_id, 'dex.result.read', { handle, offset, length }));

  server.registerTool('reach_revoke_node', {
    description: 'Revoke and disconnect a node. Confirmation must exactly equal the node_id.',
    inputSchema: { node_id: z.string().min(1), confirm_node_id: z.string().min(1) }
  }, async ({ node_id, confirm_node_id }) => {
    if (node_id !== confirm_node_id) throw new Error('node revocation confirmation mismatch');
    const wasOnline = await registry.revoke(node_id);
    await audit.append({ at: new Date().toISOString(), nodeId: node_id, client: clientId, operation: 'dex.revokeNode', ok: true, args: { nodeId: node_id } });
    return text({ revoked: true, wasOnline });
  });

  return server;
}
