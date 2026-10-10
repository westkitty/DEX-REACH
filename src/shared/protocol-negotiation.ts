import {
  REACH_DURABLE_TASK_CAPABILITY,
  REACH_PROTOCOL_V1,
  REACH_PROTOCOL_V2,
  REACH_TASK_EVENT_STREAM_CAPABILITY,
  REACH_TASK_RECONCILIATION_CAPABILITY,
  REACH_TWO_PHASE_PLAN_CAPABILITY,
  type NodeHello,
  type ReachCapability,
  type ReachProtocolVersion
} from './protocol.js';

export const CURRENT_GATEWAY_PROTOCOLS: readonly ReachProtocolVersion[] = [REACH_PROTOCOL_V2, REACH_PROTOCOL_V1];
export const CURRENT_GATEWAY_CAPABILITIES: readonly ReachCapability[] = [
  REACH_DURABLE_TASK_CAPABILITY,
  REACH_TASK_EVENT_STREAM_CAPABILITY,
  REACH_TASK_RECONCILIATION_CAPABILITY,
  REACH_TWO_PHASE_PLAN_CAPABILITY
];

export type NegotiatedProtocol = {
  version: ReachProtocolVersion;
  capabilities: ReachCapability[];
};

export type ProtocolNegotiationOptions = {
  gatewayProtocols?: readonly ReachProtocolVersion[];
  gatewayCapabilities?: readonly ReachCapability[];
};

function unique<T>(values: readonly T[]): T[] { return [...new Set(values)]; }

export function advertisedProtocols(hello: Pick<NodeHello, 'protocolVersion' | 'protocolVersionSemantic' | 'supportedProtocols'>): ReachProtocolVersion[] {
  if (hello.supportedProtocols?.length) return unique(hello.supportedProtocols);
  if (hello.protocolVersionSemantic) return [hello.protocolVersionSemantic, REACH_PROTOCOL_V1];
  return [REACH_PROTOCOL_V1];
}

export function negotiateProtocol(hello: Pick<NodeHello, 'protocolVersion' | 'protocolVersionSemantic' | 'supportedProtocols' | 'capabilities'>, options: ProtocolNegotiationOptions = {}): NegotiatedProtocol {
  const gatewayProtocols = options.gatewayProtocols ?? CURRENT_GATEWAY_PROTOCOLS;
  const gatewayCapabilities = options.gatewayCapabilities ?? CURRENT_GATEWAY_CAPABILITIES;
  const nodeProtocols = advertisedProtocols(hello);
  const version = gatewayProtocols.find(candidate => nodeProtocols.includes(candidate));
  if (!version) throw new Error('INCOMPATIBLE_PROTOCOL_VERSION: no common REACH semantic protocol version');

  const capabilityMap: Record<ReachCapability, keyof NonNullable<NodeHello['capabilities']>> = {
    durable_tasks: 'durable_tasks',
    task_event_stream: 'task_event_stream',
    task_reconciliation: 'task_reconciliation',
    two_phase_plan: 'two_phase_plan'
  };
  const capabilities = gatewayCapabilities.filter(capability => version === REACH_PROTOCOL_V2 && hello.capabilities?.[capabilityMap[capability]] === true);
  return { version, capabilities: unique(capabilities) };
}

export function supportsNegotiatedCapability(negotiated: NegotiatedProtocol, capability: ReachCapability): boolean {
  return negotiated.version === REACH_PROTOCOL_V2 && negotiated.capabilities.includes(capability);
}

export function durableCapabilityRefusal(nodeId: string, negotiated: NegotiatedProtocol): Error {
  return new Error(`CAPABILITY_UNSUPPORTED_ON_NODE: node ${nodeId} negotiated ${negotiated.version}; durable_tasks is unavailable; no durable-task handle was created`);
}
