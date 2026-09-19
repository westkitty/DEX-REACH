import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { REACH_CAPABILITIES, operationCapability, type ReachCapability } from '../src/shared/capabilities.js';
import { REMOTE_BLOCKED_COMPATIBILITY_TOOLS } from '../src/shared/compatibility.js';
import { authorizeOperation, defaultAccessState } from '../src/shared/access.js';
import {
  COMPATIBILITY_TOOLS,
  DEX_OPERATIONS,
  GATEWAY_ONLY_OPERATIONS,
  PLAN_TARGET_OPERATIONS,
  ZERO_AUTHORITY_COST,
  addAuthorityCost,
  checkpointStrategyFor,
  compatibilityToolRisk,
  describeCompatibilityTool,
  describeOperation,
  effectiveRisk,
  isKnownOperation,
  plannableOperations,
  readOnlyDelegatedOperations,
  readOnlyInspectOperations,
  remoteBlockedCompatibilityTools,
  remoteCompatibilityTools,
  requestedAuthorityCost,
  requireCompatibilityTool,
  requireOperation
} from '../src/shared/operations.js';

// --- The catalog is internally coherent -------------------------------------

test('every descriptor names a real capability and the catalog has no duplicates', () => {
  const operations = DEX_OPERATIONS.map(descriptor => descriptor.operation);
  assert.equal(new Set(operations).size, operations.length, 'duplicate operation in catalog');

  for (const descriptor of DEX_OPERATIONS) {
    assert.ok(
      (REACH_CAPABILITIES as readonly string[]).includes(descriptor.capability),
      `${descriptor.operation} declares capability ${descriptor.capability}, which is not a ReachCapability`
    );
  }

  const tools = COMPATIBILITY_TOOLS.map(descriptor => descriptor.tool);
  assert.equal(new Set(tools).size, tools.length, 'duplicate compatibility tool in catalog');
});

test('a mutation is never classified as inspection', () => {
  for (const descriptor of DEX_OPERATIONS) {
    if (descriptor.mutation) assert.notEqual(descriptor.risk, 'inspect', `${descriptor.operation} mutates but is classed inspect`);
  }
  for (const descriptor of COMPATIBILITY_TOOLS) {
    if (descriptor.mutation) assert.notEqual(descriptor.risk, 'inspect', `${descriptor.tool} mutates but is classed inspect`);
  }
});

test('shell risk requires the process.shell capability, and only shell operations claim it', () => {
  for (const descriptor of DEX_OPERATIONS) {
    if (descriptor.risk !== 'shell') continue;
    // An operation that replays an already-authorized plan was capability-checked when the plan was
    // built, so it does not demand the capability its ceiling implies. Everything else must.
    if (descriptor.riskInheritsFromTarget) continue;
    // dc.call reaches a shell through the compatibility adapter and carries the compat capability;
    // every other shell-risk operation must demand process.shell outright.
    const allowed: ReachCapability[] = descriptor.operation === 'dc.call' ? ['compat'] : ['process.shell'];
    assert.ok(allowed.includes(descriptor.capability), `${descriptor.operation} is shell risk but requires ${descriptor.capability}`);
  }
  const shellCapability = DEX_OPERATIONS.filter(descriptor => descriptor.capability === 'process.shell');
  for (const descriptor of shellCapability) {
    assert.equal(descriptor.risk, 'shell', `${descriptor.operation} requires process.shell but is not shell risk`);
  }
});

test('an inheriting operation cannot itself be planned and is refused under READ-ONLY', () => {
  const inheriting = DEX_OPERATIONS.filter(descriptor => descriptor.riskInheritsFromTarget);
  assert.deepEqual(inheriting.map(descriptor => descriptor.operation), ['dex.commitPlan']);
  for (const descriptor of inheriting) {
    // Otherwise a plan could target a commit and launder its risk through a second indirection.
    assert.equal(descriptor.supportsPlan, false, `${descriptor.operation} must not be a plan target`);
    assert.equal(descriptor.readOnlyAllowed, false, `${descriptor.operation} must be refused under READ-ONLY`);
    assert.equal((PLAN_TARGET_OPERATIONS as readonly string[]).includes(descriptor.operation), false);
  }
});

