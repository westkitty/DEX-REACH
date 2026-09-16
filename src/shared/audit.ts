import fs from 'node:fs/promises';
import path from 'node:path';
import { redact } from './security.js';
import { stateDir } from './local-env.js';
import type { RequestActor } from './protocol.js';

export type AuditEvent = {
  at: string;
  /** Which process recorded the event; a machine running both sees each request twice. */
  source?: 'gateway' | 'node';
  nodeId?: string;
  client?: string;
  /** Non-secret requesting client identity when known. */
  actor?: RequestActor;
  operation: string;
  ok: boolean;
  durationMs?: number;
  args?: unknown;
  error?: string;
};

const CONTENT_KEYS = /^(text|content|input|data|body)$/i;

/** File contents and process input never enter the audit trail; only their size does. */
export function summarizeContent(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(summarizeContent);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [
      k,
      CONTENT_KEYS.test(k) && typeof v === 'string' ? `[${Buffer.byteLength(v)} bytes omitted]` : summarizeContent(v)
    ]));
  }
  return value;
}

export function auditFile(): string {
  return path.join(stateDir(), 'audit.jsonl');
}

export class AuditLog {
  constructor(private readonly file = auditFile()) {}

  async append(event: AuditEvent): Promise<void> {
    await fs.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const safe = { ...event, args: summarizeContent(redact(event.args)) };
    await fs.appendFile(this.file, JSON.stringify(safe) + '\n', { encoding: 'utf8', mode: 0o600 });
  }

  /** Most recent events, newest last. */
  async tail(limit = 50): Promise<AuditEvent[]> {
    let raw = '';
    try { raw = await fs.readFile(this.file, 'utf8'); } catch { return []; }
    const lines = raw.split('\n').filter(Boolean);
    return lines.slice(-limit).flatMap(line => { try { return [JSON.parse(line) as AuditEvent]; } catch { return []; } });
  }
}
