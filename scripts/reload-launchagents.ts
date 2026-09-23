import fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { atomicWriteFile } from '../src/shared/state-io.js';
import { DEX_REACH_VERSION } from '../src/shared/version.js';

const execFileAsync = promisify(execFile);

type Service = { label: string; target: string };

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
    if (!label || !target) throw new Error('each --service requires LABEL and PLIST_PATH');
    out.push({ label, target });
    index += 2;
  }
  if (!out.length) throw new Error('at least one --service is required');
  return out;
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

const domain = requiredArg('--domain');
const statusFile = requiredArg('--status');
const cleanupPlist = optionalArg('--cleanup-plist');
const healthUrl = optionalArg('--health-url');
const delayValue = optionalArg('--delay-ms') || '3000';
const delayMs = Number(delayValue);
const services = serviceArgs();

if (!/^gui\/\d+$/.test(domain)) throw new Error(`invalid launchd domain: ${domain}`);
if (!Number.isFinite(delayMs) || delayMs < 500 || delayMs > 30_000) throw new Error(`invalid delay: ${delayMs}`);

const startedAt = new Date().toISOString();
await atomicWriteFile(statusFile, JSON.stringify({
  version: DEX_REACH_VERSION,
  state: 'waiting',
  startedAt,
  domain,
  services: services.map(service => ({ label: service.label, target: service.target }))
}, null, 2) + '\n');

await new Promise(resolve => setTimeout(resolve, delayMs));

const results: Array<{ label: string; bootout: 'ok' | 'not-loaded'; bootstrap?: 'ok'; kickstart?: 'ok'; verified?: 'running' | 'exit-0' }> = [];

async function reloadService(service: Service): Promise<void> {
    let bootout: 'ok' | 'not-loaded' = 'ok';
    try {
      await execFileAsync('/bin/launchctl', ['bootout', domain, service.target]);
    } catch {
      bootout = 'not-loaded';
    }

    await execFileAsync('/bin/launchctl', ['enable', `${domain}/${service.label}`]);
    await execFileAsync('/bin/launchctl', ['bootstrap', domain, service.target]);
    await execFileAsync('/bin/launchctl', ['kickstart', `${domain}/${service.label}`]);
    results.push({ label: service.label, bootout, bootstrap: 'ok', kickstart: 'ok' });
}

async function launchdPrint(label: string): Promise<string> {
  const { stdout } = await execFileAsync('/bin/launchctl', ['print', `${domain}/${label}`]);
  return stdout;
}

async function verifyPersistent(service: Service): Promise<void> {
  let last = '';
  for (let attempt = 0; attempt < 20; attempt += 1) {
    last = await launchdPrint(service.label);
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
    last = await launchdPrint(service.label);
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

const canaries = services.filter(service => service.label.endsWith('.oauth-canary'));
const persistent = services.filter(service => !service.label.endsWith('.oauth-canary'));

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
} catch (error) {
  await atomicWriteFile(statusFile, JSON.stringify({
    version: DEX_REACH_VERSION,
    state: 'failed',
    startedAt,
    failedAt: new Date().toISOString(),
    domain,
    results,
    error: errorText(error)
  }, null, 2) + '\n');
  process.exitCode = 1;
} finally {
  if (cleanupPlist) await fs.rm(cleanupPlist, { force: true }).catch(() => undefined);
}
