import test from 'node:test';
import assert from 'node:assert/strict';
import {
  REACH_PROFILES,
  OWNER_MODES,
  isReachProfile,
  isWorkspaceSafeNode,
  workspaceSafeOperationRefusal,
  workspaceSafeToolRefusal
} from '../src/shared/profiles.js';
import {
  COMPATIBILITY_TOOLS,
  DEX_OPERATIONS,
  compatibilityToolWorkspaceSafe,
  effectiveWorkspaceSafe,
  workspaceSafeCompatibilityTools,
  workspaceSafeOperations
} from '../src/shared/operations.js';
import { ACCESS_MODES, authorizeOperation, createGrant, defaultAccessState } from '../src/shared/access.js';
import { commandGuard, toolGuard } from '../src/shared/security.js';
import type { AccessState } from '../src/shared/access.js';
import type { RequestActor } from '../src/shared/protocol.js';

const CLAUDE: RequestActor = { kind: 'claude', clientId: 'client-1', clientName: 'Claude' };
const ROOTS = ['/tmp/dex-workspace-safe'];

function onState(overrides: Partial<AccessState> = {}): AccessState {
  return { ...defaultAccessState(), mode: 'on', ...overrides };
}

test('workspace-safe is an execution profile and adds no owner mode', () => {
  // The owner modes are the thing the brief pins. A fourth mode would be a new authority surface.
  assert.deepEqual([...ACCESS_MODES], ['off', 'read-only', 'on']);
  assert.deepEqual([...OWNER_MODES], ['off', 'read-only', 'on']);

  assert.ok(REACH_PROFILES.includes('workspace-safe'));
  assert.ok(isReachProfile('workspace-safe'));
  assert.equal(isReachProfile('workspace_safe'), false);
  assert.equal(isReachProfile('sandbox'), false);

  // Every previously supported profile survives. Adding one must not retire another.
  for (const existing of ['read-only', 'development', 'repository-maintenance', 'android-adb', 'remote-server', 'full-local']) {
    assert.ok(REACH_PROFILES.includes(existing as never), `${existing} must still be a valid profile`);
  }

  // Only the workspace-safe node carries the constraint; no other profile is altered by its addition.
  for (const profile of REACH_PROFILES) {
    assert.equal(isWorkspaceSafeNode(profile), profile === 'workspace-safe');
    if (profile !== 'workspace-safe') {
      assert.equal(workspaceSafeOperationRefusal(profile, 'dex.process.run'), null);
      assert.equal(workspaceSafeToolRefusal(profile, 'start_process'), null);
    }
  }
});

test('workspace-safe allows typed project work', () => {
  const allowed = workspaceSafeOperations();
  for (const operation of [
    'dex.fingerprint', 'dex.trustReport', 'dex.repoInfo', 'dex.adbDevices',
    'dex.file.read', 'dex.result.read', 'dex.receipts.list',
    'dex.file.write', 'dex.checkpoint', 'dex.plan'
  ]) {
    assert.ok(allowed.includes(operation), `${operation} must be admitted by workspace-safe`);
    assert.equal(workspaceSafeOperationRefusal('workspace-safe', operation), null);
  }

  // A typed write and a checkpoint are the point of the profile: it is not read-only.
  assert.equal(effectiveWorkspaceSafe('dex.file.write'), true);
  assert.equal(effectiveWorkspaceSafe('dex.checkpoint'), true);

  // Declared-safe compatibility tools remain reachable.
  const safeTools = workspaceSafeCompatibilityTools();
  for (const tool of ['read_file', 'list_directory', 'write_file', 'edit_block', 'create_directory', 'move_file']) {
    assert.ok(safeTools.includes(tool), `${tool} must be admitted by workspace-safe`);
    assert.equal(workspaceSafeToolRefusal('workspace-safe', tool), null);
  }
});

