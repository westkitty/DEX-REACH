#!/usr/bin/env node
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { stateDir } from '../src/shared/local-env.js';
import { pathAllowed } from '../src/shared/security.js';
import { ACCESS_MODES, accessFile, authorizeOperation, createGrant, inspectAccessPolicyFile, isAccessMode, loadAccessState, modeForActor, parseDuration, resolveMode, restorePolicyRevision, updateAccessState } from '../src/shared/access.js';
import { REACH_CAPABILITIES, type ReachCapability } from '../src/shared/capabilities.js';
import { listSecretAliases, removeSecret, setSecret } from '../src/shared/secrets.js';
import { AuditLog, auditFile } from '../src/shared/audit.js';
import { listReceipts, verifyReceipt } from '../src/shared/receipts.js';
import { readRuntimeStatus, runtimeFile } from '../src/node/runtime-status.js';
import { portfolio, resolveProject } from '../src/node/projects.js';
import { createCheckpoint } from '../src/node/native.js';
import type { AccessMode, ClientKind, ReachProfile } from '../src/shared/protocol.js';
import { describeProfile, workspaceSafeOperationRefusal } from '../src/shared/profiles.js';
import { arg, flag, localNodeIds, nodeEnvFile, readEnvFile } from './lib/node-files.js';
import { WORK_ACCESS_CLASSES, WORK_EXECUTORS, WORK_WORKLOAD_CLASSES, acquireWork, cancelTicket, describeWorkStatus, heartbeat, redactWorkStatusForShare, releaseWork, workStatus } from '../src/shared/work-coordinator.js';
import type { AccessClass, WorkloadClass } from '../src/shared/machine-capacity.js';
import type { WorkExecutor } from '../src/shared/work-coordinator.js';
import { describeTrace, isValidTraceId, listTraces, otelExportEnabled, readTrace } from '../src/shared/trace.js';
import {
  BUDGET_SCOPES,
  clearBudgetRule,
  inspectBudgetPolicy,
  isBudgetScope,
  listBudgetRules,
  makeBudgetRule,
  policyRestricts,
  upsertBudgetRule,
  type BudgetScope
} from '../src/shared/budget-policy.js';
import { loadBudgetUsage, resetBudgetUsage, usedInWindow } from '../src/shared/budget-usage.js';
import {
  approveCapabilityRequest,
  createCapabilityRequest,
  denyCapabilityRequest,
  listCapabilityRequests
} from '../src/shared/capability-requests.js';
import { addPolicyAssertion, clearPolicyAssertion, listPolicyHistory, loadPolicyAssertions } from '../src/shared/policy-assertions.js';
import { collectDoctorReport, formatDoctorReport } from '../src/shared/doctor.js';

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
  projects [--root PATH] [--depth N] [--json]  discover local Git projects and show portfolio status
  dirty [--root PATH] [--depth N] [--json]     show only projects with uncommitted changes
  project <query> [info|checkpoint] [--json]   inspect or checkpoint one uniquely matched project
  grant-clear <client>            remove grants and stop requiring grants for that client
  explain <client> <operation> [--path PATH]
  policy-check                    validate policy schema and built-in safety assertions
  budgets [--json]                show rolling execution budgets and current usage
  budget set <shared|chatgpt|claude|smoke|other> --window 1h
                                  [--max-operations N] [--max-mutations N] [--max-shell N]
                                  [--max-write-bytes N] [--max-process-ms N] [--max-concurrent N]
  budget clear <id>               remove one budget rule (shared, a client kind, or its id)
  requests [--json]               list capability requests (pending/approved/denied/expired)
  request create <client> <capability> --root PATH --for 30m [--max-uses N]
                                  --justification TEXT [--operation NAME]
  request approve <id> [--capability C] [--root PATH] [--for 30m] [--max-uses N]
  request deny <id>               refuse a pending request; creates no grant
  secrets [--json]                list node-local secret aliases (never values)
  secret set <alias> --env NAME   store a secret; the value is read from stdin, never from argv
  secret rm <alias>               remove one stored secret
  assertions [--json]             list custom policy assertions
  assertion add <client> --note TEXT [--forbid CAP] [--write-root PATH]
  assertion clear <id>
  policy-history [--limit 20] [--json]
  policy-restore <revision>       restore an old policy as a NEW revision
  doctor [--json] [--deep] [--share]  read-only diagnostics; --share redacts local paths
  uninstall [--purge-state --yes-delete-state]

