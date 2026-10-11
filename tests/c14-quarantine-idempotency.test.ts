import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { NodeTaskStore } from '../src/node/task-store.js';
import { appendQuarantine, readQuarantine, quarantineFile, type QuarantinedTaskIdentity } from '../src/shared/task-quarantine.js';
import { selectQuarantineCandidates } from '../scripts/lib/c14-window-evidence.js';
import type { TaskInspection } from '../scripts/lib/recovery-reconciliation.js';

// Quarantine idempotency at the owner-run boundary: candidate selection feeds the append-only chain.
// Synthetic task records only, in an isolated temp state directory. Nothing touches owner state.

const authority = { kind: 'owner-authorization' as const, grantedAt: '2026-10-10T23:30:00.000Z', scope: 'preserve historical tasks; effect unknown; no replay' };

async function world() {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'dex-quarantine-idem-')));
  const previous = process.env.DEX_REACH_STATE_DIR; process.env.DEX_REACH_STATE_DIR = dir;
  const store = new NodeTaskStore(dir);
  const make = async (key: string, state: 'PREPARING' | 'RUNNING' = 'PREPARING') => {
    const t = await store.create({ actorId: 'historical-actor', nodeId: 'macbook-air.local', operation: 'dex.process.run', idempotencyKey: key, payloadSha256: 'a'.repeat(64), safetyClass: 'PROCESS_UNKNOWN_EFFECT', mutationLevel: 'STATE_MUTATION' });
    await store.transition(t.taskId, 'PREPARING'); if (state === 'RUNNING') await store.transition(t.taskId, 'RUNNING');
    return (await store.read(t.taskId))!;
  };
  const records = async (): Promise<Record<string, QuarantinedTaskIdentity>> => JSON.parse(await fs.readFile(path.join(dir, 'tasks/store.json'), 'utf8')).records;
  return { dir, store, make, records, cleanup: async () => { if (previous === undefined) delete process.env.DEX_REACH_STATE_DIR; else process.env.DEX_REACH_STATE_DIR = previous; await fs.rm(dir, { recursive: true, force: true }); } };
}

const row = (taskId: string, classification = 'AMBIGUOUS_EFFECT', ev: { activity?: boolean; lease?: boolean; ticket?: boolean } = {}) =>
  ({ taskId, classification, evidence: { activity: Boolean(ev.activity), lease: Boolean(ev.lease), ticket: Boolean(ev.ticket) } }) as unknown as TaskInspection;

/** One owner run exactly as the CLI performs it: select from the current evidence, then append. */
async function ownerRun(w: Awaited<ReturnType<typeof world>>, rows: TaskInspection[]) {
  const existing = new Set((await readQuarantine(w.dir)).keys());
  const selection = selectQuarantineCandidates(rows, await w.records(), existing);
  const written = await appendQuarantine(w.dir, selection.append, authority);
  return { selection, written };
}

test('a repeated run does not duplicate existing records; later eligible records are appended; prior receipts stay byte-identical', async () => {
  const w = await world(); try {
    const a = await w.make('a');
    const first = await ownerRun(w, [row(a.taskId)]);
    assert.deepEqual(first.written.map(e => e.taskId), [a.taskId]);
    const file = quarantineFile(w.dir), afterFirst = await fs.readFile(file, 'utf8');
    const again = await ownerRun(w, [row(a.taskId)]);
    assert.deepEqual(again.selection.append, [], 'an already-quarantined record is never selected again');
    assert.deepEqual(again.selection.already, [a.taskId]);
    assert.equal(await fs.readFile(file, 'utf8'), afterFirst, 'a repeated run writes nothing');
    const b = await w.make('b', 'RUNNING');
    const later = await ownerRun(w, [row(a.taskId), row(b.taskId, 'INSUFFICIENT_EVIDENCE')]);
    assert.deepEqual(later.written.map(e => e.taskId), [b.taskId], 'only the new eligible record is appended');
    assert.ok((await fs.readFile(file, 'utf8')).startsWith(afterFirst), 'the earlier receipt bytes are unchanged');
    assert.equal((await readQuarantine(w.dir)).size, 2);
  } finally { await w.cleanup(); }
});

