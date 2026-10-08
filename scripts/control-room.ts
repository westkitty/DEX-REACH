#!/usr/bin/env node
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { NodeTaskStore, TASK_STATES, type TaskState } from '../src/node/task-store.js';
import { readRuntimeStatus } from '../src/node/runtime-status.js';
import { TaskEventLog } from '../src/shared/task-events.js';
import { listTraces, readTrace } from '../src/shared/trace.js';
import { readProcessActivities, shareSafeActivity, observeActivityProcesses } from '../src/shared/activity.js';
import { loadAccessState, resolveMode } from '../src/shared/access.js';
import { coordinatedStatus } from '../src/coordinator/client.js';
import { localNodeIds } from './lib/node-files.js';
import { DEX_REACH_VERSION } from '../src/shared/version.js';
import { REACH_PROTOCOL_VERSION } from '../src/shared/protocol.js';

const execFileAsync = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const store = new NodeTaskStore();
const host = '127.0.0.1';
const port = Number(process.env.DEX_CONTROL_PORT || 4177);
const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]);
const nodeIdPattern = /^[a-zA-Z0-9._-]{1,128}$/;
const taskIdPattern = /^rtsk_[0-9a-f]{11,13}_[0-9a-f]{16,32}$/;
const traceIdPattern = /^[0-9a-f]{32}$/;
let workCache: { value: Awaited<ReturnType<typeof coordinatedStatus>>; updatedAt: number } | null = null;
let workLoad: Promise<void> | null = null;
let traceCache: { records: Array<{ traceId: string; at: string; spans: number }>; updatedAt: number } | null = null;
let traceLoad: Promise<void> | null = null;

function refreshWorkInBackground(): void {
  if (workLoad) return;
  workLoad = coordinatedStatus().then(value => { workCache = { value, updatedAt: Date.now() }; }).catch(() => undefined).finally(() => { workLoad = null; });
}
function refreshTraceInBackground(): void {
  if (traceLoad) return;
  traceLoad = (async () => {
    const nodeId = safeNodeId(await localNodeIds());
    const candidates = nodeId ? await listTraces(100) : [];
    const records = (await Promise.all(candidates.map(async item => ({ ...item, nodeMatch: (await readTrace(item.traceId)).some(span => span.nodeId === nodeId) })))).filter(item => item.nodeMatch).map(({ nodeMatch: _match, ...item }) => item);
    traceCache = { records, updatedAt: Date.now() };
  })().catch(() => undefined).finally(() => { traceLoad = null; });
}

