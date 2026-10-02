import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readRuntimeStatus, type RuntimeStatus } from '../../src/node/runtime-status.js';
import type { AccessMode, ReachProfile } from '../../src/shared/protocol.js';
import { verifyRuntimeRelease } from './runtime-release.js';

const execFileAsync = promisify(execFile);
export type ServiceHealth = { running: boolean; pid?: number; runs?: number; lastExit?: number; root?: string };
export type MacHealth = {
  ok: boolean;
  reason: string;
  gateway: ServiceHealth;
  node: ServiceHealth;
  onlineNodes: number | null;
  aiMode: string | null;
  profile: string | null;
};
export type HealthExpectation = { nodeId: string; dir: string; healthUrl: string; gatewayWs: string; profile: ReachProfile; mode: AccessMode };

export function parseServiceHealth(text: string): ServiceHealth {
  const number = (key: string) => {
    const match = text.match(new RegExp(`^\\s*${key} = (\\d+)\\s*$`, 'm'));
    return match ? Number(match[1]) : undefined;
  };
  return {
    running: /^\s*state = running\s*$/m.test(text),
    pid: number('pid'), runs: number('runs'), lastExit: number('last exit code'),
    root: text.match(/^\s*working directory = (.+)$/m)?.[1]?.trim()
  };
}

/** A fresh file alone cannot prove its writer is alive or connected to this gateway. */
export function assessMacHealth(
  gateway: ServiceHealth, node: ServiceHealth, runtime: RuntimeStatus | null,
  body: { ok?: unknown; onlineNodes?: unknown } | null,
  expected: Pick<HealthExpectation, 'profile' | 'mode' | 'gatewayWs'>,
  now = Date.now()
): MacHealth {
  const result: MacHealth = {
    ok: false, reason: '', gateway, node,
    onlineNodes: typeof body?.onlineNodes === 'number' ? body.onlineNodes : null,
    aiMode: runtime?.access?.effectiveMode ?? null, profile: runtime?.profile ?? null
  };
  const gatewayOrigin = new URL(expected.gatewayWs);
  if (!gateway.running || !gateway.pid) result.reason = node.running ? 'gateway down / node waiting' : 'gateway and node down';
  else if (!node.running || !node.pid) result.reason = 'gateway up / node down';
  else if (gateway.lastExit === 78 || node.lastExit === 78) result.reason = 'EX_CONFIG (78) since last reload; validate configuration and reinstall';
  else if (!runtime || !Number.isFinite(Date.parse(runtime.updatedAt)) || now - Date.parse(runtime.updatedAt) > 15_000 || Date.parse(runtime.updatedAt) > now + 1000 || runtime.pid !== node.pid) result.reason = 'node status stale or process identity mismatch';
  else if (!runtime.connected || runtime.gateway !== gatewayOrigin.origin) result.reason = 'node disconnected / reconnect pending';
  else if (body?.ok !== true || result.onlineNodes !== 1) result.reason = 'gateway health requires ok:true and onlineNodes:1';
  else if (runtime.access?.effectiveMode !== expected.mode) result.reason = `connected but AI mode must be ${expected.mode}`;
  else if (runtime.profile !== expected.profile) result.reason = `connected but profile must be ${expected.profile}`;
  else { result.ok = true; result.reason = 'healthy'; }
  return result;
}

export async function readMacHealth(expected: HealthExpectation): Promise<MacHealth> {
  const domain = `gui/${process.getuid?.()}`;
  const service = async (name: string): Promise<ServiceHealth> => {
    try {
      const { stdout } = await execFileAsync('/bin/launchctl', ['print', `${domain}/com.stinkyweasel.dex-reach.${name}`]);
      return parseServiceHealth(stdout);
    } catch { return { running: false }; }
  };
  const [gateway, node, runtime] = await Promise.all([
    service('gateway'), service('node'), readRuntimeStatus(expected.nodeId, expected.dir)
  ]);
  let body = null;
  try {
    const response = await fetch(expected.healthUrl, { signal: AbortSignal.timeout(1500) });
    if (response.ok) body = await response.json();
  } catch {}
  const result = assessMacHealth(gateway, node, runtime, body, expected);
  if (result.ok) {
    try {
      if (!gateway.root || gateway.root !== node.root) throw new Error('runtime roots differ');
      await verifyRuntimeRelease(gateway.root);
      process.kill(node.pid!, 0);
      process.kill(gateway.pid!, 0);
    } catch { result.ok = false; result.reason = 'installed runtime incomplete or service process missing'; }
  }
  return result;
}

/** Node launch must wait for the new gateway listener, rather than accumulate reconnect backoff. */
export async function waitGatewayReady(url: string, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1500) });
      if (response.ok && (await response.json() as { ok?: unknown }).ok === true) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error(`gateway listener did not become ready within ${timeoutMs}ms; node was not launched`);
}

/** Require unchanged PIDs/run counts for five seconds, rather than a transient connected sample. */
export async function waitMacHealth(expected: HealthExpectation, timeoutMs = 120_000): Promise<MacHealth> {
  const deadline = Date.now() + timeoutMs;
  let stableSince = 0;
  let identity = '';
  let last: MacHealth | undefined;
  let lastUnhealthy = 'none';
  while (Date.now() < deadline) {
    last = await readMacHealth(expected);
    const next = JSON.stringify([last.gateway.pid, last.gateway.runs, last.node.pid, last.node.runs]);
    if (!last.ok) { lastUnhealthy = last.reason; stableSince = 0; identity = ''; }
    else {
      if (next !== identity) { identity = next; stableSince = Date.now(); }
      if (Date.now() - stableSince >= 5000) return last;
    }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error(`DEX health timed out after ${timeoutMs}ms: ${last?.reason ?? 'no observation'}; last unhealthy=${lastUnhealthy}; stable for ${stableSince ? Date.now() - stableSince : 0}ms; gateway pid=${last?.gateway.pid ?? 'none'}, node pid=${last?.node.pid ?? 'none'}, onlineNodes=${last?.onlineNodes ?? 'unknown'}`);
}

export async function waitInstallStatus(dir: string, timeoutMs = 420_000): Promise<void> {
  const file = path.join(dir, 'install-macos.status.json');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = JSON.parse(await fs.readFile(file, 'utf8')) as { state?: string; error?: string };
    if (status.state === 'complete') return;
    if (status.state === 'failed') throw new Error(`macOS install failed: ${status.error || 'see install-reloader-once error log'}`);
    if (!['scheduled', 'waiting'].includes(status.state || '')) throw new Error('invalid macOS install status');
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error(`macOS install timed out after ${timeoutMs}ms; inspect ${file}`);
}
