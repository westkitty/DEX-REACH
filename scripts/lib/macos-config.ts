import os from 'node:os';
import path from 'node:path';
import { loadGatewayConfig } from '../../src/gateway/config.js';
import { loadNodeConfig } from '../../src/node/config.js';
import { stateDir } from '../../src/shared/local-env.js';
import { cleanNodeId, readEnvFile } from './node-files.js';

/** Use the same parser/validators as startup, without inheriting another node's credentials. */
export async function readMacConfig(dir = stateDir(), selectedNodeId?: string) {
  const ownerFile = path.join(dir, 'secrets.env');
  const read = async (file: string) => {
    try { return await readEnvFile(file); }
    catch { throw new Error(`cannot read configuration file: ${file}`); }
  };
  const ownerEnv = await read(ownerFile);
  let gateway;
  try { gateway = loadGatewayConfig({ ...ownerEnv, DEX_REACH_STATE_DIR: dir }); }
  catch (error) { throw new Error(`${ownerFile}: ${(error as Error).message}`); }
  const nodeId = cleanNodeId(selectedNodeId || ownerEnv.DEX_REACH_NODE_ID || os.hostname());
  if (!nodeId) throw new Error('DEX_REACH_NODE_ID resolves to an empty node id');
  const nodeFile = path.join(dir, 'nodes', `${nodeId}.env`);
  const nodeEnv = await read(nodeFile);
  let node;
  try { node = loadNodeConfig(nodeEnv); }
  catch (error) { throw new Error(`${nodeFile}: ${(error as Error).message}`); }
  if (node.nodeId !== nodeId) throw new Error(`${nodeFile}: DEX_REACH_NODE_ID does not match the selected node`);
  const ws = new URL(node.gatewayWs);
  if (!['127.0.0.1', 'localhost', '::1', '[::1]'].includes(ws.hostname) ||
      Number(ws.port || (ws.protocol === 'wss:' ? 443 : 80)) !== gateway.port || ws.pathname !== '/node') {
    throw new Error(`${nodeFile}: DEX_REACH_GATEWAY_WS must point to this Mac gateway port and /node path`);
  }
  return { gateway, node, ownerFile, nodeFile, healthUrl: `http://127.0.0.1:${gateway.port}/healthz` };
}
