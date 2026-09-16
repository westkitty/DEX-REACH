import os from 'node:os';
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

export function loadGatewayConfig(): GatewayConfig {
  const host = process.env.DEX_REACH_GATEWAY_HOST || '127.0.0.1';
  const port = Number(process.env.DEX_REACH_GATEWAY_PORT || 8787);
  const publicBaseUrl = new URL(process.env.DEX_REACH_PUBLIC_BASE_URL || `http://${host}:${port}`);
  const legacyNodeToken = process.env.DEX_REACH_NODE_TOKEN?.trim();
  const legacyNodeId = process.env.DEX_REACH_NODE_ID?.trim();
  const ownerUser = process.env.DEX_REACH_OWNER_USER?.trim() || os.userInfo().username;
  const ownerPassword = process.env.DEX_REACH_OWNER_PASSWORD?.trim();
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
    stateDir: stateDir()
  };
}
