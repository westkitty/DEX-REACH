import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ExecutionFingerprint } from './protocol.js';

const execFileAsync = promisify(execFile);

async function capture(command: string, args: string[], cwd?: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(command, args, {
      cwd,
      timeout: 4000,
      maxBuffer: 1024 * 1024
    });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

export async function executionFingerprint(nodeId: string, cwd = process.cwd()): Promise<ExecutionFingerprint> {
  const repo = await capture('git', ['rev-parse', '--show-toplevel'], cwd);
  const branch = repo ? await capture('git', ['branch', '--show-current'], repo) : null;
  const remote = repo ? await capture('git', ['remote', 'get-url', 'origin'], repo) : null;
  const pythonVersion = await capture('python3', ['--version']);
  return {
    nodeId,
    hostname: os.hostname(),
    platform: process.platform,
    arch: process.arch,
    user: os.userInfo().username,
    home: os.homedir(),
    cwd,
    repositoryRoot: repo,
    branch,
    remote,
    nodeVersion: process.version,
    pythonVersion
  };
}
