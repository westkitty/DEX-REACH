#!/usr/bin/env node
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { stateDir } from '../src/shared/local-env.js';
import { pathAllowed } from '../src/shared/security.js';
import { ACCESS_MODES, accessFile, authorizeOperation, createGrant, inspectAccessPolicyFile, isAccessMode, loadAccessState, modeForActor, parseDuration, resolveMode, updateAccessState } from '../src/shared/access.js';
import { REACH_CAPABILITIES, type ReachCapability } from '../src/shared/capabilities.js';
import { AuditLog, auditFile } from '../src/shared/audit.js';
import { listReceipts, verifyReceipt } from '../src/shared/receipts.js';
import { readRuntimeStatus, runtimeFile } from '../src/node/runtime-status.js';
import type { AccessMode, ClientKind, ReachProfile } from '../src/shared/protocol.js';
import { arg, flag, localNodeIds, nodeEnvFile, readEnvFile } from './lib/node-files.js';

const execFileAsync = promisify(execFile);
const argv = process.argv.slice(2);
const command = argv[0] || 'status';
const CLIENT_KINDS: ClientKind[] = ['chatgpt', 'claude', 'smoke', 'other'];
const CLIENT_LABEL: Record<ClientKind, string> = { chatgpt: 'ChatGPT', claude: 'Claude', smoke: 'DEX smoke test', other: 'Other MCP clients' };

