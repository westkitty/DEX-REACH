import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { executionFingerprint } from '../shared/fingerprint.js';

const execFileAsync = promisify(execFile);

async function run(command: string, args: string[], cwd?: string, maxBuffer = 4 * 1024 * 1024): Promise<string> {
  const { stdout } = await execFileAsync(command, args, { cwd, timeout: 15000, maxBuffer });
  return stdout;
}

export async function repoInfo(cwd: string): Promise<Record<string, unknown>> {
  const root = (await run('git', ['rev-parse', '--show-toplevel'], cwd)).trim();
  const [branch, remote, status, log] = await Promise.all([
    run('git', ['branch', '--show-current'], root),
    run('git', ['remote', '-v'], root),
    run('git', ['status', '--short', '--branch'], root),
    run('git', ['log', '--oneline', '-10'], root)
  ]);
  return { root, branch: branch.trim(), remote: remote.trim(), status: status.trimEnd(), log: log.trimEnd() };
}

export async function adbDevices(): Promise<Record<string, unknown>> {
  try {
    const output = await run('adb', ['devices', '-l']);
    const devices = output.split('\n').slice(1).map(line => line.trim()).filter(Boolean);
    return { available: true, devices };
  } catch (error) {
    return { available: false, error: error instanceof Error ? error.message : String(error), devices: [] };
  }
}

export async function createCheckpoint(cwd: string): Promise<Record<string, unknown>> {
  const root = (await run('git', ['rev-parse', '--show-toplevel'], cwd)).trim();
  const id = `${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomBytes(3).toString('hex')}`;
  const dir = path.join(os.homedir(), '.dex-reach', 'checkpoints', id);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const [patch, status, untrackedRaw] = await Promise.all([
    run('git', ['diff', '--binary', 'HEAD'], root, 16 * 1024 * 1024),
    run('git', ['status', '--short', '--branch'], root),
    run('git', ['ls-files', '--others', '--exclude-standard', '-z'], root)
  ]);
  await fs.writeFile(path.join(dir, 'worktree.patch'), patch, { mode: 0o600 });
  await fs.writeFile(path.join(dir, 'status.txt'), status, { mode: 0o600 });
  const untracked = untrackedRaw.split('\0').filter(Boolean);
  const copied: string[] = [];
  for (const rel of untracked) {
    const source = path.join(root, rel);
    try {
      const stat = await fs.stat(source);
      if (!stat.isFile() || stat.size > 10 * 1024 * 1024) continue;
      const target = path.join(dir, 'untracked', rel);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.copyFile(source, target);
      copied.push(rel);
    } catch {
      // The file may have vanished between Git discovery and copy.
    }
  }
  const metadata = { id, root, createdAt: new Date().toISOString(), untracked: copied };
  await fs.writeFile(path.join(dir, 'metadata.json'), JSON.stringify(metadata, null, 2), { mode: 0o600 });
  return { ...metadata, patchBytes: Buffer.byteLength(patch), checkpointDir: dir };
}

export async function nativeCall(nodeId: string, operation: string, args: Record<string, unknown>): Promise<unknown> {
  switch (operation) {
    case 'dex.fingerprint':
      return executionFingerprint(nodeId, typeof args.cwd === 'string' ? args.cwd : process.cwd());
    case 'dex.repoInfo':
      return repoInfo(typeof args.cwd === 'string' ? args.cwd : process.cwd());
    case 'dex.adbDevices':
      return adbDevices();
    case 'dex.checkpoint':
      return createCheckpoint(typeof args.cwd === 'string' ? args.cwd : process.cwd());
    default:
      throw new Error(`unknown native operation: ${operation}`);
  }
}