test('ineligible records are never appended: live activity, lease, ticket, wrong classification, or no record', async () => {
  const w = await world(); try {
    const live = await w.make('live'), leased = await w.make('leased'), ticketed = await w.make('ticketed'), odd = await w.make('odd'), eligible = await w.make('eligible');
    const { selection, written } = await ownerRun(w, [
      row(live.taskId, 'AMBIGUOUS_EFFECT', { activity: true }), row(leased.taskId, 'AMBIGUOUS_EFFECT', { lease: true }),
      row(ticketed.taskId, 'AMBIGUOUS_EFFECT', { ticket: true }), row(odd.taskId, 'ACTIVE_CONFIRMED'),
      row('task_missing_record'), row(eligible.taskId)
    ]);
    assert.deepEqual(written.map(e => e.taskId), [eligible.taskId]);
    assert.deepEqual(selection.ineligible.sort(), [live.taskId, leased.taskId, ticketed.taskId, odd.taskId, 'task_missing_record'].sort());
    assert.deepEqual([...(await readQuarantine(w.dir)).keys()], [eligible.taskId], 'no ineligible record reached the log');
  } finally { await w.cleanup(); }
});

test('a batch containing an already-quarantined record is refused whole: a mixed batch cannot silently pass', async () => {
  const w = await world(); try {
    const a = await w.make('a'), b = await w.make('b');
    await appendQuarantine(w.dir, [{ task: a, classification: 'AMBIGUOUS_EFFECT' }], authority);
    const file = quarantineFile(w.dir), before = await fs.readFile(file, 'utf8');
    await assert.rejects(appendQuarantine(w.dir, [{ task: b, classification: 'AMBIGUOUS_EFFECT' }, { task: a, classification: 'AMBIGUOUS_EFFECT' }], authority), /QUARANTINE_DUPLICATE/);
    assert.equal(await fs.readFile(file, 'utf8'), before, 'nothing from the refused batch was written, including the new record');
  } finally { await w.cleanup(); }
});

test('a corrupt quarantine log fails the owner run closed: no append, no bytes changed', async () => {
  const w = await world(); try {
    const a = await w.make('a'), b = await w.make('b');
    await appendQuarantine(w.dir, [{ task: a, classification: 'AMBIGUOUS_EFFECT' }], authority);
    const file = quarantineFile(w.dir);
    await fs.writeFile(file, (await fs.readFile(file, 'utf8')).replace('"AMBIGUOUS_EFFECT"', '"RESOLVED"'));
    const before = await fs.readFile(file, 'utf8');
    await assert.rejects(ownerRun(w, [row(a.taskId), row(b.taskId)]), /QUARANTINE_LOG_CORRUPT/);
    assert.equal(await fs.readFile(file, 'utf8'), before);
  } finally { await w.cleanup(); }
});

test('an unfinished final append is tolerated for reads, but a later append must not write onto it', async () => {
  const w = await world(); try {
    const a = await w.make('a'), b = await w.make('b');
    await appendQuarantine(w.dir, [{ task: a, classification: 'AMBIGUOUS_EFFECT' }], authority);
    const file = quarantineFile(w.dir);
    await fs.appendFile(file, '{"partial":');
    const torn = await fs.readFile(file, 'utf8');
    assert.equal((await readQuarantine(w.dir)).size, 1, 'reads ignore the unfinished tail');
    await assert.rejects(appendQuarantine(w.dir, [{ task: b, classification: 'AMBIGUOUS_EFFECT' }], authority), /QUARANTINE_TORN_TAIL/);
    assert.equal(await fs.readFile(file, 'utf8'), torn, 'the torn tail is preserved, not extended or truncated');
  } finally { await w.cleanup(); }
});
