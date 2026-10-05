import os from 'node:os';
import path from 'node:path';
import { stateDir } from '../shared/local-env.js';

export type GatewayConfig = {
  host: string;
  port: number;
  publicBaseUrl: URL;
  legacyNodeToken?: string;
  legacyNodeId?: string;
  ownerUser: string;
  ownerPassword: string;
  stateDir: string;
};

export function loadGatewayConfig(env: NodeJS.ProcessEnv = process.env): GatewayConfig {
  const host = env.DEX_REACH_GATEWAY_HOST || '127.0.0.1';
  const port = Number(env.DEX_REACH_GATEWAY_PORT || 8787);
  let publicBaseUrl: URL;
  try { publicBaseUrl = new URL(env.DEX_REACH_PUBLIC_BASE_URL || `http://${host}:${port}`); }
  catch { throw new Error('DEX_REACH_PUBLIC_BASE_URL must be a valid HTTP(S) URL'); }
  if (!['http:', 'https:'].includes(publicBaseUrl.protocol)) throw new Error('DEX_REACH_PUBLIC_BASE_URL must use http:// or https://');
  const legacyNodeToken = env.DEX_REACH_NODE_TOKEN?.trim();
  const legacyNodeId = env.DEX_REACH_NODE_ID?.trim();
  const ownerUser = env.DEX_REACH_OWNER_USER?.trim() || os.userInfo().username;
  const ownerPassword = env.DEX_REACH_OWNER_PASSWORD?.trim();
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('invalid DEX_REACH_GATEWAY_PORT');
  if (legacyNodeToken && legacyNodeToken.length < 24) throw new Error('legacy DEX_REACH_NODE_TOKEN must contain at least 24 characters');
  if (!ownerPassword || ownerPassword.length < 16) throw new Error('DEX_REACH_OWNER_PASSWORD must contain at least 16 characters');
  const publicHost = publicBaseUrl.hostname.toLowerCase();
  const publicIsLoopback = ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(publicHost);
  if (!publicIsLoopback && publicBaseUrl.protocol !== 'https:') {
    throw new Error('non-local DEX_REACH_PUBLIC_BASE_URL must use https');
  }
  return {
    host,
    port,
    publicBaseUrl,
    legacyNodeToken,
    legacyNodeId,
    ownerUser,
    ownerPassword,
    stateDir: env.DEX_REACH_STATE_DIR ? path.resolve(env.DEX_REACH_STATE_DIR) : stateDir()
  };
}
