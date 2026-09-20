import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadAccessState, saveAccessState, type AccessState } from '../src/shared/access.js';
import { requestedAuthorityCost, requestedProcessMsIn, requestedWriteBytesIn } from '../src/shared/operations.js';
import { makeBudgetRule, upsertBudgetRule } from '../src/shared/budget-policy.js';
import {
  INFLIGHT_STALE_MS,
  inflightIsReclaimable,
  loadBudgetUsage,
  pruneUsage,
  reserveBudgetUsage,
  type BudgetUsage
} from '../src/shared/budget-usage.js';
import { emptyBudgetPolicy } from '../src/shared/budget-policy.js';
import {
  CapabilityRequestCorruptError,
  approveCapabilityRequest,
  capabilityRequestFile,
  createCapabilityRequest,
  listCapabilityRequests
} from '../src/shared/capability-requests.js';
import { addPolicyAssertion } from '../src/shared/policy-assertions.js';
import { NodeAuthStore } from '../src/gateway/node-auth.js';
import { encodeNodeProof, expectedProofDefaults, generateTransportKeyPair, signNodeProof } from '../src/shared/node-transport-auth.js';

/**
 * Regressions for defects found by the Phases 6-10 adversarial sweep. Each test fails against the
 * code as it was committed in b128735..22286d6 and passes against the corrections.
 */

const base = (mode: AccessState['mode'], extra: Partial<AccessState> = {}): AccessState => ({
  version: 3, revision: 0, mode, until: null, revertTo: null, clients: {}, grantRequired: {}, grants: [],
  updatedAt: new Date(0).toISOString(), ...extra
});

async function isolated(prefix: string): Promise<{ dir: string; node: string; restore: () => Promise<void> }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const previous = process.env.DEX_REACH_STATE_DIR;
  process.env.DEX_REACH_STATE_DIR = dir;
  return {
    dir,
    node: 'n',
    restore: async () => {
      if (previous === undefined) delete process.env.DEX_REACH_STATE_DIR;
      else process.env.DEX_REACH_STATE_DIR = previous;
      await fs.rm(dir, { recursive: true, force: true });
    }
  };
}

test('a compatibility call cannot launder write bytes past a write-bytes budget', async () => {
  const payload = 'x'.repeat(4096);

  // The same write, once natively and once through the compatibility adapter, must cost the same.
  const native = requestedAuthorityCost('dex.file.write', { path: '/tmp/a', text: payload });
  const viaCompat = requestedAuthorityCost('dc.call', { tool: 'write_file', arguments: { path: '/tmp/a', content: payload } });
  assert.equal(native.requestedWriteBytes, 4096);
  assert.equal(
    viaCompat.requestedWriteBytes, 4096,
    'a compatibility write must be charged its payload, or a write-bytes budget is bypassable'
  );

  // And the same for a process timeout routed through the adapter.
  const nativeShell = requestedAuthorityCost('dex.process.run', { command: 'ls', timeoutMs: 30_000 });
  const compatShell = requestedAuthorityCost('dc.call', { tool: 'start_process', arguments: { command: 'ls', timeout_ms: 30_000 } });
  assert.equal(nativeShell.requestedProcessMs, 30_000);
  assert.equal(compatShell.requestedProcessMs, 30_000, 'a compatibility process request must be charged its timeout');

  // Nested payloads are found at any depth, under either naming convention.
  assert.equal(requestedWriteBytesIn({ arguments: { deep: { content: 'abcd' } } }), 4);
  assert.equal(requestedWriteBytesIn({ arguments: { newString: 'abcde' } }), 5);
  assert.equal(requestedProcessMsIn({ arguments: { timeoutMs: 1234 } }), 1234);

  // A non-payload argument of the same size is not charged, so the cost stays about authority rather
  // than about request size.
  assert.equal(requestedWriteBytesIn({ arguments: { pattern: 'x'.repeat(4096) } }), 0);

  // An inspecting compatibility tool is charged no write bytes even if it carries a payload-shaped key.
  const inspectCompat = requestedAuthorityCost('dc.call', { tool: 'read_file', arguments: { path: '/tmp/a', content: payload } });
  assert.equal(inspectCompat.requestedWriteBytes, 0);
  assert.equal(inspectCompat.mutations, 0);

  // The cost function must stay deterministic: budgets reserve against it.
  assert.deepEqual(
    requestedAuthorityCost('dc.call', { tool: 'write_file', arguments: { path: '/tmp/a', content: payload } }),
    viaCompat
  );
});

