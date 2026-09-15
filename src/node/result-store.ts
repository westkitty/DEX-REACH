import crypto from 'node:crypto';

type StoredResult = { text: string; createdAt: number };

export class ResultStore {
  private readonly values = new Map<string, StoredResult>();

  constructor(private readonly inlineLimit = 64 * 1024, private readonly ttlMs = 30 * 60 * 1000) {}

  bound(value: unknown): unknown {
    const text = JSON.stringify(value);
    if (Buffer.byteLength(text) <= this.inlineLimit) return value;
    this.sweep();
    const handle = crypto.randomUUID();
    this.values.set(handle, { text, createdAt: Date.now() });
    return {
      truncated: true,
      handle,
      totalBytes: Buffer.byteLength(text),
      preview: text.slice(0, this.inlineLimit),
      continuation: 'Call dex.result.read with this handle and an offset.'
    };
  }

  read(handle: string, offset = 0, length = 64 * 1024): Record<string, unknown> {
    this.sweep();
    const stored = this.values.get(handle);
    if (!stored) throw new Error('result handle not found or expired');
    const start = Math.max(0, offset);
    const size = Math.max(1, Math.min(length, 256 * 1024));
    return {
      handle,
      offset: start,
      text: stored.text.slice(start, start + size),
      nextOffset: start + size < stored.text.length ? start + size : null,
      totalCharacters: stored.text.length
    };
  }

  private sweep(): void {
    const cutoff = Date.now() - this.ttlMs;
    for (const [key, value] of this.values) {
      if (value.createdAt < cutoff) this.values.delete(key);
    }
  }
}
