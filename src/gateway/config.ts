import os from 'node:os';
import path from 'node:path';

export type GatewayConfig = {
  host: string;
  port: number;
  publicBaseUrl: URL;
  nodeToken: string;
  ownerUser: string;
  ownerPassword: string;
  stateDir: string;
};

export function loadGatewayConfig(): GatewayConfig {
  const host = process.env.DEX_REACH_GATEWAY_HOST || '127.0.0.1';
  const port = Number(process.env.DEX_REACH_GATEWAY_PORT || 8787);
  const publicBaseUrl = new URL(process.env.DEX_REACH_PUBLIC_BASE_URL || `http://${host}:${port}`);
  const nodeToken = process.env.DEX_REACH_NODE_TOKEN?.trim();
  const ownerUser = process.env.DEX_REACH_OWNER_USER?.trim() || os.userInfo().username;
  const ownerPassword = process.env.DEX_REACH_OWNER_PASSWORD?.trim();
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('invalid DEX_REACH_GATEWAY_PORT');
  if (!nodeToken || nodeToken.length < 24) throw new Error('DEX_REACH_NODE_TOKEN must contain at least 24 characters');
  if (!ownerPassword || ownerPassword.length < 16) throw new Error('DEX_REACH_OWNER_PASSWORD must contain at least 16 characters');
  if (host !== '127.0.0.1' && host !== 'localhost' && publicBaseUrl.protocol !== 'https:') {
    throw new Error('non-local DEX//REACH gateway requires an https DEX_REACH_PUBLIC_BASE_URL');
  }
  return {
    host,
    port,
    publicBaseUrl,
    nodeToken,
    ownerUser,
    ownerPassword,
    stateDir: path.join(os.homedir(), '.dex-reach')
  };
}
