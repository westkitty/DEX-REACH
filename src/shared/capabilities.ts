import path from 'node:path';
import type { ClientKind } from './protocol.js';

export type ReachCapability =
  | 'inspect'
  | 'file.read'
  | 'file.write'
  | 'checkpoint'
  | 'process.shell'
  | 'compat';

export const REACH_CAPABILITIES: readonly ReachCapability[] = [
  'inspect', 'file.read', 'file.write', 'checkpoint', 'process.shell', 'compat'
];

export type CapabilityGrant = {
  id: string;
  client: ClientKind;
  capabilities: ReachCapability[];
  roots: string[];
  until: string;
  maxUses: number | null;
  uses: number;
  createdAt: string;
};

export function operationCapability(operation: string): ReachCapability {
  if (operation === 'dex.file.read' || operation === 'dex.result.read' || operation === 'dex.receipts.list') return 'file.read';
  if (operation === 'dex.file.write') return 'file.write';
  if (operation === 'dex.checkpoint') return 'checkpoint';
  if (operation === 'dex.process.run') return 'process.shell';
  if (operation === 'dc.call') return 'compat';
  return 'inspect';
}

export function requestPaths(args: Record<string, unknown>): string[] {
  const found: string[] = [];
  for (const [key, value] of Object.entries(args)) {
    if (typeof value === 'string' && /^(path|cwd|file|directory|destination|source)$/i.test(key) && path.isAbsolute(value)) found.push(path.resolve(value));
    if (value && typeof value === 'object' && !Array.isArray(value)) found.push(...requestPaths(value as Record<string, unknown>));
  }
  return found;
}

export function rootsCover(paths: string[], roots: string[]): boolean {
  if (!paths.length) return true;
  return paths.every(candidate => roots.some(root => {
    const base = path.resolve(root);
    return candidate === base || candidate.startsWith(base + path.sep);
  }));
}