test('a shell or destructive operation is never allowed into workspace-safe', () => {
  for (const descriptor of DEX_OPERATIONS) {
    if (descriptor.risk === 'shell' || descriptor.risk === 'destructive' || descriptor.risk === 'privileged') {
      assert.equal(descriptor.workspaceSafeAllowed, false, `${descriptor.operation} must stay outside workspace-safe`);
    }
  }
  for (const descriptor of COMPATIBILITY_TOOLS) {
    if (descriptor.risk === 'shell' || descriptor.risk === 'destructive' || descriptor.risk === 'privileged' || descriptor.risk === 'network') {
      assert.equal(descriptor.workspaceSafeAllowed, false, `${descriptor.tool} must stay outside workspace-safe`);
    }
  }
});

// --- Unknown classifications fail closed ------------------------------------

test('an unclassified operation or tool fails closed rather than defaulting to safe', () => {
  assert.equal(describeOperation('dex.notAThing'), undefined);
  assert.equal(isKnownOperation('dex.notAThing'), false);
  assert.throws(() => requireOperation('dex.notAThing'), /fails closed/);
  assert.throws(() => requireOperation(''), /fails closed/);

  assert.equal(describeCompatibilityTool('definitely_not_a_tool'), undefined);
  assert.throws(() => requireCompatibilityTool('definitely_not_a_tool'), /fails closed/);
  assert.throws(() => compatibilityToolRisk('definitely_not_a_tool'), /fails closed/);

  assert.throws(() => requestedAuthorityCost('dex.notAThing'), /fails closed/);
});

test('commitPlan inherits the effective risk of its planned target', () => {
  assert.equal(effectiveRisk('dex.commitPlan', 'dex.file.write'), 'typed-mutate');
  assert.equal(effectiveRisk('dex.commitPlan', 'dex.process.run'), 'shell');
  assert.equal(effectiveRisk('dex.commitPlan', 'dex.checkpoint'), 'typed-mutate');
  // A commit whose target is unknown, or absent, cannot be classified and therefore fails closed.
  assert.throws(() => effectiveRisk('dex.commitPlan'), /requires the planned target/);
  assert.throws(() => effectiveRisk('dex.commitPlan', 'dex.notAThing'), /fails closed/);
  // Every other operation carries its own declared risk.
  assert.equal(effectiveRisk('dex.file.read'), 'inspect');
});

// --- Nothing about authorization changed ------------------------------------

/** The exact operation knowledge that lived in access.ts and capabilities.ts before this phase. */
const PREVIOUS_READ_OPERATIONS = new Set(['dex.fingerprint', 'dex.trustReport', 'dex.repoInfo', 'dex.adbDevices', 'dex.file.read', 'dex.result.read', 'dex.receipts.list']);
function previousOperationCapability(operation: string): ReachCapability {
  if (operation === 'dex.file.read' || operation === 'dex.result.read' || operation === 'dex.receipts.list') return 'file.read';
  if (operation === 'dex.file.write') return 'file.write';
  if (operation === 'dex.checkpoint') return 'checkpoint';
  if (operation === 'dex.process.run') return 'process.shell';
  if (operation === 'dc.call') return 'compat';
  return 'inspect';
}

const ALL_OPERATIONS = [
  ...DEX_OPERATIONS.map(descriptor => descriptor.operation),
  ...GATEWAY_ONLY_OPERATIONS,
  'dex.notAThing',
  ''
];

test('capability mapping is identical to the pre-catalog implementation', () => {
  for (const operation of ALL_OPERATIONS) {
    assert.equal(operationCapability(operation), previousOperationCapability(operation), `capability drifted for "${operation}"`);
  }
});

test('READ-ONLY admits exactly what it admitted before the catalog', () => {
  const state = { ...defaultAccessState(), mode: 'read-only' as const };
  const actor = { kind: 'claude' as const, clientId: 'c1', clientName: 'Claude' };

  for (const operation of ALL_OPERATIONS) {
    const expected = PREVIOUS_READ_OPERATIONS.has(operation) || operation === 'dex.process.run' || operation === 'dc.call';
    const decision = authorizeOperation(state, actor, operation, 'full-local');
    assert.equal(decision.allowed, expected, `READ-ONLY admission drifted for "${operation}"`);
    if (decision.allowed) assert.equal(decision.effectiveProfile, 'read-only');
  }

  // The derived sets are the two branches of that behavior, and they do not overlap.
  assert.deepEqual([...readOnlyInspectOperations()].sort(), [...PREVIOUS_READ_OPERATIONS].sort());
  assert.deepEqual(readOnlyDelegatedOperations().sort(), ['dc.call', 'dex.process.run']);
  assert.equal(readOnlyInspectOperations().some(operation => readOnlyDelegatedOperations().includes(operation)), false);
});

