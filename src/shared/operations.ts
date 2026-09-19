import type { ReachCapability } from './capabilities.js';

/**
 * How much authority an operation can exercise, independent of who is asking. Risk is a property of
 * the operation itself; whether a caller may invoke it is decided by owner mode, client ceilings,
 * grants, roots and profile, which this module never evaluates.
 */
export type OperationRiskClass =
  | 'inspect'
  | 'typed-mutate'
  | 'shell'
  | 'network'
  | 'privileged'
  | 'destructive';

export type CheckpointStrategy = 'none' | 'git-if-available' | 'required';

export type OperationDescriptor = {
  operation: string;
  capability: ReachCapability;
  risk: OperationRiskClass;
  mutation: boolean;
  supportsPlan: boolean;
  /** Admitted by owner READ-ONLY mode. Admission is not execution: a shell operation admitted here
   *  still reaches the node's shell-free command grammar, which refuses anything that mutates. */
  readOnlyAllowed: boolean;
  /**
   * Admitted by the `workspace-safe` execution profile. For an operation whose real target is only
   * known later — a planned commit, or a compatibility call naming a tool — this flag is the ceiling
   * used when no target is known, exactly as `risk` is, and it is deliberately the refusing value.
   * Resolve the real answer with `effectiveWorkspaceSafe` or `compatibilityToolWorkspaceSafe`.
   */
  workspaceSafeAllowed: boolean;
  checkpointStrategy: CheckpointStrategy;
  /**
   * The operation replays an already-authorized plan rather than acting under its own authority, so
   * its real risk is the planned target's. `risk` above is only the ceiling used when no target is
   * known. Such an operation is capability-checked at plan time, not at commit time, which is why it
   * does not itself demand the capability its ceiling would otherwise imply.
   */
  riskInheritsFromTarget?: true;
  /**
   * The operation names a compatibility adapter tool, so workspace-safe admission is a property of
   * that tool rather than of the operation. The executor must resolve the exact tool before acting.
   */
  workspaceSafeResolvedPerTool?: true;
};

/** Deterministic requested authority, used by rolling execution budgets in a later phase. */
export type AuthorityCost = {
  operations: number;
  mutations: number;
  shellCalls: number;
  requestedWriteBytes: number;
  requestedProcessMs: number;
};

/**
 * The single source of truth for DEX operation authority metadata. Capability mapping, READ-ONLY
 * admission, plan eligibility and checkpoint strategy were previously restated in four modules;
 * every one of them now derives from this table.
 */
export const DEX_OPERATIONS: readonly OperationDescriptor[] = [
  { operation: 'dex.fingerprint', capability: 'inspect', risk: 'inspect', mutation: false, supportsPlan: false, readOnlyAllowed: true, workspaceSafeAllowed: true, checkpointStrategy: 'none' },
  { operation: 'dex.trustReport', capability: 'inspect', risk: 'inspect', mutation: false, supportsPlan: false, readOnlyAllowed: true, workspaceSafeAllowed: true, checkpointStrategy: 'none' },
  { operation: 'dex.repoInfo', capability: 'inspect', risk: 'inspect', mutation: false, supportsPlan: false, readOnlyAllowed: true, workspaceSafeAllowed: true, checkpointStrategy: 'none' },
  { operation: 'dex.adbDevices', capability: 'inspect', risk: 'inspect', mutation: false, supportsPlan: false, readOnlyAllowed: true, workspaceSafeAllowed: true, checkpointStrategy: 'none' },
  { operation: 'dex.file.read', capability: 'file.read', risk: 'inspect', mutation: false, supportsPlan: false, readOnlyAllowed: true, workspaceSafeAllowed: true, checkpointStrategy: 'none' },
  { operation: 'dex.result.read', capability: 'file.read', risk: 'inspect', mutation: false, supportsPlan: false, readOnlyAllowed: true, workspaceSafeAllowed: true, checkpointStrategy: 'none' },
  { operation: 'dex.receipts.list', capability: 'file.read', risk: 'inspect', mutation: false, supportsPlan: false, readOnlyAllowed: true, workspaceSafeAllowed: true, checkpointStrategy: 'none' },

  { operation: 'dex.file.write', capability: 'file.write', risk: 'typed-mutate', mutation: true, supportsPlan: true, readOnlyAllowed: false, workspaceSafeAllowed: true, checkpointStrategy: 'git-if-available' },
  { operation: 'dex.checkpoint', capability: 'checkpoint', risk: 'typed-mutate', mutation: true, supportsPlan: true, readOnlyAllowed: false, workspaceSafeAllowed: true, checkpointStrategy: 'none' },

  // Planning does not execute its target, but it may create a reversible checkpoint first, so it is
  // not pure inspection. It is refused under READ-ONLY exactly as a mutation would be.
  { operation: 'dex.plan', capability: 'inspect', risk: 'typed-mutate', mutation: false, supportsPlan: false, readOnlyAllowed: false, workspaceSafeAllowed: true, checkpointStrategy: 'git-if-available' },
  // Commit replays a plan that was authorized, capability-checked and checkpointed when it was
  // created. `shell` is the ceiling for an unknown target; effectiveRisk() resolves the real one.
  { operation: 'dex.commitPlan', capability: 'inspect', risk: 'shell', mutation: true, supportsPlan: false, readOnlyAllowed: false, workspaceSafeAllowed: false, checkpointStrategy: 'none', riskInheritsFromTarget: true },

  { operation: 'dex.process.run', capability: 'process.shell', risk: 'shell', mutation: true, supportsPlan: true, readOnlyAllowed: true, workspaceSafeAllowed: false, checkpointStrategy: 'git-if-available' },
  // A compatibility call's real risk depends on the exact tool; this is the ceiling for the
  // operation as a whole. Resolve the specific tool with compatibilityToolRisk().
  { operation: 'dc.call', capability: 'compat', risk: 'shell', mutation: true, supportsPlan: true, readOnlyAllowed: true, workspaceSafeAllowed: false, checkpointStrategy: 'git-if-available', workspaceSafeResolvedPerTool: true }
] as const;

