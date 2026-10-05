import { parseRepoInspection } from '../shared/repo-inspection.js';
import WebSocket from 'ws';
import path from 'node:path';
import { DesktopCommanderAdapter } from './adapters/desktop-commander.js';
import { loadNodeConfig } from './config.js';
import { ResultStore } from './result-store.js';
import { nativeCall, createCheckpoint, defaultCwd } from './native.js';
import { secretInjectionRefusal } from '../shared/secrets.js';
import { executionFingerprint } from '../shared/fingerprint.js';
import { toolGuard, pathAllowed } from '../shared/security.js';
import { assertExecutionIdentityExpectation, assertExecutionIdentityStable, executionIdentityHash, parseExecutionIdentityExpectation } from '../shared/execution-identity.js';
import { collectNodeTrustReport } from './trust-report.js';
import { AuditLog } from '../shared/audit.js';
import {
  REACH_PROTOCOL_VERSION,
  type AccessSnapshot,
  type GatewayRequest,
  type GatewayResponse,
  type NodeHello,
  type NodeStatus,
  type SchedulerSnapshot,
  type RequestActor,
  type ReachProfile
} from '../shared/protocol.js';
import { loadLocalSecrets, stateDir } from '../shared/local-env.js';
import { authorizeOperation, loadAccessState, reserveOperation, snapshot } from '../shared/access.js';
import { releaseBudgetConcurrency } from '../shared/budget-usage.js';
import { createCapabilityRequest } from '../shared/capability-requests.js';
import type { ReachCapability } from '../shared/capabilities.js';
import { appendReceipt, listReceipts } from '../shared/receipts.js';
import { consumePlan, createPlan, hashValue, sweepExpiredPlans } from '../shared/plans.js';
import { writeRuntimeStatus } from './runtime-status.js';
import { DEX_REACH_VERSION } from '../shared/version.js';
import { checkpointStrategyFor, plannableOperations } from '../shared/operations.js';
import { workspaceSafeOperationRefusal, workspaceSafeToolRefusal } from '../shared/profiles.js';
import { AdapterRegistry, remoteAdapterToolRefusal } from '../shared/adapter-contract.js';
import { childSpan, enqueueSpan, flushTraces, traceContextFrom, type ReachTraceContext } from '../shared/trace.js';
import { loadTransportKeys } from './transport-keys.js';
import { coordinatedAcquire, coordinatedCancel, coordinatedHeartbeat, coordinatedRelease, coordinatedStatus } from '../coordinator/client.js';
import { HEARTBEAT_INTERVAL_MS, redactWorkStatusForShare, type WorkRequest } from '../shared/work-coordinator.js';
import { encodeAuthorizationProof, expectedProofDefaults, signNodeProof } from '../shared/node-transport-auth.js';
import { workspaceWorkerEligible, workspaceWorkerExecute, workspaceWorkerRootsHash } from '../shared/workspace-worker.js';
import { NodeTaskStore } from './task-store.js';
import { classifyFailure, classifyOperationSafety, defaultAttemptBudget, deriveIdempotencyKey, type SafetyClass } from '../shared/durable-execution.js';
import { reconcileBootTasks } from './boot-recovery.js';
import type { ProcessExecutionContext } from '../shared/activity.js';

loadLocalSecrets();
const config = loadNodeConfig();
const adapters = new AdapterRegistry();
const backend = new DesktopCommanderAdapter(adapters);
const results = new ResultStore();
const taskStore = new NodeTaskStore();
const audit = new AuditLog();
let stopped = false;
let reconnectMs = 1000;
let activeSocket: WebSocket | null = null;
/**
 * Which credential to present next. A node can hold both a transport key and an enrollment token,
 * and only the gateway knows which one its record currently accepts.
 *
 * This exists because of a recovery that silently never completed: after an owner revokes a node,
 * forgets it and enrols it again, the node host still has the transport private key from before.
 * The gateway forgot the matching public key with the rest of the record, so every proof was
 * refused and the node retried that same refused proof forever -- online from the owner's point of
 * view, invisible to the gateway, with nothing in either log saying why. Alternating lets the node
 * find the credential that works. It cannot widen anything: the gateway still decides, so a node
 * that has completed migration is still refused when it offers a bearer token.
 */
