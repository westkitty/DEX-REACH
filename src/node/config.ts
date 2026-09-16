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
  if (!token || token.length < 24) throw new Error('DEX_REACH_NODE_TOKEN must contain at least 24 characters');
  const requestedProfile = (process.env.DEX_REACH_PROFILE || 'development') as ReachProfile;
  if (!profiles.includes(requestedProfile)) throw new Error(`invalid DEX_REACH_PROFILE: ${requestedProfile}`);
  const rawRoots = process.env.DEX_REACH_ALLOWED_ROOTS || os.homedir();
  const allowedRoots = rawRoots.split(path.delimiter).map(v => v.trim()).filter(Boolean).map(v => path.resolve(v));
  if (!allowedRoots.length) throw new Error('DEX_REACH_ALLOWED_ROOTS must contain at least one absolute filesystem root');
  const nodeId = cleanNodeId(process.env.DEX_REACH_NODE_ID || os.hostname());
  if (!nodeId) throw new Error('DEX_REACH_NODE_ID resolves to an empty node id');
  const gatewayWs = process.env.DEX_REACH_GATEWAY_WS || 'ws://127.0.0.1:8787/node';
  let gateway: URL;
  try { gateway = new URL(gatewayWs); } catch { throw new Error('DEX_REACH_GATEWAY_WS must be a valid ws:// or wss:// URL'); }
  if (!['ws:', 'wss:'].includes(gateway.protocol)) throw new Error('DEX_REACH_GATEWAY_WS must use ws:// or wss://');
  const gatewayHost = gateway.hostname.toLowerCase();
  const gatewayIsLoopback = ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(gatewayHost);
  if (!gatewayIsLoopback && gateway.protocol !== 'wss:') throw new Error('remote DEX_REACH_GATEWAY_WS must use wss://');
  return {
    nodeId,
    gatewayWs,
    token,
    profile: requestedProfile,
    allowedRoots
  };
}
