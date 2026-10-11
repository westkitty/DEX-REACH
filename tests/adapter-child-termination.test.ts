import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { terminateAdapterChild } from '../src/node/adapters/desktop-commander.js';

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

test('an adapter child that ignores stdin EOF and SIGTERM is still terminated within its bound', { timeout: 15_000 }, async () => {
  // Ignores SIGTERM and stdin closing, like an adapter busy indexing: only SIGKILL stops it.
  const child = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"], { stdio: ['pipe', 'ignore', 'ignore'] });
  await new Promise(r => child.once('spawn', r)); child.stdin!.end();
  const started = Date.now();
  await terminateAdapterChild(child.pid!, 500);
  assert.equal(alive(child.pid!), false);
  assert.ok(Date.now() - started < 3_000);
});

test('a child that exits on SIGTERM is not escalated, and an absent pid is a no-op', async () => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000);'], { stdio: 'ignore' });
  await new Promise(r => child.once('spawn', r));
  let signal: string | null = null; child.once('exit', (_c, s) => { signal = s; });
  await terminateAdapterChild(child.pid!, 2_000);
  await new Promise(r => setTimeout(r, 50));
  assert.equal(signal, 'SIGTERM');
  await terminateAdapterChild(child.pid!, 100);
});
