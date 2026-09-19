import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { stateDir } from './local-env.js';
import { atomicWriteFile, withFileLock } from './state-io.js';

/**
 * W3C Trace Context. DEX carries a trace ID so an owner can reconstruct one causal chain — MCP call,
 * gateway routing, node authorization, plan, commit, execution, receipt, checkpoint — without any of
 * those stages having to carry request or result content.
 */
export type ReachTraceContext = {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  /** Only ever a re-serialization of the validated fields above. */
  traceparent: string;
  /** Vendor state, accepted only when it parses and stays within W3C bounds. */
  tracestate?: string;
};

export const TRACE_STAGES = [
  'mcp', 'gateway', 'node', 'authorize', 'plan', 'commit', 'execute', 'receipt', 'checkpoint'
] as const;
export type TraceStage = (typeof TRACE_STAGES)[number];

/**
 * One causal step. Every field is an identifier, a hash, a classification or a duration. There is
 * deliberately no place to put arguments, file contents, stdout, stderr or credentials.
 */
export type TraceSpan = {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  stage: TraceStage;
  at: string;
  operation?: string;
  nodeId?: string;
  /** Client kind only. Never a token, never a client secret. */
  actorKind?: string;
  ok?: boolean;
  durationMs?: number;
  requestHash?: string;
  policyHash?: string;
  planId?: string;
  checkpointId?: string;
  receiptId?: string;
  /** Short refusal classification, never the refused content. */
  outcome?: string;
};

const TRACEPARENT = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;
const ZERO_TRACE = '0'.repeat(32);
const ZERO_SPAN = '0'.repeat(16);
/** W3C caps tracestate at 32 list members; oversized or malformed state is dropped, not repaired. */
const MAX_TRACESTATE_MEMBERS = 32;
const MAX_TRACESTATE_LENGTH = 512;
const TRACESTATE_MEMBER = /^[a-z0-9_\-*/@]{1,256}=[\x20-\x2b\x2d-\x3c\x3e-\x7e]{1,256}$/;

export function newTraceId(): string { return crypto.randomBytes(16).toString('hex'); }
export function newSpanId(): string { return crypto.randomBytes(8).toString('hex'); }

export function isValidTraceId(value: string): boolean {
  return /^[0-9a-f]{32}$/.test(value) && value !== ZERO_TRACE;
}
export function isValidSpanId(value: string): boolean {
  return /^[0-9a-f]{16}$/.test(value) && value !== ZERO_SPAN;
}

/**
 * Accept an inbound `tracestate` only if every member is well formed and the whole stays in bounds.
 * Anything else is dropped. DEX never merges, repairs or forwards unvalidated vendor state, and it
 * never accepts `baggage` at all: baggage is arbitrary caller-controlled key/value data, and a
 * control plane has no reason to propagate it.
 */
export function sanitizeTracestate(value: string | undefined): string | undefined {
  if (!value) return undefined;
  if (value.length > MAX_TRACESTATE_LENGTH) return undefined;
  const members = value.split(',').map(member => member.trim()).filter(Boolean);
  if (!members.length || members.length > MAX_TRACESTATE_MEMBERS) return undefined;
  if (!members.every(member => TRACESTATE_MEMBER.test(member))) return undefined;
  const keys = members.map(member => member.split('=')[0]);
  if (new Set(keys).size !== keys.length) return undefined;
  return members.join(',');
}

/** Parse an inbound `traceparent`. An unparseable or all-zero value yields null, never a guess. */
export function parseTraceparent(value: string | undefined): { traceId: string; spanId: string; sampled: boolean } | null {
  if (!value) return null;
  const match = TRACEPARENT.exec(value.trim());
  if (!match) return null;
  const [, traceId, spanId, flags] = match;
  if (!isValidTraceId(traceId!) || !isValidSpanId(spanId!)) return null;
  return { traceId: traceId!, spanId: spanId!, sampled: (Number.parseInt(flags!, 16) & 1) === 1 };
}

export function formatTraceparent(traceId: string, spanId: string, sampled = true): string {
  return `00-${traceId}-${spanId}-${sampled ? '01' : '00'}`;
}

/**
 * Continue an inbound trace when the caller supplied a valid one, otherwise start a fresh trace.
 * A malformed inbound header never breaks the request and never propagates.
 */
export function traceContextFrom(headers: { traceparent?: string; tracestate?: string } = {}): ReachTraceContext {
  const parent = parseTraceparent(headers.traceparent);
  const traceId = parent?.traceId ?? newTraceId();
  const spanId = newSpanId();
  return {
    traceId,
    spanId,
    ...(parent ? { parentSpanId: parent.spanId } : {}),
    traceparent: formatTraceparent(traceId, spanId),
    ...(sanitizeTracestate(headers.tracestate) ? { tracestate: sanitizeTracestate(headers.tracestate) } : {})
  };
}

/** A child step of an existing context, keeping the same trace and linking to its parent span. */
export function childSpan(context: ReachTraceContext): ReachTraceContext {
  const spanId = newSpanId();
  return {
    traceId: context.traceId,
    spanId,
    parentSpanId: context.spanId,
    traceparent: formatTraceparent(context.traceId, spanId),
    ...(context.tracestate ? { tracestate: context.tracestate } : {})
  };
}

// ---------------------------------------------------------------------------
// Local trace store
// ---------------------------------------------------------------------------

