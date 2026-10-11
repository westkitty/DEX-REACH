import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { NodeTaskStore } from '../src/node/task-store.js';
import { ResultStore } from '../src/node/result-store.js';
import { reconcileBootTasks } from '../src/node/boot-recovery.js';
import { cancelTask, reconcileTask, resetTask, resumeTask, requestPause } from '../src/node/task-control.js';
import { appendQuarantine, readQuarantine, quarantineFile, quarantineMatches } from '../src/shared/task-quarantine.js';

const authority = { kind: 'owner-authorization' as const, grantedAt: '2026-10-10T23:30:00.000Z', scope: 'preserve historical tasks; effect unknown; no replay' };

async function world() {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'dex-quarantine-')));
  const previous = process.env.DEX_REACH_STATE_DIR; process.env.DEX_REACH_STATE_DIR = dir;
  const store = new NodeTaskStore(dir);
  const make = async (key: string, state: 'PREPARING' | 'RUNNING') => {
    const t = await store.create({ actorId: 'historical-actor', nodeId: 'macbook-air.local', operation: 'dex.process.run', idempotencyKey: key, payloadSha256: 'a'.repeat(64), safetyClass: 'PROCESS_UNKNOWN_EFFECT', mutationLevel: 'STATE_MUTATION' });
    await store.transition(t.taskId, 'PREPARING'); if (state === 'RUNNING') await store.transition(t.taskId, 'RUNNING');
    return (await store.read(t.taskId))!;
  };
  return { dir, store, make, cleanup: async () => { if (previous === undefined) delete process.env.DEX_REACH_STATE_DIR; else process.env.DEX_REACH_STATE_DIR = previous; await fs.rm(dir, { recursive: true, force: true }); } };
}
const recordJson = async (dir: string, taskId: string) => JSON.stringify(JSON.parse(await fs.readFile(path.join(dir, 'tasks/store.json'), 'utf8')).records[taskId]);

test('quarantine is an append-only verified chain bound to task identity and state', async () => {
  const w = await world(); try {
    const a = await w.make('a', 'PREPARING'), b = await w.make('b', 'RUNNING');
    await appendQuarantine(w.dir, [{ task: a, classification: 'AMBIGUOUS_EFFECT' }], authority);
    await appendQuarantine(w.dir, [{ task: b, classification: 'INSUFFICIENT_EVIDENCE' }], authority);
    const q = await readQuarantine(w.dir);
    assert.deepEqual([...q.keys()], [a.taskId, b.taskId]);
    assert.equal(q.get(a.taskId)!.effect, 'UNKNOWN'); assert.equal(q.get(a.taskId)!.replayAuthorized, false);
    assert.ok(quarantineMatches(q.get(a.taskId)!, a));
    assert.ok(!quarantineMatches(q.get(a.taskId)!, { ...a, state: 'FAILED' }), 'a changed state no longer matches');
    assert.ok(!quarantineMatches(q.get(a.taskId)!, { ...a, payloadSha256: 'b'.repeat(64) }), 'a changed identity no longer matches');
    await assert.rejects(appendQuarantine(w.dir, [{ task: a, classification: 'AMBIGUOUS_EFFECT' }], authority), /QUARANTINE_DUPLICATE/);
    await assert.rejects(appendQuarantine(w.dir, [{ task: a, classification: 'X' }], { ...authority, scope: ' ' }), /AUTHORITY_INVALID/);
  } finally { await w.cleanup(); }
});

test('a damaged quarantine log refuses rather than releasing tasks; an unfinished final append is ignored', async () => {
  const w = await world(); try {
    const a = await w.make('a', 'PREPARING'), b = await w.make('b', 'PREPARING');
    await appendQuarantine(w.dir, [{ task: a, classification: 'AMBIGUOUS_EFFECT' }, { task: b, classification: 'AMBIGUOUS_EFFECT' }], authority);
    const file = quarantineFile(w.dir), original = await fs.readFile(file, 'utf8');
    await fs.appendFile(file, '{"partial":');
    assert.equal((await readQuarantine(w.dir)).size, 2);
    for (const damaged of [original.replace('"AMBIGUOUS_EFFECT"', '"RESOLVED"'), original.split('\n').reverse().join('\n').trimStart() + '\n', original.split('\n').slice(1).join('\n')]) {
      await fs.writeFile(file, damaged);
      await assert.rejects(readQuarantine(w.dir), /QUARANTINE_LOG_CORRUPT/);
      await assert.rejects(w.store.transition(a.taskId, 'CANCELLED'), /QUARANTINE_LOG_CORRUPT/);
    }
  } finally { await w.cleanup(); }
});

