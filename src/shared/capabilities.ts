import type { ClientKind } from './protocol.js';
import { extractPaths, pathAllowed } from './security.js';

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

/** All path-bearing request arguments, including plural compatibility-tool arrays. */
export function requestPaths(args: Record<string, unknown>): string[] {
  return extractPaths(args);
}

/** Grant roots are a second narrowing boundary and therefore receive the same canonical/symlink checks. */
export function rootsCover(paths: string[], roots: string[]): boolean {
  if (!paths.length) return true;
  return paths.every(candidate => pathAllowed(candidate, roots));
}
