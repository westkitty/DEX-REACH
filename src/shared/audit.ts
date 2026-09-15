import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { redact } from './security.js';

export type AuditEvent = {
  at: string;
  nodeId?: string;
  client?: string;
  operation: string;
  ok: boolean;
  durationMs?: number;
  args?: unknown;
  error?: string;
};

export class AuditLog {
  constructor(private readonly file = path.join(os.homedir(), '.dex-reach', 'audit.jsonl')) {}

  async append(event: AuditEvent): Promise<void> {
    await fs.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const safe = { ...event, args: redact(event.args) };
    await fs.appendFile(this.file, JSON.stringify(safe) + '\n', { encoding: 'utf8', mode: 0o600 });
  }
}
