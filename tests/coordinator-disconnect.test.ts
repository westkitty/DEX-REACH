import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { coordinatorSocketPath } from '../src/shared/work-coordinator.js';

async function socketCall(socketPath: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ path: socketPath });
    let response = '';
    socket.setEncoding('utf8');
    socket.once('error', reject);
    socket.on('data', chunk => { response += chunk; });
    socket.once('end', () => {
      try { resolve(JSON.parse(response)); } catch (error) { reject(error); }
    });
    socket.once('connect', () => socket.write('{"version":1,"command":"status"}\n'));
  });
}

test('a delayed reply after client close and EPIPE stays connection-scoped; daemon serves next request', async t => {
  for (const closeMode of ['graceful', 'abrupt'] as const) await t.test(closeMode, async () => {
    const state = await fs.mkdtemp(path.join(os.tmpdir(), 'dex-coordinator-disconnect-'));
    const previousState = process.env.DEX_REACH_STATE_DIR;
    process.env.DEX_REACH_STATE_DIR = state;
    const { NODE_OPTIONS: _testRunnerOptions, ...childEnv } = process.env;
    const script = `
      import { EventEmitter } from 'node:events';
      import { startCoordinatorServer, handleCoordinatorSocket } from './src/coordinator/main.ts';
      let release;
      const gate = new Promise(resolve => { release = resolve; });
      const server = await startCoordinatorServer(async () => {
        process.send({ kind: 'real-request-started' });
        await gate;
        process.send({ kind: 'real-request-finished' });
        return { healthy: true };
      });
      server.on('connection', socket => socket.once('close', () => process.send({ kind: 'peer-closed' })));
      process.on('message', message => { if (message?.kind === 'release') release(); });
      process.send({ kind: 'ready' });

      class EpipeSocket extends EventEmitter {
        destroyed = false; writable = true; writableEnded = false;
        setEncoding() { return this; }
        destroy() { this.destroyed = true; this.emit('close'); return this; }
        end() {
          process.send({ kind: 'epipe-write-attempted' });
          this.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));
          this.writableEnded = true;
          return this;
        }
      }
      process.on('message', async message => {
        if (message?.kind !== 'run-epipe') return;
        const fake = new EpipeSocket();
        handleCoordinatorSocket(fake, async () => {
          process.send({ kind: 'epipe-request-started' });
          await new Promise(resolve => process.once('message', item => { if (item?.kind === 'release-epipe') resolve(); }));
          return { healthy: true };
        });
        fake.emit('data', Buffer.from('{"version":1,"command":"status"}\\n'));
      });
    `;
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
      cwd: process.cwd(), env: { ...childEnv, DEX_REACH_STATE_DIR: state }, stdio: ['ignore', 'ignore', 'pipe', 'ipc']
    });
    let stderr = '';
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', chunk => { stderr += chunk; });
    const messages: Array<{ kind: string }> = [];
    child.on('message', message => messages.push(message as { kind: string }));
    const waitFor = (kind: string): Promise<void> => {
      if (messages.some(message => message.kind === kind)) return Promise.resolve();
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error(`timed out waiting for ${kind}: ${stderr}`)), 60_000);
        const onMessage = (message: unknown) => {
          if ((message as { kind?: string }).kind !== kind) return;
          clearTimeout(timeout);
          child.off('message', onMessage);
          resolve();
        };
        child.on('message', onMessage);
        child.once('exit', code => {
          clearTimeout(timeout);
          child.off('message', onMessage);
          reject(new Error(`coordinator exited (${code}) before ${kind}: ${stderr}`));
        });
      });
    };
    try {
      await waitFor('ready');
      const delayed = net.createConnection({ path: coordinatorSocketPath() });
      await new Promise<void>((resolve, reject) => {
        delayed.once('error', reject);
        delayed.once('connect', () => delayed.write('{"version":1,"command":"status"}\n', () => resolve()));
      });
      await waitFor('real-request-started');
      if (closeMode === 'graceful') delayed.end(); else delayed.destroy();
      await waitFor('peer-closed');
      child.send({ kind: 'release' });
      await waitFor('real-request-finished');

      // Force the historical Socket error deterministically at the response-write seam after the
      // real peer-disconnect case. This avoids making EPIPE depend on kernel event timing.
      child.send({ kind: 'run-epipe' });
      await waitFor('epipe-request-started');
      child.send({ kind: 'release-epipe' });
      await waitFor('epipe-write-attempted');
      assert.equal(child.exitCode, null, `coordinator exited after connection-scoped EPIPE: ${stderr}`);
      assert.deepEqual(await socketCall(coordinatorSocketPath()), { ok: true, value: { healthy: true } });
      assert.equal(child.exitCode, null);
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
        child.kill('SIGTERM');
        await exited;
      }
      await fs.rm(state, { recursive: true, force: true });
      if (previousState === undefined) delete process.env.DEX_REACH_STATE_DIR; else process.env.DEX_REACH_STATE_DIR = previousState;
    }
  });
});