test('the task store refuses every transition and update of a quarantined task', async () => {
  const w = await world(); try {
    const a = await w.make('a', 'PREPARING'), free = await w.make('free', 'PREPARING');
    await appendQuarantine(w.dir, [{ task: a, classification: 'AMBIGUOUS_EFFECT' }], authority);
    const before = await recordJson(w.dir, a.taskId);
    // Includes the remote actor cancel path (PREPARING -> CANCELLED "before execution").
    await assert.rejects(w.store.transition(a.taskId, 'CANCELLED', 'cancelled before execution', ['ACCEPTED', 'PREPARING']), /TASK_QUARANTINED/);
    await assert.rejects(w.store.transition(a.taskId, 'FAILED'), /TASK_QUARANTINED/);
    await assert.rejects(w.store.update(a.taskId, { status: 'resolved' }), /TASK_QUARANTINED/);
    await assert.rejects(w.store.update(a.taskId, { failureClass: 'AMBIGUOUS_EFFECT' }), /TASK_QUARANTINED/);
    assert.equal(await recordJson(w.dir, a.taskId), before);
    await w.store.transition(free.taskId, 'CANCELLED');
    assert.equal((await w.store.read(free.taskId))!.state, 'CANCELLED');
  } finally { await w.cleanup(); }
});

test('owner controls cannot cancel, reconcile, pause, reset or resume a quarantined task', async () => {
  const w = await world(); try {
    const a = await w.make('a', 'RUNNING');
    await appendQuarantine(w.dir, [{ task: a, classification: 'INSUFFICIENT_EVIDENCE' }], authority);
    const count = (await w.store.list({ includeArchived: true })).length;
    await assert.rejects(cancelTask(w.store, a.taskId), /TASK_QUARANTINED/);
    await assert.rejects(reconcileTask(w.store, a.taskId, 'evidence-ref'), /TASK_QUARANTINED/);
    await assert.rejects(requestPause(w.store, a.taskId, 'phase'), /TASK_QUARANTINED/);
    await assert.rejects(resetTask(w.store, a.taskId), /TASK_QUARANTINED/);
    await assert.rejects(resumeTask(w.store, a.taskId), /TASK_QUARANTINED/);
    assert.equal((await w.store.list({ includeArchived: true })).length, count, 'no child task was created');
  } finally { await w.cleanup(); }
});

test('boot recovery leaves quarantined records byte-identical and still reconciles the others', async () => {
  const w = await world(); try {
    const a = await w.make('a', 'PREPARING'), b = await w.make('b', 'RUNNING'), other = await w.make('other', 'PREPARING');
    await appendQuarantine(w.dir, [{ task: a, classification: 'AMBIGUOUS_EFFECT' }, { task: b, classification: 'AMBIGUOUS_EFFECT' }], authority);
    const before = [await recordJson(w.dir, a.taskId), await recordJson(w.dir, b.taskId)];
    const events = await fs.readFile(path.join(w.dir, 'tasks/events.jsonl'), 'utf8');
    const reports = await reconcileBootTasks(w.store, new ResultStore(64 * 1024, 60_000, w.dir));
    assert.deepEqual([await recordJson(w.dir, a.taskId), await recordJson(w.dir, b.taskId)], before);
    assert.match(reports.find(r => r.taskId === a.taskId)!.decision.reason, /Owner-quarantined/);
    assert.ok(!(await fs.readFile(path.join(w.dir, 'tasks/events.jsonl'), 'utf8')).slice(events.length).includes(a.taskId), 'no event appended for a quarantined task');
    assert.notEqual(await recordJson(w.dir, other.taskId), '', 'the unquarantined task is still processed');
    assert.ok(reports.some(r => r.taskId === other.taskId && !/Owner-quarantined/.test(r.decision.reason)));
  } finally { await w.cleanup(); }
});
