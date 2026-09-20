import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/client/stdio';
import type { ToolDescriptor } from '../../shared/protocol.js';
import { stateDir } from '../../shared/local-env.js';
import { DEX_REACH_VERSION } from '../../shared/version.js';
import {
  type AdapterAdmission,
  type AdapterManifest,
  AdapterRegistry,
  decodeAdapterManifest
} from '../../shared/adapter-contract.js';
import { DESKTOP_COMMANDER_MANIFEST_DATA } from './desktop-commander.manifest.js';
import { finishProcessActivityByPid, startProcessActivity, touchProcessActivityByPid } from '../../shared/activity.js';

/**
 * The Desktop Commander capability adapter.
 *
 * The manifest beside this file is the adapter's declaration, read as data through the same
 * fail-closed decoder any third-party manifest would take. It is deliberately not built from DEX's
 * own catalog: if it were, checking it against that catalog would prove nothing. Identity fields
 * (version, source hash) are filled in from what DEX observes on disk at load time rather than from
 * what the manifest claims, because an adapter stating its own identity is not evidence of it.
 */

const SENSITIVE_ENV_KEY = /(^DEX_REACH_(?:NODE_TOKEN|OWNER_PASSWORD|ENV_FILE)$|TOKEN|PASSWORD|PASSWD|SECRET|AUTHORIZATION|COOKIE|API[_-]?KEY|PRIVATE[_-]?KEY|CREDENTIAL)/i;

function compatibilityEnvironment(home: string): Record<string, string> {
  const base = getDefaultEnvironment();
  const safe = Object.fromEntries(Object.entries(base).filter(([key]) => !SENSITIVE_ENV_KEY.test(key)));
  return { ...safe, HOME: home, USER: os.userInfo().username };
}

function activityText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(activityText).join(' ');
  if (!value || typeof value !== 'object') return '';
  return Object.values(value as Record<string, unknown>).map(activityText).join(' ');
}

function activityPid(value: unknown): number | null {
  const match = /\bPID\s+(\d+)\b/i.exec(activityText(value));
  if (!match) return null;
  const pid = Number.parseInt(match[1]!, 10);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
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

export type ResolvedAdapterSource = { root: string; entry: string; version: string; sourceHash: string | null };

/** Where the adapter actually is, and what it actually hashes to, independent of its own claims. */
export async function resolveDesktopCommanderSource(): Promise<ResolvedAdapterSource> {
  const require = createRequire(import.meta.url);
  const root = path.dirname(require.resolve('@wonderwhy-er/desktop-commander/package.json'));
  const entry = path.join(root, 'dist/index.js');
  const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8')) as { version?: unknown };
  const version = typeof pkg.version === 'string' && pkg.version ? pkg.version : 'unknown';
  let sourceHash: string | null = null;
  try {
    sourceHash = crypto.createHash('sha256').update(await fs.readFile(entry)).digest('hex');
  } catch {
    // A missing or unreadable entry point leaves the hash null rather than inventing one. The
    // manifest still installs; identity evidence simply records that the hash is unavailable.
    sourceHash = null;
  }
  return { root, entry, version, sourceHash };
}

/** Read the adapter's declared manifest and stamp it with the identity DEX observed. */
export function loadDesktopCommanderManifest(source: ResolvedAdapterSource): AdapterManifest {
  const declared = decodeAdapterManifest(DESKTOP_COMMANDER_MANIFEST_DATA);
  if (!declared) throw new Error('desktop-commander manifest is malformed or incomplete; adapter installation fails closed');
  return { ...declared, version: source.version, source: '@wonderwhy-er/desktop-commander', sourceHash: source.sourceHash };
}

export class DesktopCommanderAdapter {
  private client: Client | null = null;
  private transport: StdioClientTransport | null = null;
  private tools: ToolDescriptor[] = [];
  private admission: AdapterAdmission | null = null;

  constructor(private readonly registry: AdapterRegistry) {}

  async start(allowedRoots: string[]): Promise<void> {
    const source = await resolveDesktopCommanderSource();
    // Install before the process starts. A manifest DEX cannot corroborate must stop the node from
    // coming up at all, rather than leaving a running adapter whose surface nobody agreed on.
    this.admission = this.registry.install(loadDesktopCommanderManifest(source));

    const isolatedHome = path.join(stateDir(), 'compat-home');
    await fs.mkdir(isolatedHome, { recursive: true, mode: 0o700 });
    this.transport = new StdioClientTransport({
      command: process.execPath,
      args: [source.entry, '--no-onboarding'],
      env: compatibilityEnvironment(isolatedHome),
      stderr: 'pipe'
    });
    this.client = new Client({ name: 'dex-reach-node', version: DEX_REACH_VERSION });
    await this.client.connect(this.transport);

    const listed = await this.client.listTools();
    const remoteSurface = new Set(this.registry.remoteToolSurface());
    // The running adapter's own tool list is filtered by the registry, not trusted as the surface.
    // A tool the adapter offers that DEX did not admit is simply not there as far as clients are
    // concerned, so an adapter update that adds a tool cannot widen the surface by itself.
    this.tools = listed.tools
      .filter(tool => remoteSurface.has(tool.name))
      .map(tool => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema }));

    const offered = new Set(listed.tools.map(tool => tool.name));
    const missing = [...remoteSurface].filter(name => !offered.has(name));
    if (missing.length) {
      throw new Error(`compatibility adapter does not offer admitted tools: ${missing.join(', ')}`);
    }

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

  manifest(): AdapterManifest | null { return this.admission?.manifest ?? null; }

  /**
   * Call an adapter tool.
   *
   * `set_config_value` and `get_config` are reached from `start()` above, which is node-local owner
   * setup rather than a remote request, so this method does not itself apply the remote surface
   * filter. Remote requests are refused before they reach here, by the executor's registry check.
   */
  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    if (!this.client) throw new Error('Desktop Commander adapter is not started');
    const result = await this.client.callTool({ name, arguments: args });
    if (result.isError) {
      const message = Array.isArray(result.content)
        ? result.content.map(item => 'text' in item ? item.text : JSON.stringify(item)).join(' ')
        : JSON.stringify(result);
      throw new Error(`compatibility backend ${name} failed: ${message}`);
    }

    // Process visibility is evidence, not authority. Activity bookkeeping is deliberately best-effort:
    // a local activity-store problem must never change whether an already-authorized adapter call runs.
    try {
      if (name === 'start_process') {
        const pid = activityPid(result);
        if (pid) {
          await startProcessActivity({
            kind: 'compat-process',
            pid,
            operation: 'compat.start_process',
            command: typeof args.command === 'string' ? args.command : 'process'
          });
        }
      } else if ((name === 'read_process_output' || name === 'interact_with_process') && typeof args.pid === 'number') {
        await touchProcessActivityByPid(args.pid);
      } else if ((name === 'force_terminate' || name === 'kill_process') && typeof args.pid === 'number') {
        await finishProcessActivityByPid(args.pid, 'terminated');
      }
    } catch {
      // The operation result remains authoritative; owner-visible activity is secondary evidence.
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