function usage(): never {
  console.log(`DEX//REACH local control

  status                          show node, connection, AI mode, clients, grants, and recent activity
  enable [--for 30m]              allow remote AI execution temporarily or persistently
  read-only [--for 30m]           allow shell-free inspection only; mutations are refused
  disable                         refuse all remote AI execution
  client <kind> <mode|default>    per-client ceiling
  audit [--limit 20] [--client chatgpt]
  grant <client> <capability> --root <path> --for 30m [--max-uses N]
  grants                          list capability grants
  receipts [--limit 20]           verify and list recent signed node receipts
  grant-clear <client>            remove grants and stop requiring grants for that client
  explain <client> <operation> [--path PATH]
  policy-check                    validate policy schema and built-in safety assertions
  uninstall [--purge-state --yes-delete-state]

Capabilities: ${REACH_CAPABILITIES.join(', ')}
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
  if (ids.length === 0) throw new Error(`no node credential found under ${path.join(stateDir(), 'nodes')}; run enrollment/install first`);
  throw new Error(`multiple nodes found (${ids.join(', ')}); pass --node <id>`);
}

function describeMode(mode: AccessMode): string {
  return mode === 'on' ? 'ENABLED (configured profile applies)' : mode === 'read-only' ? 'READ-ONLY (shell-free inspection only)' : 'DISABLED (all remote AI execution refused)';
}
function remaining(until: string | null): string {
  if (!until) return '';
  const ms = Date.parse(until) - Date.now(); if (ms <= 0) return ' (expired)';
  if (ms < 60_000) return ` (expires in ${Math.ceil(ms / 1000)}s)`;
  const minutes = Math.round(ms / 60_000); return minutes >= 120 ? ` (expires in ${Math.round(minutes / 60)}h)` : ` (expires in ${minutes}m)`;
}
function isNodeSide(e: { source?: string; client?: string }): boolean { return e.source === 'node' || (!e.source && !e.client); }
function formatAuditLine(e: { at: string; actor?: { kind: string; clientName: string }; client?: string; operation: string; ok: boolean; args?: unknown; error?: string }): string {
  const who = e.actor ? `${e.actor.clientName} [${e.actor.kind}]` : e.client ? `client ${e.client.slice(0, 8)}…` : 'unknown client';
  const a = (e.args || {}) as Record<string, unknown>;
  const target = typeof a.path === 'string' ? a.path : typeof a.command === 'string' ? `"${a.command.slice(0, 60)}"` : typeof a.tool === 'string' ? `tool ${a.tool}` : typeof a.cwd === 'string' ? a.cwd : '';
  return `  ${e.at.replace('T', ' ').slice(0, 19)}  ${e.ok ? 'ok     ' : 'REFUSED'}  ${who}  ${e.operation} ${target}${e.ok ? '' : ` — ${(e.error || '').slice(0, 120)}`}`;
}

async function status(): Promise<void> {
  const nodeId = await pickNodeId(); const env = await readEnvFile(nodeEnvFile(nodeId)); const state = await loadAccessState(nodeId);
  const effective = resolveMode(state); const runtime = await readRuntimeStatus(nodeId); const recent = (await new AuditLog().tail(200)).filter(e => e.nodeId === nodeId && isNodeSide(e)).slice(-5);
  const grantLines = state.grants.length ? state.grants.map(g => `  ${g.client.padEnd(8)} ${g.capabilities.join(',')} roots=${g.roots.join(',')} uses=${g.uses}${g.maxUses === null ? '' : '/' + g.maxUses} until=${g.until}`) : ['  (none)'];
  console.log([
    'DEX//REACH', `Node:            ${nodeId}`, `Machine:         ${os.hostname()} (${process.platform}/${process.arch}, user ${os.userInfo().username})`,
    `Node process:    ${runtime ? `running (pid ${runtime.pid})` : 'not running'}`,
    `Gateway:         ${runtime ? (runtime.connected ? `connected to ${runtime.gateway}` : `disconnected from ${runtime.gateway}`) : (env.DEX_REACH_GATEWAY_WS ? `configured ${new URL(env.DEX_REACH_GATEWAY_WS).origin}` : 'not configured')}`,
    `AI access:       ${describeMode(effective)}${state.until && effective === state.mode ? remaining(state.until) + ` then ${state.revertTo ?? 'off'}` : ''}`,
    `Profile:         ${env.DEX_REACH_PROFILE || 'development'}`, 'Allowed roots:', ...(env.DEX_REACH_ALLOWED_ROOTS || os.homedir()).split(path.delimiter).map(r => `  ${r}`),
    'AI clients:', ...CLIENT_KINDS.map(kind => { const mode = modeForActor(state, { kind, clientId: '', clientName: '' }); const ceiling = state.clients[kind] ? ` (limit: ${state.clients[kind]})` : ''; const grants = state.grantRequired[kind] ? ' [GRANTS REQUIRED]' : ''; return `  ${CLIENT_LABEL[kind].padEnd(18)} ${mode === 'off' ? 'blocked' : mode}${ceiling}${grants}`; }),
    'Capability grants:', ...grantLines, 'Recent activity:', ...(recent.length ? recent.map(formatAuditLine) : ['  (none recorded)']), `Policy file:     ${accessFile(nodeId)}`, `Audit log:       ${auditFile()}`
  ].join('\n'));
}

async function setMode(mode: AccessMode): Promise<void> {
  const nodeId = await pickNodeId();
  const duration = arg('--for', argv);
  const next = await updateAccessState(nodeId, current => {
    if (duration) {
      const revertTo = current.until ? (current.revertTo ?? 'off') : resolveMode(current);
      return { ...current, mode, until: new Date(Date.now() + parseDuration(duration)).toISOString(), revertTo };
    }
    return { ...current, mode, until: null, revertTo: null };
  });
  console.log(`${nodeId}: AI access is now ${describeMode(mode)}${next.until ? remaining(next.until) + ` then reverts to ${next.revertTo}` : ""}.`);
  console.log('Takes effect immediately for new requests; an already-reserved in-flight request may finish. No gateway contact required.');
}

async function setClient(): Promise<void> {
  const kind = argv[1] as ClientKind | undefined;
  const mode = argv[2];
  if (!kind || !CLIENT_KINDS.includes(kind) || !mode || (mode !== 'default' && !isAccessMode(mode))) usage();
  const nodeId = await pickNodeId();
  await updateAccessState(nodeId, current => {
    const clients = { ...current.clients };
    if (mode === 'default') delete clients[kind]; else clients[kind] = mode as AccessMode;
    return { ...current, clients };
  });
  console.log(`${nodeId}: ${CLIENT_LABEL[kind]} limit is now ${mode === "default" ? "the node mode" : mode}.`);
}
async function auditCommand(): Promise<void> {
  const nodeId = await pickNodeId(); const limit = Number(arg('--limit', argv) || 20); const client = arg('--client', argv);
  const events = (await new AuditLog().tail(5000)).filter(e => e.nodeId === nodeId && isNodeSide(e) && (!client || e.actor?.kind === client)).slice(-limit);
  console.log(`Last ${events.length} AI requests to ${nodeId}:`); for (const e of events) console.log(formatAuditLine(e));
}
async function grantCommand(): Promise<void> {
  const kind = argv[1] as ClientKind | undefined;
  const capability = argv[2] as ReachCapability | undefined;
  if (!kind || !CLIENT_KINDS.includes(kind) || !capability || !REACH_CAPABILITIES.includes(capability)) usage();
  const root = arg('--root', argv);
  const duration = arg('--for', argv);
  if (!root || !path.isAbsolute(root) || !duration) throw new Error('grant requires an absolute --root and --for duration');
  const maxRaw = arg('--max-uses', argv);
  const maxUses = maxRaw ? Number(maxRaw) : null;
  if (maxUses !== null && (!Number.isInteger(maxUses) || maxUses <= 0)) throw new Error('--max-uses must be a positive integer');
  const nodeId = await pickNodeId();
  const env = await readEnvFile(nodeEnvFile(nodeId));
  const allowedRoots = (env.DEX_REACH_ALLOWED_ROOTS || os.homedir()).split(path.delimiter);
  if (!pathAllowed(root, allowedRoots)) throw new Error("grant root is outside this node's configured allowed roots");
  const next = await updateAccessState(nodeId, current => createGrant(current, kind, [capability], [root], parseDuration(duration), maxUses));
  const created = next.grants[next.grants.length - 1]!;
  console.log(`${nodeId}: grant ${created.id} now constrains ${CLIENT_LABEL[kind]} to ${capability} under ${root} until ${created.until}${maxUses ? ` (${maxUses} uses max)` : ""}.`);
}
async function grantsCommand(): Promise<void> {
  const nodeId = await pickNodeId(); const state = await loadAccessState(nodeId); console.log(`Capability grants for ${nodeId}:`); if (!state.grants.length) console.log('(none)');
  for (const g of state.grants) console.log(`${g.id}  ${g.client}  ${g.capabilities.join(',')}  roots=${g.roots.join(',')}  uses=${g.uses}${g.maxUses === null ? '' : '/' + g.maxUses}  until=${g.until}`);
}
async function grantClearCommand(): Promise<void> {
  const kind = argv[1] as ClientKind | undefined;
  if (!kind || !CLIENT_KINDS.includes(kind)) usage();
  const nodeId = await pickNodeId();
  await updateAccessState(nodeId, current => {
    const grantRequired = { ...current.grantRequired };
    delete grantRequired[kind];
    return { ...current, grantRequired, grants: current.grants.filter(grant => grant.client !== kind) };
  });
  console.log(`${nodeId}: cleared ${CLIENT_LABEL[kind]} grants and restored normal node/client policy behavior.`);
}
async function explainCommand(): Promise<void> {
  const kind = argv[1] as ClientKind | undefined; const operation = argv[2]; if (!kind || !CLIENT_KINDS.includes(kind) || !operation) usage();
  const nodeId = await pickNodeId(); const state = await loadAccessState(nodeId); const env = await readEnvFile(nodeEnvFile(nodeId)); const profile = (env.DEX_REACH_PROFILE || 'development') as ReachProfile; const args: Record<string, unknown> = {}; const p = arg('--path', argv); if (p) args.path = p;
  const decision = authorizeOperation(state, { kind, clientId: 'local-explain', clientName: CLIENT_LABEL[kind] }, operation, profile, Date.now(), args); console.log(JSON.stringify({ nodeId, kind, operation, args, decision }, null, 2));
}
async function policyCheckCommand(): Promise<void> {
  const nodeId = await pickNodeId();
  const inspection = await inspectAccessPolicyFile(nodeId);
  if (!inspection.valid) throw new Error(`policy check failed: ${inspection.errors.join("; ")}`);
  console.log(`${nodeId}: policy check PASS (schema v${inspection.state.version}, revision ${inspection.state.revision}, OFF/read-only invariants + grant validation).`);
}

async function receiptsCommand(): Promise<void> {
  const nodeId = await pickNodeId();
  const limit = Math.max(1, Math.min(Number(arg('--limit', argv) || 20), 100));
  const receipts = await listReceipts(nodeId, limit);
  const linear = receipts.length <= 1 || receipts.every((receipt, index) => index === 0 || receipt.previousHash === receipts[index - 1]!.receiptHash);
  const signatures = receipts.every(receipt => verifyReceipt(receipt));
  console.log(`Recent signed receipts for ${nodeId}: ${receipts.length} (signatures=${signatures ? "PASS" : "FAIL"}, returned-chain=${linear ? "PASS" : "PARTIAL"})`);
  for (const receipt of receipts) console.log(`  ${receipt.at}  ${receipt.ok ? "ok" : "REFUSED"}  ${receipt.operation}  id=${receipt.receiptId}  hash=${receipt.receiptHash.slice(0, 12)}…`);
}
async function uninstall(): Promise<void> {
  const nodeId = await pickNodeId();
  if (process.platform === 'darwin') { const label = 'com.stinkyweasel.dex-reach.node'; const plist = path.join(os.homedir(), 'Library', 'LaunchAgents', `${label}.plist`); try { await execFileAsync('launchctl', ['bootout', `gui/${process.getuid?.() ?? os.userInfo().uid}`, plist]); } catch {} await fs.rm(plist, { force: true }); console.log(`Removed launchd service ${label} (if installed).`); }
  else if (process.platform === 'linux') { const unit = path.join(os.homedir(), '.config', 'systemd', 'user', 'dex-reach-node.service'); try { await execFileAsync('systemctl', ['--user', 'disable', '--now', 'dex-reach-node.service']); } catch {} await fs.rm(unit, { force: true }); console.log('Removed systemd user unit dex-reach-node.service (if installed).'); }
  else console.log('No service manager integration on this platform; stop any manually started node process.');
  await fs.rm(runtimeFile(nodeId), { force: true });
  if (flag('--purge-state', argv)) { if (!flag('--yes-delete-state', argv)) throw new Error('--purge-state deletes this node\'s credential and policy; add --yes-delete-state to confirm'); await fs.rm(nodeEnvFile(nodeId), { force: true }); await fs.rm(accessFile(nodeId), { force: true }); console.log(`Deleted local credential and policy for ${nodeId}.`); }
  else console.log(`Local state under ${stateDir()} was preserved.`);
}

try {
  switch (command) {
    case 'status': await status(); break;
    case 'enable': case 'on': await setMode('on'); break;
    case 'read-only': case 'readonly': await setMode('read-only'); break;
    case 'disable': case 'off': await setMode('off'); break;
    case 'client': await setClient(); break;
    case 'audit': await auditCommand(); break;
    case 'grant': await grantCommand(); break;
    case 'grants': await grantsCommand(); break;
    case 'receipts': await receiptsCommand(); break;
    case 'grant-clear': await grantClearCommand(); break;
    case 'explain': await explainCommand(); break;
    case 'policy-check': await policyCheckCommand(); break;
    case 'uninstall': await uninstall(); break;
    case 'modes': console.log(ACCESS_MODES.join('\n')); break;
    default: usage();
  }
} catch (error) { console.error(`dex-reach: ${error instanceof Error ? error.message : String(error)}`); process.exit(1); }
