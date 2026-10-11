import test from 'node:test';
import assert from 'node:assert/strict';
import { fork, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CHILD = path.join(path.dirname(fileURLToPath(import.meta.url)), 'helpers', 'checkpoint-child.ts');
type Reply = { id?: number; ok?: boolean; value?: any; error?: string; code?: string; ready?: boolean; hook?: string; pid?: number; bootId?: string };

class Child {
  private next = 1; private pending = new Map<number, (r: Reply) => void>(); private hooks: string[] = []; private hookWaiters: Array<(h: string) => void> = [];
  readonly exited: Promise<number | null>; ready!: Reply; stderr = '';
  private constructor(readonly proc: ChildProcess) {
    this.exited = new Promise(resolve => proc.once('exit', code => resolve(code)));
    proc.on('error', () => undefined);
    proc.stderr?.on('data', d => { this.stderr += d; if (process.env.CP_DEBUG) process.stderr.write(d); });
    proc.on('message', (m: Reply) => {
      if (m.hook) { const w = this.hookWaiters.shift(); if (w) w(m.hook); else this.hooks.push(m.hook); return; }
      if (m.id !== undefined) { this.pending.get(m.id)?.(m); this.pending.delete(m.id); }
    });
  }
  static async start(role: string, env: Record<string, string> = {}): Promise<Child> {
    const proc = fork(CHILD, [role], { execArgv: ['--import', 'tsx'], env: { ...process.env, ...env }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    const child = new Child(proc);
    child.ready = await new Promise<Reply>((resolve, reject) => {
      proc.once('message', (m: Reply) => resolve(m));
      child.exited.then(code => reject(new Error(`child ${role} exited ${code}: ${child.stderr.slice(0, 400)}`)));
    });
    return child;
  }
  call(cmd: string, extra: Record<string, unknown> = {}): Promise<Reply> {
    const id = this.next++;
    return new Promise((resolve, reject) => {
      if (!this.proc.connected) { reject(new Error(`child not connected for ${cmd}`)); return; }
      this.pending.set(id, resolve); this.proc.send({ id, cmd, ...extra }, error => { if (error) reject(error); });
      this.exited.then(code => reject(new Error(`child exited ${code} during ${cmd}`)));
    });
  }
  async value(cmd: string, extra: Record<string, unknown> = {}) { const r = await this.call(cmd, extra); if (!r.ok) throw new Error(r.error); return r.value; }
  hook(): Promise<string> { const h = this.hooks.shift(); return h ? Promise.resolve(h) : new Promise(r => this.hookWaiters.push(r)); }
  resume(name: string) { if (this.proc.connected) this.proc.send({ resume: name }, () => undefined); }
  async stop() { if (this.proc.exitCode === null && this.proc.signalCode === null) { this.proc.kill('SIGKILL'); await this.exited; } }
}

/** One isolated world: a holder process owning a synthetic workspace, plus participant processes. */
async function world(roles: Array<'node' | 'gateway'> = ['node', 'gateway']) {
  const holder = await Child.start('holder');
  const paths = await holder.value('setup') as Record<string, string>;
  const env = { DEX_REACH_STATE_DIR: paths.state!, DEX_REACH_CHECKPOINT_CONTROL: '1', DEX_REACH_CHECKPOINT_CONTROL_DIR: paths.control! };
  const participants: Record<string, Child> = {};
  for (const role of roles) participants[role] = await Child.start(role, env);
  const spawned: Child[] = [];
  return {
    holder, paths, env, participants, node: participants.node!, gateway: participants.gateway!,
    async participant(role: 'node' | 'gateway') { const c = await Child.start(role, env); participants[role] = c; return c; },
    async extraHolder() { const c = await Child.start('holder'); spawned.push(c); return c; },
    cli(cmd: string): Promise<{ code: number | null; stderr: string }> {
      return new Promise(resolve => {
        const p = spawn(process.execPath, ['--import', 'tsx', CHILD, 'cli', cmd], { env: { ...process.env, DEX_REACH_STATE_DIR: paths.state! }, stdio: ['ignore', 'ignore', 'pipe'] });
        let stderr = ''; p.stderr.on('data', d => { stderr += d; }); p.once('exit', code => resolve({ code, stderr }));
      });
    },
    async close() {
      for (const c of [...Object.values(participants), ...spawned]) await c.stop();
      await holder.value('cleanup').catch(() => undefined); await holder.stop();
      await fs.rm(paths.workspace!, { recursive: true, force: true });
      for (const k of ['control', 'evidence', 'expectations']) await fs.rm(paths[k]!, { recursive: true, force: true });
    }
  };
}
const read = (p: string) => fs.readFile(p, 'utf8');
const backup = (paths: Record<string, string>, txn: string, relative: string) => path.join(paths.destination!, txn, 'state', relative);

test('real node and gateway processes drain, acknowledge and produce a certified synthetic snapshot', async () => {
  const x = await world(); try {
    await x.node.value('result-commit', { delayMs: 0 });
    const o = await x.holder.value('run');
    assert.equal(o.status, 'CERTIFIED_SYNTHETIC', o.reason); assert.equal(o.replayAuthorized, false); assert.equal(o.installationAuthority, false);
    assert.deepEqual(await x.holder.value('evidence', { txn: o.transactionId }), ['PREPARED', 'ACKNOWLEDGED', 'FENCED', 'CAPTURING', 'CAPTURED', 'RESTORE_VERIFIED', 'CERTIFIED']);
    assert.equal(await read(backup(x.paths, o.transactionId, 'tasks/store.json')), await read(path.join(x.paths.state!, 'tasks/store.json')));
    assert.equal((await x.holder.value('reconcile', { txn: o.transactionId })).state, 'CERTIFIED_VERIFIED');
    // Admission reopened after release.
    assert.equal(await x.node.value('admit-probe'), 'admitted');
  } finally { await x.close(); }
});

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const notCertified = (o: any) => assert.notEqual(o.status, 'CERTIFIED_SYNTHETIC', 'must not certify');
async function terminalEvidence(x: Awaited<ReturnType<typeof world>>, txn: string) { return (await x.holder.value('evidence', { txn })).at(-1); }

test('a writer that never responds is UNRESPONSIVE, never assumed stopped', async () => {
  const x = await world(); try {
    x.node.proc.kill('SIGSTOP');
    const o = await x.holder.value('run', { options: { responseMs: 800 } });
    x.node.proc.kill('SIGCONT');
    assert.equal(o.status, 'REFUSED'); assert.match(o.reason, /WRITER_UNRESPONSIVE:node/);
    assert.equal(await terminalEvidence(x, o.transactionId), 'REFUSED');
  } finally { x.node.proc.kill('SIGCONT'); await x.close(); }
});
test('a writer that dies while draining refuses the checkpoint', async () => {
  const x = await world(); try {
    const op = x.node.call('task-and-event', { delayMs: 2_000 }).catch(() => undefined);
    await sleep(300); const run = x.holder.value('run'); await sleep(400); await x.node.stop(); await op;
    const o = await run; assert.equal(o.status, 'REFUSED'); assert.match(o.reason, /WRITER_(CONNECTION_LOST|UNRESPONSIVE|MISSING):node/);
  } finally { await x.close(); }
});
test('a result committed immediately before admission closes is captured consistently', async () => {
  const x = await world(); try {
    const taskId = await x.node.value('result-commit');
    const o = await x.holder.value('run'); assert.equal(o.status, 'CERTIFIED_SYNTHETIC', o.reason);
    const store = JSON.parse(await read(backup(x.paths, o.transactionId, 'tasks/store.json')));
    assert.ok(store.records[taskId].resultRef);
    assert.equal(await read(backup(x.paths, o.transactionId, 'results/manifest.json')), await read(path.join(x.paths.state!, 'results/manifest.json')));
  } finally { await x.close(); }
});
test('an event append racing the checkpoint is drained into the snapshot, store and events together', async () => {
  const x = await world(); try {
    const op = x.node.value('task-and-event', { delayMs: 700 });
    await sleep(250); const o = await x.holder.value('run'); const taskId = await op;
    assert.equal(o.status, 'CERTIFIED_SYNTHETIC', o.reason);
    const store = JSON.parse(await read(backup(x.paths, o.transactionId, 'tasks/store.json'))), events = await read(backup(x.paths, o.transactionId, 'tasks/events.jsonl'));
    assert.equal(store.records[taskId].state, 'RUNNING');
    assert.ok(events.split('\n').some(l => l.includes(taskId) && l.includes('"toState":"RUNNING"')));
  } finally { await x.close(); }
});
test('a receipt persisted by an in-flight operation delays the acknowledgement and is captured', async () => {
  const x = await world(); try {
    const before = (await read(path.join(x.paths.state!, 'receipts/macbook-air.local.jsonl'))).trim().split('\n').length;
    const op = x.node.value('delayed-receipt', { delayMs: 700 }); await sleep(250);
    const o = await x.holder.value('run'); await op;
    assert.equal(o.status, 'CERTIFIED_SYNTHETIC', o.reason);
    assert.equal((await read(backup(x.paths, o.transactionId, 'receipts/macbook-air.local.jsonl'))).trim().split('\n').length, before + 1);
  } finally { await x.close(); }
});
test('an unexpected coordinator lease during capture prevents certification', async () => {
  const x = await world(); try {
    const run = x.holder.value('run', { hooks: { beforeCapture: 'pause' } });
    assert.equal(await x.holder.hook(), 'beforeCapture');
    await x.node.value('raw-write', { file: 'coordinator/leases/intruder.json', text: '{}' });
    x.holder.resume('beforeCapture'); const o = await run; notCertified(o);
    assert.notEqual((await x.holder.value('reconcile', { txn: o.transactionId })).state, 'CERTIFIED_VERIFIED');
  } finally { await x.close(); }
});
test('a revocation before the fence is captured; one attempted inside the fence waits outside the snapshot', async () => {
  const x = await world(); try {
    const run = x.holder.value('run', { hooks: { afterAcks: 'pause', afterFence: 'pause' } });
    assert.equal(await x.holder.hook(), 'afterAcks');
    await x.gateway.value('revoke'); // real addRevokedNode under its own lock, before the fence
    x.holder.resume('afterAcks'); assert.equal(await x.holder.hook(), 'afterFence');
    const cli = x.cli('revoke'); await sleep(600); // blocked on the fenced revocation lock
    x.holder.resume('afterFence'); const o = await run; await cli;
    assert.equal(o.status, 'CERTIFIED_SYNTHETIC', o.reason);
    const captured = await read(backup(x.paths, o.transactionId, 'revoked-nodes.json'));
    assert.match(captured, /revoked-\d+/); assert.doesNotMatch(captured, /cli-revoked-/);
  } finally { await x.close(); }
});
test('a grant attempted between generations cannot enter the fenced snapshot', async () => {
  const x = await world(); try {
    const run = x.holder.value('run', { hooks: { afterFence: 'pause' } }); assert.equal(await x.holder.hook(), 'afterFence');
    const cli = x.cli('grant'); await sleep(600);
    x.holder.resume('afterFence'); const o = await run; const done = await cli;
    assert.equal(o.status, 'CERTIFIED_SYNTHETIC', o.reason);
    assert.doesNotMatch(await read(backup(x.paths, o.transactionId, 'nodes/macbook-air.local.access.json')), /cli-grant-/);
    if (done.code === 0) assert.match(await read(path.join(x.paths.state!, 'nodes/macbook-air.local.access.json')), /cli-grant-/);
  } finally { await x.close(); }
});
test('a participant restarted with a new identity during the checkpoint invalidates it', async () => {
  const x = await world(); try {
    const run = x.holder.value('run', { hooks: { afterFence: 'pause' } }); assert.equal(await x.holder.hook(), 'afterFence');
    await x.node.stop(); await x.participant('node');
    x.holder.resume('afterFence'); const o = await run; notCertified(o); assert.match(o.reason, /WRITER_(CONNECTION_LOST|BOUNDARY_LOST|UNRESPONSIVE):node/);
  } finally { await x.close(); }
});
test('a failure partway through an in-flight operation is a drain fault and refuses', async () => {
  const x = await world(); try {
    // The failure must land inside the 3 s drain window, after admission closes. At 500 ms a slow hosted
    // runner could finish it before prepare, a fault outside the window that is correctly certified.
    const op = x.node.call('partial-failure', { delayMs: 1500 }); await sleep(200);
    const o = await x.holder.value('run'); const r = await op;
    assert.equal(r.ok, false); assert.equal(o.status, 'REFUSED'); assert.match(o.reason, /WRITER_FAULT_DURING_DRAIN:node/);
  } finally { await x.close(); }
});
test('a writer that claims success after a partial commit cannot produce a certified snapshot', async () => {
  const x = await world(); try {
    // Task state committed without its event: what a writer that skipped half an operation leaves behind.
    const file = path.join(x.paths.state!, 'tasks/store.json'), doc = JSON.parse(await read(file));
    const id = Object.keys(doc.records)[0]!; doc.records[id].state = 'SUCCEEDED'; await fs.writeFile(file, JSON.stringify(doc, null, 2) + '\n', { mode: 0o600 });
    const o = await x.holder.value('run'); notCertified(o);
  } finally { await x.close(); }
});
test('capture failing after every writer acknowledged is FAILED_UNCERTAIN and releases admission', async () => {
  const x = await world(); try {
    const o = await x.holder.value('run', { badBudget: true });
    assert.equal(o.status, 'FAILED_UNCERTAIN'); assert.equal(await terminalEvidence(x, o.transactionId), 'FAILED');
    assert.equal((await x.holder.value('reconcile', { txn: o.transactionId })).retryAuthorized, false);
    assert.equal(await x.node.value('admit-probe'), 'admitted');
  } finally { await x.close(); }
});
test('a capture whose response is lost reconciles as UNCERTAIN after restart, with no retry', async () => {
  const x = await world(); try {
    const crashed = x.holder.call('run', { hooks: { afterCapture: 'crash' } }).catch(() => undefined);
    assert.equal(await x.holder.exited, 7); await crashed;
    const [txn] = await fs.readdir(x.paths.evidence!);
    const restarted = await x.extraHolder(); await restarted.value('attach', { paths: x.paths });
    const r = await restarted.value('reconcile', { txn });
    assert.equal(r.state, 'UNCERTAIN_INTERRUPTED'); assert.equal(r.artifact, 'PRESENT_UNRECORDED'); assert.equal(r.retryAuthorized, false); assert.equal(r.installationAuthority, false);
    await sleep(100); assert.equal(await x.node.value('admit-probe'), 'admitted');
  } finally { await x.close(); }
});
test('a holder that crashes while holding admission releases it; its stale lock cannot certify foreign state', async () => {
  const x = await world(); try {
    const run = x.holder.call('run', { hooks: { afterAcks: 'pause' } }).catch(() => undefined);
    assert.equal(await x.holder.hook(), 'afterAcks');
    const closed = await x.node.call('admit-probe'); assert.equal(closed.ok, false); assert.equal(closed.code, 'CHECKPOINT_ADMISSION_CLOSED');
    await x.holder.stop(); await run; await sleep(100);
    assert.equal(await x.node.value('admit-probe'), 'admitted');
    // A new holder recovers the dead holder's lock, but participants serve another state root.
    const other = await x.extraHolder(); await other.value('setup');
    const o = await other.value('run', { control: x.paths.control });
    assert.equal(o.status, 'REFUSED'); assert.match(o.reason, /WRITER_STATE_MISMATCH/);
    await other.value('cleanup');
  } finally { await x.close(); }
});
test('two checkpoint holders contending for one writer set: the second is refused', async () => {
  const x = await world(); try {
    const first = x.holder.value('run', { hooks: { afterAcks: 'pause' } }); assert.equal(await x.holder.hook(), 'afterAcks');
    const other = await x.extraHolder(); await other.value('setup');
    const second = await other.value('run', { control: x.paths.control, options: { lockTimeoutMs: 300 } });
    assert.equal(second.status, 'REFUSED'); assert.equal(second.reason, 'CHECKPOINT_CONTENDED');
    x.holder.resume('afterAcks'); assert.equal((await first).status, 'CERTIFIED_SYNTHETIC');
    await other.value('cleanup');
  } finally { await x.close(); }
});
test('coordinator claims, running installers and missing participants refuse admission; stale tasks are preserved', async () => {
  const x = await world(['node']); try {
    const missing = await x.holder.value('run'); assert.equal(missing.status, 'REFUSED'); assert.match(missing.reason, /WRITER_MISSING:gateway/);
    await x.participant('gateway');
    const installer = await x.holder.value('run', { processTable: '501 42 node scripts/install-macos.ts --candidate x\n' });
    assert.equal(installer.reason, 'WRITER_PROCESS_ACTIVE:runtime-installer');
    const before = await read(path.join(x.paths.state!, 'tasks/store.json'));
    const ok = await x.holder.value('run'); assert.equal(ok.status, 'CERTIFIED_SYNTHETIC', ok.reason);
    assert.ok(ok.preservedUnresolvedTasks >= 1); assert.equal(ok.replayAuthorized, false);
    assert.equal(await read(path.join(x.paths.state!, 'tasks/store.json')), before);
    await x.node.value('raw-write', { file: 'coordinator/leases/claim.json', text: '{}' });
    assert.equal((await x.holder.value('run')).reason, 'COORDINATOR_ACTIVITY_PRESENT');
  } finally { await x.close(); }
});
test('a hung operation times out the drain, refuses, and reopens admission', async () => {
  const x = await world(); try {
    void x.node.call('hang').catch(() => undefined);
    const o = await x.holder.value('run', { options: { drainMs: 400 } });
    assert.equal(o.status, 'REFUSED'); assert.match(o.reason, /DRAIN_TIMEOUT_OPERATION_MAY_CONTINUE/);
    assert.equal(await x.node.value('admit-probe'), 'admitted');
  } finally { await x.close(); }
});
test('while admission is held: new work is refused before execution and OAuth persistence is deferred out of the snapshot', async () => {
  const x = await world(); try {
    const run = x.holder.value('run', { hooks: { afterFence: 'pause' } }); assert.equal(await x.holder.hook(), 'afterFence');
    const before = await read(path.join(x.paths.state!, 'tasks/store.json'));
    const refused = await x.node.call('task-and-event'); assert.equal(refused.code, 'CHECKPOINT_ADMISSION_CLOSED');
    assert.equal(await read(path.join(x.paths.state!, 'tasks/store.json')), before);
    const registering = x.gateway.value('oauth-register'); await sleep(400);
    x.holder.resume('afterFence'); const o = await run; const clientId = await registering;
    assert.equal(o.status, 'CERTIFIED_SYNTHETIC', o.reason);
    assert.doesNotMatch(await read(backup(x.paths, o.transactionId, 'oauth.json')), new RegExp(clientId));
    assert.match(await read(path.join(x.paths.state!, 'oauth.json')), new RegExp(clientId));
  } finally { await x.close(); }
});
test('an unregistered writer changing state after acknowledgement prevents certification', async () => {
  const x = await world(); try {
    const run = x.holder.value('run', { hooks: { afterFence: 'pause' } }); assert.equal(await x.holder.hook(), 'afterFence');
    x.holder.resume('afterFence');
    await x.node.value('raw-write', { file: 'plans/unregistered.json', text: '{"version":1}' });
    const o = await run;
    // Either the change landed before the manifest (captured and consistent) or after it (refused).
    if (o.status === 'CERTIFIED_SYNTHETIC') assert.equal(await read(backup(x.paths, o.transactionId, 'plans/unregistered.json')), '{"version":1}');
    else notCertified(o);
  } finally { await x.close(); }
});
test('a gateway audit append after acknowledgement changes its generation and refuses', async () => {
  const x = await world(); try {
    const run = x.holder.value('run', { hooks: { beforeCapture: 'pause' } }); assert.equal(await x.holder.hook(), 'beforeCapture');
    await x.gateway.value('audit'); x.holder.resume('beforeCapture');
    const o = await run; notCertified(o); assert.match(o.reason, /WRITER_BOUNDARY_LOST:gateway|SNAPSHOT_GENERATION_CHANGED/);
  } finally { await x.close(); }
});

import net from 'node:net';
import { CheckpointParticipant, NODE_PARTICIPANT_GROUPS, GATEWAY_PARTICIPANT_GROUPS, controlSocket } from '../src/shared/checkpoint.js';
/** A forged participant: a real participant whose replies are tampered with before they leave. */
async function forged(control: string, role: 'node' | 'gateway', state: string, tamper: (reply: any, op: string, socket: net.Socket) => any = r => r, groups?: readonly any[], nodeId = 'macbook-air.local') {
  const real = await fs.realpath(state), st = await fs.stat(real);
  const p = new CheckpointParticipant(role, nodeId, groups ?? (role === 'node' ? NODE_PARTICIPANT_GROUPS : GATEWAY_PARTICIPANT_GROUPS), { path: real, dev: st.dev, ino: st.ino });
  const file = controlSocket(control, role); await fs.rm(file, { force: true });
  const server = net.createServer(socket => {
    let buf = ''; const conn = {};
    socket.on('data', async d => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const req = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
      const r = req.op === 'hello' ? p.hello() : req.op === 'prepare' ? await p.prepare(req, conn) : req.op === 'verify' ? p.verify(req) : p.release(req);
      const out = tamper(r, req.op, socket); if (out !== undefined) socket.write(JSON.stringify(out) + '\n'); } });
    socket.on('close', () => p.connectionClosed(conn)); socket.on('error', () => undefined);
  });
  await new Promise<void>(r => server.listen(file, () => r())); await fs.chmod(file, 0o600);
  return { participant: p, close: () => new Promise<void>(r => server.close(() => r())) };
}
const FORGED_REASONS: Record<string, RegExp> = {
  'ack signed by a different process key': /CHECKPOINT_SIGNATURE_INVALID/, 'ack for another transaction': /WRITER_ACK_INVALID:node/, 'ack with a forged nonce': /WRITER_ACK_INVALID:node/,
  'ack from a stale boot identity': /WRITER_ACK_INVALID:node/, 'ack claiming a different pid': /WRITER_ACK_INVALID:node/, 'ack with work still in flight': /WRITER_ACK_INVALID:node/,
  'verify reporting a changed generation': /WRITER_BOUNDARY_LOST:node/, 'duplicated acknowledgement': /WRITER_PROTOCOL_UNSOLICITED/, 'participant for another node': /WRITER_IDENTITY_MISMATCH:node/,
  'participant claiming groups it does not own': /WRITER_IDENTITY_MISMATCH:node/, 'hello with a substituted public key': /CHECKPOINT_SIGNATURE_INVALID/
};
const resign = (msg: any, p: CheckpointParticipant, change: (payload: any) => void) => { const payload = { ...msg.payload }; change(payload); return (p as any).sign(payload); };
for (const [name, build] of Object.entries({
  'ack signed by a different process key': async (c: string, s: string) => { const other = new CheckpointParticipant('node', 'macbook-air.local', NODE_PARTICIPANT_GROUPS, { path: '/x', dev: 0, ino: 0 }); return forged(c, 'node', s, (r, op) => op === 'prepare' ? { payload: r.payload, signature: (other as any).sign(r.payload).signature } : r); },
  'ack for another transaction': async (c: string, s: string) => { let p: any; const f = await forged(c, 'node', s, (r, op) => op === 'prepare' ? resign(r, p, x => { x.txn = '00000000-0000-4000-8000-000000000000'; }) : r); p = f.participant; return f; },
  'ack with a forged nonce': async (c: string, s: string) => { let p: any; const f = await forged(c, 'node', s, (r, op) => op === 'prepare' ? resign(r, p, x => { x.nonce = 'f'.repeat(64); }) : r); p = f.participant; return f; },
  'ack from a stale boot identity': async (c: string, s: string) => { let p: any; const f = await forged(c, 'node', s, (r, op) => op === 'prepare' ? resign(r, p, x => { x.bootId = '11111111-1111-4111-8111-111111111111'; }) : r); p = f.participant; return f; },
  'ack claiming a different pid': async (c: string, s: string) => { let p: any; const f = await forged(c, 'node', s, (r, op) => op === 'prepare' ? resign(r, p, x => { x.pid = 1; }) : r); p = f.participant; return f; },
  'ack with work still in flight': async (c: string, s: string) => { let p: any; const f = await forged(c, 'node', s, (r, op) => op === 'prepare' ? resign(r, p, x => { x.inFlight = 1; }) : r); p = f.participant; return f; },
  'verify reporting a changed generation': async (c: string, s: string) => { let p: any; const f = await forged(c, 'node', s, (r, op) => op === 'verify' ? resign(r, p, x => { x.generation += 1; }) : r); p = f.participant; return f; },
  'duplicated acknowledgement': async (c: string, s: string) => forged(c, 'node', s, (r, op, sock) => { if (op === 'prepare') sock.write(JSON.stringify(r) + '\n'); return r; }),
  'participant for another node': async (c: string, s: string) => forged(c, 'node', s, r => r, undefined, 'other-node'),
  'participant claiming groups it does not own': async (c: string, s: string) => forged(c, 'node', s, r => r, ['oauth']),
  'hello with a substituted public key': async (c: string, s: string) => { const other = new CheckpointParticipant('node', 'macbook-air.local', NODE_PARTICIPANT_GROUPS, { path: '/x', dev: 0, ino: 0 }); return forged(c, 'node', s, (r, op) => op === 'hello' ? { payload: { ...r.payload, publicKey: other.publicKey }, signature: r.signature } : r); }
})) test(`forged participant refused: ${name}`, async () => {
  const x = await world([]); const fakes: Array<{ close: () => Promise<void> }> = []; try {
    fakes.push(await forged(x.paths.control!, 'gateway', x.paths.state!), await build(x.paths.control!, x.paths.state!));
    const o = await x.holder.value('run', { options: { responseMs: 1_000 } });
    assert.match(o.reason, FORGED_REASONS[name]!);
    notCertified(o); assert.equal(o.installationAuthority, false);
    assert.notEqual((await x.holder.value('reconcile', { txn: o.transactionId })).state, 'CERTIFIED_VERIFIED');
  } finally { for (const f of fakes) await f.close(); await x.close(); }
});
