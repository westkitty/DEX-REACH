import type { ClientKind } from './protocol.js';
import { extractPaths, pathAllowed } from './security.js';
import { describeOperation } from './operations.js';

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

/**
 * Capability required by an operation, read from the central operation catalog.
 *
 * An operation outside the catalog resolves to `inspect`, the narrowest capability, which is what
 * this function has always done. That is deliberately not a way in: an unknown operation is refused
 * by the node executor before it can do anything, and grant matching against `inspect` cannot widen
 * authority. Callers that must classify before acting use `requireOperation` instead, which throws.
 */
export function operationCapability(operation: string): ReachCapability {
  return describeOperation(operation)?.capability ?? 'inspect';
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
