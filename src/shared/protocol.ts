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

export type NodeHello = {
  type: 'hello';
  protocolVersion: number;
  nodeId: string;
  profile: ReachProfile;
  fingerprint: ExecutionFingerprint;
  tools: ToolDescriptor[];
  allowedRoots: string[];
  agentVersion: string;
};
export type GatewayRequest = {
  type: 'request';
  id: string;
  operation: string;
  args: Record<string, unknown>;
};

export type GatewayResponse = {
  type: 'response';
  id: string;
  ok: boolean;
  result?: unknown;
  error?: string;
};

export type Heartbeat = { type: 'heartbeat'; at: number };
export type WireMessage = NodeHello | GatewayRequest | GatewayResponse | Heartbeat;
