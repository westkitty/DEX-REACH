import { stateDir } from '../src/shared/local-env.js';
import { readMacConfig } from './lib/macos-config.js';
import { waitInstallStatus, waitMacHealth } from './lib/macos-health.js';
import { arg } from './lib/node-files.js';

try {
  if (process.platform !== 'darwin') throw new Error('healthz:assert requires macOS launchd');
  const timeoutMs = Number(arg('--timeout-ms') || 60_000);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 6000 || timeoutMs > 300_000) throw new Error('--timeout-ms must be 6000..300000');
  const dir = stateDir();
  if (process.argv.includes('--wait-install')) await waitInstallStatus(dir);
  const { node, healthUrl } = await readMacConfig(dir, arg('--node-id'));
  const health = await waitMacHealth({ dir, healthUrl, gatewayWs: node.gatewayWs, nodeId: node.nodeId, profile: 'full-local', mode: 'on' }, timeoutMs);
  console.log(JSON.stringify(health));
} catch (error) {
  console.error((error as Error).message);
  process.exitCode = 1;
}
