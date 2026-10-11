import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { startLivePair } from './lib/live-reach.js';

/** Reuse the last fully received event ID on reconnect; gap frames must be surfaced by the caller. */
export async function consumeTaskEvents(fetchStream: (cursor?: string) => Promise<Response>,
  receive: (event: { kind: string; cursor?: string; data: unknown }) => void, cursor?: string): Promise<string | undefined> {
  const response = await fetchStream(cursor);
  if (!response.ok || !response.body) throw new Error(`task stream refused: HTTP ${response.status}`);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      let end: number;
      while ((end = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2);
        const kind = frame.match(/^event: (.+)$/m)?.[1] ?? 'message';
        const id = frame.match(/^id: (tev_[0-9a-f]{24})$/m)?.[1];
        const data = frame.match(/^data: (.+)$/m)?.[1];
        if (data) {
          receive({ kind, ...(id ? { cursor: id } : {}), data: JSON.parse(data) });
          if (id) cursor = id;
        }
      }
      if (buffer.length > 64 * 1024) throw new Error('event frame exceeds client limit');
      if (done) break;
    }
    return cursor;
  } finally { await reader.cancel().catch(() => undefined); }
}

async function fixture(): Promise<void> {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const pair = await startLivePair({ repoRoot, nodeIds: ['example-node'] });
  try {
    await pair.dexCli(['enable', '--node', 'example-node']);
    const source = path.join(pair.roots, 'example.txt'); await fs.writeFile(source, 'synthetic');
    const started = await pair.call('reach_task', { node_id: 'example-node', action: 'start', operation: 'dex.file.read', arguments: { path: source }, mode: 'durable' });
    const taskId = started.text.match(/rtsk_[0-9a-f]+_[0-9a-f]+/)?.[0];
    if (!started.ok || !taskId) throw new Error('fixture task not accepted');
    const route = `/api/v2/tasks/${taskId}/events?node_id=example-node`;
    await consumeTaskEvents(cursor => pair.authorizedFetch(route, cursor ? { headers: { 'Last-Event-ID': cursor } } : undefined),
      event => console.log(JSON.stringify(event)));
  } finally { await pair.stop(); await fs.rm(pair.workspace, { recursive: true, force: true }); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv.includes('--fixture')) throw new Error('run with --fixture; only isolated demonstration is supported');
  await fixture();
}
