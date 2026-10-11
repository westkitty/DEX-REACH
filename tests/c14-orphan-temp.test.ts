import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fixture } from './helpers/recovery-fixture.js';
import { inspectCoverage, verifyCoverage, manifestDigest, orphanedAtomicTemp } from '../scripts/lib/recovery-coverage.js';
import { defaultLinkPolicy } from '../scripts/lib/recovery-symlinks.js';

// A pid that certainly belonged to a process which has exited.
const deadPid = () => spawnSync(process.execPath, ['-e', '']).pid!;
const temp = (base: string, pid: number) => `${base}.${pid}.${crypto.randomUUID()}.tmp`;
const transient = (problems: string[]) => problems.filter(p => p.includes('TRANSIENT_WRITE_OR_LOCK_PRESENT'));

test('atomic-write temp names are recognized only in the exact writer pattern', () => {
  const pid = deadPid(), alive = () => false;
  assert.equal(orphanedAtomicTemp(temp('events.jsonl', pid), alive), true);
  for (const name of ['events.jsonl.tmp', `events.jsonl.${pid}.not-a-uuid.tmp`, `events.jsonl.${pid}.${crypto.randomUUID()}.tmp.extra`, `.${pid}.${crypto.randomUUID()}.tmp`, `x.0.${crypto.randomUUID()}.tmp`, 'store.json.lock'])
    assert.equal(orphanedAtomicTemp(name, alive), false, name);
  assert.equal(orphanedAtomicTemp(temp('events.jsonl', process.pid)), false, 'a live writer is never orphaned');
});

test('orphaned coordinator temps are preserved residue, not a blocking transient write', async () => {
  const w = await fixture(); try {
    const name = temp('events.jsonl', deadPid()), file = path.join(w.source.state, 'coordinator/history', name);
    await fs.writeFile(file, '{"partial":', { mode: 0o600 });
    const m = await inspectCoverage(w.source, 'synthetic', defaultLinkPolicy());
    assert.deepEqual(transient(m.problems), []);
    const entry = m.entries.find(e => e.relative === `coordinator/history/${name}`)!;
    assert.equal(entry.kind, 'file'); assert.equal(entry.residue, 'ORPHANED_ATOMIC_TEMP'); assert.equal(entry.bytes, 11);
    assert.equal(entry.schema, undefined);
    assert.deepEqual(m.problems, []);
    // Bytes stay integrity-bound: a later change to the residue refuses verification.
    const digest = manifestDigest(m);
    await verifyCoverage(m, w.source, digest);
    await fs.appendFile(file, 'x');
    await assert.rejects(verifyCoverage(m, w.source, digest));
  } finally { await w.cleanup(); }
});

test('a temp owned by a live writer still blocks, as do locks and unpatterned temps', async () => {
  const w = await fixture(); try {
    for (const name of [temp('events.jsonl', process.pid), 'events.jsonl.lock', 'stray.tmp'])
      await fs.writeFile(path.join(w.source.state, 'coordinator/history', name), '', { mode: 0o600 });
    const m = await inspectCoverage(w.source, 'synthetic', defaultLinkPolicy());
    assert.equal(transient(m.problems).length, 3);
    assert.ok(!m.entries.some(e => e.residue));
  } finally { await w.cleanup(); }
});

test('orphaned temp beside a task-store file is residue too; a live one there blocks', async () => {
  const w = await fixture(); try {
    const orphan = temp('store.json', deadPid());
    await fs.writeFile(path.join(w.source.state, 'tasks', orphan), '{', { mode: 0o600 });
    let m = await inspectCoverage(w.source, 'synthetic', defaultLinkPolicy());
    assert.deepEqual(m.problems, []);
    assert.equal(m.entries.find(e => e.relative === `tasks/${orphan}`)!.residue, 'ORPHANED_ATOMIC_TEMP');
    await fs.writeFile(path.join(w.source.state, 'tasks', temp('store.json', process.pid)), '{', { mode: 0o600 });
    m = await inspectCoverage(w.source, 'synthetic', defaultLinkPolicy());
    assert.deepEqual(transient(m.problems), ['tasks:TRANSIENT_WRITE_OR_LOCK_PRESENT']);
  } finally { await w.cleanup(); }
});

test('a residue symlink is never treated as an orphaned temp', async () => {
  const w = await fixture(); try {
    await fs.symlink('events.jsonl', path.join(w.source.state, 'coordinator/history', temp('events.jsonl', deadPid())));
    const m = await inspectCoverage(w.source, 'synthetic', defaultLinkPolicy());
    assert.ok(m.problems.length > 0);
    assert.ok(!m.entries.some(e => e.residue));
  } finally { await w.cleanup(); }
});
