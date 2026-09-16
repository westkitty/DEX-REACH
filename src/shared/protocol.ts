export const REACH_PROTOCOL_VERSION = 1;

export type ReachProfile =
  | 'read-only'
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

export type NodeHello = {
  type: 'hello';
  protocolVersion: number;
  nodeId: string;
  profile: ReachProfile;
  fingerprint: ExecutionFingerprint;
  tools: ToolDescriptor[];
  allowedRoots: string[];
  agentVersion: string;
  access?: AccessSnapshot;
};

/** Pushed by a node whenever its local access policy changes. */
export type NodeStatus = { type: 'status'; access: AccessSnapshot };

export type GatewayRequest = {
  type: 'request';
  id: string;
  operation: string;
  args: Record<string, unknown>;
  actor?: RequestActor;
};

export type GatewayResponse = {
  type: 'response';
  id: string;
  ok: boolean;
  result?: unknown;
  error?: string;
};

export type Heartbeat = { type: 'heartbeat'; at: number };
export type WireMessage = NodeHello | NodeStatus | GatewayRequest | GatewayResponse | Heartbeat;