Shared-machine work coordination (resource admission only; grants no execution authority):
  work-status [--json] [--share]  machine capacity, active leases, queue depth, observed load
  work-queue [--json]             queued tickets in FIFO order
  work-acquire --repo PATH --access read|mutate|exclusive --workload light|medium|heavy
                [--executor claude-code|chatgpt|codex|grok|human|other] [--phase LABEL]
                [--pid N] [--branch NAME] [--json]
                --pid names the long-lived process that owns the work. Without it the lease is
                owned by this short-lived command and must be kept alive by work-heartbeat.
  work-release <lease-id> [--force]
  work-wait <ticket-id> [--timeout 30m]   bounded polling until the ticket is admitted
  work-cancel <ticket-id>
  work-heartbeat <lease-or-ticket-id>

Causal tracing (evidence only; never arguments, file contents or process output):
  trace <trace-id> [--json]       reconstruct one causal chain across MCP, node, plan, commit,
                                  execution, receipt and checkpoint
  traces [--limit 20] [--json]    recent trace ids

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
  const decision = authorizeOperation(state, { kind, clientId: 'local-explain', clientName: CLIENT_LABEL[kind] }, operation, profile, Date.now(), args);
  // The node's execution profile is a second narrowing the policy decision does not carry, so a
  // report that showed only the policy answer would tell the owner an operation is permitted that
  // the node would refuse. Both narrowings are reported, and the operation runs only if both allow.
  const profileRefusal = workspaceSafeOperationRefusal(profile, operation);
  const wouldRun = decision.allowed && !profileRefusal;
  console.log(JSON.stringify({
    nodeId, kind, operation, args,
    policy: decision,
    profile: { configured: profile, description: describeProfile(profile), refusal: profileRefusal },
    wouldRun
  }, null, 2));
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

function configuredRoots(env: Record<string, string>): string[] {
  return (env.DEX_REACH_ALLOWED_ROOTS || os.homedir()).split(path.delimiter).filter(Boolean);
}

function defaultPortfolioRoots(allowedRoots: string[]): string[] {
  const home = os.homedir();
  return pathAllowed(home, allowedRoots) ? [home] : allowedRoots.slice(0, 1);
}

async function portfolioCommand(onlyDirty = false): Promise<void> {
  const nodeId = await pickNodeId();
  const env = await readEnvFile(nodeEnvFile(nodeId));
  const allowedRoots = configuredRoots(env);
  const requestedRoot = arg('--root', argv);
  let roots = defaultPortfolioRoots(allowedRoots);
  if (requestedRoot) {
    if (!path.isAbsolute(requestedRoot)) throw new Error('--root must be an absolute path');
    if (!pathAllowed(requestedRoot, allowedRoots)) throw new Error("requested project root is outside this node's configured allowed roots");
    roots = [requestedRoot];
  }
  const depthRaw = Number(arg('--depth', argv) || 3);
  if (!Number.isInteger(depthRaw) || depthRaw < 0 || depthRaw > 8) throw new Error('--depth must be an integer from 0 through 8');
  let projects = await portfolio(roots, { maxDepth: depthRaw });
  if (onlyDirty) projects = projects.filter(project => project.dirty);
  if (flag('--json', argv)) {
    console.log(JSON.stringify({ nodeId, roots, count: projects.length, projects }, null, 2));
    return;
  }
  const heading = onlyDirty ? 'Dirty Git projects' : 'Git project portfolio';
  console.log(`${heading} for ${nodeId}: ${projects.length}`);
  for (const project of projects) {
    const sync = project.ahead === null ? '' : ` ↑${project.ahead} ↓${project.behind}`;
    const dirty = project.dirty ? `DIRTY(${project.changes})` : 'clean';
    console.log(`${dirty.padEnd(12)} ${project.branch.padEnd(28)}${sync.padEnd(10)} ${project.path}`);
  }
}

