import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { executionFingerprint } from '../shared/fingerprint.js';
import { canonicalPathForScope, commandGuard, pathAllowed, parseReadonlyCommand } from '../shared/security.js';
import type { ReachProfile } from '../shared/protocol.js';
import { workspaceSafeOperationRefusal } from '../shared/profiles.js';
import { stateDir } from '../shared/local-env.js';
import { NO_SECRETS, requestedSecretAliases, resolveSecrets, scrubSecretValues, secretInjectionRefusal, type ResolvedSecrets } from '../shared/secrets.js';
import { describeOperation } from '../shared/operations.js';
import { finishProcessActivity, startProcessActivity } from '../shared/activity.js';

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

/**
 * Run a bounded local command.
 *
 * `secrets` is already-resolved material for this one invocation. It is injected into the child's
 * environment and never into the command string: a value on a command line is visible in the
 * process table to every other process on the machine, which would defeat the whole point. Values
 * are scrubbed from stdout and stderr on the way back, best effort and only for a verbatim echo.
 */
export async function nativeProcess(
  command: string,
  cwd: string,
  profile: ReachProfile,
  timeoutMs: number,
  roots: string[] = [cwd],
  secrets: ResolvedSecrets = NO_SECRETS
): Promise<Record<string, unknown>> {
  const blocked = commandGuard(command, profile, roots);
  if (blocked) throw new Error(blocked);
  // The last gate before injection, repeated from nativeCall and the node dispatcher because this is
  // where a value actually enters a child environment. Under read-only the allowlisted grammar
  // includes programs that print their own environment, and READ-ONLY admission never consults a
  // capability grant, so a value must not be here at all rather than relying on output scrubbing,
  // which is best effort and explicitly not a boundary.
  if (secrets.values.length && (profile === 'read-only' || profile === 'workspace-safe')) {
    throw new Error(`the ${profile} profile does not inject stored secrets; it admits only commands that have no use for a credential`);
  }
  const timeout = Math.max(100, Math.min(timeoutMs, 60_000));
  const readonly = profile === 'read-only' ? parseReadonlyCommand(command, roots) : null;
  const shell = profile === 'read-only' ? null : nodeShell();
  // safeChildEnvironment strips the node's own credential-shaped variables first; the broker's
  // injection is layered on top of that clean base, so a stored secret cannot be shadowed by, or
  // silently merged with, something inherited from the node process.
  const env = { ...safeChildEnvironment(), ...secrets.env };
  const scrub = (text: string) => scrubSecretValues(redactKnownEnvironmentSecrets(text), secrets.values);
  const program = readonly ? readonly.program : shell!;
  const childArgs = readonly ? readonly.args : ['-lc', command];
  return new Promise(resolve => {
    const child = execFile(program, childArgs, { cwd, timeout, maxBuffer: 2 * 1024 * 1024, env }, async (error, stdout, stderr) => {
      const activity = await activityPromise.catch(() => null);
      if (!error) {
        if (activity) await finishProcessActivity(activity.id, 'completed', 0).catch(() => undefined);
        resolve({ exitCode: 0, stdout: scrub(stdout), stderr: scrub(stderr), secretsUsed: secrets.aliases });
        return;
      }
      const value = error as Error & { code?: number | string; killed?: boolean; stdout?: string; stderr?: string };
      const exitCode = typeof value.code === 'number' ? value.code : 1;
      if (activity) {
        await finishProcessActivity(activity.id, value.killed ? 'timed-out' : 'failed', exitCode).catch(() => undefined);
      }
      resolve({
        exitCode,
        stdout: scrub(value.stdout || stdout || ''),
        stderr: scrub(value.stderr || stderr || value.message),
        secretsUsed: secrets.aliases
      });
    });
    const activityPromise = child.pid
      ? startProcessActivity({ kind: 'native-process', pid: child.pid, operation: 'dex.process.run', command, cwd })
      : Promise.resolve(null);
  });
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
  // The same repetition for workspace-safe. nativeCall never receives a planned commit or a
  // compatibility call, so no target resolution is needed here.
  const workspaceSafeBlocked = workspaceSafeOperationRefusal(profile, operation);
  if (workspaceSafeBlocked) throw new Error(workspaceSafeBlocked);
  // Repeated here as well as at the node's dispatcher, because this is the function that holds the
  // only call to resolveSecrets: a future caller reaching nativeCall by another path must not be
  // able to inject under a profile or an operation the dispatcher would have refused.
  const secretsBlocked = secretInjectionRefusal(operation, profile, args);
  if (secretsBlocked) throw new Error(secretsBlocked);
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
      // Resolve here and nowhere earlier. This is after final authorization and immediately before
      // the invocation, so a value is in memory for the shortest window the design allows and never
      // while the request is still being authorized, planned, traced or recorded.
      const secrets = await resolveSecrets(nodeId, requestedSecretAliases(args));
      return nativeProcess(String(args.command || ''), cwd, profile, Number(args.timeoutMs || 15000), roots, secrets);
    }
    default:
      throw new Error(`unknown native operation: ${operation}`);
  }
}
