import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

// Runs in its own process: before the repair, an activity-lock timeout during a long command was an
// unhandled rejection that terminated the whole node process mid-task.
const script = `
import { withFileLock } from './src/shared/state-io.ts';
import { activityLockFile } from './src/shared/activity.ts';
import { nativeProcess } from './src/node/native.ts';
import fs from 'node:fs/promises';
await fs.mkdir(process.env.DEX_REACH_STATE_DIR + '/activity', { recursive: true, mode: 0o700 });
let release; const held = new Promise(r => { release = r; }); let ready; const fenced = new Promise(r => { ready = r; });
const holder = withFileLock(activityLockFile(), async () => { ready(); await held; }, { timeoutMs: 1000 });
await fenced;
const run = nativeProcess('sleep 7', process.env.ROOT, 'full-local', 20000, [process.env.ROOT]);
setTimeout(() => release(), 6500);
const result = await run; await holder;
console.log('RESULT ' + JSON.stringify({ exitCode: result.exitCode }));
`;

test('an activity-lock timeout while a command runs does not crash the node process', { timeout: 60_000 }, async () => {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'dex-activity-crash-')));
  try {
    const root = path.join(dir, 'root'); await fs.mkdir(root);
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], { cwd: process.cwd(), env: { ...process.env, DEX_REACH_STATE_DIR: path.join(dir, 'state'), ROOT: root }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = ''; child.stdout.on('data', d => { out += d; }); child.stderr.on('data', d => { err += d; });
    const code = await new Promise<number | null>(r => child.once('exit', r));
    assert.equal(code, 0, err.split('\n').filter(l => /Error|lock/.test(l)).slice(0, 3).join(' | '));
    assert.match(out, /RESULT \{"exitCode":0\}/);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('process activity evidence is still recorded when its lock is contended for longer than 5 s', { timeout: 60_000 }, async () => {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'dex-activity-evidence-')));
  try {
    const root = path.join(dir, 'root'); await fs.mkdir(root);
    const evidence = `
import { withFileLock } from './src/shared/state-io.ts';
import { activityLockFile, listProcessActivities } from './src/shared/activity.ts';
import { nativeProcess } from './src/node/native.ts';
import fs from 'node:fs/promises';
await fs.mkdir(process.env.DEX_REACH_STATE_DIR + '/activity', { recursive: true, mode: 0o700 });
let release; const held = new Promise(r => { release = r; }); let ready; const fenced = new Promise(r => { ready = r; });
const holder = withFileLock(activityLockFile(), async () => { ready(); await held; }, { timeoutMs: 1000 });
await fenced; setTimeout(() => release(), 7000);
const result = await nativeProcess('sleep 9', process.env.ROOT, 'full-local', 30000, [process.env.ROOT]);
await holder;
const rows = await listProcessActivities({ includeFinished: true });
console.log('ROWS ' + JSON.stringify(rows.map(r => r.state)) + ' EXIT ' + result.exitCode);
`;
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', evidence], { cwd: process.cwd(), env: { ...process.env, DEX_REACH_STATE_DIR: path.join(dir, 'state'), ROOT: root }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; child.stdout.on('data', d => { out += d; });
    assert.equal(await new Promise<number | null>(r => child.once('exit', r)), 0);
    assert.match(out, /ROWS \["completed"\] EXIT 0/, 'the start and the finish of the process were both recorded');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
