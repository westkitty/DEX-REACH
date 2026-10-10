import type express from 'express';
import { rateLimit } from 'express-rate-limit';
import type { NodeRegistry } from './registry.js';
import type { RequestActor } from '../shared/protocol.js';
import type { TaskStreamPage } from '../shared/task-stream.js';

/** Bounded SSE pull bridge. Node-owned replay is authoritative across gateway restarts. */
export function installTaskStream(app: express.Express, registry: NodeRegistry, bearer: express.RequestHandler,
  actorFor: (req: express.Request) => RequestActor,
  verify: (req: express.Request) => Promise<void>): void {
  let subscribers = 0;
  // Match the OAuth admission budget. One gateway-wide key also bounds limiter state,
  // and admission runs before bearer verification to bound unauthenticated churn.
  app.get('/api/v2/tasks/:taskId/events', rateLimit({
    windowMs: 60_000, limit: 300, keyGenerator: () => 'task-stream-ingress',
    standardHeaders: 'draft-8', legacyHeaders: false
  }), bearer, async (req, res) => {
    const nodeId = req.query.node_id;
    const taskId = req.params.taskId;
    const cursorHeader = req.headers['last-event-id'];
    let cursor = typeof cursorHeader === 'string' ? cursorHeader : undefined;
    if (typeof nodeId !== 'string' || !nodeId || typeof taskId !== 'string'
      || !/^rtsk_[0-9a-f]{11,13}_[0-9a-f]{16,32}$/.test(taskId)
      || (cursor !== undefined && !/^tev_[0-9a-f]{24}$/.test(cursor))) {
      res.status(400).json({ error: 'invalid stream identity or cursor' }); return;
    }
    if (subscribers >= 32) { res.status(429).json({ error: 'subscriber limit reached' }); return; }
    subscribers += 1;
    res.setTimeout(60_000, () => res.destroy());
    let closed = false;
    res.on('close', () => { closed = true; });
    const deadline = Date.now() + 60_000;
    async function write(frame: string): Promise<boolean> {
      if (closed) return false;
      if (res.write(frame)) return true;
      return new Promise(resolve => {
        const finish = (ok: boolean) => { clearTimeout(timer); res.off('drain', drained); res.off('close', ended); resolve(ok); };
        const drained = () => finish(true);
        const ended = () => finish(false);
        const timer = setTimeout(() => { res.destroy(); finish(false); }, 2000);
        res.once('drain', drained); res.once('close', ended);
      });
    }
    try {
      while (!closed && Date.now() < deadline) {
        // bearer middleware has already verified OAuth. Reverify on each read for token expiry/revocation.
        await verify(req);
        if (res.writableEnded || closed) break;
        const page = (await registry.requestWithTrace(nodeId, 'dex.task', {}, actorFor(req), undefined, 5000,
          { action: 'events', taskId, ...(cursor ? { cursor } : {}) })).result as TaskStreamPage;
        if (closed) break;
        if (page.taskId !== taskId || page.nodeId !== nodeId || !Array.isArray(page.events) || page.events.length > 100) throw new Error('invalid event page');
        if (!res.headersSent) {
          res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', 'X-Reach-Protocol-Version': '2.0' });
          res.flushHeaders();
        }
        if (page.gap && !await write('event: gap\ndata: {"replay":"truncated-or-expired"}\n\n')) break;
        for (const event of page.events) {
          // Do not forward arbitrary node-supplied fields or text to the public client.
          if (!/^tev_[0-9a-f]{24}$/.test(event.eventId) || event.taskId !== taskId || !Number.isFinite(Date.parse(event.at))
            || !['accepted','updated','transition','archived','control'].includes(event.kind)
            || !['ACCEPTED','PREPARING','RUNNING','INPUT_REQUIRED','AMBIGUOUS','COMPLETED','FAILED','CANCELLED','RECONCILED'].includes(event.state)) throw new Error('invalid event');
          const data = { taskId, nodeId, eventId: event.eventId, kind: event.kind, at: new Date(event.at).toISOString(), state: event.state, summary: `Task state: ${event.state}.` };
          if (!await write(`id: ${event.eventId}\nevent: task\ndata: ${JSON.stringify(data)}\n\n`)) { closed = true; break; }
          cursor = event.eventId;
        }
        if (page.terminal || closed) break;
        await new Promise(resolve => setTimeout(resolve, 250));
      }
    } catch {
      if (!res.headersSent) res.status(403).json({ error: 'task stream unavailable or unauthorized' });
      // After admission, close without disclosing node refusal details. Reconnect rechecks authority.
    } finally {
      subscribers -= 1;
      res.end();
    }
  });
}
