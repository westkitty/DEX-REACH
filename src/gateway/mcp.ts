import * as z from 'zod/v4';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { NodeRegistry } from './registry.js';
import type { AuditLog } from '../shared/audit.js';

const NODE_ID_HINT = 'Target node ID exactly as returned by reach_list_nodes (for example "macbook-air.local"). Never guess; each node is a different machine.';

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const MUTATE = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false } as const;

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
    title: 'List DEX Nodes',
    description: 'List every enrolled DEX//REACH node (machine) with its node ID, online state, identity fingerprint, execution profile, allowed filesystem roots, and capability counts. Call this first and pick the node_id explicitly before any other DEX//REACH action.',
    inputSchema: {},
    annotations: READ
  }, async () => text(registry.listNodes()));

  server.registerTool('reach_list_tools', {
    title: 'List Node Compatibility Tools',
    description: 'List the local compatibility-adapter tools (names and schemas) exposed by one online node, for use with reach_call.',
    inputSchema: { node_id: z.string().min(1).describe(NODE_ID_HINT) },
    annotations: READ
  }, async ({ node_id }) => text(registry.listTools(node_id)));

  server.registerTool('reach_call', {
    title: 'Call Node Compatibility Tool',
    description: 'Invoke one compatibility-adapter tool on the selected node by exact name with a JSON arguments object. May read or mutate the machine depending on the tool; prefer the dedicated reach_* actions when one exists. Use reach_list_tools first when the schema is unknown.',
    inputSchema: {
      node_id: z.string().min(1).describe(NODE_ID_HINT),
      tool: z.string().min(1).describe('Exact tool name from reach_list_tools.'),
      arguments: z.record(z.string(), z.unknown()).default({}).describe('Arguments object matching that tool\'s input schema.')
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }
  }, async ({ node_id, tool, arguments: args }) => routed(node_id, 'dc.call', { tool, arguments: args }));

  server.registerTool('reach_fingerprint', {
    title: 'Get Execution Fingerprint',
    description: 'Return a fresh execution identity for the selected node: hostname, platform, architecture, user, home, working directory, Git repository root/branch/remote, and runtime versions. Use it to prove which physical machine will run commands.',
    inputSchema: { node_id: z.string().min(1).describe(NODE_ID_HINT), cwd: z.string().optional().describe('Optional directory to fingerprint instead of the node default.') },
    annotations: READ
  }, async ({ node_id, cwd }) => routed(node_id, 'dex.fingerprint', cwd ? { cwd } : {}));

  server.registerTool('reach_repo_info', {
    title: 'Inspect Git Repository',
    description: 'Inspect a Git repository on the selected node: root, branch, remotes, working-tree status, and recent commits. Read-only; never mutates the repository.',
    inputSchema: { node_id: z.string().min(1).describe(NODE_ID_HINT), cwd: z.string().optional().describe('Directory inside the repository; defaults to the node working directory.') },
    annotations: READ
  }, async ({ node_id, cwd }) => routed(node_id, 'dex.repoInfo', cwd ? { cwd } : {}));

  server.registerTool('reach_adb_devices', {
    title: 'List Android ADB Devices',
    description: 'List Android devices visible to the selected node over ADB (USB or network discovery). Read-only.',
    inputSchema: { node_id: z.string().min(1).describe(NODE_ID_HINT) },
    annotations: READ
  }, async ({ node_id }) => routed(node_id, 'dex.adbDevices', {}));

  server.registerTool('reach_checkpoint', {
    title: 'Create Git Checkpoint',
    description: 'Capture a reversible snapshot (patch of tracked and untracked changes) of a Git worktree on the selected node into DEX-managed checkpoint storage. Does not modify repository history or the working tree.',
    inputSchema: { node_id: z.string().min(1).describe(NODE_ID_HINT), cwd: z.string().optional().describe('Directory inside the repository; defaults to the node working directory.') },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
  }, async ({ node_id, cwd }) => routed(node_id, 'dex.checkpoint', cwd ? { cwd } : {}));

  server.registerTool('reach_file_read', {
    title: 'Read File',
    description: 'Read a UTF-8 text file (bounded size) from the selected node. The path must be inside that node\'s allowed roots. Read-only.',
    inputSchema: {
      node_id: z.string().min(1).describe(NODE_ID_HINT),
      path: z.string().min(1).describe('Absolute file path on the node.'),
      max_bytes: z.number().int().positive().max(1048576).default(1048576).describe('Maximum bytes to return (default and cap 1 MiB).')
    },
    annotations: READ
  }, async ({ node_id, path, max_bytes }) => routed(node_id, 'dex.file.read', { path, maxBytes: max_bytes }));

  server.registerTool('reach_file_write', {
    title: 'Write File',
    description: 'Write (overwrite) or append UTF-8 text to a file on the selected node. The path must be inside that node\'s allowed roots. Mutates the filesystem; "rewrite" replaces existing content.',
    inputSchema: {
      node_id: z.string().min(1).describe(NODE_ID_HINT),
      path: z.string().min(1).describe('Absolute file path on the node.'),
      text: z.string().describe('UTF-8 text to write.'),
      mode: z.enum(['rewrite', 'append']).default('rewrite').describe('"rewrite" replaces the file; "append" adds to the end.')
    },
    annotations: MUTATE
  }, async ({ node_id, path, text: value, mode }) => routed(node_id, 'dex.file.write', { path, text: value, mode }));

  server.registerTool('reach_process_run', {
    title: 'Run Shell Command',
    description: 'Run a bounded, time-limited shell command on the selected node and return stdout, stderr, and exit code. Guarded by REACH Guard (blocked destructive patterns) and the node\'s allowed roots. Mutating: the command may change the machine.',
    inputSchema: {
      node_id: z.string().min(1).describe(NODE_ID_HINT),
      command: z.string().min(1).describe('Shell command line to execute.'),
      cwd: z.string().optional().describe('Working directory inside the node\'s allowed roots; defaults to the node working directory.'),
      timeout_ms: z.number().int().positive().max(60000).default(15000).describe('Timeout in milliseconds (max 60000).')
    },
    annotations: MUTATE
  }, async ({ node_id, command, cwd, timeout_ms }) => routed(node_id, 'dex.process.run', { command, ...(cwd ? { cwd } : {}), timeoutMs: timeout_ms }));

  server.registerTool('reach_result_read', {
    title: 'Read Large Result Segment',
    description: 'Read the next segment of a large result that was truncated, using the continuation handle returned by the original action. Read-only.',
    inputSchema: {
      node_id: z.string().min(1).describe(NODE_ID_HINT),
      handle: z.string().uuid().describe('Continuation handle from a truncated result.'),
      offset: z.number().int().nonnegative().default(0).describe('Byte offset to start from.'),
      length: z.number().int().positive().max(262144).default(65536).describe('Bytes to return (max 262144).')
    },
    annotations: READ
  }, async ({ node_id, handle, offset, length }) => routed(node_id, 'dex.result.read', { handle, offset, length }));

  server.registerTool('reach_revoke_node', {
    title: 'Revoke Node',
    description: 'Permanently revoke a node\'s credential and disconnect it from the gateway. Irreversible without re-enrollment; confirm_node_id must exactly equal node_id.',
    inputSchema: { node_id: z.string().min(1).describe(NODE_ID_HINT), confirm_node_id: z.string().min(1).describe('Must exactly repeat node_id as confirmation.') },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false }
  }, async ({ node_id, confirm_node_id }) => {
    if (node_id !== confirm_node_id) throw new Error('node revocation confirmation mismatch');
    const wasOnline = await registry.revoke(node_id);
    await audit.append({ at: new Date().toISOString(), nodeId: node_id, client: clientId, operation: 'dex.revokeNode', ok: true, args: { nodeId: node_id } });
    return text({ revoked: true, wasOnline });
  });

  return server;
}
