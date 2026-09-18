import type { AccessMode, AccessSnapshot } from './protocol.js';

export type FamiliarAttention = 'idle' | 'aware' | 'focused' | 'interrupted' | 'urgent';
export type FamiliarReaction =
  | 'neutral'
  | 'curious'
  | 'startled'
  | 'pleased'
  | 'irritated'
  | 'sleepy'
  | 'dizzy'
  | 'celebrate'
  | 'warning'
  | 'error';
export type FamiliarTrigger = 'pointer' | 'touch' | 'audio' | 'system' | 'agent' | 'timer' | 'world';

export type FamiliarSignal = {
  entityId: string;
  source: string;
  attention: FamiliarAttention;
  reaction?: FamiliarReaction;
  intensity: number;
  trigger: FamiliarTrigger;
  priority?: number;
  durationMs?: number;
  timestamp: number;
  sequence: number;
};

export function familiarForNode(input: {
  nodeId: string;
  online: boolean;
  access: AccessSnapshot | null;
  sequence?: number;
  now?: number;
}): FamiliarSignal {
  const now = input.now ?? Date.now();
  const sequence = input.sequence ?? 0;
  if (!input.online) {
    return {
      entityId: input.nodeId,
      source: 'dex-reach.node',
      attention: 'interrupted',
      reaction: 'error',
      intensity: 0.85,
      trigger: 'system',
      priority: 70,
      timestamp: now,
      sequence
    };
  }

  const mode: AccessMode | 'unknown' = input.access?.effectiveMode ?? 'unknown';
  if (mode === 'off') {
    return {
      entityId: input.nodeId,
      source: 'dex-reach.policy',
      attention: 'aware',
      reaction: 'warning',
      intensity: 0.55,
      trigger: 'system',
      priority: 45,
      timestamp: now,
      sequence
    };
  }
  if (mode === 'read-only') {
    return {
      entityId: input.nodeId,
      source: 'dex-reach.policy',
      attention: 'aware',
      reaction: 'curious',
      intensity: 0.4,
      trigger: 'system',
      priority: 25,
      timestamp: now,
      sequence
    };
  }
  if (mode === 'on') {
    return {
      entityId: input.nodeId,
      source: 'dex-reach.node',
      attention: 'focused',
      reaction: 'neutral',
      intensity: 0.5,
      trigger: 'system',
      priority: 20,
      timestamp: now,
      sequence
    };
  }

  return {
    entityId: input.nodeId,
    source: 'dex-reach.node',
    attention: 'aware',
    reaction: 'neutral',
    intensity: 0.25,
    trigger: 'system',
    priority: 10,
    timestamp: now,
    sequence
  };
}

export function familiarForOperation(input: {
  nodeId: string;
  phase: 'requesting' | 'awaiting-authorization' | 'success' | 'failure';
  sequence: number;
  now?: number;
}): FamiliarSignal {
  const now = input.now ?? Date.now();
  const base = {
    entityId: input.nodeId,
    source: 'dex-reach.operation',
    trigger: 'agent' as const,
    timestamp: now,
    sequence: input.sequence
  };
  switch (input.phase) {
    case 'requesting':
      return { ...base, attention: 'focused', reaction: 'neutral', intensity: 0.55, priority: 35, durationMs: 4000 };
    case 'awaiting-authorization':
      return { ...base, attention: 'urgent', reaction: 'warning', intensity: 0.8, priority: 65, durationMs: 8000 };
    case 'success':
      return { ...base, attention: 'aware', reaction: 'pleased', intensity: 0.5, priority: 40, durationMs: 1200 };
    case 'failure':
      return { ...base, attention: 'interrupted', reaction: 'error', intensity: 0.85, priority: 75, durationMs: 1800 };
  }
}
