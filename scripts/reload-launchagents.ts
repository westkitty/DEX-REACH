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

const results: Array<{ label: string; bootout: 'ok' | 'not-loaded'; bootstrap?: 'ok'; kickstart?: 'ok' }> = [];
try {
  for (const service of services) {
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

    if (service.label.endsWith('.gateway')) await new Promise(resolve => setTimeout(resolve, 500));
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