test('OFF still refuses everything and ON is unchanged', () => {
  const actor = { kind: 'claude' as const, clientId: 'c1', clientName: 'Claude' };
  for (const operation of ALL_OPERATIONS) {
    assert.equal(authorizeOperation({ ...defaultAccessState(), mode: 'off' }, actor, operation, 'full-local').allowed, false, `OFF leaked "${operation}"`);
    assert.equal(authorizeOperation({ ...defaultAccessState(), mode: 'on' }, actor, operation, 'full-local').allowed, true, `ON changed for "${operation}"`);
  }
});

// --- Plan and checkpoint contracts ------------------------------------------

test('plan targets match the catalog and keep their published wire order', () => {
  // The order is part of the reach_plan MCP schema, so it is asserted exactly, not as a set.
  assert.deepEqual([...PLAN_TARGET_OPERATIONS], ['dex.file.write', 'dex.process.run', 'dex.checkpoint', 'dc.call']);
  assert.deepEqual([...PLAN_TARGET_OPERATIONS].sort(), plannableOperations().sort());
});

test('checkpoint strategy matches the operations that previously took one', () => {
  const previouslyCheckpointed = ['dex.file.write', 'dex.process.run', 'dc.call'];
  for (const operation of DEX_OPERATIONS.map(descriptor => descriptor.operation)) {
    const takesCheckpoint = checkpointStrategyFor(operation) !== 'none';
    assert.equal(takesCheckpoint, previouslyCheckpointed.includes(operation) || operation === 'dex.plan', `checkpoint strategy drifted for ${operation}`);
  }
  // An unknown operation takes no checkpoint and cannot be planned.
  assert.equal(checkpointStrategyFor('dex.notAThing'), 'none');
});

// --- Surface counts are unchanged -------------------------------------------

