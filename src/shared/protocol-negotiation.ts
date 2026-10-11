import {
  REACH_DURABLE_TASK_CAPABILITY,
  REACH_PROTOCOL_V1,
  REACH_PROTOCOL_V2,
  REACH_TASK_EVENT_STREAM_CAPABILITY,
  REACH_TWO_PHASE_PLAN_CAPABILITY,
  type NodeHello,
  type ReachCapability,
  type ReachProtocolVersion
} from './protocol.js';

export const CURRENT_GATEWAY_PROTOCOLS: readonly ReachProtocolVersion[] = [REACH_PROTOCOL_V2, REACH_PROTOCOL_V1];
export const CURRENT_GATEWAY_CAPABILITIES: readonly ReachCapability[] = [
  REACH_DURABLE_TASK_CAPABILITY,
  REACH_TASK_EVENT_STREAM_CAPABILITY,
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
  if (hello.protocolVersion !== 1) throw new Error('INCOMPATIBLE_PROTOCOL_VERSION: invalid legacy transport version');
  const known = [REACH_PROTOCOL_V1, REACH_PROTOCOL_V2];
  if (hello.protocolVersionSemantic !== undefined && !known.includes(hello.protocolVersionSemantic)) throw new Error('INCOMPATIBLE_PROTOCOL_VERSION: invalid semantic version');
  if (hello.supportedProtocols !== undefined) {
    if (!Array.isArray(hello.supportedProtocols) || !hello.supportedProtocols.length
      || hello.supportedProtocols.some(v => !known.includes(v))
      || unique(hello.supportedProtocols).length !== hello.supportedProtocols.length
      || (hello.protocolVersionSemantic !== undefined && hello.supportedProtocols[0] !== hello.protocolVersionSemantic)) {
      throw new Error('INCOMPATIBLE_PROTOCOL_VERSION: invalid protocol offer');
    }
    return [...hello.supportedProtocols];
  }
  if (hello.protocolVersionSemantic === REACH_PROTOCOL_V2) throw new Error('INCOMPATIBLE_PROTOCOL_VERSION: v2 requires explicit supported protocols');
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

/** One acknowledgement per connection; a historical gateway may instead send a v1 request. */
export class NodeNegotiation {
  private phase: 'waiting' | 'admitted' | 'closed' = 'waiting';
  negotiated: NegotiatedProtocol = { version: REACH_PROTOCOL_V1, capabilities: [] };
  constructor(private readonly offer: NodeHello) {}
  acknowledge(value: unknown): NegotiatedProtocol {
    if (this.phase !== 'waiting' || !value || typeof value !== 'object') throw new Error('unexpected acknowledgement');
    const ack = value as { type?: unknown; protocolVersion?: unknown; capabilities?: unknown };
    if (ack.type !== 'hello_ack' || !advertisedProtocols(this.offer).includes(ack.protocolVersion as ReachProtocolVersion)
      || !Array.isArray(ack.capabilities) || ack.capabilities.length > 4
      || new Set(ack.capabilities).size !== ack.capabilities.length
      || ack.capabilities.some(c => typeof c !== 'string' || this.offer.capabilities?.[c as ReachCapability] !== true)
      || (ack.protocolVersion === REACH_PROTOCOL_V1 && ack.capabilities.length)) throw new Error('invalid acknowledgement');
    this.phase = 'admitted';
    this.negotiated = { version: ack.protocolVersion as ReachProtocolVersion, capabilities: ack.capabilities as ReachCapability[] };
    return this.negotiated;
  }
  request(): NegotiatedProtocol {
    if (this.phase === 'closed') throw new Error('connection closed');
    // An old gateway never acknowledges. Its first request seals v1 admission; late acks refuse.
    this.phase = 'admitted';
    return this.negotiated;
  }
  close(): void { this.phase = 'closed'; }
}