test('a per-client budget measures only its own client', async () => {
  const ctx = await isolated('dex-reach-fix-scope-');
  try {
    await saveAccessState(ctx.node, base('on'), ctx.dir);
    // claude may spend 2 operations per hour. chatgpt has no rule of its own.
    await upsertBudgetRule(ctx.node, 'claude', makeBudgetRule('claude', 3_600_000, { maxOperations: 2 }), ctx.dir);

    const cost = requestedAuthorityCost('dex.file.read', { path: '/tmp/x' });

    // chatgpt spends four operations. None of it belongs to claude's ceiling.
    for (let i = 0; i < 4; i += 1) {
      const spent = await reserveBudgetUsage(ctx.node, 'chatgpt', cost, { dir: ctx.dir });
      assert.equal(spent.allowed, true, `chatgpt request ${i + 1} has no rule and must be admitted`);
    }

    const first = await reserveBudgetUsage(ctx.node, 'claude', cost, { dir: ctx.dir });
    assert.equal(first.allowed, true, "another client's usage must not consume claude's budget");
    const second = await reserveBudgetUsage(ctx.node, 'claude', cost, { dir: ctx.dir });
    assert.equal(second.allowed, true);

    // claude's own third request is the one that exceeds claude's own ceiling.
    const third = await reserveBudgetUsage(ctx.node, 'claude', cost, { dir: ctx.dir });
    assert.equal(third.allowed, false);
    assert.match(third.allowed ? '' : third.reason, /claude clients to 2 operations/);
  } finally {
    await ctx.restore();
  }
});

test('a shared budget still measures every client together', async () => {
  const ctx = await isolated('dex-reach-fix-shared-');
  try {
    await saveAccessState(ctx.node, base('on'), ctx.dir);
    await upsertBudgetRule(ctx.node, 'shared', makeBudgetRule('shared', 3_600_000, { maxOperations: 2 }), ctx.dir);
    const cost = requestedAuthorityCost('dex.file.read', { path: '/tmp/x' });

    assert.equal((await reserveBudgetUsage(ctx.node, 'chatgpt', cost, { dir: ctx.dir })).allowed, true);
    assert.equal((await reserveBudgetUsage(ctx.node, 'claude', cost, { dir: ctx.dir })).allowed, true);
    // Two different clients have together used the shared ceiling, so the third is refused.
    const third = await reserveBudgetUsage(ctx.node, 'smoke', cost, { dir: ctx.dir });
    assert.equal(third.allowed, false);
    assert.match(third.allowed ? '' : third.reason, /this node to 2 operations/);
  } finally {
    await ctx.restore();
  }
});

test('a crashed holder does not keep a concurrency slot forever', () => {
  const policy = { ...emptyBudgetPolicy(), shared: makeBudgetRule('shared', 3_600_000, { maxConcurrent: 1 }) };
  const now = Date.now();

  // A dead process past the staleness window is reclaimable. PID 1 is always alive, so a live holder
  // is not, however old its slot is: the ceiling must still hold for work that is genuinely running.
  const deadPid = 2 ** 22 + 7;
  assert.equal(inflightIsReclaimable({ id: 'a', client: 'claude', at: now - INFLIGHT_STALE_MS - 1, pid: deadPid }, now), true);
  assert.equal(inflightIsReclaimable({ id: 'b', client: 'claude', at: now - INFLIGHT_STALE_MS - 1, pid: 1 }, now), false);

  // A fresh slot is never reclaimed, dead holder or not.
  assert.equal(inflightIsReclaimable({ id: 'c', client: 'claude', at: now, pid: deadPid }, now), false);

  // A slot written before pids were recorded cannot be liveness-checked, so age alone reclaims it.
  assert.equal(inflightIsReclaimable({ id: 'd', client: 'claude', at: now - INFLIGHT_STALE_MS - 1 }, now), true);

  const leaked: BudgetUsage = {
    version: 1,
    samples: [],
    inflight: [
      { id: 'stale', client: 'claude', at: now - INFLIGHT_STALE_MS - 1, pid: deadPid },
      { id: 'live', client: 'claude', at: now, pid: 1 }
    ]
  };
  const pruned = pruneUsage(leaked, policy, now);
  assert.deepEqual(pruned.inflight.map(entry => entry.id), ['live'], 'the abandoned slot must be released');
});

