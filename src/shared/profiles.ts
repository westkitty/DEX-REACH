import type { AccessMode, ReachProfile } from './protocol.js';
import {
  compatibilityToolWorkspaceSafe,
  describeOperation,
  effectiveWorkspaceSafe,
  requireCompatibilityTool
} from './operations.js';

/**
 * Node execution profiles. A profile is a standing local constraint the machine owner configures on
 * the node itself; it is not an owner mode and it is not something a remote client can select.
 *
 * Owner modes remain exactly OFF / READ-ONLY / ON. `workspace-safe` is an execution profile that
 * narrows what ON can reach on this node. Adding it does not change any installed node: a node keeps
 * whatever `DEX_REACH_PROFILE` it was configured with, and the default is still `development`.
 */
export const REACH_PROFILES: readonly ReachProfile[] = [
  'read-only',
  'workspace-safe',
  'development',
  'repository-maintenance',
  'android-adb',
  'remote-server',
  'full-local'
];

export function isReachProfile(value: unknown): value is ReachProfile {
  return typeof value === 'string' && (REACH_PROFILES as string[]).includes(value);
}

/**
 * Whether the node's configured profile is the workspace-safe one.
 *
 * This is deliberately read from the node's own configuration rather than from the effective profile
 * an authorization decision produces. Owner mode and the profile are separate narrowings that must
 * compose by intersection: READ-ONLY replaces the effective profile with `read-only`, and if the
 * workspace-safe refusal were driven by that replacement instead, READ-ONLY would re-admit the very
 * operations the owner configured this node to refuse. A narrowing must never widen.
 */
export function isWorkspaceSafeNode(nodeProfile: ReachProfile): boolean {
  return nodeProfile === 'workspace-safe';
}

/**
 * Standing workspace-safe refusal for a routed operation, or null when the profile does not object.
 *
 * `null` is not authorization. It means only that this one constraint has nothing to say; owner
 * mode, client ceilings, grants, roots, plan rules and the executor's own guards all still apply.
 */
export function workspaceSafeOperationRefusal(
  nodeProfile: ReachProfile,
  operation: string,
  plannedTarget?: string
): string | null {
  if (!isWorkspaceSafeNode(nodeProfile)) return null;
  const descriptor = describeOperation(operation);
  // An operation outside the catalog cannot be reasoned about, so the strictest profile refuses it
  // rather than letting it through to be classified somewhere further down.
  if (!descriptor) return `workspace-safe profile refuses the unclassified operation ${operation}`;
  if (descriptor.workspaceSafeResolvedPerTool) return null;
  // An inheriting operation whose target is itself resolved per compatibility tool cannot be decided
  // from the operation pair alone. The executor resolves the exact tool with workspaceSafeToolRefusal
  // before the call runs, so this constraint defers rather than guessing in either direction.
  if (descriptor.riskInheritsFromTarget && plannedTarget && describeOperation(plannedTarget)?.workspaceSafeResolvedPerTool) {
    return null;
  }
  if (effectiveWorkspaceSafe(operation, plannedTarget)) return null;
  return descriptor.riskInheritsFromTarget
    ? `workspace-safe profile does not permit committing a plan for ${plannedTarget}`
    : `workspace-safe profile does not permit ${operation}; it allows typed project work, not arbitrary execution`;
}

/** Standing workspace-safe refusal for a compatibility adapter tool, or null when it is admitted. */
export function workspaceSafeToolRefusal(nodeProfile: ReachProfile, tool: string): string | null {
  if (!isWorkspaceSafeNode(nodeProfile)) return null;
  // Fail closed: requireCompatibilityTool throws on anything undeclared, and an undeclared adapter
  // tool is exactly what this profile exists to refuse.
  const descriptor = requireCompatibilityTool(tool);
  if (compatibilityToolWorkspaceSafe(descriptor.tool)) return null;
  return `workspace-safe profile does not permit compatibility tool ${tool}`;
}

/**
 * Human-readable description of what a profile permits, for the owner CLI and the trust report.
 * Descriptions state limits rather than advertising capability.
 */
export function describeProfile(profile: ReachProfile): string {
  switch (profile) {
    case 'read-only':
      return 'READ-ONLY (shell-free recognized inspection commands only)';
    case 'workspace-safe':
      return 'workspace-safe (inspection, reads, typed writes, checkpoints and declared-safe compatibility tools; no arbitrary shell)';
    case 'full-local':
      return 'full-local (arbitrary local shell within allowed roots; not an OS-level sandbox)';
    default:
      return profile;
  }
}

/**
 * The owner modes, restated here only so callers can describe the two axes together. Profiles never
 * add a mode and never substitute for one.
 */
export const OWNER_MODES: readonly AccessMode[] = ['off', 'read-only', 'on'];