async function projectCommand(): Promise<void> {
  const query = argv[1];
  const action = argv[2] && !argv[2]!.startsWith('--') ? argv[2] : 'info';
  if (!query || !['info', 'checkpoint'].includes(action)) usage();
  const nodeId = await pickNodeId();
  const env = await readEnvFile(nodeEnvFile(nodeId));
  const allowedRoots = configuredRoots(env);
  const roots = defaultPortfolioRoots(allowedRoots);
  const projects = await portfolio(roots, { maxDepth: 3 });
  const project = resolveProject(query, projects);
  if (action === 'checkpoint') {
    const checkpoint = await createCheckpoint(project.path);
    console.log(JSON.stringify({ nodeId, project, checkpoint }, null, 2));
    return;
  }
  if (flag('--json', argv)) console.log(JSON.stringify({ nodeId, project }, null, 2));
  else {
    console.log([
      project.name,
      `Path:     ${project.path}`,
      `Branch:   ${project.branch}`,
      `Remote:   ${project.remote ?? '(none)'}`,
      `Status:   ${project.dirty ? `DIRTY (${project.changes} changes)` : 'clean'}`,
      `Upstream: ${project.upstream ?? '(none)'}`,
      `Sync:     ${project.ahead === null ? 'unknown' : `ahead ${project.ahead}, behind ${project.behind}`}`
    ].join('\n'));
  }
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


// --- Shared-machine work coordination -------------------------------------
// These commands answer "can this run now?". They never answer "is this allowed?": owner mode,
// client ceilings, grants, roots, profiles and plans are unaffected by any lease (DEX-INV-022).

function workOption<T extends string>(name: string, allowed: readonly T[], fallback: T): T {
  const value = arg(name, argv);
  if (value === undefined) return fallback;
  if (!(allowed as readonly string[]).includes(value)) throw new Error(`${name} must be one of: ${allowed.join(', ')}`);
  return value as T;
}

async function workStatusCommand(): Promise<void> {
  const status = await workStatus();
  if (flag('--share', argv)) { console.log(JSON.stringify(redactWorkStatusForShare(status), null, 2)); return; }
  if (flag('--json', argv)) { console.log(JSON.stringify(status, null, 2)); return; }
  console.log(describeWorkStatus(status).join('\n'));
  console.log(`\nAdmission for a new medium mutating job: ${status.capacity.canAdmit ? 'AVAILABLE' : 'QUEUE'}`);
  for (const reason of status.capacity.reasons) console.log(`  ${reason}`);
  console.log('\nMachine admission is not execution authority. Run `dex explain` for the authorization question.');
}

async function workQueueCommand(): Promise<void> {
  const status = await workStatus();
  if (flag('--json', argv)) { console.log(JSON.stringify(status.tickets, null, 2)); return; }
  if (!status.tickets.length) { console.log('Work queue is empty.'); return; }
  console.log(`Work queue (FIFO, ${status.tickets.length} waiting):`);
  status.tickets.forEach((ticket, index) => {
    const where = ticket.repositoryRoot ? path.basename(ticket.repositoryRoot) : 'machine';
    console.log(`  ${String(index + 1).padStart(2)}. ${ticket.id}  ${ticket.executor.padEnd(11)} ${where} / ${ticket.workload} / ${ticket.access}  since ${ticket.enqueuedAt.replace('T', ' ').slice(0, 19)}`);
  });
}

function workPid(): number | undefined {
  const value = arg('--pid', argv);
  if (value === undefined) return undefined;
  const pid = Number.parseInt(value, 10);
  if (!Number.isInteger(pid) || pid <= 0) throw new Error('--pid must be a positive process id');
  return pid;
}

async function workAcquireCommand(): Promise<void> {
  const result = await acquireWork({
    executor: workOption<WorkExecutor>('--executor', WORK_EXECUTORS, 'other'),
    access: workOption<AccessClass>('--access', WORK_ACCESS_CLASSES, 'read'),
    workload: workOption<WorkloadClass>('--workload', WORK_WORKLOAD_CLASSES, 'light'),
    repositoryRoot: arg('--repo', argv),
    branch: arg('--branch', argv),
    phase: arg('--phase', argv),
    ticketId: arg('--ticket', argv),
    pid: workPid()
  });
  if (flag('--json', argv)) { console.log(JSON.stringify(result, null, 2)); if (result.status === 'queued') process.exitCode = 3; return; }
  if (result.status === 'acquired') {
    console.log(`ADMITTED  lease ${result.lease.id}`);
    console.log(`  ${result.lease.workload} / ${result.lease.access}${result.lease.repositoryRoot ? ` on ${result.lease.repositoryRoot}` : ''}`);
    console.log(`  Owning process: ${result.lease.pid}`);
    console.log(`  Heartbeat with: npm run dex -- work-heartbeat ${result.lease.id}  (every ~30s, or the lease expires after 2.5 minutes without one)`);
    console.log(`  Release with:   npm run dex -- work-release ${result.lease.id}`);
    console.log('  This lease reserves machine capacity only; it grants no execution authority.');
    return;
  }
  console.log(`QUEUED    ticket ${result.ticket.id} (position ${result.position})`);
  for (const reason of result.reasons) console.log(`  ${reason}`);
  console.log(`  Wait with: npm run dex -- work-wait ${result.ticket.id}`);
  process.exitCode = 3;
}

async function workReleaseCommand(): Promise<void> {
  const id = argv[1];
  if (!id) throw new Error('usage: work-release <lease-id> [--force]');
  const result = await releaseWork(id, { force: flag('--force', argv) });
  if (!result.released) throw new Error(result.reason || `could not release ${id}`);
  console.log(`Released ${id}.`);
}

async function workCancelCommand(): Promise<void> {
  const id = argv[1];
  if (!id) throw new Error('usage: work-cancel <ticket-id>');
  if (!(await cancelTicket(id))) throw new Error(`no queued ticket ${id}`);
  console.log(`Cancelled ${id}. Other waiters keep their positions.`);
}

async function workHeartbeatCommand(): Promise<void> {
  const id = argv[1];
  if (!id) throw new Error('usage: work-heartbeat <lease-or-ticket-id>');
  if (!(await heartbeat(id))) throw new Error(`no active lease or ticket ${id}`);
  console.log(`Heartbeat recorded for ${id}.`);
}

function optionalCeiling(name: string): number | null {
  const raw = arg(name, argv);
  if (raw === undefined) return null;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer`);
  return value;
}

function describeBudgetRule(rule: ReturnType<typeof listBudgetRules>[number], usage: Awaited<ReturnType<typeof loadBudgetUsage>>, now: number): string {
  const used = usedInWindow(usage, rule.id === 'shared' ? 'shared' : rule.id as ClientKind, rule.windowMs, now);
  const parts: string[] = [];
  const show = (label: string, max: number | null, current: number) => {
    if (max === null) return;
    parts.push(`${label} ${current}/${max}`);
  };
  show('ops', rule.maxOperations, used.operations);
  show('mutations', rule.maxMutations, used.mutations);
  show('shell', rule.maxShellCalls, used.shellCalls);
  show('write-bytes', rule.maxRequestedWriteBytes, used.requestedWriteBytes);
  show('process-ms', rule.maxRequestedProcessMs, used.requestedProcessMs);
  if (rule.maxConcurrent !== null) {
    const active = rule.id === 'shared' ? usage.inflight.length : usage.inflight.filter(entry => entry.client === rule.id).length;
    parts.push(`concurrent ${active}/${rule.maxConcurrent}`);
  }
  const windowMin = rule.windowMs / 60_000;
  const window = windowMin >= 60 ? `${windowMin / 60}h` : `${windowMin}m`;
  return `  ${rule.id.padEnd(8)} window=${window}  ${parts.join(', ') || '(no ceilings)'}`;
}

async function budgetsCommand(): Promise<void> {
  const nodeId = await pickNodeId();
  const inspection = await inspectBudgetPolicy(nodeId);
  const usage = inspection.unrestricted ? { version: 1 as const, samples: [], inflight: [] } : await loadBudgetUsage(nodeId).catch(() => ({ version: 1 as const, samples: [], inflight: [] }));
  if (flag('--json', argv)) {
    console.log(JSON.stringify({ nodeId, unrestricted: inspection.unrestricted, valid: inspection.valid, exists: inspection.exists, policy: inspection.policy, usage, errors: inspection.errors }, null, 2));
    return;
  }
  if (inspection.unrestricted) {
    console.log(`${nodeId}: no execution budget configured. Owner mode, client ceilings, grants, roots and profile still govern authority.`);
    if (!inspection.valid) console.log(`  note: ${inspection.errors.join('; ')}`);
    return;
  }
  const now = Date.now();
  console.log(`Execution budgets for ${nodeId} (restrictions only; they never grant authority):`);
  for (const rule of listBudgetRules(inspection.policy)) console.log(describeBudgetRule(rule, usage, now));
  console.log(`  inflight slots: ${usage.inflight.length}`);
}

async function budgetSetCommand(): Promise<void> {
  const scope = argv[2];
  if (!isBudgetScope(scope)) throw new Error(`usage: budget set <${BUDGET_SCOPES.join('|')}> --window 1h [--max-operations N] ...`);
  const windowRaw = arg('--window', argv);
  if (!windowRaw) throw new Error('budget set requires --window (e.g. 1h, 30m)');
  const rule = makeBudgetRule(scope, parseDuration(windowRaw), {
    maxOperations: optionalCeiling('--max-operations'),
    maxMutations: optionalCeiling('--max-mutations'),
    maxShellCalls: optionalCeiling('--max-shell'),
    maxRequestedWriteBytes: optionalCeiling('--max-write-bytes'),
    maxRequestedProcessMs: optionalCeiling('--max-process-ms'),
    maxConcurrent: optionalCeiling('--max-concurrent')
  });
  const nodeId = await pickNodeId();
  const next = await upsertBudgetRule(nodeId, scope as BudgetScope, rule);
  console.log(`${nodeId}: budget ${rule.id} now restricts ${scope} (window ${windowRaw}). Budgets only narrow authority; they never grant it.`);
  console.log(`  revision ${next.revision}`);
}

async function requestsCommand(): Promise<void> {
  const nodeId = await pickNodeId();
  const requests = await listCapabilityRequests(nodeId);
  if (flag('--json', argv)) { console.log(JSON.stringify({ nodeId, requests }, null, 2)); return; }
  if (!requests.length) { console.log(`${nodeId}: no capability requests.`); return; }
  console.log(`Capability requests for ${nodeId} (a request is not a grant):`);
  for (const request of requests) {
    console.log(`  ${request.id}  ${request.status.padEnd(8)} ${request.client}  ${request.capabilities.join(',')}  roots=${request.roots.join(',')}  for=${Math.round(request.durationMs / 60_000)}m  ${request.justification}`);
  }
}

async function requestCreateCommand(): Promise<void> {
  const kind = argv[2] as ClientKind | undefined;
  const capability = argv[3] as ReachCapability | undefined;
  if (!kind || !CLIENT_KINDS.includes(kind) || !capability || !REACH_CAPABILITIES.includes(capability)) {
    throw new Error('usage: request create <client> <capability> --root PATH --for 30m --justification TEXT');
  }
  const root = arg('--root', argv);
  const duration = arg('--for', argv);
  const justification = arg('--justification', argv);
  if (!root || !path.isAbsolute(root) || !duration || !justification) {
    throw new Error('request create requires an absolute --root, --for duration, and --justification');
  }
  const maxRaw = arg('--max-uses', argv);
  const maxUses = maxRaw ? Number(maxRaw) : null;
  if (maxUses !== null && (!Number.isInteger(maxUses) || maxUses <= 0)) throw new Error('--max-uses must be a positive integer');
  const nodeId = await pickNodeId();
  const env = await readEnvFile(nodeEnvFile(nodeId));
  const allowedRoots = (env.DEX_REACH_ALLOWED_ROOTS || os.homedir()).split(path.delimiter);
  if (!pathAllowed(root, allowedRoots)) throw new Error("request root is outside this node's configured allowed roots");
  const created = await createCapabilityRequest(nodeId, {
    client: kind,
    capabilities: [capability],
    roots: [root],
    durationMs: parseDuration(duration),
    maxUses,
    justification,
    operation: arg('--operation', argv)
  });
  console.log(`${nodeId}: recorded request ${created.id} from ${kind} for ${capability}. This is not a grant. Approve locally with: npm run dex -- request approve ${created.id}`);
}

async function requestApproveCommand(): Promise<void> {
  const id = argv[2];
  if (!id) throw new Error('usage: request approve <id> [--capability C] [--root PATH] [--for 30m] [--max-uses N]');
  const nodeId = await pickNodeId();
  const capability = arg('--capability', argv) as ReachCapability | undefined;
  if (capability && !REACH_CAPABILITIES.includes(capability)) throw new Error(`unknown capability ${capability}`);
  const root = arg('--root', argv);
  const duration = arg('--for', argv);
  const maxRaw = arg('--max-uses', argv);
  const maxUses = maxRaw ? Number(maxRaw) : undefined;
  if (maxUses !== undefined && (!Number.isInteger(maxUses) || maxUses <= 0)) throw new Error('--max-uses must be a positive integer');
  const result = await approveCapabilityRequest(nodeId, id, {
    ...(capability ? { capabilities: [capability] } : {}),
    ...(root ? { roots: [root] } : {}),
    ...(duration ? { durationMs: parseDuration(duration) } : {}),
    ...(maxUses !== undefined ? { maxUses } : {})
  });
  console.log(`${nodeId}: approved request ${id} as grant ${result.grantId}${result.request.narrowed ? ' (narrowed)' : ''}. Remote AI still cannot raise this grant.`);
}

// ---------------------------------------------------------------------------
// EXPERIMENTAL node-local secret broker
// ---------------------------------------------------------------------------

/**
 * Read a secret value without it ever appearing in argv.
 *
 * A value passed as a command-line argument is visible in the process table to every other process
 * on the machine and is written to the owner's shell history, so it is refused outright rather than
 * accepted with a warning. When stdin is a terminal, echo is disabled while typing; when it is a
 * pipe, the value is read from it, which is what makes `... | dex secret set` work in a script
 * without the value ever being an argument.
 */
async function readSecretValue(): Promise<string> {
  for (const rejected of ['--value', '--secret', '--password']) {
    if (argv.includes(rejected)) {
      throw new Error(`refusing ${rejected}: a secret on the command line is visible in the process table and in shell history. Pipe it in, or type it at the prompt.`);
    }
  }
  if (!process.stdin.isTTY) {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '');
  }
  const readline = await import('node:readline');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  const asMutable = rl as unknown as { output?: NodeJS.WriteStream; _writeToOutput?: (text: string) => void };
  asMutable._writeToOutput = () => {};
  process.stdout.write('Secret value (not echoed): ');
  try {
    return await new Promise<string>(resolve => rl.question('', answer => resolve(answer)));
  } finally {
    rl.close();
    process.stdout.write('\n');
  }
}

async function secretsCommand(): Promise<void> {
  const nodeId = await pickNodeId();
  const aliases = await listSecretAliases(nodeId);
  if (flag('--json', argv)) { console.log(JSON.stringify({ nodeId, secrets: aliases }, null, 2)); return; }
  if (!aliases.length) { console.log(`${nodeId}: no stored secrets.`); return; }
  console.log(`Node-local secrets for ${nodeId} (EXPERIMENTAL; aliases only, values never leave this node):`);
  for (const info of aliases) {
    console.log(`  ${info.alias.padEnd(24)} -> $${info.env.padEnd(24)} id ${info.fingerprint}  updated ${info.updatedAt.replace('T', ' ').slice(0, 19)}`);
  }
  console.log('  A model names an alias. It never receives a value, and secret.use is required on top of whatever the operation itself needs.');
}

async function secretSetCommand(): Promise<void> {
  const alias = argv[2];
  const env = arg('--env', argv);
  if (!alias || !env) throw new Error('usage: secret set <alias> --env NAME   (value is read from stdin, never from argv)');
  const nodeId = await pickNodeId();
  const value = await readSecretValue();
  const result = await setSecret(nodeId, alias, env, value);
  console.log(`${nodeId}: ${result.replaced ? 'replaced' : 'stored'} secret ${result.info.alias} -> $${result.info.env} (id ${result.info.fingerprint}).`);
  console.log('  The value stays on this node. Grant secret.use separately; process.shell alone does not permit it.');
}

async function secretRemoveCommand(): Promise<void> {
  const alias = argv[2];
  if (!alias) throw new Error('usage: secret rm <alias>');
  const nodeId = await pickNodeId();
  if (!(await removeSecret(nodeId, alias))) throw new Error(`no secret alias ${alias}`);
  console.log(`${nodeId}: removed secret ${alias}.`);
}

async function assertionsCommand(): Promise<void> {
  const nodeId = await pickNodeId();
  const assertions = await loadPolicyAssertions(nodeId);
  if (flag('--json', argv)) { console.log(JSON.stringify({ nodeId, assertions }, null, 2)); return; }
  if (!assertions.length) { console.log(`${nodeId}: no custom policy assertions.`); return; }
  console.log(`Policy assertions for ${nodeId} (regression tests against the real policy engine):`);
  for (const assertion of assertions) {
    const forbid = assertion.forbidCapabilities.length ? ` forbid=${assertion.forbidCapabilities.join(',')}` : '';
    const roots = assertion.writeRoots.length ? ` write-roots=${assertion.writeRoots.join(',')}` : '';
    console.log(`  ${assertion.id}  ${assertion.client}${forbid}${roots}  ${assertion.note}`);
  }
}

async function assertionAddCommand(): Promise<void> {
  const kind = argv[2] as ClientKind | undefined;
  if (!kind || !CLIENT_KINDS.includes(kind)) throw new Error('usage: assertion add <client> --note TEXT [--forbid CAP] [--write-root PATH]');
  const note = arg('--note', argv);
  if (!note) throw new Error('assertion add requires --note');
  const forbid = arg('--forbid', argv) as ReachCapability | undefined;
  if (forbid && !REACH_CAPABILITIES.includes(forbid)) throw new Error(`unknown capability ${forbid}`);
  const writeRoot = arg('--write-root', argv);
  const nodeId = await pickNodeId();
  const created = await addPolicyAssertion(nodeId, {
    client: kind,
    note,
    ...(forbid ? { forbidCapabilities: [forbid] } : {}),
    ...(writeRoot ? { writeRoots: [writeRoot] } : {})
  });
  console.log(`${nodeId}: assertion ${created.id} will refuse owner-policy writes that violate: ${created.note}`);
}

async function assertionClearCommand(): Promise<void> {
  const id = argv[2];
  if (!id) throw new Error('usage: assertion clear <id>');
  const nodeId = await pickNodeId();
  await clearPolicyAssertion(nodeId, id);
  console.log(`${nodeId}: cleared assertion ${id}.`);
}

async function policyHistoryCommand(): Promise<void> {
  const nodeId = await pickNodeId();
  const limit = Number(arg('--limit', argv) || 20);
  const entries = await listPolicyHistory(nodeId, Number.isFinite(limit) && limit > 0 ? limit : 20);
  if (flag('--json', argv)) { console.log(JSON.stringify(entries.map(({ state, ...rest }) => rest), null, 2)); return; }
  if (!entries.length) { console.log(`${nodeId}: no policy history yet.`); return; }
  console.log(`Policy history for ${nodeId} (append-only; restore creates a new revision):`);
  for (const entry of entries) {
    console.log(`  rev ${String(entry.revision).padStart(4)}  ${entry.at.replace('T', ' ').slice(0, 19)}  ${entry.hash.slice(0, 12)}…${entry.restoredFrom !== null ? `  restored-from ${entry.restoredFrom}` : ''}`);
  }
}

async function doctorCommand(): Promise<void> {
  const nodeId = await pickNodeId().catch(() => undefined);
  const report = await collectDoctorReport({
    json: flag('--json', argv),
    deep: flag('--deep', argv),
    share: flag('--share', argv),
    repoRoot: process.cwd(),
    nodeId
  });
  if (flag('--json', argv) || flag('--share', argv)) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  console.log(formatDoctorReport(report).join('\n'));
}

async function policyRestoreCommand(): Promise<void> {
  const revision = Number(argv[1]);
  if (!Number.isInteger(revision) || revision < 0) throw new Error('usage: policy-restore <revision>');
  const nodeId = await pickNodeId();
  const next = await restorePolicyRevision(nodeId, revision);
  console.log(`${nodeId}: restored policy from revision ${revision} as new revision ${next.revision}. History was not rewritten.`);
}

async function requestDenyCommand(): Promise<void> {
  const id = argv[2];
  if (!id) throw new Error('usage: request deny <id>');
  const nodeId = await pickNodeId();
  const denied = await denyCapabilityRequest(nodeId, id);
  console.log(`${nodeId}: denied request ${denied.id}. No grant was created.`);
}

async function budgetClearCommand(): Promise<void> {
  const id = argv[2];
  if (!id) throw new Error('usage: budget clear <id>');
  const nodeId = await pickNodeId();
  const next = await clearBudgetRule(nodeId, id);
  if (!policyRestricts(next)) await resetBudgetUsage(nodeId);
  console.log(`${nodeId}: cleared budget ${id}.${policyRestricts(next) ? '' : ' No remaining budget rules; usage counters reset.'}`);
}

async function workWaitCommand(): Promise<void> {
  const ticketId = argv[1];
  if (!ticketId) throw new Error('usage: work-wait <ticket-id> [--timeout 30m]');
  const timeoutMs = parseDuration(arg('--timeout', argv) || '30m');
  const deadline = Date.now() + timeoutMs;
  const pollMs = 25_000;
  const status = await workStatus();
  const ticket = status.tickets.find(entry => entry.id === ticketId);
  if (!ticket) throw new Error(`no queued ticket ${ticketId}`);

  // Bounded low-cost polling. Waiting is a valid outcome, not a failure.
  while (true) {
    const result = await acquireWork({
      executor: ticket.executor,
      access: ticket.access,
      workload: ticket.workload,
      repositoryRoot: ticket.repositoryRoot,
      phase: ticket.phase,
      ticketId
    });
    if (result.status === 'acquired') {
      console.log(`ADMITTED  lease ${result.lease.id}`);
      console.log(`  Release with: npm run dex -- work-release ${result.lease.id}`);
      return;
    }
    if (Date.now() >= deadline) {
      console.log(`STILL QUEUED  ticket ${ticketId} (position ${result.position}) after waiting.`);
      console.log('  The ticket remains valid. This is QUEUED, not FAILED.');
      process.exitCode = 3;
      return;
    }
    console.log(`  queued at position ${result.position}: ${result.reasons[0] ?? 'waiting'}`);
    await new Promise(resolve => setTimeout(resolve, Math.min(pollMs, Math.max(1000, deadline - Date.now()))));
  }
}



// --- Causal tracing ---------------------------------------------------------

async function traceCommand(): Promise<void> {
  const traceId = argv[1];
  if (!traceId) throw new Error('usage: trace <trace-id> [--json]');
  if (!isValidTraceId(traceId)) throw new Error('trace id must be 32 lowercase hex characters');
  const spans = await readTrace(traceId);
  if (flag('--json', argv)) { console.log(JSON.stringify(spans, null, 2)); return; }
  console.log(describeTrace(spans).join('\n'));
  if (!spans.length) return;
  console.log(`OpenTelemetry export: ${otelExportEnabled() ? 'ENABLED by DEX_REACH_OTEL_EXPORT' : 'off (default)'}`);
}

async function tracesCommand(): Promise<void> {
  const limit = Number(arg('--limit', argv) || 20);
  const traces = await listTraces(Number.isFinite(limit) && limit > 0 ? limit : 20);
  if (flag('--json', argv)) { console.log(JSON.stringify(traces, null, 2)); return; }
  if (!traces.length) { console.log('No traces recorded.'); return; }
  console.log(`Recent traces (${traces.length}):`);
  for (const entry of traces) {
    console.log(`  ${entry.traceId}  ${String(entry.spans).padStart(3)} steps  last ${entry.at.replace('T', ' ').slice(0, 19)}`);
  }
  console.log('\nInspect one with: npm run dex -- trace <trace-id>');
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
    case 'projects': await portfolioCommand(false); break;
    case 'dirty': await portfolioCommand(true); break;
    case 'project': await projectCommand(); break;
    case 'grant-clear': await grantClearCommand(); break;
    case 'explain': await explainCommand(); break;
    case 'policy-check': await policyCheckCommand(); break;
    case 'budgets': await budgetsCommand(); break;
    case 'budget':
      if (argv[1] === 'set') await budgetSetCommand();
      else if (argv[1] === 'clear') await budgetClearCommand();
      else usage();
      break;
    case 'requests': await requestsCommand(); break;
    case 'request':
      if (argv[1] === 'create') await requestCreateCommand();
      else if (argv[1] === 'approve') await requestApproveCommand();
      else if (argv[1] === 'deny') await requestDenyCommand();
      else usage();
      break;
    case 'secrets': await secretsCommand(); break;
    case 'secret':
      if (argv[1] === 'set') await secretSetCommand();
      else if (argv[1] === 'rm') await secretRemoveCommand();
      else usage();
      break;
    case 'assertions': await assertionsCommand(); break;
    case 'assertion':
      if (argv[1] === 'add') await assertionAddCommand();
      else if (argv[1] === 'clear') await assertionClearCommand();
      else usage();
      break;
    case 'policy-history': await policyHistoryCommand(); break;
    case 'policy-restore': await policyRestoreCommand(); break;
    case 'doctor': await doctorCommand(); break;
    case 'uninstall': await uninstall(); break;
    case 'work-status': await workStatusCommand(); break;
    case 'work-queue': await workQueueCommand(); break;
    case 'work-acquire': await workAcquireCommand(); break;
    case 'work-release': await workReleaseCommand(); break;
    case 'work-cancel': await workCancelCommand(); break;
    case 'work-heartbeat': await workHeartbeatCommand(); break;
    case 'work-wait': await workWaitCommand(); break;
    case 'trace': await traceCommand(); break;
    case 'traces': await tracesCommand(); break;
    case 'modes': console.log(ACCESS_MODES.join('\n')); break;
    default: usage();
  }
} catch (error) { console.error(`dex-reach: ${error instanceof Error ? error.message : String(error)}`); process.exit(1); }
