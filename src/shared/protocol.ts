export const REACH_PROTOCOL_VERSION = 1;
export const REACH_PROTOCOL_V1 = '1.0' as const;
export const REACH_PROTOCOL_V2 = '2.0' as const;
export const REACH_DURABLE_TASK_CAPABILITY = 'durable_tasks' as const;
export const REACH_TASK_EVENT_STREAM_CAPABILITY = 'task_event_stream' as const;
export const REACH_TASK_RECONCILIATION_CAPABILITY = 'task_reconciliation' as const;
export const REACH_TWO_PHASE_PLAN_CAPABILITY = 'two_phase_plan' as const;

export type ReachProtocolVersion = typeof REACH_PROTOCOL_V1 | typeof REACH_PROTOCOL_V2;
export type ReachCapability =
  | typeof REACH_DURABLE_TASK_CAPABILITY
  | typeof REACH_TASK_EVENT_STREAM_CAPABILITY
  | typeof REACH_TASK_RECONCILIATION_CAPABILITY
  | typeof REACH_TWO_PHASE_PLAN_CAPABILITY;

export type ReachProfile =
  | 'read-only'
  // Typed project work without arbitrary shell: inspection, reads, typed writes, checkpoints and the
  // declared-safe compatibility tools. It is an execution profile, not a fourth owner mode.
  | 'workspace-safe'
  | 'development'
  | 'repository-maintenance'
  | 'android-adb'
  | 'remote-server'
  | 'full-local';

export type ExecutionFingerprint = {
  nodeId: string;
  hostname: string;
  platform: string;
  arch: string;
  user: string;
  home: string;
  cwd: string;
  repositoryRoot: string | null;
  branch: string | null;
  remote: string | null;
  nodeVersion: string;
  pythonVersion: string | null;
};

export type ToolDescriptor = {
  name: string;
  description?: string;
  inputSchema?: unknown;
};

/** Node-local AI access mode. `off` < `read-only` < `on`. The node enforces it; the gateway only displays it. */
export type AccessMode = 'off' | 'read-only' | 'on';

/** Which kind of AI client asked, derived on the gateway from the OAuth client registration (never from a token). */
export type ClientKind = 'chatgpt' | 'claude' | 'smoke' | 'other';

/** Non-secret identity of the requesting AI client. Contains no tokens, cookies, or credentials. */
export type RequestActor = {
  kind: ClientKind;
  clientId: string;
  clientName: string;
};

/** What a node currently advertises about its local access policy (safe to show to any AI client). */
export type AccessSnapshot = {
  mode: AccessMode;
  effectiveMode: AccessMode;
  until: string | null;
  revertTo: AccessMode | null;
  clients: Partial<Record<ClientKind, AccessMode>>;
};

export type SchedulerEventSnapshot = {
  cursor: number;
  at: string;
  event: string;
  id?: string;
  executor?: string;
  access?: string;
  workload?: string;
  reason?: string;
  forced?: boolean;
  observedUncoordinatedHeavy?: number;
  dexServices?: number;
};

export type SchedulerBundleTotals = {
  cpuUnits: number;
  memoryMiB: number;
  highIo: number;
  heavyNetwork: number;
  repositoryWrites: number;
  machineExclusive: number;
};

/** Privacy-safe local scheduler data displayed to browser clients; no paths, PIDs or command text. */
export type SchedulerSnapshot = {
  substantiveSlots: number;
  heavySlots: number;
  activeLeases: number;
  queueDepth: number;
  queueLatencyMs: { oldest: number; p50: number; p95: number };
  activeBundleTotals?: SchedulerBundleTotals;
  queuedBundleTotals?: SchedulerBundleTotals;
  eventCursor?: number;
  eventWindowStartCursor?: number;
  events?: SchedulerEventSnapshot[];
  observationCache?: { hits: number; misses: number; hitRate: number; sampledAt?: string | null; ageMs?: number | null };
  observedUncoordinatedHeavy: number;
  degraded: boolean;
};

export type NodeHello = {
  type: 'hello';
  protocolVersion: number;
  /** Additive semantic version marker. The integer above remains for v1 transport-auth compatibility. */
  protocolVersionSemantic?: ReachProtocolVersion;
  /** Ordered by preference; omission is the historical v1 hello shape. */
  supportedProtocols?: ReachProtocolVersion[];
  nodeId: string;
  profile: ReachProfile;
  fingerprint: ExecutionFingerprint;
  tools: ToolDescriptor[];
  allowedRoots: string[];
  agentVersion: string;
  /** Optional feature metadata. Omitted by legacy v1 nodes, never inferred by the gateway. */
  capabilities?: {
    durable_tasks?: boolean;
    task_event_stream?: boolean;
    task_reconciliation?: boolean;
    two_phase_plan?: boolean;
  };
  access?: AccessSnapshot;
  scheduler?: SchedulerSnapshot;
};

/** Pushed by a node whenever its local access policy changes. */
export type NodeStatus = { type: 'status'; access: AccessSnapshot; scheduler?: SchedulerSnapshot };

export type ProtocolHelloAck = {
  type: 'hello_ack';
  protocolVersion: ReachProtocolVersion;
  capabilities: ReachCapability[];
};

/** Content-free asynchronous progress frame; task payloads and results never cross this frame. */
export type TaskProgressEvent = {
  type: 'task_event';
  taskId: string;
  kind: 'accepted' | 'progress' | 'completed' | 'failed';
  state: string;
  summary: string;
  at: string;
};

export type GatewayRequest = {
  type: 'request';
  id: string;
  operation: string;
  args: Record<string, unknown>;
  actor?: RequestActor;
  /** W3C trace context, validated by the node. An invalid value is ignored, never repaired. */
  traceparent?: string;
  tracestate?: string;
  /** Internal lifecycle control. It is not part of the compatibility-adapter tool surface. */
  task?: DurableTaskRequest;
};

export type DurableTaskRequest =
  | { action: 'start'; operation: string; args: Record<string, unknown>; ttlMs?: number }
  | { action: 'get' | 'result' | 'cancel'; taskId: string };

export type GatewayResponse = {
  type: 'response';
  id: string;
  ok: boolean;
  result?: unknown;
  error?: string;
  /** The trace the node recorded this exchange under, so the owner can follow it with `dex trace`. */
  traceId?: string;
};

export type Heartbeat = { type: 'heartbeat'; at: number };
export type WireMessage = NodeHello | ProtocolHelloAck | TaskProgressEvent | NodeStatus | GatewayRequest | GatewayResponse | Heartbeat;
