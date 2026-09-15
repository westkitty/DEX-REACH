import os from 'node:os';
import path from 'node:path';
import type { ReachProfile } from '../shared/protocol.js';

const profiles: ReachProfile[] = [
  'read-only', 'development', 'repository-maintenance',
  'android-adb', 'remote-server', 'full-local'
];

function cleanNodeId(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
}

export type NodeConfig = {
  nodeId: string;
  gatewayWs: string;
  token: string;
  profile: ReachProfile;
  allowedRoots: string[];
};

export function loadNodeConfig(): NodeConfig {
  const token = process.env.DEX_REACH_NODE_TOKEN?.trim();
  if (!token) throw new Error('DEX_REACH_NODE_TOKEN is required');
  const requestedProfile = (process.env.DEX_REACH_PROFILE || 'development') as ReachProfile;
  if (!profiles.includes(requestedProfile)) throw new Error(`invalid DEX_REACH_PROFILE: ${requestedProfile}`);
  const rawRoots = process.env.DEX_REACH_ALLOWED_ROOTS || os.homedir();
  const allowedRoots = rawRoots.split(path.delimiter).map(v => path.resolve(v.trim())).filter(Boolean);
  return {
    nodeId: cleanNodeId(process.env.DEX_REACH_NODE_ID || os.hostname()),
    gatewayWs: process.env.DEX_REACH_GATEWAY_WS || 'ws://127.0.0.1:8787/node',
    token,
    profile: requestedProfile,
    allowedRoots
  };
}
