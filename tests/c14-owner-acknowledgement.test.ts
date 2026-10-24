import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { NodeTaskStore } from '../src/node/task-store.js';
import { appendQuarantine, readQuarantine, quarantineFile, type QuarantinedTaskIdentity } from '../src/shared/task-quarantine.js';
import { acknowledgeTask, listAcknowledgementCandidates, taskDisposition } from '../scripts/lib/c14-window-evidence.js';
import { RELEASE_ROOT, RETAINED_RELEASE, RETAINED_TREE, evaluatePreflight, type PreflightFacts } from '../scripts/lib/c14-recovery-preflight.js';
import type { TaskInspection } from '../scripts/lib/recovery-reconciliation.js';

// Owner per-record acknowledgement (decision D3). Synthetic records in an isolated temp state directory only.

const actor = { by: 'andrew', uid: 501, host: 'MacBook-Air.local' };

async function world() {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'dex-owner-ack-')));
  const previous = process.env.DEX_REACH_STATE_DIR; process.env.DEX_REACH_STATE_DIR = dir;
  const store = new NodeTaskStore(dir);
  const make = async (key: string, state: 'PREPARING' | 'RUNNING' = 'PREPARING') => {
    const t = await store.create({ actorId: 'historical-actor', nodeId: 'macbook-air.local', operation: state === 'RUNNING' ? 'dex.file.read' : 'dex.process.run', idempotencyKey: key, payloadSha256: 'a'.repeat(64), safetyClass: 'PROCESS_UNKNOWN_EFFECT', mutationLevel: 'STATE_MUTATION' });
    await store.transition(t.taskId, 'PREPARING'); if (state === 'RUNNING') await store.transition(t.taskId, 'RUNNING');
    return (await store.read(t.taskId))!;
  };
  const records = async (): Promise<Record<string, QuarantinedTaskIdentity>> => JSON.parse(await fs.readFile(path.join(dir, 'tasks/store.json'), 'utf8')).records;
  /** Every task-history file, byte for byte. The acknowledgement may only ever add the quarantine log. */
  const history = async () => Object.fromEntries(await Promise.all(['tasks/store.json', 'tasks/events.jsonl'].map(async f => [f, await fs.readFile(path.join(dir, f)).catch(() => null)])));
  return { dir, store, make, records, history, cleanup: async () => { if (previous === undefined) delete process.env.DEX_REACH_STATE_DIR; else process.env.DEX_REACH_STATE_DIR = previous; await fs.rm(dir, { recursive: true, force: true }); } };
}
const row = (t: { taskId: string; state: string }, classification = 'AMBIGUOUS_EFFECT', ev: { activity?: boolean; lease?: boolean; ticket?: boolean } = {}) =>
  ({ taskId: t.taskId, state: t.state, actorId: 'historical-actor', updatedAt: '2026-10-10T00:00:00.000Z', classification, evidence: { activity: Boolean(ev.activity), lease: Boolean(ev.lease), ticket: Boolean(ev.ticket) } }) as unknown as TaskInspection;

test('dry run is the default: nothing is written; --confirm appends exactly one owner-attributed line and history stays byte-identical', async () => {
  const w = await world(); try {
    const a = await w.make('a'), rows = [row(a)], before = await w.history();
    const dry = await acknowledgeTask(w.dir, rows, await w.records(), { taskId: a.taskId, reason: 'Reviewed 2026-10-24; effect unknown, accept as historical', actor, confirm: false });
    assert.equal(dry.status, 'WOULD_APPEND');
    await assert.rejects(fs.access(quarantineFile(w.dir)), 'a dry run creates no log');
    const done = await acknowledgeTask(w.dir, rows, await w.records(), { taskId: a.taskId, reason: '  Reviewed 2026-10-24; effect unknown  ', actor, confirm: true, at: '2026-10-24T14:00:00.000Z' });
    assert.equal(done.status, 'APPENDED');
    const entry = (await readQuarantine(w.dir)).get(a.taskId)!;
    assert.deepEqual(entry.acknowledgement, { ...actor, reason: 'Reviewed 2026-10-24; effect unknown' });
    assert.equal(entry.at, '2026-10-24T14:00:00.000Z'); assert.equal(entry.effect, 'UNKNOWN'); assert.equal(entry.replayAuthorized, false);
    assert.equal(entry.observedState, 'PREPARING'); assert.equal(entry.classification, 'AMBIGUOUS_EFFECT');
    assert.deepEqual(await w.history(), before, 'task store and event history are untouched');
    assert.equal((await w.store.read(a.taskId))!.state, 'PREPARING', 'the record still shows its original state');
  } finally { await w.cleanup(); }
});