function safeNodeId(ids: string[]): string | null {
  const hostname = os.hostname().toLowerCase().replace(/\.local$/, '').replace(/[^a-z0-9._-]/g, '-');
  const exact = ids.filter(id => id.toLowerCase().replace(/\.local$/, '') === hostname);
  return exact.length === 1 ? exact[0]! : null;
}
function json(res: http.ServerResponse, status: number, value: unknown) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(JSON.stringify(value));
}
function validRequest(req: http.IncomingMessage): boolean {
  if (!req.headers.host || !allowedHosts.has(req.headers.host.toLowerCase())) return false;
  const origin = req.headers.origin;
  if (origin && origin !== `http://${req.headers.host}`) return false;
  return req.method === 'GET' || req.method === 'HEAD';
}
async function git(args: string[]): Promise<string> {
  try { const { stdout } = await execFileAsync('git', args, { cwd: root, timeout: 1500, maxBuffer: 16_384 }); return stdout.trim(); }
  catch { return 'unavailable'; }
}
async function overview() {
  const nodeId = safeNodeId(await localNodeIds());
  const tasks = (await store.list()).filter(task => nodeId !== null && task.nodeId === nodeId);
  const active = tasks.filter(task => !['COMPLETED', 'FAILED', 'CANCELLED', 'RECONCILED'].includes(task.state));
  const attention = tasks.filter(task => ['FAILED', 'AMBIGUOUS', 'INPUT_REQUIRED'].includes(task.state)).slice(0, 6).map(task => ({ taskId: task.taskId, state: task.state, operation: task.operation, updatedAtUtc: task.updatedAtUtc, status: task.summary.status }));
  const [runtime, access, activity, services, project] = await Promise.all([
    nodeId ? readRuntimeStatus(nodeId) : Promise.resolve(null),
    nodeId ? loadAccessState(nodeId).catch(() => null) : Promise.resolve(null),
    readProcessActivities({ includeFinished: true, limit: 20 }).then(items => shareSafeActivity(items)).catch(() => []),
    observeActivityProcesses().catch(() => ({ dexServices: [], uncoordinatedHeavy: [] })),
    Promise.all([git(['rev-parse', '--abbrev-ref', 'HEAD']), git(['rev-parse', 'HEAD']), git(['status', '--porcelain'])])
  ]);
  refreshWorkInBackground();
  const work = workCache && Date.now() - workCache.updatedAt < 30_000 ? workCache.value : null;
  const activeCount = active.length;
  const servicesObserved = services.dexServices.map(item => item.processLabel);
  return {
    generatedAt: new Date().toISOString(), staleAfterMs: 15_000,
    machine: { hostname: os.hostname(), platform: process.platform, arch: process.arch, nodeId, online: Boolean(runtime), runtimeUpdatedAt: runtime?.updatedAt ?? null, runtimeVersion: DEX_REACH_VERSION, accessMode: access ? resolveMode(access) : null, gateway: runtime ? (runtime.connected ? 'connected' : 'disconnected') : 'unavailable', coordinator: work ? (work.degraded ? 'degraded' : 'available') : 'unavailable', worker: servicesObserved.some(label => /worker/i.test(label)) ? 'observed' : 'not observed', queueDepth: work ? work.tickets.length : null, activeLeases: work ? work.leases.length : null, cpu: null, memory: null },
    services: { observed: servicesObserved, unavailableMetrics: ['CPU pressure', 'memory pressure'] },
    tasks: { active: activeCount, waiting: work?.tickets.length ?? null, attention, recent: tasks.slice(0, 8).map(task => ({ taskId: task.taskId, state: task.state, operation: task.operation, nodeId: task.nodeId, updatedAtUtc: task.updatedAtUtc, status: task.summary.status })) },
    activity: activity.slice(0, 8),
    connector: { localBackend: 'available', gateway: runtime?.connected ? 'available' : 'unavailable', publicMcp: 'not measured by local UI', protocolVersion: REACH_PROTOCOL_VERSION, expectedPublicActions: 17, chatGptExposure: 'not independently verified' },
    project: { repository: 'westkitty/DEX-REACH', branch: project[0], head: project[1], dirty: project[2] !== '', dirtyCount: project[2] === '' ? 0 : project[2].split('\n').length, sourceState: 'local worktree', tested: 'not established by this UI', committed: project[2] === '' ? 'clean worktree' : 'uncommitted changes', pushed: 'not measured', installed: runtime ? DEX_REACH_VERSION : 'unavailable', deployed: 'not measured' }
  };
}
async function handle(req: http.IncomingMessage, res: http.ServerResponse) {
  if (!validRequest(req)) return json(res, 403, { error: 'Local Control Room accepts same-origin loopback requests only.' });
  const url = new URL(req.url || '/', `http://${req.headers.host}`);
  if (url.pathname.startsWith('/api/')) {
    try {
      if (url.pathname === '/api/overview') return json(res, 200, await overview());
      if (url.pathname === '/api/tasks') {
        const parsedLimit = Number(url.searchParams.get('limit') || 20);
        const parsedOffset = Number(url.searchParams.get('offset') || 0);
        if (!Number.isSafeInteger(parsedLimit) || !Number.isSafeInteger(parsedOffset)) return json(res, 400, { error: 'Invalid task page.' });
        const limit = Math.max(1, Math.min(50, parsedLimit));
        const offset = Math.max(0, parsedOffset);
        const state = url.searchParams.get('state');
        if (state && !TASK_STATES.includes(state as TaskState)) return json(res, 400, { error: 'Unsupported task state.' });
        const nodeId = safeNodeId(await localNodeIds());
        const all = (await store.list(state ? { state: state as TaskState } : {})).filter(task => nodeId !== null && task.nodeId === nodeId);
        return json(res, 200, { items: all.slice(offset, offset + limit).map(task => ({ ...task, actorId: undefined, idempotencyKey: undefined, payloadSha256: undefined, policyHash: undefined, resultRef: undefined, resultHash: undefined, repoContext: undefined })), total: all.length, offset, limit, states: TASK_STATES });
      }
      const detail = /^\/api\/tasks\/([^/]+)$/.exec(url.pathname);
      if (detail) {
        const id = decodeURIComponent(detail[1]!);
        if (!taskIdPattern.test(id)) return json(res, 400, { error: 'Invalid task identity.' });
        const task = await store.read(id);
        if (!task || task.nodeId !== safeNodeId(await localNodeIds())) return json(res, 404, { error: 'Task not found for the exact local node.' });
        const [events, trace, activity] = await Promise.all([new TaskEventLog(store.rootDir).list(id, 200), task.traceId ? readTrace(task.traceId) : Promise.resolve([]), readProcessActivities({ includeFinished: true, limit: 200 }).then(items => shareSafeActivity(items.filter(item => item.taskId === id)))]);
        return json(res, 200, { task: { ...task, resultAvailable: Boolean(task.resultRef), actorId: undefined, idempotencyKey: undefined, payloadSha256: undefined, policyHash: undefined, resultRef: undefined, resultHash: undefined, repoContext: undefined }, events, trace, activity, controls: [] });
      }
      if (url.pathname === '/api/log') {
        const parsedLimit = Number(url.searchParams.get('limit') || 20);
        const parsedOffset = Number(url.searchParams.get('offset') || 0);
        if (!Number.isSafeInteger(parsedLimit) || !Number.isSafeInteger(parsedOffset)) return json(res, 400, { error: 'Invalid log page.' });
        const limit = Math.max(1, Math.min(50, parsedLimit));
        const offset = Math.max(0, parsedOffset);
        const allActivity = shareSafeActivity(await readProcessActivities({ includeFinished: true, limit: 200 }));
        refreshTraceInBackground();
        const tracesReady = Boolean(traceCache && Date.now() - traceCache.updatedAt < 60_000);
        const traceRecords = tracesReady ? traceCache!.records : [];
        return json(res, 200, { activity: allActivity.slice(offset, offset + limit), activityTotal: allActivity.length, traces: traceRecords.slice(offset, offset + limit), tracesHaveMore: traceRecords.length > offset + limit, traceWindowCap: 100, traceStatus: tracesReady ? 'ready' : 'loading', offset, limit });
      }
      const trace = /^\/api\/traces\/([^/]+)$/.exec(url.pathname);
      if (trace) {
        const id = decodeURIComponent(trace[1]!);
        if (!traceIdPattern.test(id)) return json(res, 400, { error: 'Invalid trace identity.' });
        return json(res, 200, { spans: await readTrace(id) });
      }
      return json(res, 404, { error: 'Unknown local API route.' });
    } catch {
      return json(res, 503, { error: 'Local DEX state is temporarily unavailable.' });
    }
  }
  const file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
  if (!['index.html', 'app.js', 'styles.css', 'favicon.svg'].includes(file)) { res.writeHead(404); return res.end('Not found'); }
  const fs = await import('node:fs/promises');
  const body = await fs.readFile(path.join(root, 'control-room', file));
  res.writeHead(200, { 'content-type': file.endsWith('.js') ? 'text/javascript; charset=utf-8' : file.endsWith('.css') ? 'text/css; charset=utf-8' : file.endsWith('.svg') ? 'image/svg+xml' : 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'" });
  res.end(body);
}
const server = http.createServer((req, res) => { void handle(req, res).catch(() => { if (!res.headersSent) json(res, 500, { error: 'Control Room request failed.' }); }); });
server.requestTimeout = 5000;
server.headersTimeout = 6000;
server.listen(port, host, () => console.log(`STINKY WEASEL CONTROL listening at http://127.0.0.1:${port}`));
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => server.close(() => process.exit(0)));
