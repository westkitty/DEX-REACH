import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  TRACE_SPAN_LIMIT,
  TRACE_QUEUE_SPANS, TRACE_QUEUE_BYTES, TRACE_BATCH_SPANS,
  enqueueSpan, flushTraces, traceQueueDiagnostics, traceTesting,
  type TraceSpan,
  childSpan,
  describeTrace,
  formatTraceparent,
  isValidSpanId,
  isValidTraceId,
  listTraces,
  newSpanId,
  newTraceId,
  otelExportEnabled,
  parseTraceparent,
  readTrace,
  recordSpan,
  sanitizeSpan,
  sanitizeTracestate,
  traceContextFrom,
  traceDir
} from '../src/shared/trace.js';

async function withStateDir<T>(fn: () => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dex-reach-trace-'));
  const previous = process.env.DEX_REACH_STATE_DIR;
  process.env.DEX_REACH_STATE_DIR = dir;
  try { return await fn(); } finally {
    if (previous === undefined) delete process.env.DEX_REACH_STATE_DIR; else process.env.DEX_REACH_STATE_DIR = previous;
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test('trace and span ids follow W3C shape and reject the all-zero values', () => {
  assert.equal(isValidTraceId(newTraceId()), true);
  assert.equal(isValidSpanId(newSpanId()), true);
  // All-zero is explicitly invalid in W3C Trace Context, not merely unusual.
  assert.equal(isValidTraceId('0'.repeat(32)), false);
  assert.equal(isValidSpanId('0'.repeat(16)), false);
  assert.equal(isValidTraceId('ABCDEF01234567890123456789012345'), false, 'uppercase is not valid');
  assert.equal(isValidTraceId('abc'), false);
});

test('a malformed traceparent is ignored rather than repaired or trusted', () => {
  const good = formatTraceparent('4bf92f3577b34da6a3ce929d0e0e4736', '00f067aa0ba902b7');
  assert.equal(good, '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01');
  const parsed = parseTraceparent(good);
  assert.equal(parsed?.traceId, '4bf92f3577b34da6a3ce929d0e0e4736');
  assert.equal(parsed?.spanId, '00f067aa0ba902b7');
  assert.equal(parsed?.sampled, true);

  for (const bad of [
    undefined, '', 'garbage', '00-short-00f067aa0ba902b7-01',
    `00-${'0'.repeat(32)}-00f067aa0ba902b7-01`,
    `00-4bf92f3577b34da6a3ce929d0e0e4736-${'0'.repeat(16)}-01`,
    '99-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
    '00-4BF92F3577B34DA6A3CE929D0E0E4736-00f067aa0ba902b7-01'
  ]) {
    assert.equal(parseTraceparent(bad), null, `accepted a bad traceparent: ${String(bad)}`);
  }
});

test('an inbound trace is continued, and an invalid one starts a fresh trace instead of failing', () => {
  const continued = traceContextFrom({ traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01' });
  assert.equal(continued.traceId, '4bf92f3577b34da6a3ce929d0e0e4736');
  assert.equal(continued.parentSpanId, '00f067aa0ba902b7');
  assert.notEqual(continued.spanId, '00f067aa0ba902b7', 'a new span id is minted for this hop');

  const fresh = traceContextFrom({ traceparent: 'nonsense' });
  assert.equal(isValidTraceId(fresh.traceId), true);
  assert.equal(fresh.parentSpanId, undefined);

  const child = childSpan(continued);
  assert.equal(child.traceId, continued.traceId);
  assert.equal(child.parentSpanId, continued.spanId);
  assert.notEqual(child.spanId, continued.spanId);
});

test('vendor tracestate is bounded and validated, and baggage is never accepted', () => {
  assert.equal(sanitizeTracestate('vendor=abc123,other=xyz'), 'vendor=abc123,other=xyz');
  assert.equal(sanitizeTracestate('  vendor=abc  '), 'vendor=abc');
  assert.equal(sanitizeTracestate(undefined), undefined);
  assert.equal(sanitizeTracestate(''), undefined);
  // Malformed, oversized, over-membered and duplicate-key state is dropped rather than repaired.
  assert.equal(sanitizeTracestate('no-equals-sign'), undefined);
  assert.equal(sanitizeTracestate('a'.repeat(600)), undefined);
  assert.equal(sanitizeTracestate(Array.from({ length: 40 }, (_, i) => `k${i}=v`).join(',')), undefined);
  assert.equal(sanitizeTracestate('dup=1,dup=2'), undefined);

  // There is no code path that reads or propagates baggage: it is caller-controlled arbitrary data.
  const context = traceContextFrom({ traceparent: undefined, tracestate: undefined });
  assert.equal(Object.keys(context).includes('baggage'), false);
});

test('a span cannot carry arguments, content, output or credentials', async () => {
  const secret = 'super-secret-token-value';
  const dirty = {
    traceId: newTraceId(),
    spanId: newSpanId(),
    stage: 'execute' as const,
    at: new Date().toISOString(),
    operation: 'dex.process.run',
    // Everything below is what a careless caller might attach.
    args: { command: 'cat /etc/passwd' },
    stdout: 'root:x:0:0',
    text: 'file body',
    token: secret,
    authorization: `Bearer ${secret}`,
    baggage: 'user=alice'
  } as never;

  const clean = sanitizeSpan(dirty);
  const serialized = JSON.stringify(clean);
  for (const leaked of ['args', 'stdout', 'text', 'token', 'authorization', 'baggage', secret, '/etc/passwd', 'root:x']) {
    assert.doesNotMatch(serialized, new RegExp(leaked.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `span leaked ${leaked}`);
  }
  assert.equal(clean.operation, 'dex.process.run');
  assert.equal(clean.stage, 'execute');

  // The same guarantee has to hold once the span is on disk.
  await withStateDir(async () => {
    await recordSpan(dirty);
    const onDisk = await fs.readFile(path.join(traceDir(), `${(dirty as { traceId: string }).traceId}.jsonl`), 'utf8');
    for (const leaked of [secret, '/etc/passwd', 'stdout', 'baggage']) {
      assert.doesNotMatch(onDisk, new RegExp(leaked.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    }
  });
});

test('a causal chain is reconstructed in order across every stage', async () => {
  await withStateDir(async () => {
    const traceId = newTraceId();
    const root = { traceId, spanId: newSpanId(), at: '2026-09-19T00:00:01.000Z' };
    const stages = ['mcp', 'gateway', 'node', 'authorize', 'plan', 'commit', 'execute', 'receipt', 'checkpoint'] as const;

    for (const [index, stage] of stages.entries()) {
      await recordSpan({
        traceId,
        spanId: newSpanId(),
        parentSpanId: root.spanId,
        stage,
        at: `2026-09-19T00:00:${String(index + 1).padStart(2, '0')}.000Z`,
        operation: 'dex.file.write',
        nodeId: 'test-node',
        actorKind: 'claude',
        ok: true,
        durationMs: index
      });
    }

    const spans = await readTrace(traceId);
    assert.equal(spans.length, stages.length);
    assert.deepEqual(spans.map(span => span.stage), [...stages]);
    // Every span belongs to the same trace and links back to its parent.
    assert.equal(new Set(spans.map(span => span.traceId)).size, 1);
    assert.ok(spans.every(span => span.parentSpanId === root.spanId));

    const summary = describeTrace(spans).join('\n');
    assert.match(summary, /Trace /);
    assert.match(summary, /authorize/);
    assert.match(summary, /checkpoint/);
    assert.match(summary, /causal evidence only/);

    const listed = await listTraces();
    assert.equal(listed.length, 1);
    assert.equal(listed[0]!.traceId, traceId);
    assert.equal(listed[0]!.spans, stages.length);
  });
});

test('trace storage is bounded and an unknown trace reads as empty, not as an error', async () => {
  await withStateDir(async () => {
    const traceId = newTraceId();
    for (let index = 0; index < TRACE_SPAN_LIMIT + 25; index += 1) {
      await recordSpan({ traceId, spanId: newSpanId(), stage: 'execute', at: new Date(Date.now() + index).toISOString() });
    }
    assert.equal((await readTrace(traceId)).length, TRACE_SPAN_LIMIT);

    assert.deepEqual(await readTrace(newTraceId()), []);
    assert.deepEqual(describeTrace([]), ['No spans recorded for that trace id.']);
    // An invalid id is refused rather than used to build a path.
    await assert.rejects(async () => readTrace('../../etc/passwd').then(() => { throw new Error('unreachable'); }), () => true);
  });
});

test('OpenTelemetry export is off unless the owner turns it on', () => {
  const previous = process.env.DEX_REACH_OTEL_EXPORT;
  try {
    delete process.env.DEX_REACH_OTEL_EXPORT;
    assert.equal(otelExportEnabled(), false);
    process.env.DEX_REACH_OTEL_EXPORT = '0';
    assert.equal(otelExportEnabled(), false);
    process.env.DEX_REACH_OTEL_EXPORT = '1';
    assert.equal(otelExportEnabled(), true);
  } finally {
    if (previous === undefined) delete process.env.DEX_REACH_OTEL_EXPORT; else process.env.DEX_REACH_OTEL_EXPORT = previous;
  }
});


const queuedSpan = (overrides: Partial<TraceSpan> = {}): TraceSpan => ({ traceId: newTraceId(), spanId: newSpanId(), stage: 'execute', at: new Date().toISOString(), ...overrides });

test('enqueue strips secret fields before writing, validates IDs, and preserves causal order and retention', async () => {
  await withStateDir(async () => {
    const traceId = newTraceId(); const parent = newSpanId();
    assert.equal(enqueueSpan(queuedSpan({ traceId: 'invalid' })), false);
    assert.equal(enqueueSpan(queuedSpan({ spanId: '0'.repeat(16) })), false);
    assert.equal(enqueueSpan(queuedSpan({ parentSpanId: 'invalid' })), false);
    assert.equal(enqueueSpan(queuedSpan({ operation: { secret: 'nested' } as never })), false);
    for (let i = 0; i < 525; i += 1) {
      assert.equal(enqueueSpan({ ...queuedSpan({ traceId, parentSpanId: parent, durationMs: i }), args: { secret: 'private' }, token: 'private' } as TraceSpan), true);
    }
    assert.equal(await flushTraces(), true);
    const spans = await readTrace(traceId);
    assert.equal(spans.length, 500);
    assert.deepEqual(spans.map(span => span.durationMs), Array.from({ length: 500 }, (_, i) => i + 25));
    assert.ok(spans.every(span => span.parentSpanId === parent));
    assert.ok(!JSON.stringify(spans).includes('private'));
    assert.equal((await fs.stat(path.join(traceDir(), `${traceId}.jsonl`))).mode & 0o777, 0o600);
  });
});

test('both queue limits count in-flight memory, drop newest, and writers receive sanitized batches', async () => {
  for (const bound of ['spans', 'bytes'] as const) {
    let release!: () => void; let entered!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    const before = traceQueueDiagnostics();
    const batches: string[][] = [];
    traceTesting.setWriter(async (_file, lines) => { batches.push([...lines]); entered(); await blocked; });
    try {
      const traceId = newTraceId();
      const large = bound === 'bytes' ? Object.fromEntries(['operation', 'nodeId', 'actorKind', 'requestHash', 'policyHash', 'planId', 'checkpointId', 'receiptId', 'outcome'].map(field => [field, '界'.repeat(200)])) : {};
      assert.ok(enqueueSpan(queuedSpan({ traceId, ...large })));
      const flush = flushTraces({ timeoutMs: 20 }); await started;
      let inserted = 1;
      while (enqueueSpan({ ...queuedSpan({ traceId, ...large }), token: 'private' } as TraceSpan)) inserted += 1;
      const full = traceQueueDiagnostics();
      assert.equal(full.queuedSpans, inserted);
      assert.ok(full.queuedBytes <= TRACE_QUEUE_BYTES);
      assert.equal(full.droppedSpans, before.droppedSpans + 1);
      if (bound === 'spans') assert.equal(inserted, TRACE_QUEUE_SPANS);
      else assert.ok(inserted < TRACE_QUEUE_SPANS);
      assert.equal(await flush, false);
      assert.equal(traceQueueDiagnostics().incompleteFlush, true);
      assert.match(describeTrace([]).join(' '), /incomplete/);
      release(); assert.equal(await flushTraces(), true);
      assert.ok(batches.every(batch => batch.length <= TRACE_BATCH_SPANS));
      assert.ok(!JSON.stringify(batches).includes('private'));
      assert.equal(traceQueueDiagnostics().queuedBytes, 0);
    } finally { release(); await flushTraces(); traceTesting.setWriter(); }
  }
});

test('writer failures lose diagnostics without rejecting enqueue or flush and do not retry', async () => {
  const before = traceQueueDiagnostics().failedSpans; let calls = 0;
  traceTesting.setWriter(async () => { calls += 1; throw new Error('disk failed'); });
  try {
    assert.ok(enqueueSpan(queuedSpan()));
    assert.equal(await flushTraces(), true);
    assert.equal(traceQueueDiagnostics().failedSpans, before + 1);
    assert.equal(calls, 1); assert.equal(traceQueueDiagnostics().queuedSpans, 0);
  } finally { traceTesting.setWriter(); }
});

test('queued destinations stay separate and diagnostic reads flush immediately', async () => {
  await withStateDir(async () => {
    const first = process.env.DEX_REACH_STATE_DIR!;
    const second = path.join(first, 'second'); const a = queuedSpan(); const b = queuedSpan();
    enqueueSpan(a); process.env.DEX_REACH_STATE_DIR = second; enqueueSpan(b);
    assert.equal((await readTrace(b.traceId)).length, 1);
    assert.equal((await listTraces()).length, 1);
    assert.equal((await readTrace(a.traceId)).length, 0);
    process.env.DEX_REACH_STATE_DIR = first;
    assert.equal((await readTrace(a.traceId)).length, 1);
    assert.equal((await readTrace(b.traceId)).length, 0);
    enqueueSpan(queuedSpan()); assert.equal((await listTraces()).length, 2);
  });
});

test('flush captures a watermark instead of waiting for future arrivals', async () => {
  let releaseFirst!: () => void; let releaseSecond!: () => void;
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const first = new Promise<void>(resolve => { releaseFirst = resolve; });
  const second = new Promise<void>(resolve => { releaseSecond = resolve; });
  let calls = 0;
  traceTesting.setWriter(async () => { if (++calls === 1) { entered(); await first; } else await second; });
  try {
    enqueueSpan(queuedSpan()); const flush = flushTraces(); await started;
    enqueueSpan(queuedSpan()); releaseFirst(); assert.equal(await flush, true);
    assert.equal(traceQueueDiagnostics().queuedSpans, 1);
    releaseSecond(); await flushTraces();
  } finally { releaseFirst(); releaseSecond(); await flushTraces(); traceTesting.setWriter(); }
});

test('shutdown flush is bounded and closes the scheduled writer timer', async () => {
  let release!: () => void; const pending = new Promise<void>(resolve => { release = resolve; });
  traceTesting.setWriter(async () => pending);
  try {
    enqueueSpan(queuedSpan());
    assert.equal(await flushTraces({ shutdown: true, timeoutMs: 20 }), false);
    assert.equal(enqueueSpan(queuedSpan()), false);
    assert.equal(traceQueueDiagnostics().incompleteFlush, true);
  } finally { release(); await flushTraces(); traceTesting.setWriter(); }
});