test('pruning never refunds rolling cost that is still inside a window', () => {
  const policy = { ...emptyBudgetPolicy(), shared: makeBudgetRule('shared', 3_600_000, { maxOperations: 5 }) };
  const now = Date.now();
  const usage: BudgetUsage = {
    version: 1,
    samples: [
      { at: now - 1000, client: 'claude', operations: 1, mutations: 0, shellCalls: 0, requestedWriteBytes: 0, requestedProcessMs: 0 },
      { at: now - 3_600_001, client: 'claude', operations: 1, mutations: 0, shellCalls: 0, requestedWriteBytes: 0, requestedProcessMs: 0 }
    ],
    inflight: []
  };
  const pruned = pruneUsage(usage, policy, now);
  assert.equal(pruned.samples.length, 1, 'the out-of-window sample is dropped and the in-window one is kept');
  assert.equal(pruned.samples[0]!.at, now - 1000);
});

test('a corrupt capability request log is refused rather than silently emptied', async () => {
  const ctx = await isolated('dex-reach-fix-requests-');
  try {
    await saveAccessState(ctx.node, base('on'), ctx.dir);

    // A real request, so there is an audit trail worth losing.
    const created = await createCapabilityRequest(ctx.node, {
      client: 'claude',
      capabilities: ['file.read'],
      roots: [ctx.dir],
      durationMs: 60_000,
      maxUses: 1,
      justification: 'read one project file'
    }, ctx.dir);
    assert.equal((await listCapabilityRequests(ctx.node, ctx.dir)).length, 1);

    // Corrupt the file the way a truncated write or a bad edit would.
    const file = capabilityRequestFile(ctx.node, ctx.dir);
    await fs.writeFile(file, '{"version":1,"requests":[{"id":', 'utf8');

    await assert.rejects(() => listCapabilityRequests(ctx.node, ctx.dir), CapabilityRequestCorruptError);

    // The critical part: creating a new request must not overwrite the corrupt file, because doing so
    // destroyed the record of requests whose grants may still be live.
    await assert.rejects(() => createCapabilityRequest(ctx.node, {
      client: 'claude',
      capabilities: ['file.read'],
      roots: [ctx.dir],
      durationMs: 60_000,
      maxUses: 1,
      justification: 'a second request'
    }, ctx.dir), CapabilityRequestCorruptError);

    const onDisk = await fs.readFile(file, 'utf8');
    assert.equal(onDisk, '{"version":1,"requests":[{"id":', 'the corrupt file must be left untouched for the owner');
    assert.ok(!onDisk.includes(created.id) || onDisk === '{"version":1,"requests":[{"id":');
  } finally {
    await ctx.restore();
  }
});

