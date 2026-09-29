import fs from 'node:fs/promises';
import { atomicWriteFile } from '../src/shared/state-io.js';
import { DEX_REACH_VERSION } from '../src/shared/version.js';
import { execFileDeadline } from './lib/process-deadline.js';
import { restorePlist } from './lib/plist-rollback.js';

type Service = { label: string; target: string; rollbackTarget?: string };

function requiredArg(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value) throw new Error(`missing ${name}`);
  return value;
}

function optionalArg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function serviceArgs(): Service[] {
  const out: Service[] = [];
  for (let index = 2; index < process.argv.length; index += 1) {
    if (process.argv[index] !== '--service') continue;
    const label = process.argv[index + 1];
    const target = process.argv[index + 2];
    const rollback = process.argv[index + 3];
    if (!label || !target || !rollback) throw new Error('each --service requires LABEL PLIST_PATH ROLLBACK_PATH_OR_DASH');
    out.push({ label, target, ...(rollback === '-' ? {} : { rollbackTarget: rollback }) });
    index += 3;
  }
  if (!out.length) throw new Error('at least one --service is required');
  return out;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const domain = requiredArg('--domain');
const statusFile = requiredArg('--status');
const cleanupPlist = optionalArg('--cleanup-plist');
const cleanupDir = optionalArg('--cleanup-dir');
const healthUrl = optionalArg('--health-url');
const delayMs = Number(optionalArg('--delay-ms') || '3000');
const commandTimeoutMs = Number(optionalArg('--command-timeout-ms') || '10000');
const services = serviceArgs();

if (!/^gui\/\d+$/.test(domain)) throw new Error(`invalid launchd domain: ${domain}`);
if (!Number.isFinite(delayMs) || delayMs < 500 || delayMs > 30_000) throw new Error(`invalid delay: ${delayMs}`);
if (!Number.isFinite(commandTimeoutMs) || commandTimeoutMs < 250 || commandTimeoutMs > 120_000) throw new Error(`invalid command timeout: ${commandTimeoutMs}`);

async function launchctl(args: string[]): Promise<{ stdout: string; stderr: string }> {
  return execFileDeadline('/bin/launchctl', args, commandTimeoutMs);
}

const startedAt = new Date().toISOString();
await atomicWriteFile(statusFile, JSON.stringify({
  version: DEX_REACH_VERSION,
  state: 'waiting',
  startedAt,
  domain,
  services: services.map(service => ({
    label: service.label,
    target: service.target,
    rollbackAvailable: Boolean(service.rollbackTarget)
  }))
}, null, 2) + '\n');

await new Promise(resolve => setTimeout(resolve, delayMs));

const results: Array<{
  label: string;
  bootout: 'ok' | 'not-loaded';
  bootstrap?: 'ok';
  kickstart?: 'ok';
  verified?: 'running' | 'exit-0';
}> = [];

async function reloadService(service: Service): Promise<void> {
  let bootout: 'ok' | 'not-loaded' = 'ok';
  try {
    await launchctl(['bootout', domain, service.target]);
  } catch {
    bootout = 'not-loaded';
  }
  await launchctl(['enable', `${domain}/${service.label}`]);
  await launchctl(['bootstrap', domain, service.target]);
  await launchctl(['kickstart', `${domain}/${service.label}`]);
  results.push({ label: service.label, bootout, bootstrap: 'ok', kickstart: 'ok' });
}

async function launchdPrint(label: string): Promise<string> {
  const { stdout } = await launchctl(['print', `${domain}/${label}`]);
  return stdout;
}

async function verifyPersistent(service: Service): Promise<void> {
  let last = '';
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      last = await launchdPrint(service.label);
    } catch (error) {
      last = errorText(error);
    }
    if (/\bstate = running\b/.test(last) && /\bpid = \d+\b/.test(last)) {
      const result = results.find(item => item.label === service.label);
      if (result) result.verified = 'running';
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error(`${service.label} did not remain running after reload: ${last.slice(0, 400)}`);
}

async function verifyHealth(url: string): Promise<void> {
  let last = '';
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1500) });
      last = await response.text();
      if (response.ok) {
        const body = JSON.parse(last) as { onlineNodes?: number };
        if (Number(body.onlineNodes) >= 1) return;
      }
    } catch (error) {
      last = errorText(error);
    }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error(`DEX health verification failed: ${last.slice(0, 300)}`);
}