test('re-acknowledging is a no-op, not a duplicate; earlier log bytes never change', async () => {
  const w = await world(); try {
    const a = await w.make('a'), b = await w.make('b', 'RUNNING'), rows = [row(a), row(b, 'INSUFFICIENT_EVIDENCE')];
    await acknowledgeTask(w.dir, rows, await w.records(), { taskId: a.taskId, reason: 'first', actor, confirm: true });
    const file = quarantineFile(w.dir), first = await fs.readFile(file, 'utf8');
    const again = await acknowledgeTask(w.dir, rows, await w.records(), { taskId: a.taskId, reason: 'second', actor, confirm: true });
    assert.equal(again.status, 'ALREADY_ACKNOWLEDGED');
    assert.equal(await fs.readFile(file, 'utf8'), first);
    assert.equal((await acknowledgeTask(w.dir, rows, await w.records(), { taskId: b.taskId, reason: 'file read, no effect to know', actor, confirm: true })).status, 'APPENDED');
    assert.ok((await fs.readFile(file, 'utf8')).startsWith(first), 'appends only');
    assert.equal((await readQuarantine(w.dir)).size, 2);
  } finally { await w.cleanup(); }
});

test('refusals write nothing: missing reason, unknown id, resolved class, live claim, missing record, stale entry', async () => {
  const w = await world(); try {
    const a = await w.make('a'), live = await w.make('live'), lease = await w.make('lease'), ticket = await w.make('ticket'), active = await w.make('active'), gone = await w.make('gone');
    const rows = [row(a), row(live, 'AMBIGUOUS_EFFECT', { activity: true }), row(lease, 'AMBIGUOUS_EFFECT', { lease: true }), row(ticket, 'INSUFFICIENT_EVIDENCE', { ticket: true }), row(active, 'ACTIVE_CONFIRMED'), row(gone)];
    const records = await w.records(); delete records[gone.taskId];
    const ask = (taskId: string, reason = 'owner review') => acknowledgeTask(w.dir, rows, records, { taskId, reason, actor, confirm: true });
    const reason = async (taskId: string, r?: string) => { const o = await ask(taskId, r); assert.equal(o.status, 'REFUSED'); return (o as { reason: string }).reason; };
    assert.equal(await reason(a.taskId, '   '), 'REASON_REQUIRED');
    assert.equal(await reason('task_does_not_exist'), 'UNKNOWN_TASK');
    assert.equal(await reason(active.taskId), 'NOT_UNRESOLVED');
    for (const t of [live, lease, ticket]) assert.equal(await reason(t.taskId), 'LIVE_CLAIM');
    assert.equal(await reason(gone.taskId), 'RECORD_MISSING');
    await assert.rejects(fs.access(quarantineFile(w.dir)), 'no refusal wrote anything');
    // An entry for a record whose identity has since changed is refused, never silently re-acknowledged.
    await appendQuarantine(w.dir, [{ task: { ...records[a.taskId]!, state: 'RUNNING' }, classification: 'AMBIGUOUS_EFFECT' }], { kind: 'owner-authorization', grantedAt: '2026-10-24T00:00:00.000Z', scope: 'test' });
    const bytes = await fs.readFile(quarantineFile(w.dir), 'utf8');
    assert.equal(await reason(a.taskId), 'ENTRY_NO_LONGER_MATCHES');
    assert.equal(await fs.readFile(quarantineFile(w.dir), 'utf8'), bytes);
    await assert.rejects(appendQuarantine(w.dir, [{ task: records[live.taskId]!, classification: 'AMBIGUOUS_EFFECT', acknowledgement: { ...actor, reason: '' } }], { kind: 'owner-authorization', grantedAt: '2026-10-24T00:00:00.000Z', scope: 'test' }), /ACKNOWLEDGEMENT_INVALID/);
  } finally { await w.cleanup(); }
});

test('acknowledged records cannot be replayed or changed: the task store refuses every transition', async () => {
  const w = await world(); try {
    const a = await w.make('a');
    await acknowledgeTask(w.dir, [row(a)], await w.records(), { taskId: a.taskId, reason: 'owner review', actor, confirm: true });
    const before = await w.history();
    for (const next of ['RUNNING', 'COMPLETED', 'FAILED'] as const) await assert.rejects(w.store.transition(a.taskId, next), /TASK_QUARANTINED/);
    assert.deepEqual(await w.history(), before);
  } finally { await w.cleanup(); }
});

test('a tampered acknowledgement breaks the hash chain and fails closed', async () => {
  const w = await world(); try {
    const a = await w.make('a');
    await acknowledgeTask(w.dir, [row(a)], await w.records(), { taskId: a.taskId, reason: 'owner review', actor, confirm: true });
    const file = quarantineFile(w.dir);
    await fs.writeFile(file, (await fs.readFile(file, 'utf8')).replace('owner review', 'someone else'));
    await assert.rejects(readQuarantine(w.dir), /QUARANTINE_LOG_CORRUPT/);
  } finally { await w.cleanup(); }
});