let preferBearerCredential = false;
let lastStatusJson = '';

// Reconcile durable tasks before advertising execution readiness. The recovery pass preserves
// contradictory coordinator/process evidence and never replays an uncertain side effect.
const activeTasks = await taskStore.loadActiveTasks();
const bootRecovery = await reconcileBootTasks(taskStore, results);
await backend.start(config.allowedRoots);
await sweepExpiredPlans();
console.log(`DEX//REACH node ${config.nodeId} started with ${backend.listTools().length} compatibility tools, ${activeTasks.length} durable active task(s), ${bootRecovery.length} boot reconciliation decision(s) (state dir ${stateDir()})`);

async function currentAccess(): Promise<AccessSnapshot> {
  return snapshot(await loadAccessState(config.nodeId));
}

async function executeOperation(operation: string, args: Record<string, unknown>, actor: RequestActor | undefined, profile: ReachProfile, context: ProcessExecutionContext = {}): Promise<unknown> {
  // The node's configured profile is a standing constraint, evaluated here rather than through the
  // effective profile an authorization decision produced. READ-ONLY replaces that effective profile,
  // so reading the constraint from it would let READ-ONLY re-admit what workspace-safe refuses. Both
  // narrowings must apply; neither may widen the other.
  const profileBlocked = workspaceSafeOperationRefusal(config.profile, operation);
  if (profileBlocked) throw new Error(profileBlocked);
  // Every operation the node executes passes through here, including compatibility calls, which
  // nativeCall never sees. A request that names a secret an operation cannot inject is refused
  // rather than executed without it. The node's configured profile is used, not the effective one
  // an authorization produced, for the same reason as the line above: both narrowings must apply.
  const secretsBlocked = secretInjectionRefusal(operation, config.profile, args)
    ?? secretInjectionRefusal(operation, profile, args);
  if (secretsBlocked) throw new Error(secretsBlocked);
  if (operation === 'dc.call') {
    const tool = String(args.tool || '');
    const toolArgs = (args.arguments || {}) as Record<string, unknown>;
    // The registry, not the running adapter, decides what a remote client may name. An adapter that
    // starts offering a new tool cannot widen the surface, and a remote-blocked tool is absent
    // rather than merely refused, so probing cannot tell "blocked" from "not provided".
    const notProvided = remoteAdapterToolRefusal(adapters, tool);
    if (notProvided) throw new Error(notProvided);
    const toolBlocked = workspaceSafeToolRefusal(config.profile, tool);
    if (toolBlocked) throw new Error(toolBlocked);
    const blocked = toolGuard(tool, toolArgs, profile, config.allowedRoots);
    if (blocked) throw new Error(blocked);
    return backend.callTool(tool, toolArgs, context);
  }
  if (operation === 'dex.result.read') {
    return results.read(String(args.handle || ''), Number(args.offset || 0), Number(args.length || 65536));
  }
  if (operation === 'dex.trustReport') {
    return collectNodeTrustReport({
      nodeId: config.nodeId,
      profile: config.profile,
      allowedRoots: config.allowedRoots,
      gatewayWs: config.gatewayWs,
      tools: backend.listTools(),
      agentVersion: DEX_REACH_VERSION
    });
  }
  if (operation === 'dex.receipts.list') return listReceipts(config.nodeId, Number(args.limit || 20));
  if (operation === 'dex.capability.request') {
    const capabilities = Array.isArray(args.capabilities)
      ? args.capabilities.map(value => String(value) as ReachCapability)
      : typeof args.capability === 'string' ? [args.capability as ReachCapability] : [];
    const roots = Array.isArray(args.roots) ? args.roots.map(value => String(value)) : typeof args.root === 'string' ? [args.root] : [];
    return createCapabilityRequest(config.nodeId, {
      client: actor?.kind ?? 'other',
      capabilities,
      roots,
      durationMs: Number(args.durationMs || 0),
      maxUses: args.maxUses === undefined || args.maxUses === null ? null : Number(args.maxUses),
      justification: String(args.justification || ''),
      operation: typeof args.operation === 'string' ? args.operation : undefined
    });
  }
  if (workspaceWorkerEligible(operation, args)) {
    const delegated = await workspaceWorkerExecute(config.nodeId, operation, args, workspaceWorkerRootsHash(config.allowedRoots), context);
    if (delegated !== null) return delegated;
  }
  return nativeCall(config.nodeId, operation, args, config.allowedRoots, profile, context);
}

