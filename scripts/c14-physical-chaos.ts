import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Client, type OAuthClientProvider, type OAuthDiscoveryState } from '@modelcontextprotocol/client';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { OAuthClientInformationFull, OAuthClientMetadata, OAuthTokens } from '@modelcontextprotocol/server';
import { atomicWriteFile } from '../src/shared/state-io.js';
import { loadOwnerSecrets } from '../src/shared/local-env.js';
import { DEX_REACH_VERSION } from '../src/shared/version.js';
import { readQuarantine, quarantineMatches, type QuarantinedTaskIdentity } from '../src/shared/task-quarantine.js';

/**
 * C14 physical chaos on the INSTALLED services of MacBook-Air.local, through the real public MCP path.
 * Owner-authorized maintenance only. It uses the installed OAuth canary's existing client and tokens
 * (normal refresh; never a password or new authorization) and kills only the four DEX//REACH services,
 * which launchd restarts. Every outcome is checked for same-task identity, no replay and no duplicate
 * external effect. It never changes policy, credentials or historical tasks.
 */
const exec = promisify(execFile);
const state = '/Users/andrew/.dex-reach', nodeId = 'macbook-air.local', uid = 501;
const credentialFile = path.join(state, 'oauth-canary.json');
loadOwnerSecrets();
const base = new URL(process.env.DEX_REACH_PUBLIC_BASE_URL || 'http://127.0.0.1:8787');

