import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { ToolDescriptor } from '../shared/protocol.js';
import { stateDir } from '../shared/local-env.js';

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
      env: { ...getDefaultEnvironment(), HOME: isolatedHome, USER: os.userInfo().username },
      stderr: 'pipe'
    });
    this.client = new Client({ name: 'dex-reach-node', version: '0.2.0' });
    await this.client.connect(this.transport);
    const listed = await this.client.listTools();
    this.tools = listed.tools.map(tool => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema
    }));
    await this.safeConfig('telemetryEnabled', false);
    if (allowedRoots.length) await this.safeConfig('allowedDirectories', allowedRoots);
  }

  listTools(): ToolDescriptor[] {
    return this.tools;
  }

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
    await this.client?.close();
    this.client = null;
    this.transport = null;
  }

  private async safeConfig(key: string, value: unknown): Promise<void> {
    try {
      await this.callTool('set_config_value', { key, value });
    } catch (error) {
      console.warn(`DEX//REACH could not set Desktop Commander ${key}:`, error);
    }
  }
}
