import type { ClientKind } from './protocol.js';
import { extractPaths, pathAllowed } from './security.js';
import { describeCompatibilityTool, describeOperation } from './operations.js';

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

/**
 * Every capability a request must hold, not just the one its operation names.
 *
 * `dc.call` names `compat`, but the call it wraps does whatever the named adapter tool does. Reading
 * only the wrapper's capability meant a grant holding `compat` alone could write files and start
 * processes through the adapter without ever holding `file.write` or `process.shell` — the wrapper
 * laundered the capability the same way an unresolved risk class would launder risk. A routed call
 * now demands both: the wrapper's capability and the tool's own.
 *
 * Fails closed on a call that names no tool or a tool DEX does not classify: it demands every
 * capability, which no grant holds, so such a call can never match one.
 */
export function requiredCapabilities(operation: string, args: Record<string, unknown> = {}): ReachCapability[] {
  const base = operationCapability(operation);
  const descriptor = describeOperation(operation);
  if (!descriptor?.workspaceSafeResolvedPerTool) return [base];
  const tool = typeof args.tool === 'string' ? args.tool : '';
  const known = describeCompatibilityTool(tool);
  if (!known) return [...REACH_CAPABILITIES];
  return base === known.capability ? [base] : [base, known.capability];
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
