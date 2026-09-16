#!/usr/bin/env node
/**
 * DEX//REACH local control for the machine owner. Everything here works offline and without the gateway:
 *   status | enable [--for 30m] | disable | read-only [--for 30m] | client <kind> <mode|default> | audit [--limit N] | uninstall
 * Never prints credentials.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { stateDir } from '../src/shared/local-env.js';
import { ACCESS_MODES, accessFile, isAccessMode, loadAccessState, modeForActor, parseDuration, resolveMode, saveAccessState, type AccessState } from '../src/shared/access.js';
import { AuditLog, auditFile } from '../src/shared/audit.js';
import { readRuntimeStatus, runtimeFile } from '../src/node/runtime-status.js';
import type { AccessMode, ClientKind } from '../src/shared/protocol.js';
import { arg, flag, localNodeIds, nodeEnvFile, readEnvFile } from './lib/node-files.js';

const execFileAsync = promisify(execFile);
const argv = process.argv.slice(2);
const command = argv[0] || 'status';
const CLIENT_KINDS: ClientKind[] = ['chatgpt', 'claude', 'smoke', 'other'];
const CLIENT_LABEL: Record<ClientKind, string> = { chatgpt: 'ChatGPT', claude: 'Claude', smoke: 'DEX smoke test', other: 'Other MCP clients' };

function usage(): never {
  console.log(`DEX//REACH local control

  status                          show this machine's node, connection, and AI access mode
  enable [--for 30m]              allow remote AI execution (optionally only for a while, then revert)
  read-only [--for 30m]           allow inspection only; writes and mutating commands are refused
  disable                         refuse all remote AI execution (kill switch)
  client <kind> <mode|default>    per-client ceiling; kind = chatgpt|claude|other|smoke, mode = off|read-only|on
  audit [--limit 20] [--client chatgpt]   what AI clients asked this machine to do
  uninstall [--purge-state --yes-delete-state]   remove the node service; optionally delete local DEX state

Options: --node <id> when more than one node credential exists locally.`);
  process.exit(command === 'help' || command === '--help' ? 0 : 2);
}

async function pickNodeId(): Promise<string> {
  const requested = arg('--node', argv) || process.env.DEX_REACH_NODE_ID;
  const ids = await localNodeIds();
  if (requested) {
    if (!ids.includes(requested)) throw new Error(`no local credential for node "${requested}" (known: ${ids.join(', ') || 'none'})`);
    return requested;
  }
  if (ids.length === 1) return ids[0]!;
  if (ids.length === 0) throw new Error(`no node credential found under ${path.join(stateDir(), 'nodes')}; run the enrollment/install step first`);
  throw new Error(`multiple nodes found (${ids.join(', ')}); pass --node <id>`);
}

function describeMode(mode: AccessMode): string {
  return mode === 'on' ? 'ENABLED (configured profile applies)' : mode === 'read-only' ? 'READ-ONLY (inspection only; writes refused)' : 'DISABLED (all remote AI execution refused)';
}

function remaining(until: string | null): string {
  if (!until) return '';
  const ms = Date.parse(until) - Date.now();
  if (ms <= 0) return ' (expired)';
  if (ms < 60_000) return ` (expires in ${Math.ceil(ms / 1000)}s)`;
  const minutes = Math.round(ms / 60_000);
  return minutes >= 120 ? ` (expires in ${Math.round(minutes / 60)}h)` : ` (expires in ${minutes}m)`;
}

async function status(): Promise<void> {
  const nodeId = await pickNodeId();
  const env = await readEnvFile(nodeEnvFile(nodeId));
  const state = await loadAccessState(nodeId);
  const effective = resolveMode(state);
  const runtime = await readRuntimeStatus(nodeId);
  const audit = new AuditLog();
  const recent = (await audit.tail(200)).filter(e => e.nodeId === nodeId && isNodeSide(e)).slice(-5);
  const lines = [
    'DEX//REACH',
    `Node:            ${nodeId}`,
    `Machine:         ${os.hostname()} (${process.platform}/${process.arch}, user ${os.userInfo().username})`,
    `Node process:    ${runtime ? `running (pid ${runtime.pid})` : 'not running'}`,
    `Gateway:         ${runtime ? (runtime.connected ? `connected to ${runtime.gateway}` : `disconnected from ${runtime.gateway}`) : (env.DEX_REACH_GATEWAY_WS ? `configured ${new URL(env.DEX_REACH_GATEWAY_WS).origin}` : 'not configured')}`,
    `AI access:       ${describeMode(effective)}${state.until && effective === state.mode ? remaining(state.until) + ` then ${state.revertTo ?? 'off'}` : ''}`,
    `Profile:         ${env.DEX_REACH_PROFILE || 'development'}`,
    'Allowed roots:',
    ...(env.DEX_REACH_ALLOWED_ROOTS || os.homedir()).split(path.delimiter).map(r => `  ${r}`),
    'AI clients:',
    ...CLIENT_KINDS.map(kind => {
      const mode = modeForActor(state, { kind, clientId: '', clientName: '' });
      const ceiling = state.clients[kind] ? ` (limit: ${state.clients[kind]})` : '';
      return `  ${CLIENT_LABEL[kind].padEnd(18)} ${mode === 'off' ? 'blocked' : mode}${ceiling}`;
    }),
    'Recent activity:',
    ...(recent.length ? recent.map(formatAuditLine) : ['  (none recorded)']),
    `Policy file:     ${accessFile(nodeId)}`,
    `Audit log:       ${auditFile()}`
  ];
  console.log(lines.join('\n'));
}

/** The node's own record is authoritative for "what ran here"; gateway copies exist only on the gateway machine. */
function isNodeSide(e: { source?: string; client?: string }): boolean {
  return e.source === 'node' || (!e.source && !e.client);
}