/**
 * Owner actions the gateway performs directly. They never reach node-side authorization, so they are
 * deliberately not in the routed-operation catalog.
 */
export const GATEWAY_ONLY_OPERATIONS: readonly string[] = ['dex.revokeNode'];

const BY_OPERATION = new Map(DEX_OPERATIONS.map(descriptor => [descriptor.operation, descriptor]));

/** Look up a routed operation. Returns undefined for anything not in the catalog. */
export function describeOperation(operation: string): OperationDescriptor | undefined {
  return BY_OPERATION.get(operation);
}

/** Fail-closed lookup. Callers that must classify before acting use this one. */
export function requireOperation(operation: string): OperationDescriptor {
  const descriptor = describeOperation(operation);
  if (!descriptor) throw new Error(`unknown DEX operation "${operation}"; classification fails closed`);
  return descriptor;
}

export function isKnownOperation(operation: string): boolean {
  return BY_OPERATION.has(operation);
}

/**
 * Operations admitted by READ-ONLY as pure inspection. Their effective profile becomes `read-only`
 * and the node serves them directly.
 */
export function readOnlyInspectOperations(): string[] {
  return DEX_OPERATIONS.filter(d => d.readOnlyAllowed && d.risk === 'inspect').map(d => d.operation);
}

/**
 * Operations admitted by READ-ONLY whose safety is enforced further down, by the node's shell-free
 * command grammar and compatibility tool allowlist rather than by policy alone.
 */
export function readOnlyDelegatedOperations(): string[] {
  return DEX_OPERATIONS.filter(d => d.readOnlyAllowed && d.risk !== 'inspect').map(d => d.operation);
}

/**
 * Exact wire contract for `reach_plan`'s target enum. The order is part of the published MCP schema,
 * so it is stated explicitly here and a regression test holds it equal to the catalog's plannable set.
 */
export const PLAN_TARGET_OPERATIONS = ['dex.file.write', 'dex.process.run', 'dex.checkpoint', 'dc.call'] as const;

export function plannableOperations(): string[] {
  return DEX_OPERATIONS.filter(d => d.supportsPlan).map(d => d.operation);
}

export function checkpointStrategyFor(operation: string): CheckpointStrategy {
  return describeOperation(operation)?.checkpointStrategy ?? 'none';
}

/** An inheriting operation takes the effective risk of the target it was planned for. */
export function effectiveRisk(operation: string, plannedTarget?: string): OperationRiskClass {
  const descriptor = requireOperation(operation);
  if (!descriptor.riskInheritsFromTarget) return descriptor.risk;
  if (!plannedTarget) throw new Error(`${operation} risk requires the planned target operation`);
  return requireOperation(plannedTarget).risk;
}

/**
 * Operations the `workspace-safe` profile admits outright, with no target still to resolve. An
 * operation that resolves per plan target or per compatibility tool is deliberately absent: it is
 * neither admitted nor refused here, because the answer is not knowable from the operation alone.
 */
export function workspaceSafeOperations(): string[] {
  return DEX_OPERATIONS
    .filter(d => d.workspaceSafeAllowed && !d.riskInheritsFromTarget && !d.workspaceSafeResolvedPerTool)
    .map(d => d.operation);
}