test('workspace-safe refuses arbitrary shell, process/session tools and privileged surfaces', () => {
  const shellRefusal = workspaceSafeOperationRefusal('workspace-safe', 'dex.process.run');
  assert.ok(shellRefusal && /does not permit dex\.process\.run/.test(shellRefusal));
  assert.equal(effectiveWorkspaceSafe('dex.process.run'), false);

  // Even a command the read-only grammar would accept is refused: the profile has no shell at all,
  // not a narrower one.
  assert.equal(commandGuard('ls -la /tmp/dex-workspace-safe', 'read-only', ROOTS), null);
  assert.ok(commandGuard('ls -la /tmp/dex-workspace-safe', 'workspace-safe', ROOTS));
  assert.ok(commandGuard('rm -rf /', 'workspace-safe', ROOTS));

  for (const tool of ['start_process', 'interact_with_process', 'read_process_output', 'list_processes', 'list_sessions']) {
    assert.ok(workspaceSafeToolRefusal('workspace-safe', tool), `${tool} must be refused by workspace-safe`);
    assert.ok(toolGuard(tool, {}, 'workspace-safe', ROOTS), `${tool} must be refused by the tool guard`);
  }
  for (const tool of ['force_terminate', 'kill_process']) {
    assert.ok(workspaceSafeToolRefusal('workspace-safe', tool), `${tool} must be refused by workspace-safe`);
  }
  for (const tool of ['set_config_value', 'get_recent_tool_calls', 'give_feedback_to_desktop_commander', 'get_prompts']) {
    assert.ok(workspaceSafeToolRefusal('workspace-safe', tool), `${tool} must be refused by workspace-safe`);
    assert.ok(toolGuard(tool, {}, 'workspace-safe', ROOTS), `${tool} must stay node-owned`);
  }

  // Safety configuration mutation is refused by the profile, not only by the remote block list.
  assert.equal(compatibilityToolWorkspaceSafe('set_config_value'), false);

  // No privileged or destructive operation or tool may be workspace-safe by construction.
  for (const descriptor of DEX_OPERATIONS) {
    if (['shell', 'privileged', 'destructive', 'network'].includes(descriptor.risk) && !descriptor.riskInheritsFromTarget) {
      assert.equal(descriptor.workspaceSafeAllowed, false, `${descriptor.operation} must not be workspace-safe`);
    }
  }
  for (const descriptor of COMPATIBILITY_TOOLS) {
    if (['shell', 'privileged', 'destructive', 'network'].includes(descriptor.risk)) {
      assert.equal(descriptor.workspaceSafeAllowed, false, `${descriptor.tool} must not be workspace-safe`);
    }
  }
});

test('an undeclared adapter tool or unclassified operation is refused rather than classified later', () => {
  assert.throws(() => workspaceSafeToolRefusal('workspace-safe', 'some_new_vendor_tool'), /fails closed/);
  assert.throws(() => workspaceSafeToolRefusal('workspace-safe', ''), /fails closed/);

  const refusal = workspaceSafeOperationRefusal('workspace-safe', 'dex.somethingNew');
  assert.ok(refusal && /unclassified operation/.test(refusal));
});

test('a commit inherits its target rather than laundering risk through the plan', () => {
  // Commit carries the refusing ceiling when no target is known, exactly as its risk does.
  assert.throws(() => effectiveWorkspaceSafe('dex.commitPlan'), /requires the planned target/);

  assert.equal(effectiveWorkspaceSafe('dex.commitPlan', 'dex.file.write'), true);
  assert.equal(effectiveWorkspaceSafe('dex.commitPlan', 'dex.checkpoint'), true);
  assert.equal(effectiveWorkspaceSafe('dex.commitPlan', 'dex.process.run'), false);

  assert.equal(workspaceSafeOperationRefusal('workspace-safe', 'dex.commitPlan', 'dex.file.write'), null);
  const blocked = workspaceSafeOperationRefusal('workspace-safe', 'dex.commitPlan', 'dex.process.run');
  assert.ok(blocked && /committing a plan for dex\.process\.run/.test(blocked));

  // A compatibility target defers to the exact tool instead of guessing in either direction.
  assert.equal(workspaceSafeOperationRefusal('workspace-safe', 'dex.commitPlan', 'dc.call'), null);
  assert.throws(() => effectiveWorkspaceSafe('dc.call'), /per compatibility tool/);
  assert.equal(workspaceSafeToolRefusal('workspace-safe', 'write_file'), null);
  assert.ok(workspaceSafeToolRefusal('workspace-safe', 'start_process'));
});

test('OFF still overrides workspace-safe', () => {
  const state = onState({ mode: 'off' });
  for (const operation of ['dex.fingerprint', 'dex.file.read', 'dex.file.write', 'dex.checkpoint', 'dex.plan']) {
    const decision = authorizeOperation(state, CLAUDE, operation, 'workspace-safe');
    assert.equal(decision.allowed, false, `${operation} must be refused while the owner is OFF`);
  }
});