function facts(taskCount: number, taskUnresolved: number, taskQuarantined: number): PreflightFacts {
  const hash = 'b'.repeat(64), sha = 'a'.repeat(40);
  return { hostname: 'MacBook-Air.local', model: 'MacBookAir10,1', platform: 'darwin', arch: 'arm64', user: 'andrew', uid: 501, home: '/Users/andrew', root: RELEASE_ROOT, repositoryUrl: 'git@github.com:westkitty/DEX-REACH.git', branch: '', head: sha, remoteHead: sha, dirty: false, approvedSha: sha, candidateVersion: '0.4.0', approvedVersion: '0.4.0', ciHead: sha, ciChecks: Object.fromEntries(['validate', 'runtime-proof', 'reproducible-build', 'analyze', 'CodeQL'].map(k => [k, 'SUCCESS'])), installedIntact: true, installedRelease: RETAINED_RELEASE, servicesVerified: true, backupCertified: true,
    baseline: { previousReleaseId: RETAINED_RELEASE, previousDigest: RETAINED_TREE, observedDigest: RETAINED_TREE, previousExists: true, provenance: 'manifest-verified', legacyProvenanceApproved: false, transactionId: '12345678-1234-4234-8234-123456789abc', state: 'prepared', fresh: true, serviceReleaseIds: Array(5).fill(RETAINED_RELEASE), configVerified: true, inventoryVerified: true, helperIdle: true, rollbackActive: false, provenanceDetails: { sourceSha: '87a99494ebb3471d3ecc3a79acd630ec18858a92', installTransaction: '9bf5079f-397e-4cd8-af35-99f1550d3d68', dependencyDigest: hash, configDigest: hash, expectedConfigDigest: hash, policyDigest: hash, expectedPolicyDigest: hash, ownerManifestDigest: hash, trustedManifestDigest: hash, snapshotComplete: true, metadataVerified: true, reserveVerified: true } },
    restoreProof: { scope: 'synthetic', sourceSha: sha, passed: true }, taskCount, taskUnresolved, taskQuarantined, claimsKnown: true, claimsCount: 0, ownerPreservationVerified: true, freeBytes: 10 * 1024 ** 3, spaceMeasured: true, space: { candidateBytes: 100, dependencyBytes: 100, retainedBytes: 100, backupBytes: 100, restoreBytes: 100, stagingBytes: 100, reserveBytes: 2 * 1024 ** 3 }, exactLegacyPairingVerified: true, credentialsCompatible: true, requiredHostCapabilityAvailable: true, maintenanceAuthorized: true };
}

test('preflight NONTERMINAL_TASKS flips from blocked to clear only when every record of any count is acknowledged; other gates unchanged', async () => {
  for (const count of [1, 19, 21]) {
    const w = await world(); try {
      const tasks = await Promise.all(Array.from({ length: count }, (_, i) => w.make(`k${i}`, i % 10 === 9 ? 'RUNNING' : 'PREPARING')));
      const rows = tasks.map(t => row(t, t.state === 'RUNNING' ? 'INSUFFICIENT_EVIDENCE' : 'AMBIGUOUS_EFFECT'));
      const gate = async () => { const d = taskDisposition(rows, await w.records(), await readQuarantine(w.dir)); return evaluatePreflight(facts(d.total, d.unresolved, d.quarantined)); };
      const baseline = await gate();
      assert.equal(baseline.checks.NONTERMINAL_TASKS, false);
      for (const [i, t] of tasks.entries()) {
        assert.equal((await gate()).checks.NONTERMINAL_TASKS, false, `still blocked with ${count - i} unacknowledged`);
        await acknowledgeTask(w.dir, rows, await w.records(), { taskId: t.taskId, reason: `owner review ${i}`, actor, confirm: true });
      }
      const cleared = await gate();
      assert.equal(cleared.checks.NONTERMINAL_TASKS, true);
      const others = (r: typeof cleared) => Object.fromEntries(Object.entries(r.checks).filter(([k]) => k !== 'NONTERMINAL_TASKS'));
      assert.deepEqual(others(cleared), others(baseline), 'no other gate moved');
      const listing = listAcknowledgementCandidates(rows, await w.records(), await readQuarantine(w.dir));
      assert.equal(listing.length, count); assert.ok(listing.every(r => r.dispositioned && r.acknowledgedBy === 'andrew' && r.replayAuthorized === false));
    } finally { await w.cleanup(); }
  }
});