class CanaryCredentials implements OAuthClientProvider {
  private stored: { version: 1; client?: OAuthClientInformationFull; tokens?: OAuthTokens; verifier?: string; discovery?: OAuthDiscoveryState } = { version: 1 };
  async load() { this.stored = JSON.parse(await fs.readFile(credentialFile, 'utf8')); if (!this.stored.client || !this.stored.tokens?.refresh_token) throw new Error('CANARY_CREDENTIAL_UNAVAILABLE'); }
  get redirectUrl() { return 'http://127.0.0.1:49153/callback'; }
  get clientMetadata(): OAuthClientMetadata { return { client_name: 'DEX REACH OAuth Canary', redirect_uris: ['http://127.0.0.1:49153/callback'], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' }; }
  clientInformation() { return this.stored.client; }
  async saveClientInformation(): Promise<void> { throw new Error('CHAOS_NEVER_REGISTERS_CLIENTS'); }
  tokens() { return this.stored.tokens; }
  async saveTokens(value: OAuthTokens) { this.stored.tokens = value; await atomicWriteFile(credentialFile, JSON.stringify(this.stored, null, 2) + '\n', 0o600); }
  redirectToAuthorization(): void { throw new Error('CHAOS_NEVER_AUTHORIZES: refresh failed; run the canary instead'); }
  async saveCodeVerifier(): Promise<void> { throw new Error('CHAOS_NEVER_AUTHORIZES'); }
  codeVerifier(): string { throw new Error('CHAOS_NEVER_AUTHORIZES'); }
  async saveDiscoveryState(value: OAuthDiscoveryState) { this.stored.discovery = value; await atomicWriteFile(credentialFile, JSON.stringify(this.stored, null, 2) + '\n', 0o600); }
  discoveryState() { return this.stored.discovery; }
  async invalidateCredentials(): Promise<void> { throw new Error('CHAOS_NEVER_INVALIDATES_CREDENTIALS'); }
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
type Task = { taskId: string; state: string; idempotencyKey?: string; failureClass?: string };
let client: Client;
async function connect() {
  const credentials = new CanaryCredentials(); await credentials.load();
  client = new Client({ name: 'dex-reach-c14-physical-chaos', version: DEX_REACH_VERSION }, { capabilities: {} });
  await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', base), { authProvider: credentials }));
}
const text = (r: any) => (r.content ?? []).filter((c: any) => c.type === 'text').map((c: any) => c.text).join('\n');
async function call(name: string, args: Record<string, unknown>) {
  for (let attempt = 0; ; attempt++) {
    try { const r = await client.callTool({ name, arguments: args }); return { ok: !r.isError, text: text(r) }; }
    catch (error) { if (attempt >= 20) throw error; await sleep(1500); await client.close().catch(() => undefined); await connect().catch(() => undefined); }
  }
}
const parseTask = (t: string): Task => { const v = JSON.parse(t); return (v.task ?? v) as Task; };
async function start(operation: string, args: Record<string, unknown>) { return call('reach_task', { node_id: nodeId, action: 'start', operation, arguments: args, mode: 'durable' }); }
async function get(taskId: string) { const r = await call('reach_task', { node_id: nodeId, action: 'get', task_id: taskId }); if (!r.ok) throw new Error(`TASK_GET_FAILED:${r.text.slice(0, 120)}`); return parseTask(r.text); }
async function until<T>(what: string, ms: number, fn: () => Promise<T | undefined>): Promise<T> {
  const end = Date.now() + ms; let last: unknown;
  while (Date.now() < end) { try { const v = await fn(); if (v !== undefined) return v; } catch (error) { last = error; } await sleep(1000); }
  throw new Error(`TIMEOUT:${what}:${last instanceof Error ? last.message.slice(0, 80) : ''}`);
}
const TERMINAL = ['COMPLETED', 'FAILED', 'CANCELLED', 'RECONCILED', 'AMBIGUOUS'];
async function terminal(taskId: string) { return until(`terminal ${taskId}`, 90_000, async () => { const t = await get(taskId); return TERMINAL.includes(t.state) ? t : undefined; }); }
async function launchdPid(role: string): Promise<number | null> { const { stdout } = await exec('/bin/launchctl', ['print', `gui/${uid}/com.stinkyweasel.dex-reach.${role}`]); return Number(stdout.match(/\bpid = (\d+)/)?.[1]) || null; }
async function kill(role: string) {
  const before = await launchdPid(role); if (!before) throw new Error(`SERVICE_NOT_RUNNING:${role}`);
  await exec('/bin/launchctl', ['kill', 'SIGKILL', `gui/${uid}/com.stinkyweasel.dex-reach.${role}`]);
  const after = await until(`${role} restarted by launchd`, 60_000, async () => { const p = await launchdPid(role).catch(() => null); return p && p !== before ? p : undefined; });
  return { before, after };
}
async function nodeOnline() {
  return until('node online', 90_000, async () => { const r = await call('reach_list_nodes', {}); const nodes = JSON.parse(r.text) as Array<{ nodeId: string; online: boolean }>; return nodes.find(n => n.nodeId === nodeId)?.online ? true : undefined; });
}
async function storeTasks() { return JSON.parse(await fs.readFile(path.join(state, 'tasks/store.json'), 'utf8')).records as Record<string, Task & QuarantinedTaskIdentity>; }
async function claims() { let n = 0; for (const d of ['leases', 'queue']) n += (await fs.readdir(path.join(state, 'coordinator', d))).length; return n; }
const lines = async (file: string) => (await fs.readFile(file, 'utf8').catch(() => '')).split('\n').filter(Boolean).length;

type Result = { scenario: string; pass: boolean; observed: Record<string, unknown> };
async function main() {
  if (os.hostname() !== 'MacBook-Air.local' || process.getuid?.() !== uid) throw new Error('WRONG_HOST');
  const run = crypto.randomUUID().slice(0, 8), scratch = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), `dex-c14-chaos-${run}-`));
  const quarantineBefore = await readQuarantine(state);
  await connect(); await nodeOnline();
  if (process.argv.includes('--dry-run')) {
    // Plumbing check only: one durable read through the real MCP path, no service interruption.
    const s = await start('dex.fingerprint', { idempotencyKey: `c14-chaos-dry-${run}` }); const done = await terminal(parseTask(s.text).taskId);
    console.log(JSON.stringify({ dryRun: true, started: s.ok, state: done.state, taskIdShape: /^rtsk_/.test(done.taskId) }));
    await client.close().catch(() => undefined); return;
  }
  const results: Result[] = [];
  const record = (scenario: string, pass: boolean, observed: Record<string, unknown>) => { results.push({ scenario, pass, observed }); console.error(`${pass ? 'PASS' : 'FAIL'} ${scenario} ${JSON.stringify(observed)}`); };
  const proc = (marker: string, seconds: number) => `sleep ${seconds}; echo effect >> ${JSON.stringify(path.join(scratch, marker))}`;

  // A. Gateway killed right after a durable start: the node finishes the same task once.
  { const key = `c14-chaos-${run}-A`, s = await start('dex.process.run', { command: proc('A', 3), cwd: scratch, timeout_ms: 20_000, idempotencyKey: key });
    const task = parseTask(s.text); const k = await kill('gateway'); await nodeOnline();
    const done = await terminal(task.taskId); const again = parseTask((await start('dex.process.run', { command: proc('A', 3), cwd: scratch, timeout_ms: 20_000, idempotencyKey: key })).text);
    await sleep(5000); const same = Object.values(await storeTasks()).filter(t => t.idempotencyKey === key).length;
    record('A gateway kill after durable start', s.ok && done.state === 'COMPLETED' && again.taskId === task.taskId && await lines(path.join(scratch, 'A')) === 1 && same === 1, { pids: k, state: done.state, sameTaskOnRetry: again.taskId === task.taskId, effects: await lines(path.join(scratch, 'A')), tasksForKey: same }); }