function formatAuditLine(e: { at: string; actor?: { kind: string; clientName: string }; client?: string; operation: string; ok: boolean; args?: unknown; error?: string }): string {
  const who = e.actor ? `${e.actor.clientName} [${e.actor.kind}]` : e.client ? `client ${e.client.slice(0, 8)}…` : 'unknown client';
  const a = (e.args || {}) as Record<string, unknown>;
  const target = typeof a.path === 'string' ? a.path : typeof a.command === 'string' ? `"${a.command.slice(0, 60)}"` : typeof a.tool === 'string' ? `tool ${a.tool}` : typeof a.cwd === 'string' ? a.cwd : '';
  return `  ${e.at.replace('T', ' ').slice(0, 19)}  ${e.ok ? 'ok     ' : 'REFUSED'}  ${who}  ${e.operation} ${target}${e.ok ? '' : ` — ${(e.error || '').slice(0, 120)}`}`;
}

async function setMode(mode: AccessMode): Promise<void> {
  const nodeId = await pickNodeId();
  const current = await loadAccessState(nodeId);
  const duration = arg('--for', argv);
  let next: AccessState;
  if (duration) {
    const ms = parseDuration(duration);
    // Extending a window keeps the original baseline; it never promotes a temporary mode to permanent.
    const revertTo = current.until ? (current.revertTo ?? 'off') : resolveMode(current);
    next = { ...current, mode, until: new Date(Date.now() + ms).toISOString(), revertTo };
  } else {
    next = { ...current, mode, until: null, revertTo: null };
  }
  await saveAccessState(nodeId, next);
  console.log(`${nodeId}: AI access is now ${describeMode(mode)}${next.until ? remaining(next.until) + ` then reverts to ${next.revertTo}` : ''}.`);
  console.log('Takes effect immediately for new requests; no gateway contact required.');
}

async function setClient(): Promise<void> {
  const kind = argv[1] as ClientKind | undefined;
  const mode = argv[2];
  if (!kind || !CLIENT_KINDS.includes(kind) || !mode || (mode !== 'default' && !isAccessMode(mode))) usage();
  const nodeId = await pickNodeId();
  const current = await loadAccessState(nodeId);
  const clients = { ...current.clients };
  if (mode === 'default') delete clients[kind]; else clients[kind] = mode as AccessMode;
  await saveAccessState(nodeId, { ...current, clients });
  console.log(`${nodeId}: ${CLIENT_LABEL[kind]} limit is now ${mode === 'default' ? 'the node mode' : mode} (effective: ${modeForActor({ ...current, clients }, { kind, clientId: '', clientName: '' })}).`);
}

async function auditCommand(): Promise<void> {
  const nodeId = await pickNodeId();
  const limit = Number(arg('--limit', argv) || 20);
  const client = arg('--client', argv);
  const events = (await new AuditLog().tail(5000)).filter(e => e.nodeId === nodeId && isNodeSide(e) && (!client || e.actor?.kind === client)).slice(-limit);
  console.log(`Last ${events.length} AI requests to ${nodeId} (file contents and credentials are never recorded):`);
  for (const e of events) console.log(formatAuditLine(e));
}

async function uninstall(): Promise<void> {
  const nodeId = await pickNodeId();
  if (process.platform === 'darwin') {
    const label = 'com.stinkyweasel.dex-reach.node';
    const plist = path.join(os.homedir(), 'Library', 'LaunchAgents', `${label}.plist`);
    try { await execFileAsync('launchctl', ['bootout', `gui/${process.getuid?.() ?? os.userInfo().uid}`, plist]); } catch {}
    await fs.rm(plist, { force: true });
    console.log(`Removed launchd service ${label} (if it was installed).`);
  } else if (process.platform === 'linux') {
    const unit = path.join(os.homedir(), '.config', 'systemd', 'user', 'dex-reach-node.service');
    try { await execFileAsync('systemctl', ['--user', 'disable', '--now', 'dex-reach-node.service']); } catch {}
    await fs.rm(unit, { force: true });
    console.log('Removed systemd user unit dex-reach-node.service (if it was installed).');
  } else {
    console.log('No service manager integration on this platform; stop any manually started node process.');
  }
  await fs.rm(runtimeFile(nodeId), { force: true });
  if (flag('--purge-state', argv)) {
    if (!flag('--yes-delete-state', argv)) throw new Error('--purge-state deletes this node\'s credential and policy; add --yes-delete-state to confirm');
    await fs.rm(nodeEnvFile(nodeId), { force: true });
    await fs.rm(accessFile(nodeId), { force: true });
    console.log(`Deleted local credential and policy for ${nodeId}. Audit log, checkpoints, and other nodes were left in place under ${stateDir()}.`);
    console.log('Ask the gateway owner to run: npm run nodes -- revoke ' + nodeId);
  } else {
    console.log(`Local state under ${stateDir()} was preserved (re-run with --purge-state --yes-delete-state to delete this node's credential and policy).`);
  }
}

try {
  switch (command) {
    case 'status': await status(); break;
    case 'enable': case 'on': await setMode('on'); break;
    case 'read-only': case 'readonly': await setMode('read-only'); break;
    case 'disable': case 'off': await setMode('off'); break;
    case 'client': await setClient(); break;
    case 'audit': await auditCommand(); break;
    case 'uninstall': await uninstall(); break;
    case 'modes': console.log(ACCESS_MODES.join('\n')); break;
    default: usage();
  }
} catch (error) {
  console.error(`dex-reach: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