async function verifyCanary(service: Service): Promise<void> {
  let last = '';
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      last = await launchdPrint(service.label);
    } catch (error) {
      last = errorText(error);
    }
    if (/\blast exit code = 0\b/.test(last) && !/\bstate = running\b/.test(last)) {
      const result = results.find(item => item.label === service.label);
      if (result) result.verified = 'exit-0';
      return;
    }
    if (/\blast exit code = [1-9]\d*\b/.test(last) && !/\bstate = running\b/.test(last)) {
      throw new Error(`${service.label} exited non-zero after reload: ${last.slice(0, 400)}`);
    }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error(`${service.label} did not complete successfully after reload: ${last.slice(0, 400)}`);
}

async function rollbackService(service: Service): Promise<{
  label: string;
  definition: 'restored' | 'removed';
  restarted: boolean;
}> {
  try {
    await launchctl(['bootout', domain, service.target]);
  } catch {
    // Absence is an acceptable starting state for rollback.
  }
  const definition = await restorePlist(service.target, service.rollbackTarget);
  if (definition === 'removed') return { label: service.label, definition, restarted: false };
  await launchctl(['enable', `${domain}/${service.label}`]);
  await launchctl(['bootstrap', domain, service.target]);
  await launchctl(['kickstart', `${domain}/${service.label}`]);
  return { label: service.label, definition, restarted: true };
}

const canaries = services.filter(service => service.label.endsWith('.oauth-canary'));
const persistent = services.filter(service => !service.label.endsWith('.oauth-canary'));
let completed = false;

try {
  for (const service of persistent) {
    await reloadService(service);
    if (service.label.endsWith('.gateway')) await new Promise(resolve => setTimeout(resolve, 500));
  }

  for (const service of persistent) await verifyPersistent(service);
  if (healthUrl) await verifyHealth(healthUrl);

  for (const service of canaries) {
    await reloadService(service);
    await verifyCanary(service);
  }

  await atomicWriteFile(statusFile, JSON.stringify({
    version: DEX_REACH_VERSION,
    state: 'complete',
    startedAt,
    completedAt: new Date().toISOString(),
    domain,
    results
  }, null, 2) + '\n');
  completed = true;
  if (cleanupDir) await fs.rm(cleanupDir, { recursive: true, force: true }).catch(() => undefined);
} catch (error) {
  const rollback = {
    attempted: true,
    ok: false,
    results: [] as Array<{ label: string; definition: 'restored' | 'removed'; restarted: boolean }>,
    error: undefined as string | undefined
  };
  try {
    for (const service of [...services].reverse()) rollback.results.push(await rollbackService(service));

    const restoredPersistent = persistent.filter(service => Boolean(service.rollbackTarget));
    for (const service of restoredPersistent) await verifyPersistent(service);

    const restoredGateway = restoredPersistent.some(service => service.label.endsWith('.gateway'));
    const restoredNode = restoredPersistent.some(service => service.label.endsWith('.node'));
    if (healthUrl && restoredGateway && restoredNode) await verifyHealth(healthUrl);

    rollback.ok = true;
  } catch (rollbackError) {
    rollback.error = errorText(rollbackError);
  }

  await atomicWriteFile(statusFile, JSON.stringify({
    version: DEX_REACH_VERSION,
    state: 'failed',
    startedAt,
    failedAt: new Date().toISOString(),
    domain,
    results,
    error: errorText(error),
    rollback
  }, null, 2) + '\n');
  process.exitCode = 1;
} finally {
  if (!completed && cleanupDir) {
    // Preserve rollback evidence after failure. A later successful installation may reclaim it.
  }
  if (cleanupPlist) await fs.rm(cleanupPlist, { force: true }).catch(() => undefined);
}
