import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { executionFingerprint } from '../shared/fingerprint.js';
import { canonicalPathForScope, commandGuard, pathAllowed, parseReadonlyCommand } from '../shared/security.js';
import type { ReachProfile } from '../shared/protocol.js';
import { stateDir } from '../shared/local-env.js';
import { describeOperation } from '../shared/operations.js';

const execFileAsync = promisify(execFile);
const SENSITIVE_ENV_KEY = /(^DEX_REACH_(?:NODE_TOKEN|OWNER_PASSWORD|ENV_FILE)$|TOKEN|PASSWORD|PASSWD|SECRET|AUTHORIZATION|COOKIE|API[_-]?KEY|PRIVATE[_-]?KEY|CREDENTIAL)/i;

export function safeChildEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(source).filter(([key, value]) => value !== undefined && !SENSITIVE_ENV_KEY.test(key)));
}

function redactKnownEnvironmentSecrets(text: string, source: NodeJS.ProcessEnv = process.env): string {
  let output = text;
  const values = Object.entries(source)
    .filter(([key, value]) => Boolean(value && value.length >= 4 && SENSITIVE_ENV_KEY.test(key)))
    .map(([, value]) => value!)
    .sort((a, b) => b.length - a.length);
  for (const value of values) output = output.split(value).join('[REDACTED]');
  return output;
}

async function run(command: string, args: string[], cwd?: string, maxBuffer = 4 * 1024 * 1024): Promise<string> {
  const { stdout } = await execFileAsync(command, args, { cwd, timeout: 15000, maxBuffer, env: safeChildEnvironment() });
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
    let mdnsServices: string[] = [];
    try {
      const mdns = await run('adb', ['mdns', 'services']);
      mdnsServices = mdns.split('\n').slice(1).map(line => line.trim()).filter(Boolean);
    } catch {}
    return { available: true, devices, mdnsServices };
  } catch (error) {
    return { available: false, error: error instanceof Error ? error.message : String(error), devices: [] };
  }
}

