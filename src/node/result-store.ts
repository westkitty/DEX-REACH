import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { stateDir } from '../shared/local-env.js';
import { atomicWriteFile, withFileLock } from '../shared/state-io.js';

const RESULT_SCHEMA_VERSION = 1 as const;
const HANDLE_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type ResultMetadata = {
  version: typeof RESULT_SCHEMA_VERSION;
  handle: string;
  taskId: string | null;
  resultHash: string;
  size: number;
  encoding: 'utf8-json';
  createdAt: string;
  expiresAt: string;
};

export type StoredResultReference = {
  metadata: ResultMetadata;
  publicValue: unknown;
};

type ResultDocument = { version: typeof RESULT_SCHEMA_VERSION; records: Record<string, ResultMetadata> };

function resultDir(dir = stateDir()): string { return path.join(dir, 'results'); }
function resultManifest(dir = stateDir()): string { return path.join(resultDir(dir), 'manifest.json'); }
function resultLock(dir = stateDir()): string { return path.join(resultDir(dir), 'results.lock'); }
function resultBlob(dir: string, handle: string): string {
  if (!HANDLE_PATTERN.test(handle)) throw new Error('invalid result handle');
  return path.join(resultDir(dir), `${handle}.json`);
}

function emptyDocument(): ResultDocument { return { version: RESULT_SCHEMA_VERSION, records: {} }; }

function parseDocument(raw: string): ResultDocument {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new Error('result store is corrupt; refusing mutation'); }
  if (!value || typeof value !== 'object' || (value as { version?: unknown }).version !== RESULT_SCHEMA_VERSION || typeof (value as { records?: unknown }).records !== 'object') {
    throw new Error('result store has an unsupported schema or shape; refusing mutation');
  }
  const records = (value as { records: Record<string, unknown> }).records;
  for (const [handle, metadata] of Object.entries(records)) {
    if (!HANDLE_PATTERN.test(handle) || !metadata || typeof metadata !== 'object') throw new Error('result store metadata is corrupt; refusing mutation');
    const entry = metadata as Partial<ResultMetadata>;
    if (entry.version !== RESULT_SCHEMA_VERSION || entry.handle !== handle || (entry.taskId !== null && typeof entry.taskId !== 'string') || typeof entry.resultHash !== 'string' || !/^[0-9a-f]{64}$/i.test(entry.resultHash) || typeof entry.size !== 'number' || !Number.isSafeInteger(entry.size) || entry.size < 0 || entry.encoding !== 'utf8-json' || typeof entry.createdAt !== 'string' || typeof entry.expiresAt !== 'string') {
      throw new Error('result store metadata is corrupt; refusing mutation');
    }
  }
  return value as ResultDocument;
}

async function readDocument(dir: string): Promise<ResultDocument> {
  try { return parseDocument(await fs.readFile(resultManifest(dir), 'utf8')); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyDocument();
    throw error;
  }
}

export class ResultStore {
  constructor(
    private readonly inlineLimit = 64 * 1024,
    private readonly ttlMs = 30 * 60 * 1000,
    private readonly dir = stateDir()
  ) {
    if (!Number.isSafeInteger(inlineLimit) || inlineLimit < 1) throw new Error('result inline limit must be positive');
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1) throw new Error('result ttl must be positive');
  }

  async boundWithReference(value: unknown, taskId: string | null = null): Promise<StoredResultReference> {
    const text = JSON.stringify(value) ?? 'null';
    const now = Date.now();
    const metadata: ResultMetadata = {
      version: RESULT_SCHEMA_VERSION,
      handle: crypto.randomUUID(),
      taskId,
      resultHash: crypto.createHash('sha256').update(text).digest('hex'),
      size: Buffer.byteLength(text),
      encoding: 'utf8-json',
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + this.ttlMs).toISOString()
    };
    await withFileLock(resultLock(this.dir), async () => {
      const document = await readDocument(this.dir);
      await fs.mkdir(resultDir(this.dir), { recursive: true, mode: 0o700 });
      await atomicWriteFile(resultBlob(this.dir, metadata.handle), text, 0o600);
      document.records[metadata.handle] = metadata;
      await atomicWriteFile(resultManifest(this.dir), JSON.stringify(document, null, 2) + '\n', 0o600);
    });
    const publicValue = metadata.size <= this.inlineLimit ? value : {
      truncated: true,
      handle: metadata.handle,
      totalBytes: metadata.size,
      preview: text.slice(0, this.inlineLimit),
      continuation: 'Call dex.result.read with this handle and an offset.'
    };
    return { metadata, publicValue };
  }

  async bound(value: unknown, taskId: string | null = null): Promise<unknown> {
    return (await this.boundWithReference(value, taskId)).publicValue;
  }

  async read(handle: string, offset = 0, length = 64 * 1024): Promise<Record<string, unknown>> {
    const metadata = await this.metadata(handle);
    const text = await fs.readFile(resultBlob(this.dir, handle), 'utf8');
    if (Buffer.byteLength(text) !== metadata.size || crypto.createHash('sha256').update(text).digest('hex') !== metadata.resultHash) {
      throw new Error('result blob hash mismatch; refusing read');
    }
    const start = Math.max(0, Math.min(Number.isFinite(offset) ? offset : 0, text.length));
    const size = Math.max(1, Math.min(Number.isFinite(length) ? length : 64 * 1024, 256 * 1024));
    return {
      handle,
      offset: start,
      text: text.slice(start, start + size),
      nextOffset: start + size < text.length ? start + size : null,
      totalCharacters: text.length,
      resultHash: metadata.resultHash,
      taskId: metadata.taskId
    };
  }

  async readValue(handle: string): Promise<unknown> {
    const metadata = await this.metadata(handle);
    const text = await fs.readFile(resultBlob(this.dir, handle), 'utf8');
    const actualHash = crypto.createHash('sha256').update(text).digest('hex');
    if (actualHash !== metadata.resultHash) throw new Error('result blob hash mismatch; refusing recovery');
    try { return JSON.parse(text) as unknown; } catch { throw new Error('result blob is corrupt; refusing recovery'); }
  }

  async metadata(handle: string): Promise<ResultMetadata> {
    if (!HANDLE_PATTERN.test(handle)) throw new Error('invalid result handle');
    const document = await readDocument(this.dir);
    const metadata = document.records[handle];
    if (!metadata || Date.parse(metadata.expiresAt) <= Date.now()) throw new Error('result handle not found or expired');
    return { ...metadata };
  }

  async sweep(now = Date.now()): Promise<number> {
    return withFileLock(resultLock(this.dir), async () => {
      const document = await readDocument(this.dir);
      let removed = 0;
      for (const [handle, metadata] of Object.entries(document.records)) {
        if (Date.parse(metadata.expiresAt) <= now) {
          delete document.records[handle];
          await fs.rm(resultBlob(this.dir, handle), { force: true });
          removed += 1;
        }
      }
      if (removed) await atomicWriteFile(resultManifest(this.dir), JSON.stringify(document, null, 2) + '\n', 0o600);
      return removed;
    });
  }
}