function identityCwdForPlan(args: Record<string, unknown>): string {
  const cwdCandidate = typeof args.cwd === 'string'
    ? args.cwd
    : typeof args.path === 'string'
      ? path.dirname(args.path)
      : defaultCwd(config.allowedRoots);
  if (!path.isAbsolute(cwdCandidate) || !pathAllowed(cwdCandidate, config.allowedRoots)) return defaultCwd(config.allowedRoots);
  return cwdCandidate;
}

async function checkpointForPlan(operation: string, args: Record<string, unknown>): Promise<string | null> {
  if (checkpointStrategyFor(operation) === 'none') return null;
  const cwdCandidate = identityCwdForPlan(args);
  try {
    return String((await createCheckpoint(cwdCandidate) as { id: string }).id);
  } catch {
    return null;
  }
}

async function buildPlan(actor: RequestActor | undefined, args: Record<string, unknown>): Promise<unknown> {
  const operation = String(args.operation || '');
  const targetArgs = (args.arguments || {}) as Record<string, unknown>;
  if (!plannableOperations().includes(operation)) throw new Error(`plan target must be ${plannableOperations().join(', ')}`);
  // Refuse at plan time rather than at commit time, so a workspace-safe node never issues a plan it
  // would not honour and never takes a checkpoint for one.
  const plannedBlocked = workspaceSafeOperationRefusal(config.profile, operation);
  if (plannedBlocked) throw new Error(plannedBlocked);
  if (operation === 'dc.call') {
    const plannedTool = workspaceSafeToolRefusal(config.profile, String(targetArgs.tool || ''));
    if (plannedTool) throw new Error(plannedTool);
  }
  const state = await loadAccessState(config.nodeId);
  const decision = authorizeOperation(state, actor, operation, config.profile, Date.now(), targetArgs);
  if (!decision.allowed) throw new Error(decision.reason);
  const fingerprint = await executionFingerprint(config.nodeId, identityCwdForPlan(targetArgs));
  const expectedIdentity = parseExecutionIdentityExpectation(args.expectedIdentity);
  assertExecutionIdentityExpectation(expectedIdentity, fingerprint);
  const checkpointId = await checkpointForPlan(operation, targetArgs);
  const plan = await createPlan({
    nodeId: config.nodeId,
    actor: actor ?? null,
    operation,
    args: targetArgs,
    policyHash: hashValue(state),
    checkpointId,
    fingerprint,
    fingerprintHash: executionIdentityHash(fingerprint)
  });
  return {
    id: plan.id,
    nodeId: plan.nodeId,
    operation: plan.operation,
    requestHash: plan.requestHash,
    policyHash: plan.policyHash,
    checkpointId: plan.checkpointId,
    expiresAt: plan.expiresAt,
    identityHash: plan.fingerprintHash,
    identity: plan.fingerprint
  };
}