test('the public MCP action surface is still exactly 16 tools in the same order', async () => {
  const source = await fs.readFile('src/gateway/mcp.ts', 'utf8');
  const registered = [...source.matchAll(/server\.registerTool\('([a-z_]+)'/g)].map(match => match[1]!);
  assert.deepEqual(registered, [
    'reach_list_nodes', 'reach_list_tools', 'reach_call', 'reach_fingerprint', 'reach_trust_report',
    'reach_repo_info', 'reach_adb_devices', 'reach_checkpoint', 'reach_file_read', 'reach_file_write',
    'reach_process_run', 'reach_plan', 'reach_commit_plan', 'reach_receipts', 'reach_result_read', 'reach_revoke_node'
  ]);
  assert.equal(registered.length, 16);
});

test('the compatibility surface is still 26 local tools with exactly 4 withheld remotely', () => {
  assert.equal(COMPATIBILITY_TOOLS.length, 26);
  assert.equal(remoteCompatibilityTools().length, 22);
  assert.deepEqual(remoteBlockedCompatibilityTools().sort(), [
    'get_prompts', 'get_recent_tool_calls', 'give_feedback_to_desktop_commander', 'set_config_value'
  ]);
  // The block list the backend filters on is the one derived from the catalog.
  assert.deepEqual([...REMOTE_BLOCKED_COMPATIBILITY_TOOLS].sort(), remoteBlockedCompatibilityTools().sort());
  assert.equal(REMOTE_BLOCKED_COMPATIBILITY_TOOLS.length, 4);
});

test('every remotely reachable compatibility tool is classified', () => {
  for (const tool of remoteCompatibilityTools()) {
    const descriptor = requireCompatibilityTool(tool);
    assert.equal(descriptor.remoteBlocked, false);
    assert.ok(['inspect', 'typed-mutate', 'shell', 'destructive'].includes(descriptor.risk), `${tool} has unexpected remote risk ${descriptor.risk}`);
  }
});

// --- Native coverage ---------------------------------------------------------

test('every operation the node executor handles is in the catalog', async () => {
  const source = await fs.readFile('src/node/native.ts', 'utf8');
  const handled = [...source.matchAll(/case '([a-zA-Z.]+)':/g)].map(match => match[1]!);
  assert.ok(handled.length >= 7, 'native dispatch cases were not found');
  for (const operation of handled) {
    assert.ok(isKnownOperation(operation), `native.ts handles "${operation}" but the catalog does not classify it`);
  }
  // Operations the node serves outside nativeCall are classified too.
  for (const operation of ['dc.call', 'dex.result.read', 'dex.trustReport', 'dex.receipts.list', 'dex.plan', 'dex.commitPlan']) {
    assert.ok(isKnownOperation(operation), `${operation} is unclassified`);
  }
});

// --- Requested authority cost ------------------------------------------------

test('requested authority cost is deterministic and derived from the request', () => {
  const write = requestedAuthorityCost('dex.file.write', { path: '/tmp/x', text: 'hello' });
  assert.deepEqual(write, { operations: 1, mutations: 1, shellCalls: 0, requestedWriteBytes: 5, requestedProcessMs: 0 });
  // Same request, same cost, every time.
  assert.deepEqual(requestedAuthorityCost('dex.file.write', { path: '/tmp/x', text: 'hello' }), write);
  // Multi-byte text is counted in bytes, not characters.
  assert.equal(requestedAuthorityCost('dex.file.write', { text: 'é' }).requestedWriteBytes, 2);

  const run = requestedAuthorityCost('dex.process.run', { command: 'ls', timeoutMs: 15000 });
  assert.deepEqual(run, { operations: 1, mutations: 1, shellCalls: 1, requestedWriteBytes: 0, requestedProcessMs: 15000 });

  const read = requestedAuthorityCost('dex.file.read', { path: '/tmp/x' });
  assert.deepEqual(read, { operations: 1, mutations: 0, shellCalls: 0, requestedWriteBytes: 0, requestedProcessMs: 0 });

  // A nonsense timeout contributes nothing rather than NaN.
  assert.equal(requestedAuthorityCost('dex.process.run', { timeoutMs: 'soon' }).requestedProcessMs, 0);
  assert.equal(requestedAuthorityCost('dex.process.run', { timeoutMs: -5 }).requestedProcessMs, 0);

  assert.deepEqual(addAuthorityCost(ZERO_AUTHORITY_COST, write), write);
  assert.deepEqual(addAuthorityCost(write, run), {
    operations: 2, mutations: 2, shellCalls: 1, requestedWriteBytes: 5, requestedProcessMs: 15000
  });
});

test('cost never grants anything: it is a number, not a decision', () => {
  // The cost helper has no access to policy and cannot return an allow/deny.
  const cost = requestedAuthorityCost('dex.process.run', { command: 'rm -rf /', timeoutMs: 1 });
  assert.equal(typeof cost.operations, 'number');
  assert.equal(Object.keys(cost).sort().join(','), 'mutations,operations,requestedProcessMs,requestedWriteBytes,shellCalls');
});

test('plan commit inherits the target cost and cannot launder a higher-risk operation', () => {
  const run = requestedAuthorityCost('dex.process.run', { command: 'ls', timeoutMs: 9000 });
  const throughCommit = requestedAuthorityCost('dex.commitPlan', { planId: 'p1' }, {
    plannedTarget: 'dex.process.run',
    plannedArgs: { command: 'ls', timeoutMs: 9000 }
  });
  assert.deepEqual(throughCommit, run);
  assert.equal(throughCommit.shellCalls, 1);
  assert.equal(throughCommit.requestedProcessMs, 9000);
  const write = requestedAuthorityCost('dex.file.write', { text: 'hello' });
  const writeCommit = requestedAuthorityCost('dex.commitPlan', { planId: 'p2' }, {
    plannedTarget: 'dex.file.write',
    plannedArgs: { text: 'hello' }
  });
  assert.deepEqual(writeCommit, write);
  assert.equal(writeCommit.shellCalls, 0);
  const unknownTargetCeiling = requestedAuthorityCost('dex.commitPlan', { planId: 'p3' });
  assert.equal(unknownTargetCeiling.shellCalls, 1);
});