/**
 * Whether `workspace-safe` admits this operation, resolving an inheriting operation against the
 * target it was planned for. Fails closed: an operation whose target is a compatibility tool cannot
 * be answered here, and an inheriting operation with no known target is an error rather than a pass.
 */
export function effectiveWorkspaceSafe(operation: string, plannedTarget?: string): boolean {
  const descriptor = requireOperation(operation);
  if (descriptor.workspaceSafeResolvedPerTool) {
    throw new Error(`${operation} workspace-safe admission is per compatibility tool; resolve the tool first`);
  }
  if (!descriptor.riskInheritsFromTarget) return descriptor.workspaceSafeAllowed;
  if (!plannedTarget) throw new Error(`${operation} workspace-safe admission requires the planned target operation`);
  return effectiveWorkspaceSafe(plannedTarget);
}

// ---------------------------------------------------------------------------
// Compatibility adapter tools
// ---------------------------------------------------------------------------

export type CompatibilityToolDescriptor = {
  tool: string;
  risk: OperationRiskClass;
  mutation: boolean;
  /** Withheld from remote clients entirely: safety configuration, local call history, vendor surfaces. */
  remoteBlocked: boolean;
  workspaceSafeAllowed: boolean;
};

/**
 * The pinned compatibility adapter's full local tool surface. Remote clients see only the entries
 * that are not `remoteBlocked`. Keeping the block list and the risk table in one place stops them
 * from drifting apart.
 */
export const COMPATIBILITY_TOOLS: readonly CompatibilityToolDescriptor[] = [
  { tool: 'get_config', risk: 'inspect', mutation: false, remoteBlocked: false, workspaceSafeAllowed: true },
  { tool: 'get_file_info', risk: 'inspect', mutation: false, remoteBlocked: false, workspaceSafeAllowed: true },
  { tool: 'get_usage_stats', risk: 'inspect', mutation: false, remoteBlocked: false, workspaceSafeAllowed: true },
  { tool: 'list_directory', risk: 'inspect', mutation: false, remoteBlocked: false, workspaceSafeAllowed: true },
  { tool: 'read_file', risk: 'inspect', mutation: false, remoteBlocked: false, workspaceSafeAllowed: true },
  { tool: 'read_multiple_files', risk: 'inspect', mutation: false, remoteBlocked: false, workspaceSafeAllowed: true },
  { tool: 'start_search', risk: 'inspect', mutation: false, remoteBlocked: false, workspaceSafeAllowed: true },
  { tool: 'get_more_search_results', risk: 'inspect', mutation: false, remoteBlocked: false, workspaceSafeAllowed: true },
  { tool: 'list_searches', risk: 'inspect', mutation: false, remoteBlocked: false, workspaceSafeAllowed: true },
  { tool: 'stop_search', risk: 'inspect', mutation: false, remoteBlocked: false, workspaceSafeAllowed: true },

  { tool: 'create_directory', risk: 'typed-mutate', mutation: true, remoteBlocked: false, workspaceSafeAllowed: true },
  { tool: 'move_file', risk: 'typed-mutate', mutation: true, remoteBlocked: false, workspaceSafeAllowed: true },
  { tool: 'write_file', risk: 'typed-mutate', mutation: true, remoteBlocked: false, workspaceSafeAllowed: true },
  { tool: 'write_pdf', risk: 'typed-mutate', mutation: true, remoteBlocked: false, workspaceSafeAllowed: true },
  { tool: 'edit_block', risk: 'typed-mutate', mutation: true, remoteBlocked: false, workspaceSafeAllowed: true },

  // Process and session tools are shell by another name, and stay outside workspace-safe.
  { tool: 'start_process', risk: 'shell', mutation: true, remoteBlocked: false, workspaceSafeAllowed: false },
  { tool: 'interact_with_process', risk: 'shell', mutation: true, remoteBlocked: false, workspaceSafeAllowed: false },
  { tool: 'read_process_output', risk: 'inspect', mutation: false, remoteBlocked: false, workspaceSafeAllowed: false },
  { tool: 'list_processes', risk: 'inspect', mutation: false, remoteBlocked: false, workspaceSafeAllowed: false },
  { tool: 'list_sessions', risk: 'inspect', mutation: false, remoteBlocked: false, workspaceSafeAllowed: false },
  { tool: 'force_terminate', risk: 'destructive', mutation: true, remoteBlocked: false, workspaceSafeAllowed: false },
  { tool: 'kill_process', risk: 'destructive', mutation: true, remoteBlocked: false, workspaceSafeAllowed: false },

  // Withheld from remote clients: safety configuration, local call history, and vendor surfaces.
  { tool: 'set_config_value', risk: 'privileged', mutation: true, remoteBlocked: true, workspaceSafeAllowed: false },
  { tool: 'get_recent_tool_calls', risk: 'privileged', mutation: false, remoteBlocked: true, workspaceSafeAllowed: false },
  { tool: 'give_feedback_to_desktop_commander', risk: 'network', mutation: false, remoteBlocked: true, workspaceSafeAllowed: false },
  { tool: 'get_prompts', risk: 'privileged', mutation: false, remoteBlocked: true, workspaceSafeAllowed: false }
] as const;

