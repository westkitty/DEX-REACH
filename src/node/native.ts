import { inspectRepository } from './repo-inspection.js';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { executionFingerprint } from '../shared/fingerprint.js';
import { canonicalPathForScope, commandGuard, pathAllowed, parseReadonlyCommand, redactSensitiveText } from '../shared/security.js';
import type { ReachProfile } from '../shared/protocol.js';
import { workspaceSafeOperationRefusal } from '../shared/profiles.js';
import { stateDir } from '../shared/local-env.js';
import { NO_SECRETS, requestedSecretAliases, resolveSecrets, scrubSecretValues, secretInjectionRefusal, type ResolvedSecrets } from '../shared/secrets.js';
import { describeOperation } from '../shared/operations.js';
import { withLockPatience } from '../shared/state-io.js';
import { bindProcessIntent, finishProcessActivity, recordProcessIntent, updateProcessActivity, type ProcessExecutionContext } from '../shared/activity.js';
import { ProcessSignalTerminationError } from '../shared/durable-execution.js';

const execFileAsync = promisify(execFile);

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
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

async function run(command: string, args: string[], cwd?: string, maxBuffer = 4 * 1024 * 1024, signal?: AbortSignal): Promise<string> {
  const { stdout } = await execFileAsync(command, args, { cwd, timeout: 15000, maxBuffer, signal, env: { ...safeChildEnvironment(), ...(signal ? { GIT_OPTIONAL_LOCKS: '0' } : {}) } });
  return stdout;
}

export async function repoInfo(cwd: string, signal?: AbortSignal, maxBuffer = 4 * 1024 * 1024): Promise<Record<string, unknown>> {
  const root = (await run('git', ['rev-parse', '--show-toplevel'], cwd, maxBuffer, signal)).trim();
  const [branch, remote, status, log] = await Promise.all([
    run('git', ['branch', '--show-current'], root, maxBuffer, signal),
    run('git', ['remote', '-v'], root, maxBuffer, signal),
    run('git', ['status', '--short', '--branch'], root, maxBuffer, signal),
    run('git', ['log', '--oneline', '-10'], root, maxBuffer, signal)
  ]);
  return { root, branch: branch.trim(), remote: remote.trim(), status: status.trimEnd(), log: log.trimEnd() };
}

type NativeCommandRunner = (command: string, args: string[]) => Promise<string>;

export async function adbDevices(
  runner: NativeCommandRunner = (command, args) => run(command, args)
): Promise<Record<string, unknown>> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const output = await runner('adb', ['devices', '-l']);
      const devices = output.split('\n').slice(1).map(line => line.trim()).filter(Boolean);
      let mdnsServices: string[] = [];
      try {
        const mdns = await runner('adb', ['mdns', 'services']);
        mdnsServices = mdns.split('\n').slice(1).map(line => line.trim()).filter(Boolean);
      } catch {}
      return { available: true, devices, mdnsServices };
    } catch (error) {
      lastError = error;
      if (attempt < 2) await sleep(250 * (attempt + 1));
    }
  }
  return { available: false, error: lastError instanceof Error ? lastError.message : String(lastError), devices: [] };
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

const ACTIVITY_LOCK_PATIENCE_MS = 30_000;