export async function createCheckpoint(cwd: string): Promise<Record<string, unknown>> {
  const root = (await run('git', ['rev-parse', '--show-toplevel'], cwd)).trim();
  const id = `${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomBytes(3).toString('hex')}`;
  const dir = path.join(stateDir(), 'checkpoints', id);
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

function scopedPath(value: unknown, roots: string[], label: string): string {
  if (typeof value !== 'string' || !path.isAbsolute(value)) throw new Error(`${label} must be an absolute path`);
  const canonical = canonicalPathForScope(value);
  if (!canonical || !pathAllowed(canonical, roots)) throw new Error(`path outside allowed roots: ${path.resolve(value)}`);
  return canonical;
}

export async function nativeReadFile(file: string, maxBytes = 1024 * 1024): Promise<Record<string, unknown>> {
  const stat = await fs.stat(file);
  if (!stat.isFile()) throw new Error('path is not a regular file');
  if (stat.size > maxBytes) throw new Error(`file exceeds native read limit of ${maxBytes} bytes`);
  return { path: file, bytes: stat.size, text: await fs.readFile(file, 'utf8') };
}

export async function nativeWriteFile(file: string, text: string, mode: 'rewrite' | 'append'): Promise<Record<string, unknown>> {
  if (Buffer.byteLength(text) > 2 * 1024 * 1024) throw new Error('native write exceeds 2 MiB limit');
  if (mode === 'append') await fs.appendFile(file, text, { encoding: 'utf8' });
  else await fs.writeFile(file, text, { encoding: 'utf8' });
  const stat = await fs.stat(file);
  return { path: file, bytes: stat.size, mode };
}

// POSIX login shell used for bounded process execution. Override with DEX_REACH_SHELL on a node whose
// shell lives elsewhere. Windows nodes are not supported by this executor yet; fail loudly instead of guessing.
export function nodeShell(): string {
  const configured = process.env.DEX_REACH_SHELL?.trim();
  if (configured) return configured;
  if (process.platform === 'win32') throw new Error('dex.process.run is not supported on win32 nodes yet');
  return process.platform === 'darwin' ? '/bin/zsh' : '/bin/sh';
}

export async function nativeProcess(command: string, cwd: string, profile: ReachProfile, timeoutMs: number, roots: string[] = [cwd]): Promise<Record<string, unknown>> {
  const blocked = commandGuard(command, profile, roots);
  if (blocked) throw new Error(blocked);
  const timeout = Math.max(100, Math.min(timeoutMs, 60_000));
  const readonly = profile === 'read-only' ? parseReadonlyCommand(command, roots) : null;
  const shell = profile === 'read-only' ? null : nodeShell();
  try {
    const { stdout, stderr } = readonly
      ? await execFileAsync(readonly.program, readonly.args, { cwd, timeout, maxBuffer: 2 * 1024 * 1024, env: safeChildEnvironment() })
      : await execFileAsync(shell!, ['-lc', command], { cwd, timeout, maxBuffer: 2 * 1024 * 1024, env: safeChildEnvironment() });
    return { exitCode: 0, stdout: redactKnownEnvironmentSecrets(stdout), stderr: redactKnownEnvironmentSecrets(stderr) };
  } catch (error) {
    const value = error as Error & { code?: number; stdout?: string; stderr?: string };
    return {
      exitCode: typeof value.code === 'number' ? value.code : 1,
      stdout: redactKnownEnvironmentSecrets(value.stdout || ''),
      stderr: redactKnownEnvironmentSecrets(value.stderr || value.message)
    };
  }
}

/**
 * Where an operation runs when the client gives no cwd. The node process is often launched from the
 * DEX checkout, which may sit outside the owner's allowed roots; never default to a disallowed directory.
 */
export function defaultCwd(roots: string[]): string {
  const cwd = process.cwd();
  if (pathAllowed(cwd, roots)) return cwd;
  return roots[0] ?? cwd;
}

export async function nativeCall(nodeId: string, operation: string, args: Record<string, unknown>, roots: string[], profile: ReachProfile): Promise<unknown> {
  // Second, independent READ-ONLY check driven by the operation catalog. Policy already refuses
  // these before routing; this repeats the refusal at the executor so a future caller that reaches
  // nativeCall by another path cannot mutate under a read-only profile.
  const descriptor = describeOperation(operation);
  if (profile === 'read-only' && descriptor && !descriptor.readOnlyAllowed) {
    throw new Error(`read-only profile does not permit ${operation}`);
  }
  switch (operation) {
    case 'dex.fingerprint':
      return executionFingerprint(nodeId, scopedPath(typeof args.cwd === 'string' ? args.cwd : defaultCwd(roots), roots, 'cwd'));
    case 'dex.repoInfo':
      return repoInfo(scopedPath(typeof args.cwd === 'string' ? args.cwd : defaultCwd(roots), roots, 'cwd'));
    case 'dex.adbDevices':
      return adbDevices();
    case 'dex.checkpoint': {
      const cwd = scopedPath(typeof args.cwd === 'string' ? args.cwd : defaultCwd(roots), roots, 'cwd');
      return createCheckpoint(cwd);
    }
    case 'dex.file.read': {
      const file = scopedPath(args.path, roots, 'path');
      return nativeReadFile(file, Number(args.maxBytes || 1024 * 1024));
    }
    case 'dex.file.write': {
      if (profile === 'read-only') throw new Error('read-only profile does not permit native file writes');
      const file = scopedPath(args.path, roots, 'path');
      const mode = args.mode === 'append' ? 'append' : 'rewrite';
      return nativeWriteFile(file, String(args.text ?? ''), mode);
    }
    case 'dex.process.run': {
      const cwd = scopedPath(typeof args.cwd === 'string' ? args.cwd : defaultCwd(roots), roots, 'cwd');
      return nativeProcess(String(args.command || ''), cwd, profile, Number(args.timeoutMs || 15000), roots);
    }
    default:
      throw new Error(`unknown native operation: ${operation}`);
  }
}