test('a full nonce cache refuses new proofs instead of forgetting replayable ones', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dex-reach-fix-nonce-'));
  try {
    const store = new NodeAuthStore(dir);
    await store.initialize();
    await store.enroll('node-a');
    const keys = generateTransportKeyPair();
    const enrollment = await store.createEnrollmentToken('node-a');
    await store.consumeEnrollment('node-a', enrollment, keys.publicKey);

    const captured = signNodeProof(keys.privateKey, expectedProofDefaults('node-a'));
    const first = await store.authenticateProof('node-a', encodeNodeProof(captured));
    assert.equal(first.ok, true);

    // Replay is refused while the nonce is remembered.
    const replay = await store.authenticateProof('node-a', encodeNodeProof(captured));
    assert.equal(replay.ok, false);
    assert.equal(replay.ok ? '' : replay.reason, 'replay');

    // Fill the cache with live nonces. Once it is full of entries that can still be replayed, a new
    // proof must be refused; evicting one to make room would make that evicted proof replayable.
    let sawCapacity = false;
    for (let i = 0; i < 5000; i += 1) {
      const proof = signNodeProof(keys.privateKey, expectedProofDefaults('node-a'));
      const result = await store.authenticateProof('node-a', encodeNodeProof(proof));
      if (!result.ok && result.reason === 'nonce-capacity') { sawCapacity = true; break; }
      assert.equal(result.ok, true, `proof ${i} should either authenticate or hit capacity`);
    }
    assert.equal(sawCapacity, true, 'the cache must fail closed at capacity rather than evict live nonces');

    // The originally captured proof is still refused as a replay, which is the property eviction broke.
    const replayAfterFull = await store.authenticateProof('node-a', encodeNodeProof(captured));
    assert.equal(replayAfterFull.ok, false);
    assert.equal(replayAfterFull.ok ? '' : replayAfterFull.reason, 'replay');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

/**
 * Regression for a defect introduced by the correction above. Failing closed at capacity is right,
 * but the capacity was counted across every node at once, so one node's ordinary traffic refused
 * every other node's proofs. A node must only ever exhaust its own share.
 */
test('one node filling its nonce share does not lock another node out', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dex-reach-fix-nonce-scope-'));
  try {
    const store = new NodeAuthStore(dir);
    await store.initialize();
    const enrolled = new Map<string, string>();
    for (const nodeId of ['node-busy', 'node-quiet']) {
      const keys = generateTransportKeyPair();
      await store.consumeEnrollment(nodeId, await store.createEnrollmentToken(nodeId), keys.publicKey);
      enrolled.set(nodeId, keys.privateKey);
    }
    const proofFor = (nodeId: string) =>
      encodeNodeProof(signNodeProof(enrolled.get(nodeId) as string, expectedProofDefaults(nodeId)));

    assert.equal((await store.authenticateProof('node-quiet', proofFor('node-quiet'))).ok, true);

    // node-busy is a well-behaved node doing a lot of work: every proof is correctly signed.
    let sawCapacity = false;
    for (let i = 0; i < 6000; i += 1) {
      const result = await store.authenticateProof('node-busy', proofFor('node-busy'));
      if (!result.ok && result.reason === 'nonce-capacity') { sawCapacity = true; break; }
      assert.equal(result.ok, true, `node-busy proof ${i} should authenticate or hit its own capacity`);
    }
    assert.equal(sawCapacity, true, 'a node must still fail closed once its own share is exhausted');

    // The node that did nothing is unaffected. A shared ceiling refused it here.
    const quiet = await store.authenticateProof('node-quiet', proofFor('node-quiet'));
    assert.equal(quiet.ok, true, 'one node must not be able to deny another node authentication');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

/**
 * Approval must record the decision before it creates authority.
 *
 * The grant used to be written first. Any failure of the decision step then left a live capability
 * grant in owner policy while the request still read `pending` or `expired` with `grantId: null`,
 * and the owner had been told the approval failed: authority with no record explaining it.
 */
test('a failed approval never leaves a grant the request does not record', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dex-reach-fix-approve-'));
  const node = 'approve-node';
  try {
    await saveAccessState(node, base('on'), dir);
    // An owner assertion that this client must never hold file.write makes grant creation fail.
    await addPolicyAssertion(node, { client: 'claude', forbidCapabilities: ['file.write'], note: 'no writes for claude' }, dir);
    const request = await createCapabilityRequest(node, {
      client: 'claude', capabilities: ['file.write'], roots: [path.join(dir, 'project')],
      durationMs: 2 * 3_600_000, maxUses: null, justification: 'regression'
    }, dir);

    await assert.rejects(() => approveCapabilityRequest(node, request.id, {}, dir));

    // No authority was created, and the decision that was attempted is on the record.
    const state = await loadAccessState(node, dir);
    assert.equal(state.grants.length, 0, 'a refused grant must not exist in owner policy');
    const recorded = (await listCapabilityRequests(node, dir)).find(entry => entry.id === request.id);
    assert.equal(recorded?.status, 'approved', 'the decision must be durable before any grant is written');
    assert.equal(recorded?.grantId, request.id);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

/**
 * The same property across the expiry boundary, where the old ordering actually leaked: the request
 * was pending when approval started and expired before the decision was recorded. This sweep only
 * fails when a leak is observed, so it can miss the window but never fails spuriously.
 */
test('approval across the request expiry boundary never grants authority it does not record', async () => {
  for (let lead = 0; lead <= 12; lead += 1) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dex-reach-fix-approve-race-'));
    const node = 'race-node';
    try {
      await saveAccessState(node, base('on'), dir);
      const request = await createCapabilityRequest(node, {
        client: 'claude', capabilities: ['file.write'], roots: [path.join(dir, 'project')],
        durationMs: 600, maxUses: null, justification: 'regression'
      }, dir);
      const target = Date.parse(request.expiresAt) - lead;
      while (Date.now() < target) { /* spin to the exact boundary */ }

      let failed = false;
      try { await approveCapabilityRequest(node, request.id, {}, dir); } catch { failed = true; }
      if (!failed) continue;

      const state = await loadAccessState(node, dir);
      const recorded = (await listCapabilityRequests(node, dir)).find(entry => entry.id === request.id);
      assert.equal(
        state.grants.length, 0,
        `a failed approval left ${state.grants.length} live grant(s) while the request records ${recorded?.status} grantId=${recorded?.grantId}`
      );
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  }
});
