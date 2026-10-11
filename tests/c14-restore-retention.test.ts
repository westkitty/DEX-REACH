import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { expandedFixture } from './helpers/recovery-fixture.js';
import { verifyRestoredApplication } from '../scripts/lib/recovery-application.js';
import { TASK_EVENT_LIMIT } from '../src/shared/task-events.js';
import { appendQuarantine } from '../src/shared/task-quarantine.js';
import { NodeTaskStore } from '../src/node/task-store.js';

const nodeId = 'macbook-air.local';
const TERMINAL = ['COMPLETED', 'FAILED', 'CANCELLED', 'RECONCILED', 'AMBIGUOUS'];

async function expiredResult(state: string) {
  const file = path.join(state, 'results/manifest.json'), m = JSON.parse(await fs.readFile(file, 'utf8'));
  const handle = Object.keys(m.records)[0]!;
  m.records[handle].expiresAt = '2020-01-01T00:00:00.000Z';
  return { file, m, handle };
}
async function saturateJournal(state: string) {
  const filler = Array.from({ length: TASK_EVENT_LIMIT }, (_, i) => JSON.stringify({ eventId: `tev_f${i}`, at: new Date().toISOString(), taskId: 'rtsk_filler', kind: 'updated' }));
  await fs.writeFile(path.join(state, 'tasks/events.jsonl'), filler.join('\n') + '\n');
}

test('expired result: a manifest hash that disagrees with the task binding is refused', async () => {
  const w = await expandedFixture(); try {
    const { file, m, handle } = await expiredResult(w.source.state);
    m.records[handle].resultHash = 'f'.repeat(64);
    await fs.writeFile(file, JSON.stringify(m));
    await assert.rejects(verifyRestoredApplication(w.source), /APPLICATION_RESULT_BINDING/);
  } finally { await w.cleanup(); }
});

test('expired result: a record without a valid expiry is refused, never treated as current', async () => {
  const w = await expandedFixture(); try {
    const { file, m, handle } = await expiredResult(w.source.state);
    delete m.records[handle].expiresAt;
    await fs.writeFile(file, JSON.stringify(m));
    // Either the result store's schema check or the restore binding check refuses; both fail closed.
    await assert.rejects(verifyRestoredApplication(w.source), /APPLICATION_RESULT_BINDING|result store metadata is corrupt/);
  } finally { await w.cleanup(); }
});

test('retention-evicted history: a quarantined task is accepted under a saturated journal, a live task is not', async () => {
  const w = await expandedFixture(); try {
    const tasks = await new NodeTaskStore(w.source.state).list({ includeArchived: true });
    const live = tasks.find(t => !TERMINAL.includes(t.state));
    assert.ok(live, 'fixture has a non-terminal task');
    await saturateJournal(w.source.state);
    await assert.rejects(verifyRestoredApplication(w.source), /APPLICATION_EVENT_HISTORY_MISSING/, 'live task without history is refused');
    await appendQuarantine(w.source.state, [{ task: { taskId: live.taskId, rootTaskId: live.rootTaskId, parentTaskId: live.parentTaskId, actorId: live.actorId, nodeId: live.nodeId, operation: live.operation, idempotencyKey: live.idempotencyKey, payloadSha256: live.payloadSha256, policyHash: live.policyHash, createdAtUtc: live.createdAtUtc, attemptNumber: live.attemptNumber, state: live.state }, classification: 'effect-unknown' }], { kind: 'owner-authorization', grantedAt: new Date().toISOString(), scope: 'synthetic-test' });
    await verifyRestoredApplication(w.source);
  } finally { await w.cleanup(); }
});

test('revocation evidence: a list naming this node is refused as forged authority', async () => {
  const w = await expandedFixture(); try {
    await fs.writeFile(path.join(w.source.state, 'revoked-nodes.json'), JSON.stringify([nodeId]));
    await assert.rejects(verifyRestoredApplication(w.source), /APPLICATION_REVOCATIONS/);
  } finally { await w.cleanup(); }
});

test('revocation evidence: non-string entries and malformed JSON fail closed', async () => {
  const w = await expandedFixture(); try {
    await fs.writeFile(path.join(w.source.state, 'revoked-nodes.json'), JSON.stringify(['ok', 7]));
    await assert.rejects(verifyRestoredApplication(w.source), /APPLICATION_REVOCATIONS/);
    await fs.writeFile(path.join(w.source.state, 'revoked-nodes.json'), '[not json');
    await assert.rejects(verifyRestoredApplication(w.source), /JSON|Unexpected|token/i);
  } finally { await w.cleanup(); }
});

test('a missing result manifest is an error, not a silent pass', async () => {
  const w = await expandedFixture(); try {
    await fs.rm(path.join(w.source.state, 'results/manifest.json'));
    await assert.rejects(verifyRestoredApplication(w.source));
  } finally { await w.cleanup(); }
});