/** Keys that must never appear in a span, whatever a caller tries to attach. */
const FORBIDDEN_SPAN_KEYS = /^(args|arguments|text|content|input|body|data|stdout|stderr|output|result|command|token|secret|password|credential|authorization|cookie|key|baggage|env)$/i;

const SPAN_FIELDS: readonly (keyof TraceSpan)[] = [
  'traceId', 'spanId', 'parentSpanId', 'stage', 'at', 'operation', 'nodeId', 'actorKind',
  'ok', 'durationMs', 'requestHash', 'policyHash', 'planId', 'checkpointId', 'receiptId', 'outcome'
];

export const TRACE_SPAN_LIMIT = 500;

export function traceDir(): string { return path.join(stateDir(), 'traces'); }
export function traceFile(traceId: string): string {
  if (!isValidTraceId(traceId)) throw new Error('invalid trace id');
  return path.join(traceDir(), `${traceId}.jsonl`);
}

/**
 * Strip a span to its declared fields. A caller that attaches anything else — deliberately or by
 * passing a whole request through — loses it here rather than at review time.
 */
export function sanitizeSpan(span: TraceSpan): TraceSpan {
  const out: Record<string, unknown> = {};
  for (const field of SPAN_FIELDS) {
    const value = span[field];
    if (value === undefined) continue;
    if (FORBIDDEN_SPAN_KEYS.test(field)) continue;
    out[field] = typeof value === 'string' ? value.slice(0, 200) : value;
  }
  return out as unknown as TraceSpan;
}

/** Append one causal step. Tracing is best effort: it must never fail a real operation. */
export async function recordSpan(span: TraceSpan): Promise<void> {
  if (!isValidTraceId(span.traceId) || !isValidSpanId(span.spanId)) return;
  const file = traceFile(span.traceId);
  await fs.mkdir(traceDir(), { recursive: true, mode: 0o700 });
  await withFileLock(`${file}.lock`, async () => {
    let lines: string[] = [];
    try { lines = (await fs.readFile(file, 'utf8')).split('\n').filter(Boolean); } catch { /* first span */ }
    lines.push(JSON.stringify(sanitizeSpan(span)));
    await atomicWriteFile(file, lines.slice(-TRACE_SPAN_LIMIT).join('\n') + '\n');
  }, { timeoutMs: 5000 }).catch(() => undefined);
}

export async function readTrace(traceId: string): Promise<TraceSpan[]> {
  try {
    const raw = await fs.readFile(traceFile(traceId), 'utf8');
    return raw.split('\n').filter(Boolean).flatMap(line => {
      try { return [sanitizeSpan(JSON.parse(line) as TraceSpan)]; } catch { return []; }
    });
  } catch {
    return [];
  }
}

export async function listTraces(limit = 20): Promise<{ traceId: string; at: string; spans: number }[]> {
  let names: string[];
  try { names = await fs.readdir(traceDir()); } catch { return []; }
  const traces = [];
  for (const name of names.filter(entry => entry.endsWith('.jsonl'))) {
    const traceId = name.slice(0, -6);
    if (!isValidTraceId(traceId)) continue;
    const spans = await readTrace(traceId);
    if (!spans.length) continue;
    traces.push({ traceId, at: spans[spans.length - 1]!.at, spans: spans.length });
  }
  return traces.sort((a, b) => b.at.localeCompare(a.at)).slice(0, limit);
}

/**
 * Owner-facing causal summary. It states what happened and what links the steps together; it never
 * reproduces what was read, written or executed.
 */
export function describeTrace(spans: readonly TraceSpan[]): string[] {
  if (!spans.length) return ['No spans recorded for that trace id.'];
  const ordered = [...spans].sort((a, b) => a.at.localeCompare(b.at));
  const first = ordered[0]!;
  const lines = [
    `Trace ${first.traceId}`,
    `Steps:  ${ordered.length}`,
    `Window: ${first.at.replace('T', ' ').slice(0, 19)} → ${ordered[ordered.length - 1]!.at.replace('T', ' ').slice(0, 19)}`,
    ''
  ];
  for (const span of ordered) {
    const detail = [
      span.operation,
      span.nodeId ? `node ${span.nodeId}` : '',
      span.actorKind ? `actor ${span.actorKind}` : '',
      span.planId ? `plan ${span.planId.slice(0, 8)}…` : '',
      span.checkpointId ? `checkpoint ${span.checkpointId.slice(0, 12)}…` : '',
      span.receiptId ? `receipt ${span.receiptId.slice(0, 8)}…` : '',
      span.requestHash ? `request ${span.requestHash.slice(0, 12)}…` : '',
      span.policyHash ? `policy ${span.policyHash.slice(0, 12)}…` : '',
      typeof span.durationMs === 'number' ? `${span.durationMs}ms` : '',
      span.outcome ? `— ${span.outcome}` : ''
    ].filter(Boolean).join('  ');
    const mark = span.ok === undefined ? ' ' : span.ok ? '✓' : '✗';
    lines.push(`  ${mark} ${span.at.slice(11, 19)}  ${span.stage.padEnd(10)} ${detail}`);
  }
  lines.push('', 'This summary lists causal evidence only. Arguments, file contents and process output are never traced.');
  return lines;
}

/**
 * OpenTelemetry export is opt-in and off by default. Enabling it is an owner decision, and even then
 * only the fields above leave the machine: DEX has no code path that exports content.
 */
export function otelExportEnabled(): boolean {
  return process.env.DEX_REACH_OTEL_EXPORT === '1';
}