const BY_TOOL = new Map(COMPATIBILITY_TOOLS.map(descriptor => [descriptor.tool, descriptor]));

export function describeCompatibilityTool(tool: string): CompatibilityToolDescriptor | undefined {
  return BY_TOOL.get(tool);
}

/** Fail-closed: an unclassified compatibility tool cannot be reasoned about, so it is refused. */
export function requireCompatibilityTool(tool: string): CompatibilityToolDescriptor {
  const descriptor = describeCompatibilityTool(tool);
  if (!descriptor) throw new Error(`unknown compatibility tool "${tool}"; classification fails closed`);
  return descriptor;
}

export function compatibilityToolRisk(tool: string): OperationRiskClass {
  return requireCompatibilityTool(tool).risk;
}

export function remoteBlockedCompatibilityTools(): string[] {
  return COMPATIBILITY_TOOLS.filter(descriptor => descriptor.remoteBlocked).map(descriptor => descriptor.tool);
}

/** Whether `workspace-safe` admits this compatibility tool. Fails closed on an unclassified tool. */
export function compatibilityToolWorkspaceSafe(tool: string): boolean {
  return requireCompatibilityTool(tool).workspaceSafeAllowed;
}

export function workspaceSafeCompatibilityTools(): string[] {
  return COMPATIBILITY_TOOLS
    .filter(descriptor => descriptor.workspaceSafeAllowed && !descriptor.remoteBlocked)
    .map(descriptor => descriptor.tool);
}

export function remoteCompatibilityTools(): string[] {
  return COMPATIBILITY_TOOLS.filter(descriptor => !descriptor.remoteBlocked).map(descriptor => descriptor.tool);
}

// ---------------------------------------------------------------------------
// Requested authority cost
// ---------------------------------------------------------------------------

export const ZERO_AUTHORITY_COST: AuthorityCost = {
  operations: 0, mutations: 0, shellCalls: 0, requestedWriteBytes: 0, requestedProcessMs: 0
};

export type AuthorityCostContext = {
  /** For operations whose risk inherits from a plan target, the real operation being committed. */
  plannedTarget?: string;
  plannedArgs?: Record<string, unknown>;
};

function costFrom(mutation: boolean, risk: OperationRiskClass, args: Record<string, unknown>): AuthorityCost {
  const text = typeof args.text === 'string' ? args.text : '';
  const timeoutMs = Number(args.timeoutMs);
  return {
    operations: 1,
    mutations: mutation ? 1 : 0,
    shellCalls: risk === 'shell' ? 1 : 0,
    requestedWriteBytes: mutation && text ? Buffer.byteLength(text, 'utf8') : 0,
    requestedProcessMs: risk === 'shell' && Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.floor(timeoutMs) : 0
  };
}

/**
 * Deterministic cost of what a request *asks for*, computed from the request itself rather than from
 * what execution turns out to do. Budgets reserve against this, so the same request must always
 * cost the same. Indirect operations inherit their real target; they cannot launder a higher-risk
 * action through a cheaper wrapper classification.
 */
export function requestedAuthorityCost(
  operation: string,
  args: Record<string, unknown> = {},
  context: AuthorityCostContext = {}
): AuthorityCost {
  const descriptor = requireOperation(operation);
  if (descriptor.riskInheritsFromTarget) {
    if (!context.plannedTarget) return costFrom(descriptor.mutation, descriptor.risk, args);
    return requestedAuthorityCost(context.plannedTarget, context.plannedArgs ?? args);
  }
  if (descriptor.workspaceSafeResolvedPerTool) {
    const tool = typeof args.tool === 'string' ? args.tool : '';
    if (tool) {
      const toolDesc = requireCompatibilityTool(tool);
      return costFrom(toolDesc.mutation, toolDesc.risk, args);
    }
  }
  return costFrom(descriptor.mutation, descriptor.risk, args);
}

export function addAuthorityCost(a: AuthorityCost, b: AuthorityCost): AuthorityCost {
  return {
    operations: a.operations + b.operations,
    mutations: a.mutations + b.mutations,
    shellCalls: a.shellCalls + b.shellCalls,
    requestedWriteBytes: a.requestedWriteBytes + b.requestedWriteBytes,
    requestedProcessMs: a.requestedProcessMs + b.requestedProcessMs
  };
}
