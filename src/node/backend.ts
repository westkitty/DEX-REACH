import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { ToolDescriptor } from '../shared/protocol.js';
import { stateDir } from '../shared/local-env.js';
import { DEX_REACH_VERSION } from '../shared/version.js';

const SENSITIVE_ENV_KEY = /(^DEX_REACH_(?:NODE_TOKEN|OWNER_PASSWORD|ENV_FILE)$|TOKEN|PASSWORD|PASSWD|SECRET|AUTHORIZATION|COOKIE|API[_-]?KEY|PRIVATE[_-]?KEY|CREDENTIAL)/i;

function compatibilityEnvironment(home: string): Record<string, string> {
  const base = getDefaultEnvironment();
  const safe = Object.fromEntries(Object.entries(base).filter(([key]) => !SENSITIVE_ENV_KEY.test(key)));
  return { ...safe, HOME: home, USER: os.userInfo().username };
}

function findConfig(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object') return null;
  const object = value as Record<string, unknown>;
  if (object.config && typeof object.config === 'object') return object.config as Record<string, unknown>;
  if ('telemetryEnabled' in object && 'allowedDirectories' in object) return object;
  if (Array.isArray(object.content)) {
    for (const item of object.content) {
      if (item && typeof item === 'object' && typeof (item as { text?: unknown }).text === 'string') {
        try {
          const parsed = JSON.parse((item as { text: string }).text) as unknown;
          const found = findConfig(parsed);
          if (found) return found;
        } catch {}
      }
    }
  }
  for (const child of Object.values(object)) {
    const found = findConfig(child);
    if (found) return found;
  }
  return null;
}

const REMOTE_BLOCKED_TOOLS = new Set(['set_config_value', 'get_recent_tool_calls', 'give_feedback_to_desktop_commander', 'get_prompts']);

export class DesktopCommanderBackend {
  private client: Client | null = null;
  private transport: StdioClientTransport | null = null;
  private tools: ToolDescriptor[] = [];

  async start(allowedRoots: string[]): Promise<void> {
    const require = createRequire(import.meta.url);
    const packageRoot = path.dirname(require.resolve('@wonderwhy-er/desktop-commander/package.json'));
    const entry = path.join(packageRoot, 'dist/index.js');
    const isolatedHome = path.join(stateDir(), 'compat-home');
    await fs.mkdir(isolatedHome, { recursive: true, mode: 0o700 });
    this.transport = new StdioClientTransport({
      command: process.execPath,
      args: [entry, '--no-onboarding'],
      env: compatibilityEnvironment(isolatedHome),
      stderr: 'pipe'
    });
    this.client = new Client({ name: 'dex-reach-node', version: DEX_REACH_VERSION });
    await this.client.connect(this.transport);
    const listed = await this.client.listTools();
    this.tools = listed.tools
      .filter(tool => !REMOTE_BLOCKED_TOOLS.has(tool.name))
      .map(tool => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema
      }));

    // These are security boundaries, not optional polish. If the compatibility backend cannot accept
    // or report them, the node must fail to start instead of silently running with wider access.
    await this.callTool('set_config_value', { key: 'telemetryEnabled', value: false });
    await this.callTool('set_config_value', { key: 'allowedDirectories', value: allowedRoots });
    const configResult = await this.callTool('get_config', {});
    const config = findConfig(configResult);
    if (!config) throw new Error('compatibility backend did not return a verifiable configuration');
    if (config.telemetryEnabled !== false) throw new Error('compatibility backend telemetry could not be disabled');
    const configuredRoots = Array.isArray(config.allowedDirectories) ? config.allowedDirectories.map(String) : [];
    if (configuredRoots.length !== allowedRoots.length || !allowedRoots.every(root => configuredRoots.includes(root))) {
      throw new Error(`compatibility backend allowedDirectories mismatch: expected ${JSON.stringify(allowedRoots)} got ${JSON.stringify(configuredRoots)}`);
    }
  }

  listTools(): ToolDescriptor[] { return this.tools; }

  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    if (!this.client) throw new Error('Desktop Commander backend is not started');
    const result = await this.client.callTool({ name, arguments: args });
    if (result.isError) {
      const message = Array.isArray(result.content)
        ? result.content.map(item => 'text' in item ? item.text : JSON.stringify(item)).join(' ')
        : JSON.stringify(result);
      throw new Error(`compatibility backend ${name} failed: ${message}`);
    }
    return result;
  }

  async close(): Promise<void> {
    const client = this.client;
    this.client = null;
    this.transport = null;
    if (!client) return;
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        client.close().catch(() => undefined),
        new Promise<void>(resolve => { timer = setTimeout(resolve, 1500); timer.unref(); })
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
