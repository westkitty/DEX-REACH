// Isolated child process for multi-process checkpoint tests. Every role runs real production modules
// against a synthetic DEX_REACH_STATE_DIR; nothing here can reach owner state or installed services.
import fs from 'node:fs/promises';
import path from 'node:path';
import { checkpointControlFromEnv, processCheckpoint } from '../../src/shared/checkpoint.js';
import { NodeTaskStore } from '../../src/node/task-store.js';
import { ResultStore } from '../../src/node/result-store.js';
import { appendReceipt } from '../../src/shared/receipts.js';
import { AuditLog } from '../../src/shared/audit.js';
import { createGrant, updateAccessState } from '../../src/shared/access.js';
import { addRevokedNode } from '../../src/shared/revoked-nodes.js';
import { ReachOAuthProvider } from '../../src/gateway/auth.js';

const role = process.argv[2] as 'node' | 'gateway' | 'cli' | 'holder';
const state = process.env.DEX_REACH_STATE_DIR ?? '';
if (role !== 'holder' && !state.includes('dex-c14-recovery-')) throw new Error('CHILD_REQUIRES_SYNTHETIC_STATE');
const nodeId = 'macbook-air.local', hash = 'a'.repeat(64);
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
type Command = { id: number; cmd: string; delayMs?: number; file?: string; text?: string; config?: string };
const reply = (id: number, body: Record<string, unknown>) => process.send?.({ id, ...body });

async function durableTask(store: NodeTaskStore, key: string) {
  const task = await store.create({ actorId: 'synthetic-actor', nodeId, operation: 'dex.fingerprint', idempotencyKey: key, payloadSha256: hash, safetyClass: 'PURE_READ_IDEMPOTENT', mutationLevel: 'NONE' });
  await store.transition(task.taskId, 'PREPARING'); return task;
}
async function nodeCommand(c: Command): Promise<unknown> {
  const store = new NodeTaskStore(state), results = new ResultStore(64 * 1024, 60 * 60_000, state), delay = c.delayMs ?? 0;
  switch (c.cmd) {
    // Store commit and event append are separate locks: the delay sits inside the operation, between them.
    case 'task-and-event': return processCheckpoint().admit(async () => { const t = await durableTask(store, `k-${c.id}`); await sleep(delay); await store.transition(t.taskId, 'RUNNING'); return t.taskId; });
    case 'result-commit': return processCheckpoint().admit(async () => {
      const t = await durableTask(store, `r-${c.id}`); await store.transition(t.taskId, 'RUNNING'); await sleep(delay);
      const bound = await results.boundWithReference({ synthetic: c.id }, t.taskId);
      await store.update(t.taskId, { resultRef: bound.metadata.handle, resultHash: bound.metadata.resultHash }); return t.taskId;
    });
    case 'delayed-receipt': return processCheckpoint().admit(async () => { await sleep(delay); await appendReceipt({ nodeId, operation: 'dex.fingerprint', args: {}, result: { id: c.id }, ok: true, durationMs: 1, policy: {} }); await new AuditLog().append({ at: new Date().toISOString(), source: 'node', nodeId, operation: 'dex.fingerprint', ok: true, durationMs: 1, args: {} } as never); return true; });
    // Commits part of its state, then fails: the participant must count it as a drain fault.
    case 'partial-failure': return processCheckpoint().admit(async () => { await sleep(delay); await durableTask(store, `p-${c.id}`); throw new Error('SYNTHETIC_PARTIAL_FAILURE'); });
    case 'hang': return processCheckpoint().admit(() => new Promise(() => undefined));
    case 'admit-probe': return processCheckpoint().admit(async () => 'admitted');
    // Bypasses every gate: an unregistered or misbehaving writer, detectable only by content.
    case 'raw-write': await fs.mkdir(path.dirname(path.join(state, c.file!)), { recursive: true, mode: 0o700 }); await fs.writeFile(path.join(state, c.file!), c.text ?? '{}', { mode: 0o600 }); return true;
    default: throw new Error(`UNKNOWN_NODE_COMMAND:${c.cmd}`);
  }
}
let oauth: ReachOAuthProvider | undefined;
async function gatewayCommand(c: Command): Promise<unknown> {
  switch (c.cmd) {
    case 'oauth-register': {
      oauth ??= new ReachOAuthProvider(state, 'synthetic-owner', 'synthetic-password-not-real', new URL('https://synthetic.invalid/mcp'));
      await oauth.initialize();
      const client = await oauth.clientsStore.registerClient({ redirect_uris: ['https://synthetic.invalid/cb'], client_name: `synthetic-${c.id}` } as never);
      return client.client_id;
    }
    case 'revoke': return [...await addRevokedNode(state, `revoked-${c.id}`)].length;
    case 'audit': await new AuditLog().append({ at: new Date().toISOString(), source: 'gateway', ok: true, durationMs: 1, args: {} } as never); return true;
    default: throw new Error(`UNKNOWN_GATEWAY_COMMAND:${c.cmd}`);
  }
}
async function cliCommand(cmd: string): Promise<unknown> {
  if (cmd === 'grant') return updateAccessState(nodeId, s => createGrant(s, 'chatgpt', ['file.write'], ['/synthetic/workspace'], 60_000, 1, `cli-grant-${process.pid}`), state);
  if (cmd === 'receipt') return appendReceipt({ nodeId, operation: 'dex.fingerprint', args: {}, result: { cli: process.pid }, ok: true, durationMs: 1, policy: {} });
  if (cmd === 'revoke') return addRevokedNode(state, `cli-revoked-${process.pid}`);
  throw new Error(`UNKNOWN_CLI_COMMAND:${cmd}`);
}

if (role === 'cli') {
  cliCommand(process.argv[3]!).then(() => process.exit(0), error => { process.stderr.write(String(error?.message ?? error)); process.exit(3); });
} else if (role === 'holder') {
  // A holder in its own process: it owns its synthetic workspace, so tests can kill it mid-protocol.
  const holder = await import('./checkpoint-holder.js');
  process.on('message', async (c: Command & Record<string, unknown>) => {
    if (c.resume) return holder.resume(String(c.resume));
    try { reply(c.id, { ok: true, value: await holder.handle(c, hook => process.send?.({ hook })) }); }
    catch (error) { reply(c.id, { ok: false, error: String((error as Error).message) }); }
  });
  process.send?.({ ready: true, pid: process.pid });
} else {
  const control = await checkpointControlFromEnv(role, nodeId, state);
  if (!control) throw new Error('CHECKPOINT_CONTROL_NOT_ENABLED');
  process.on('message', async (c: Command) => {
    try { reply(c.id, { ok: true, value: await (role === 'node' ? nodeCommand(c) : gatewayCommand(c)) }); }
    catch (error) { reply(c.id, { ok: false, error: String((error as Error).message), code: (error as { code?: string }).code }); }
  });
  process.send?.({ ready: true, pid: process.pid, bootId: control.participant.bootId });
}