test('READ-ONLY narrows workspace-safe and workspace-safe never widens READ-ONLY', () => {
  const state = onState({ mode: 'read-only' });

  // Typed writes and checkpoints are exactly what workspace-safe adds over read-only. READ-ONLY has
  // to take them away again.
  for (const operation of ['dex.file.write', 'dex.checkpoint', 'dex.plan', 'dex.commitPlan']) {
    const decision = authorizeOperation(state, CLAUDE, operation, 'workspace-safe');
    assert.equal(decision.allowed, false, `${operation} must be refused under READ-ONLY`);
  }

  // Inspection is admitted, and the effective profile becomes read-only rather than staying
  // workspace-safe, so the narrower of the two governs execution.
  const inspect = authorizeOperation(state, CLAUDE, 'dex.file.read', 'workspace-safe');
  assert.equal(inspect.allowed, true);
  assert.equal(inspect.allowed && inspect.effectiveProfile, 'read-only');

  // The composition hazard: READ-ONLY admits dex.process.run and lets the shell-free grammar decide.
  // On a workspace-safe node that must not become a way back to a shell, so the node's own profile
  // is what the constraint is evaluated against, not the effective profile READ-ONLY produced.
  const delegated = authorizeOperation(state, CLAUDE, 'dex.process.run', 'workspace-safe');
  assert.equal(delegated.allowed, true);
  assert.equal(delegated.allowed && delegated.effectiveProfile, 'read-only');
  assert.equal(workspaceSafeOperationRefusal(delegated.allowed ? delegated.effectiveProfile : 'read-only', 'dex.process.run'), null);
  assert.ok(
    workspaceSafeOperationRefusal('workspace-safe', 'dex.process.run'),
    'the node profile must still refuse the shell that READ-ONLY delegated'
  );
});

test('client ceilings still narrow a workspace-safe node', () => {
  const ceilingOff = onState({ clients: { claude: 'off' } });
  assert.equal(authorizeOperation(ceilingOff, CLAUDE, 'dex.file.write', 'workspace-safe').allowed, false);
  assert.equal(authorizeOperation(ceilingOff, CLAUDE, 'dex.file.read', 'workspace-safe').allowed, false);

  const ceilingRead = onState({ clients: { claude: 'read-only' } });
  assert.equal(authorizeOperation(ceilingRead, CLAUDE, 'dex.file.write', 'workspace-safe').allowed, false);
  const inspect = authorizeOperation(ceilingRead, CLAUDE, 'dex.file.read', 'workspace-safe');
  assert.equal(inspect.allowed && inspect.effectiveProfile, 'read-only');

  // A different client's ceiling does not narrow this one; the ceiling is per client kind.
  const otherCeiling = onState({ clients: { chatgpt: 'off' } });
  assert.equal(authorizeOperation(otherCeiling, CLAUDE, 'dex.file.write', 'workspace-safe').allowed, true);
});

test('grants still narrow a workspace-safe node', () => {
  const granted = createGrant(onState(), 'claude', ['file.read'], ROOTS, 60_000, 1);

  // A write is inside workspace-safe but outside the grant, so it is refused.
  assert.equal(authorizeOperation(granted, CLAUDE, 'dex.file.write', 'workspace-safe').allowed, false);

  const read = authorizeOperation(granted, CLAUDE, 'dex.file.read', 'workspace-safe', Date.now(), { path: `${ROOTS[0]}/a.txt` });
  assert.equal(read.allowed, true);

  // Outside the grant's roots it is refused even though the capability matches.
  assert.equal(
    authorizeOperation(granted, CLAUDE, 'dex.file.read', 'workspace-safe', Date.now(), { path: '/etc/passwd' }).allowed,
    false
  );

  // An expired grant is not a way through.
  const expired = { ...granted, grants: granted.grants.map(g => ({ ...g, until: new Date(Date.now() - 1000).toISOString() })) };
  assert.equal(authorizeOperation(expired, CLAUDE, 'dex.file.read', 'workspace-safe').allowed, false);
});

test('workspace-safe only restricts; it never grants authority a wider profile lacked', () => {
  // Anything workspace-safe admits, full-local admits too. The profile is a subset, not a side door.
  for (const operation of workspaceSafeOperations()) {
    assert.equal(workspaceSafeOperationRefusal('full-local', operation), null);
  }
  for (const tool of workspaceSafeCompatibilityTools()) {
    assert.equal(workspaceSafeToolRefusal('full-local', tool), null);
  }

  // The workspace-safe compatibility set is strictly inside the remote-exposed set: the profile
  // cannot reach a tool that remote clients are denied outright.
  const remoteBlocked = COMPATIBILITY_TOOLS.filter(d => d.remoteBlocked).map(d => d.tool);
  for (const tool of workspaceSafeCompatibilityTools()) {
    assert.ok(!remoteBlocked.includes(tool), `${tool} must not be both remote-blocked and workspace-safe`);
  }

  // And it is strictly smaller than the full operation catalog, or it would not be a restriction.
  assert.ok(workspaceSafeOperations().length < DEX_OPERATIONS.length);
  assert.ok(workspaceSafeCompatibilityTools().length < COMPATIBILITY_TOOLS.length);
});