/**
 * Run a bounded local command.
 *
 * Outcome identity. A child that exits on its own yields its real exit code: `exitCode` is returned
 * and the task layer decides its state. A child that ends by a signal, including the SIGTERM a node
 * shutdown or a process-group stop delivers, or that is stopped by the time limit, has no exit code
 * and an unknown effect. It is rejected with `ProcessSignalTerminationError`, which the task layer
 * records as AMBIGUOUS, never COMPLETED. A child that never started is rejected without any code.
 * No path invents an exit code.
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
  secrets: ResolvedSecrets = NO_SECRETS,
  context: ProcessExecutionContext = {}
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
  if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs)) throw new Error('invalid process time limit');
  const readonly = profile === 'read-only' ? parseReadonlyCommand(command, roots) : null;
  const shell = profile === 'read-only' ? null : nodeShell();
  // safeChildEnvironment strips the node's own credential-shaped variables first; the broker's
  // injection is layered on top of that clean base, so a stored secret cannot be shadowed by, or
  // silently merged with, something inherited from the node process.
  const env = { ...safeChildEnvironment(), ...secrets.env };
  const scrub = (text: string) => scrubSecretValues(redactKnownEnvironmentSecrets(text), secrets.values);
  const program = readonly ? readonly.program : shell!;
  const childArgs = readonly ? readonly.args : ['-lc', command];
  try { if (!(await fs.stat(cwd)).isDirectory()) throw new Error('not a directory'); }
  catch { throw new Error('process could not be started (invalid working directory)'); }
  // This fixed POSIX shim waits on its private stdin. No user command is evaluated until
  // intent and the waiting process identity have been persisted. exec keeps the same PID.
  const barrier = 'exec "$@"\n';
  return withLockPatience(ACTIVITY_LOCK_PATIENCE_MS, async () => {
    const timeout = Math.max(100, Math.min(timeoutMs, 60_000));
    // Keep the resource bound in the closure that allocates the timer, before any launch evidence.
    if (timeout < 100 || timeout > 60_000) throw new Error('invalid process time limit');
    const intent = await recordProcessIntent({ kind: 'native-process', operation: 'dex.process.run', command, cwd, ...context });
    let child!: ReturnType<typeof execFile>;
    let timedOut = false;
    let deadline: ReturnType<typeof setTimeout>;
    const stopAtDeadline = () => { timedOut = true; child.kill(); };
    const outcome = new Promise<{ error: Error | null; stdout: string; stderr: string }>(resolve => {
      child = execFile('/bin/sh', ['-s', '--', program, ...childArgs],
        { cwd, maxBuffer: 2 * 1024 * 1024, env }, (error, stdout, stderr) => { clearTimeout(deadline); resolve({ error, stdout, stderr }); });
      deadline = setTimeout(stopAtDeadline, ACTIVITY_LOCK_PATIENCE_MS + 5000);
    });
    // Observe pipe failures immediately, including a timeout during identity/ledger contention.
    let pipeError: Error | null = null;
    child.stdin?.on('error', error => { pipeError = error; });
    try {
      if (!child.pid) throw new Error('PROCESS_INTENT_NO_PID');
      await bindProcessIntent(intent.id, child.pid);
      if (child.exitCode !== null || child.signalCode !== null || !child.stdin || pipeError) throw new Error('PROCESS_BARRIER_ENDED');
      clearTimeout(deadline!);
      deadline = setTimeout(stopAtDeadline, timeout);
      await new Promise<void>((resolve, reject) => child.stdin!.write(barrier, error => { if (error) reject(error); else { child.stdin!.end(); resolve(); } }));
    } catch {
      // This handle belongs to our child; never signal a PID obtained from the ledger.
      child.kill();
      await outcome;
      throw new ProcessSignalTerminationError(null, 'signal', 'Process launch evidence could not be committed; execution is uncertain and replay is forbidden.');
    }
    const { error, stdout, stderr } = await outcome;
    try {
      if (stdout || stderr) await updateProcessActivity(intent.id, { lastStdoutAt: new Date().toISOString() });
      if (!error) {
        if (!await finishProcessActivity(intent.id, 'completed', 0)) throw new Error('PROCESS_ACTIVITY_MISSING');
        return { exitCode: 0, stdout: scrub(stdout), stderr: scrub(stderr), secretsUsed: secrets.aliases };
      }
      const value = error as Error & { code?: number | string; killed?: boolean; signal?: NodeJS.Signals | null };
      if (typeof value.code === 'number' && !value.signal && !timedOut && !value.killed) {
        if (!await finishProcessActivity(intent.id, 'failed', value.code)) throw new Error('PROCESS_ACTIVITY_MISSING');
        return { exitCode: value.code, stdout: scrub(stdout), stderr: scrub(stderr || value.message), secretsUsed: secrets.aliases };
      }
      if (!await finishProcessActivity(intent.id, timedOut ? 'timed-out' : 'terminated', undefined, value.signal ?? undefined)) throw new Error('PROCESS_ACTIVITY_MISSING');
      throw new ProcessSignalTerminationError(value.signal ?? null, timedOut ? 'time-limit' : 'signal', `Process ${timedOut ? 'exceeded its time limit' : `was terminated by ${value.signal ?? 'an unknown signal'}`}; its effect is unknown, the outcome is uncertain, and replay is forbidden.`);
    } catch (error) {
      if (error instanceof ProcessSignalTerminationError) throw error;
      throw new ProcessSignalTerminationError(null, 'signal', 'Process result evidence could not be committed; its effect is uncertain and replay is forbidden.');
    }
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

export async function nativeCall(nodeId: string, operation: string, args: Record<string, unknown>, roots: string[], profile: ReachProfile, context: ProcessExecutionContext = {}): Promise<unknown> {
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
    case 'dex.repoInfo': {
      const cwd = scopedPath(typeof args.cwd === 'string' ? args.cwd : defaultCwd(roots), roots, 'cwd');
      if (args.inspection === undefined) return repoInfo(cwd);
      return inspectRepository(nodeId, cwd, roots, args.inspection, (directory, signal) => repoInfo(directory, signal, 8192), text => redactKnownEnvironmentSecrets(redactSensitiveText(text)));
    }
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
      return nativeProcess(String(args.command || ''), cwd, profile, (args.timeoutMs === undefined ? 15000 : args.timeoutMs) as number, roots, secrets, context);
    }
    default:
      throw new Error(`unknown native operation: ${operation}`);
  }
}
