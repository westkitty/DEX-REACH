import fs from 'node:fs/promises';
import path from 'node:path';
import { stateDir } from '../../src/shared/local-env.js';

/** Parses a KEY=VALUE env file. Values are returned as-is; callers must never print DEX_REACH_NODE_TOKEN. */
export async function readEnvFile(file: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const line of (await fs.readFile(file, 'utf8')).split(/\r?\n/)) {
    if (!line || line.startsWith('#') || !line.includes('=')) continue;
    const [key, ...rest] = line.split('=');
    if (key) out[key.trim()] = rest.join('=').trim();
  }
  return out;
}

export async function writeEnvFile(file: string, values: Record<string, string>): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const text = Object.entries(values).map(([k, v]) => `${k}=${v}`).join('\n') + '\n';
  const temp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temp, text, { mode: 0o600 });
  await fs.rename(temp, file);
}

export function nodesDir(dir = stateDir()): string {
  return path.join(dir, 'nodes');
}

export function nodeEnvFile(nodeId: string, dir = stateDir()): string {
  return path.join(nodesDir(dir), `${nodeId}.env`);
}

/** Node IDs that have a credential file locally. */
export async function localNodeIds(dir = stateDir()): Promise<string[]> {
  try {
    return (await fs.readdir(nodesDir(dir))).filter(name => name.endsWith('.env')).map(name => name.slice(0, -4)).sort();
  } catch {
    return [];
  }
}

export function cleanNodeId(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
}

export function arg(name: string, argv = process.argv): string | undefined {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

export function flag(name: string, argv = process.argv): boolean {
  return argv.includes(name);
}