async function commitPlan(actor: RequestActor | undefined, args: Record<string, unknown>, context: ProcessExecutionContext = {}): Promise<unknown> {
  const plan = await consumePlan(String(args.planId || ''));
  if (plan.nodeId !== config.nodeId) throw new Error('execution plan targets a different node');
  if ((plan.actor?.clientId || null) !== (actor?.clientId || null) || (plan.actor?.kind || null) !== (actor?.kind || null)) {
    throw new Error('execution plan belongs to a different client');
  }
  // A plan issued before the owner narrowed this node to workspace-safe is stale authority, not
  // grandfathered authority, so the commit is refused against the profile in force now.
  const commitBlocked = workspaceSafeOperationRefusal(config.profile, 'dex.commitPlan', plan.operation);
  if (commitBlocked) throw new Error(commitBlocked);
  if (plan.operation === 'dc.call') {
    const commitTool = workspaceSafeToolRefusal(config.profile, String((plan.args as Record<string, unknown>).tool || ''));
    if (commitTool) throw new Error(commitTool);
  }
  if (!plan.fingerprint || !plan.fingerprintHash) throw new Error('execution plan predates identity binding; create a new plan');
  if (executionIdentityHash(plan.fingerprint) !== plan.fingerprintHash) throw new Error('stored execution identity is inconsistent; create a new plan');
  const currentFingerprint = await executionFingerprint(config.nodeId, plan.fingerprint.cwd);
  assertExecutionIdentityStable(plan.fingerprint, currentFingerprint);
  const reservation = await reserveOperation(
    config.nodeId,
    actor,
    plan.operation,
    config.profile,
    plan.args,
    { expectedPolicyHash: plan.policyHash }
  );
  try {
    const value = await executeOperation(plan.operation, plan.args, actor, reservation.decision.effectiveProfile, context);
    return {
      planId: plan.id,
      operation: plan.operation,
      requestHash: plan.requestHash,
      policyHash: plan.policyHash,
      checkpointId: plan.checkpointId,
      result: value
    };
  } finally {
    await releaseBudgetConcurrency(config.nodeId, reservation.budgetReservationId);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function coordinatorRequest(taskId: string, attempt: number, operation: string, safety: SafetyClass): WorkRequest {
  const access = safety === 'PURE_READ_IDEMPOTENT' ? 'read' : safety === 'DESTRUCTIVE' ? 'exclusive' : 'mutate';
  // Unknown-effect shell/process work is still bounded and repository-serialized, but must not be
  // classified as an impossible heavy bundle on small hosts: a 4-CPU runner has a 3-unit budget.
  // The operation's safety class controls replay/reconciliation; workload controls admission cost.
  const workload = access === 'read' ? 'light' : 'medium';
  return {
    executor: 'other', access, workload,
    ...(access === 'read' ? {} : { repositoryRoot: config.allowedRoots[0] }),
    phase: operation, taskId, attempt
  };
}

async function acquireTaskLease(taskId: string, attempt: number, operation: string, safety: SafetyClass): Promise<string> {
  const request = coordinatorRequest(taskId, attempt, operation, safety);
  const deadline = Date.now() + 60_000;
  let ticketId: string | undefined;
  let lastReason = 'coordinator admission is pending';
  try {
    for (;;) {
      const admission = await coordinatedAcquire({ ...request, ...(ticketId ? { ticketId } : {}) });
      if (admission.status === 'acquired') return admission.lease.id;
      ticketId = admission.ticket.id;
      lastReason = admission.reasons.join('; ') || `position ${admission.position}`;
      await taskStore.update(taskId, { status: `WAITING_FOR_COORDINATOR: ${lastReason}` });
      if (Date.now() >= deadline) throw new Error(`COORDINATOR_WAIT_TIMEOUT: ${lastReason}`);
      await sleep(250);
    }
  } catch (error) {
    if (ticketId) await coordinatedCancel(ticketId).catch(() => false);
    throw error;
  }
}

function startTaskHeartbeat(taskId: string, leaseId: string): NodeJS.Timeout {
  const timer = setInterval(() => {
    void (async () => {
      const alive = await coordinatedHeartbeat(leaseId).catch(() => false);
      if (alive) await taskStore.update(taskId, { status: 'RUNNING: coordinator and task heartbeat current.' }).catch(() => undefined);
      else await taskStore.update(taskId, { status: 'DEGRADED: coordinator heartbeat was not acknowledged; replay remains forbidden until reconciliation.' }).catch(() => undefined);
    })();
  }, HEARTBEAT_INTERVAL_MS);
  timer.unref?.();
  return timer;
}

async function handleRequest(request: GatewayRequest): Promise<GatewayResponse> {
  const started = Date.now();
  const actor = request.actor;
  let policy: unknown = null;
  let receiptCheckpoint: string | null = null;
  let budgetReservationId: string | undefined;
  let taskId: string | null = null;
  let taskSafety: SafetyClass | null = null;
  let leaseId: string | null = null;
  let heartbeatTimer: NodeJS.Timeout | null = null;
  // Continue the caller's trace when it supplied a valid W3C context, otherwise start one here.
  // A malformed inbound header never fails the request and never propagates.
  const trace: ReachTraceContext = traceContextFrom({
    traceparent: typeof request.traceparent === 'string' ? request.traceparent : undefined,
    tracestate: typeof request.tracestate === 'string' ? request.tracestate : undefined
  });
  enqueueSpan({
    traceId: trace.traceId, spanId: trace.spanId, parentSpanId: trace.parentSpanId,
    stage: 'node', at: new Date().toISOString(), operation: request.operation,
    nodeId: config.nodeId, actorKind: actor?.kind
  });
  try {
    // Preauthorize against current owner state without consuming rolling budget or grant uses. This
    // lets a duplicate idempotent request attach to its existing task without charging a new slot.
    if (request.operation === 'dex.repoInfo' && request.args.inspection !== undefined) parseRepoInspection(request.args.inspection);
    const preauthorization = await reserveOperation(config.nodeId, actor, request.operation, config.profile, request.args, { reserveBudget: false, consumeGrant: false });
    const actorId = `actor_${hashValue(actor ? { kind: actor.kind, clientId: actor.clientId } : { kind: 'unknown' }).slice(0, 24)}`;
    taskSafety = classifyOperationSafety(request.operation);
    const policyHash = hashValue(preauthorization.policy);
    const idempotency = deriveIdempotencyKey({
      actorId, nodeId: config.nodeId, operation: request.operation, args: request.args,
      policyHash,
      requestedKey: typeof request.args.idempotencyKey === 'string' ? request.args.idempotencyKey : undefined,
      requestId: request.id
    });
    const existing = (await taskStore.list({ idempotencyKey: idempotency.key })).find(task =>
      task.actorId === actorId && task.nodeId === config.nodeId && task.operation === request.operation
    );
    if (existing) {
      if (existing.payloadSha256 !== idempotency.payloadHash || (existing.policyHash && existing.policyHash !== policyHash)) {
        throw new Error('IDEMPOTENCY_KEY_COLLISION_MISMATCH: existing task binding differs; refusing execution');
      }
      if (existing.state === 'COMPLETED' && existing.resultRef) {
        const recovered = await results.readValue(existing.resultRef);
        return { type: 'response', id: request.id, ok: true, result: recovered, traceId: trace.traceId };
      }
      if (existing.state === 'AMBIGUOUS') {
        return { type: 'response', id: request.id, ok: false, error: `task ${existing.taskId} is AMBIGUOUS; reconciliation is required and replay is forbidden`, traceId: trace.traceId };
      }
      if (existing.state === 'FAILED' || existing.state === 'CANCELLED') {
        return { type: 'response', id: request.id, ok: false, error: `task ${existing.taskId} already ended as ${existing.state}: ${existing.summary.status}`, traceId: trace.traceId };
      }
      return { type: 'response', id: request.id, ok: false, error: `task ${existing.taskId} is already ${existing.state}; attach to the existing task`, traceId: trace.traceId };
    }

    // The final authorization reservation happens immediately before execution and is serialized with
    // owner policy updates. OFF therefore wins over stale remote state instead of being overwritten.
    const reservation = await reserveOperation(config.nodeId, actor, request.operation, config.profile, request.args, { expectedPolicyHash: policyHash });
    budgetReservationId = reservation.budgetReservationId;
    policy = reservation.policy;
    const authorizeSpan = childSpan(trace);
    enqueueSpan({
      traceId: authorizeSpan.traceId, spanId: authorizeSpan.spanId, parentSpanId: authorizeSpan.parentSpanId,
      stage: 'authorize', at: new Date().toISOString(), operation: request.operation,
      nodeId: config.nodeId, actorKind: actor?.kind, ok: true,
      policyHash: hashValue(reservation.policy)
    });
    const task = await taskStore.create({
      actorId, nodeId: config.nodeId, operation: request.operation,
      idempotencyKey: idempotency.key, payloadSha256: idempotency.payloadHash,
      policyHash: hashValue(reservation.policy), attemptBudget: defaultAttemptBudget(taskSafety),
      safetyClass: taskSafety,
      mutationLevel: taskSafety === 'PURE_READ_IDEMPOTENT' ? 'NONE' : 'STATE_MUTATION'
    });
    taskId = task.taskId;
    await taskStore.transition(taskId, 'PREPARING', 'Task admitted on the selected node.');
    leaseId = await acquireTaskLease(taskId, task.attemptNumber, request.operation, taskSafety);
    await taskStore.transition(taskId, 'RUNNING', `Task execution started with coordinator lease ${leaseId}.`);
    heartbeatTimer = startTaskHeartbeat(taskId, leaseId);
    const executionContext: ProcessExecutionContext = { taskId, attempt: task.attemptNumber, phase: request.operation };
    let value: unknown;
    try {
      if (request.operation === 'dex.plan') {
        value = await buildPlan(actor, request.args);
        receiptCheckpoint = (value as { checkpointId?: string | null }).checkpointId ?? null;
      } else if (request.operation === 'dex.commitPlan') {
        value = await commitPlan(actor, request.args, executionContext);
        receiptCheckpoint = (value as { checkpointId?: string | null }).checkpointId ?? null;
      } else {
        value = await executeOperation(request.operation, request.args, actor, reservation.decision.effectiveProfile, executionContext);
      }
    } finally {
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      heartbeatTimer = null;
      const released = await coordinatedRelease(leaseId).catch(() => ({ released: false, reason: 'coordinator release failed' }));
      if (!released.released) await taskStore.update(taskId, { status: `DEGRADED: coordinator lease release was not confirmed (${released.reason || 'unknown reason'}).` }).catch(() => undefined);
      leaseId = null;
    }
    const stored = await results.boundWithReference(value, taskId);
    await taskStore.update(taskId, { resultRef: stored.metadata.handle, resultHash: stored.metadata.resultHash });
    await taskStore.transition(taskId, 'COMPLETED', 'Task completed with a persisted result reference.');
    const result = stored.publicValue;
    const durationMs = Date.now() - started;
    const executeSpan = childSpan(authorizeSpan);
    enqueueSpan({
      traceId: executeSpan.traceId, spanId: executeSpan.spanId, parentSpanId: executeSpan.parentSpanId,
      stage: request.operation === 'dex.plan' ? 'plan' : request.operation === 'dex.commitPlan' ? 'commit' : 'execute',
      at: new Date().toISOString(), operation: request.operation, nodeId: config.nodeId,
      actorKind: actor?.kind, ok: true, durationMs,
      requestHash: hashValue({ operation: request.operation, args: request.args }),
      ...(receiptCheckpoint ? { checkpointId: receiptCheckpoint } : {})
    });
    await audit.append({
      at: new Date().toISOString(), source: 'node', nodeId: config.nodeId, actor,
      operation: request.operation, ok: true, durationMs, args: request.args
    });
    const receipt = await appendReceipt({
      nodeId: config.nodeId, actor, operation: request.operation, args: request.args, ok: true,
      result: value, durationMs, policy, checkpointId: receiptCheckpoint
    });
    const receiptSpan = childSpan(executeSpan);
    enqueueSpan({
      traceId: receiptSpan.traceId, spanId: receiptSpan.spanId, parentSpanId: receiptSpan.parentSpanId,
      stage: 'receipt', at: new Date().toISOString(), operation: request.operation,
      nodeId: config.nodeId, actorKind: actor?.kind, ok: true, receiptId: receipt.receiptId
    });
    return { type: 'response', id: request.id, ok: true, result, traceId: trace.traceId };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    heartbeatTimer = null;
    if (leaseId) {
      await coordinatedRelease(leaseId).catch(() => undefined);
      leaseId = null;
    }
    if (taskId && taskSafety) {
      const failureClass = classifyFailure({ error, safety: taskSafety });
      await taskStore.update(taskId, { failureClass, status: `Task stopped: ${failureClass}.` }).catch(() => undefined);
      const current = await taskStore.read(taskId).catch(() => null);
      if (current?.state === 'RUNNING' || current?.state === 'PREPARING') {
        const next = failureClass === 'AMBIGUOUS_EFFECT' ? 'AMBIGUOUS' : 'FAILED';
        await taskStore.transition(taskId, next, `Task stopped: ${failureClass}.`).catch(() => undefined);
      }
    }
    const durationMs = Date.now() - started;
    const failSpan = childSpan(trace);
    enqueueSpan({
      traceId: failSpan.traceId, spanId: failSpan.spanId, parentSpanId: failSpan.parentSpanId,
      stage: 'execute', at: new Date().toISOString(), operation: request.operation,
      nodeId: config.nodeId, actorKind: actor?.kind, ok: false, durationMs,
      // Refusal classification only. The refusal message can quote a path or a command, so it is
      // deliberately not traced; the audit log already holds the redacted detail.
      outcome: 'refused'
    });
    await audit.append({
      at: new Date().toISOString(), source: 'node', nodeId: config.nodeId, actor,
      operation: request.operation, ok: false, durationMs, args: request.args, error: message
    });
    const receipt = await appendReceipt({
      nodeId: config.nodeId, actor, operation: request.operation, args: request.args, ok: false,
      error: message, durationMs, policy: policy ?? { unavailable: true }, checkpointId: receiptCheckpoint
    }).catch(() => null);
    if (receipt) {
      const receiptSpan = childSpan(failSpan);
      enqueueSpan({
        traceId: receiptSpan.traceId, spanId: receiptSpan.spanId, parentSpanId: receiptSpan.parentSpanId,
        stage: 'receipt', at: new Date().toISOString(), operation: request.operation,
        nodeId: config.nodeId, actorKind: actor?.kind, ok: false, receiptId: receipt.receiptId
      });
    }
    return { type: 'response', id: request.id, ok: false, error: message, traceId: trace.traceId };
  } finally {
    await releaseBudgetConcurrency(config.nodeId, budgetReservationId).catch(() => undefined);
  }
}

async function publishStatus(): Promise<void> {
  const access = await currentAccess();
  const scheduler = redactWorkStatusForShare(await coordinatedStatus()) as SchedulerSnapshot;
  const json = JSON.stringify({ access, scheduler });
  const connected = activeSocket?.readyState === WebSocket.OPEN;
  await writeRuntimeStatus(config.nodeId, {
    pid: process.pid,
    connected,
    gateway: new URL(config.gatewayWs).origin,
    access,
    updatedAt: new Date().toISOString()
  });
  if (json !== lastStatusJson && connected && activeSocket) {
    const status: NodeStatus = { type: 'status', access, scheduler };
    activeSocket.send(JSON.stringify(status));
  }
  lastStatusJson = json;
}

const statusTimer = setInterval(() => void publishStatus().catch(() => undefined), 2000);
statusTimer.unref();
const planSweepTimer = setInterval(() => void sweepExpiredPlans().catch(() => undefined), 60_000);
planSweepTimer.unref();

async function connect(): Promise<void> {
  if (stopped) return;
  const url = new URL(config.gatewayWs);
  url.searchParams.set('nodeId', config.nodeId);
  const headers: Record<string, string> = {};
  const transport = preferBearerCredential ? null : await loadTransportKeys(config.nodeId);
  const credential: 'transport proof' | 'enrollment token' = transport ? 'transport proof' : 'enrollment token';
  if (transport) {
    const proof = signNodeProof(transport.privateKey, expectedProofDefaults(config.nodeId));
    headers.Authorization = encodeAuthorizationProof(proof);
  } else {
    headers.Authorization = `Bearer ${config.token}`;
  }
  const ws = new WebSocket(url, { headers });
  let opened = false;
  let lastAliveAt = Date.now();
  ws.on('pong', () => { lastAliveAt = Date.now(); });

  ws.on('open', async () => {
    opened = true;
    // Remember what the gateway actually accepted, so a reconnect does not go back to a credential
    // already known to be refused and spend every retry on it.
    preferBearerCredential = credential === 'enrollment token';
    reconnectMs = 1000;
    lastAliveAt = Date.now();
    activeSocket = ws;
    lastStatusJson = '';
    const hello: NodeHello = {
      type: 'hello',
      protocolVersion: REACH_PROTOCOL_VERSION,
      nodeId: config.nodeId,
      profile: config.profile,
      fingerprint: await executionFingerprint(config.nodeId),
      tools: backend.listTools(),
      allowedRoots: config.allowedRoots,
      agentVersion: DEX_REACH_VERSION,
      access: await currentAccess(),
      scheduler: redactWorkStatusForShare(await coordinatedStatus()) as SchedulerSnapshot
    };
    ws.send(JSON.stringify(hello));
    void publishStatus().catch(() => undefined);
    console.log(`DEX//REACH node connected to ${url.origin} using its ${credential}`);
  });

  ws.on('message', async data => {
    lastAliveAt = Date.now();
    let parsed: unknown;
    try { parsed = JSON.parse(data.toString()); } catch { return; }
    if (!parsed || typeof parsed !== 'object' || (parsed as { type?: string }).type !== 'request') return;
    const response = await handleRequest(parsed as GatewayRequest);
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(response));
  });

  const heartbeat = setInterval(() => {
    if (ws.readyState !== WebSocket.OPEN) return;
    if (Date.now() - lastAliveAt > 12000) {
      ws.terminate();
      return;
    }
    ws.ping();
    ws.send(JSON.stringify({ type: 'heartbeat', at: Date.now() }));
  }, 5000);
  heartbeat.unref();

  ws.on('close', () => {
    clearInterval(heartbeat);
    if (activeSocket === ws) activeSocket = null;
    void publishStatus().catch(() => undefined);
    if (stopped) return;
    const delay = reconnectMs;
    reconnectMs = Math.min(reconnectMs * 2, 30000);
    if (!opened) {
      // Refused before the socket ever opened. The gateway does not say why -- deliberately, so a
      // prober learns nothing -- so the only thing this node can do is offer its other credential
      // next time and say plainly in its own log that it is doing so.
      preferBearerCredential = credential === 'transport proof';
      console.warn(`DEX//REACH gateway refused this node's ${credential}; retrying in ${delay}ms with its ${preferBearerCredential ? 'enrollment token' : 'transport proof'}. If that is also refused, the owner must re-enroll this node.`);
    } else {
      console.warn(`DEX//REACH gateway disconnected; reconnecting in ${delay}ms`);
    }
    setTimeout(() => void connect(), delay).unref();
  });
  ws.on('error', error => { console.error('DEX//REACH node websocket error:', error.message); });
}

async function shutdown(): Promise<void> {
  if (stopped) return;
  stopped = true;
  clearInterval(statusTimer);
  clearInterval(planSweepTimer);
  await Promise.all([backend.close(), flushTraces({ shutdown: true })]);
  process.exit(0);
}
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
await connect();
