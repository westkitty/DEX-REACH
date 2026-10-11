import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { withQueueCleanup, QueueProofFailure } from './c13-acceptance.js';
import type * as Client from '../../src/coordinator/client.js';
import { coordinatorSocketPath } from '../../src/shared/work-coordinator.js';

/** Exit can precede observation; a lost exit event must never retain a reservation forever. */
export async function waitForCallerExit(caller: ReturnType<typeof spawn>, timeoutMs = 5000): Promise<void> {
  if (caller.exitCode !== null || caller.signalCode !== null) return;
  await new Promise<void>((resolve, reject) => {
    const done = () => { clearTimeout(timer); caller.off('exit', done); resolve(); };
    const timer = setTimeout(() => { caller.off('exit', done); reject(new Error('test caller exit unproven; cleanup requires reconciliation')); }, timeoutMs);
    caller.once('exit', done);
  });
}

/** Run only during authorized acceptance; import the active immutable client, never source fallback. */
export async function installedQueueProof(runtimeRoot: string, dependencies: { client?: typeof Client; socketPath?: string; spawnCaller?: typeof spawn; temporaryDirectory?: string; onRoot?: (root: string) => Promise<void>; onClean?: () => Promise<void> } = {}): Promise<void> {
  if (!(await fs.lstat(dependencies.socketPath ?? coordinatorSocketPath())).isSocket()) throw new Error('installed coordinator socket missing');
  const moduleUrl = pathToFileURL(path.join(runtimeRoot, 'dist/src/coordinator/client.js')).href;
  const client = dependencies.client ?? await import(moduleUrl) as typeof Client;
  const repositoryRoot = await fs.realpath(await fs.mkdtemp(path.join(dependencies.temporaryDirectory ?? os.tmpdir(), 'dex-c13-queue-')));
  let leaseId: string | undefined;
  let caller: ReturnType<typeof spawn> | undefined;
  let interrupted = false;
  const stop = () => { interrupted = true; if (caller && caller.exitCode === null && caller.signalCode === null) caller.kill('SIGTERM'); };
  const checkInterrupted = () => { if (interrupted) throw new Error('queue proof interrupted'); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  try { await withQueueCleanup(async () => {
    checkInterrupted();
    await dependencies.onRoot?.(repositoryRoot);
    const initial = await client.coordinatedStatus({ requireDaemon: true });
    if (initial.leases.length || initial.tickets.length) throw new Error('real work present; queue proof refused');
    checkInterrupted();
    const held = await client.coordinatedAcquire({ executor: 'human', access: 'mutate', workload: 'light', repositoryRoot, phase: 'c13-queue-proof' }, { requireDaemon: true });
    if (held.status !== 'acquired') {
      if (held.status === 'queued') await client.coordinatedCancel(held.ticket.id, { requireDaemon: true });
      throw new Error('bounded test lease not admitted');
    }
    leaseId = held.lease.id;
    checkInterrupted();
    const source = `import {coordinatedAcquire} from ${JSON.stringify(moduleUrl)};
      const result = await coordinatedAcquire({executor:'human',access:'mutate',workload:'light',repositoryRoot:${JSON.stringify(repositoryRoot)},phase:'c13-queue-proof'}, {requireDaemon:true});
      console.log(JSON.stringify({pid:process.pid,result})); await new Promise(r=>process.stdin.once('data',r));`;
    caller = (dependencies.spawnCaller ?? spawn)(process.execPath, ['--input-type=module', '-e', source], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, NODE_OPTIONS: '' } });
    let output = '';
    const returned = await new Promise<{ pid: number; result: { status: string; ticket?: { id: string } } }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('queue caller timeout; reconcile scoped reservations')), 10000);
      caller!.stdout!.on('data', chunk => { output += chunk; if (output.includes('\n')) { clearTimeout(timer); try { resolve(JSON.parse(output)); } catch (error) { reject(error); } } });
      caller!.once('error', error => { clearTimeout(timer); reject(error); });
      caller!.once('exit', () => { clearTimeout(timer); reject(new Error('queue caller exited before observation')); });
    });
    checkInterrupted();
    if (returned.result.status !== 'queued') throw new Error('conflicting caller was not queued');
    const ticket = (await client.coordinatedStatus({ requireDaemon: true })).tickets.find(t => t.id === returned.result.ticket?.id);
    checkInterrupted();
    if (!ticket || ticket.pid !== caller.pid || ticket.pid !== returned.pid || ticket.pidIsWorkload !== false) throw new Error('queued ticket does not belong to caller or changed workload semantics');
    const exited = waitForCallerExit(caller);
    caller.stdin!.end('\n');
    await exited;
    checkInterrupted();
    const after = (await client.coordinatedStatus({ requireDaemon: true })).tickets.find(t => t.id === ticket.id);
    // Tickets survive caller exit until the existing bounded stale interval; no immediate eviction.
    if (!after || after.pid !== returned.pid || after.pidIsWorkload !== false) throw new Error('ticket persistence after caller exit regressed');
  }, async () => {
    if (caller && caller.exitCode === null && caller.signalCode === null) {
      const exited = waitForCallerExit(caller);
      caller.kill('SIGKILL'); await exited;
    }
    const current = await client.coordinatedStatus({ requireDaemon: true });
    for (const ticket of current.tickets.filter(t => t.repositoryRoot === repositoryRoot)) await client.coordinatedCancel(ticket.id, { requireDaemon: true });
    // A lost acquire response may have created a lease: reconcile only this unique temporary root.
    for (const lease of current.leases.filter(l => l.repositoryRoot === repositoryRoot)) {
      const released = await client.coordinatedRelease(lease.id, { pid: lease.pid, requireDaemon: true });
      if (!released.released) throw new Error(`test lease cleanup refused: ${lease.id}`);
    }
    const final = await client.coordinatedStatus({ requireDaemon: true });
    if (final.tickets.some(t => t.repositoryRoot === repositoryRoot) || final.leases.some(l => l.repositoryRoot === repositoryRoot) || (leaseId && final.leases.some(l => l.id === leaseId))) throw new Error('orphaned test reservation; owner reconciliation required');
    await fs.rmdir(repositoryRoot);
    await dependencies.onClean?.();
  }); } catch (error) {
    if (error instanceof QueueProofFailure && error.cleanupFailed) error.repositoryRoot = repositoryRoot;
    throw error;
  } finally { process.off('SIGINT', stop); process.off('SIGTERM', stop); }
}