  // B. Node killed while the process task is RUNNING: never replayed, effect at most once.
  { const key = `c14-chaos-${run}-B`, s = await start('dex.process.run', { command: proc('B', 5), cwd: scratch, timeout_ms: 30_000, idempotencyKey: key });
    const task = parseTask(s.text); await until('B running', 30_000, async () => (await get(task.taskId)).state === 'RUNNING' ? true : undefined);
    const k = await kill('node'); await nodeOnline(); const after = await terminal(task.taskId);
    const retry = await start('dex.process.run', { command: proc('B', 5), cwd: scratch, timeout_ms: 30_000, idempotencyKey: key });
    await sleep(8000); const effects = await lines(path.join(scratch, 'B')), same = Object.values(await storeTasks()).filter(t => t.idempotencyKey === key).length;
    const noReplay = after.state === 'AMBIGUOUS' ? !retry.ok || parseTask(retry.text).taskId === task.taskId : after.state === 'COMPLETED' && parseTask(retry.text).taskId === task.taskId;
    record('B node kill during RUNNING process', noReplay && effects <= 1 && same === 1, { pids: k, state: after.state, failureClass: after.failureClass, retryRefusedOrSame: noReplay, effects, tasksForKey: same }); }

  // C. Coordinator killed while a task holds its lease: definite outcome, no leaked claims.
  { const key = `c14-chaos-${run}-C`, s = await start('dex.process.run', { command: proc('C', 4), cwd: scratch, timeout_ms: 30_000, idempotencyKey: key });
    const task = parseTask(s.text); await until('C running', 30_000, async () => (await get(task.taskId)).state === 'RUNNING' ? true : undefined);
    const k = await kill('coordinator'); const after = await terminal(task.taskId); await sleep(6000);
    const leaked = await until('claims released', 200_000, async () => (await claims()) === 0 ? 0 : undefined).catch(async () => claims());
    record('C coordinator kill during lease', TERMINAL.includes(after.state) && await lines(path.join(scratch, 'C')) <= 1 && leaked === 0, { pids: k, state: after.state, effects: await lines(path.join(scratch, 'C')), claimsAfter: leaked }); }

  // D. Worker killed: restarted by launchd and durable work still completes.
  { const k = await kill('worker'); const s = await start('dex.fingerprint', { idempotencyKey: `c14-chaos-${run}-D` }); const done = await terminal(parseTask(s.text).taskId);
    record('D worker kill then durable task', done.state === 'COMPLETED', { pids: k, state: done.state }); }

  // E. All four persistent services restarted: earlier durable results remain readable by task id.
  { const key = `c14-chaos-${run}-E`, first = await terminal(parseTask((await start('dex.fingerprint', { idempotencyKey: key })).text).taskId);
    const pids: Record<string, unknown> = {}; for (const role of ['coordinator', 'worker', 'gateway', 'node']) pids[role] = await kill(role);
    await nodeOnline(); const result = await call('reach_task', { node_id: nodeId, action: 'result', task_id: first.taskId }); const read = await get(first.taskId);
    record('E full service restart preserves durable result', first.state === 'COMPLETED' && result.ok && read.state === 'COMPLETED', { pids, resultReadable: result.ok, state: read.state }); }

  // Historical quarantine untouched by every interruption.
  const records = await storeTasks(), quarantineAfter = await readQuarantine(state);
  const preserved = quarantineBefore.size > 0 && quarantineAfter.size === quarantineBefore.size && [...quarantineBefore.values()].every(e => records[e.taskId] && quarantineMatches(e, records[e.taskId]!));
  record('historical quarantined tasks preserved', preserved || quarantineBefore.size === 0, { quarantined: quarantineBefore.size, preserved });
  await client.close().catch(() => undefined);
  const report = { version: 1, run, at: new Date().toISOString(), host: os.hostname(), scope: 'installed-services-physical', e7Verified: false, pass: results.every(r => r.pass), results };
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = report.pass ? 0 : 1;
}
main().catch(error => { console.error(`CHAOS_ABORTED: ${error instanceof Error ? error.message : 'unknown'}`); process.exitCode = 2; });
