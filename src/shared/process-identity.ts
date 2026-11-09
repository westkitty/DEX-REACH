import fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';

/**
 * Process identity for activity and orphan evidence (ADR-0001 identity rules).
 *
 * `kill(pid, 0)` proves only that some process currently holds that PID. A PID can be reused, so a
 * bare PID is never proof that the process we started is still running, and a live PID is never
 * proof that its effect succeeded. Identity binds a PID to the platform start time of the process
 * that was observed at spawn: the Linux boot id plus the kernel start tick from /proc, or the macOS
 * `ps lstart` value. Two observations agree only if both the start token and the PID match.
 *
 * Versioned and migration-safe: records written before identity existed have no identity and are
 * UNVERIFIABLE, which fails closed. An identity with an unknown version or shape is invalid and is
 * refused, never silently upgraded or ignored.
 */

const execFileAsync = promisify(execFile);

export const PROCESS_IDENTITY_VERSION = 1 as const;
export const PROCESS_IDENTITY_PLATFORMS = ['linux', 'darwin'] as const;
export type ProcessIdentityPlatform = (typeof PROCESS_IDENTITY_PLATFORMS)[number];

export type ProcessIdentity = {
  version: typeof PROCESS_IDENTITY_VERSION;
  pid: number;
  platform: ProcessIdentityPlatform;
  startToken: string;
  capturedAt: string;
};

/**
 * SAME: the PID exists and its start token matches the recorded identity.
 * GONE: the PID does not exist.
 * REUSED: the PID exists but its start token differs, so the recorded process has ended and the PID
 *         now belongs to a different process. The recorded process is not running.
 * UNVERIFIABLE: no identity, a contradictory identity, or a start token that cannot be read.
 *         Liveness is unknown; callers must fail closed and never treat it as dead or as proof.
 */
export type ProcessIdentityVerdict = 'SAME' | 'GONE' | 'REUSED' | 'UNVERIFIABLE';

const START_TOKEN_PATTERN = /^[\x20-\x7e]{1,200}$/;

export function pidExists(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the PID exists but belongs to another user: it exists, so it is not GONE.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Reads the platform start identity of a live process, or null when it cannot be read. */
export async function readStartToken(pid: number, platform: string = process.platform): Promise<string | null> {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    if (platform === 'linux') {
      const stat = await fs.readFile(`/proc/${pid}/stat`, 'utf8');
      // Fields after the parenthesised command name; starttime is field 22 of the whole record.
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      const starttime = fields[19];
      const bootId = (await fs.readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim();
      if (!starttime || !/^\d+$/.test(starttime) || !bootId) return null;
      return `${bootId}:${starttime}`;
    }
    if (platform === 'darwin') {
      const { stdout } = await execFileAsync('ps', ['-o', 'lstart=', '-p', String(pid)], { env: { ...process.env, LC_ALL: 'C' }, timeout: 5000 });
      const value = stdout.trim();
      return value ? `lstart:${value}` : null;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * A start observation: the same start token readStartToken produces, plus (macOS only) the process
 * age from `ps etime`. Age lets a caller compare the process birth against a recorded claim time
 * without parsing a local-time `lstart` string, which is ambiguous across DST and time zones.
 */
export type ProcessStartObservation = { startToken: string; elapsedSeconds?: number };

/** `ps` elapsed time `[[dd-]hh:]mm:ss` to seconds; undefined when it cannot be read exactly. */
function parseEtime(raw: string): number | undefined {
  const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(raw);
  if (!match) return undefined;
  const [, days, hours, minutes, seconds] = match;
  if (Number(minutes) > 59 || Number(seconds) > 59 || (hours !== undefined && Number(hours) > 23)) return undefined;
  return ((Number(days ?? 0) * 24 + Number(hours ?? 0)) * 60 + Number(minutes)) * 60 + Number(seconds);
}

/** Parses `ps -o etime=,lstart= -p <pid>` output. The token is byte-identical to readStartToken's. */
export function parseDarwinStartObservation(stdout: string): ProcessStartObservation | null {
  const match = /^\s*(\S+)\s+(\S.*?)\s*$/.exec(stdout.replace(/\n+$/, ''));
  if (!match || match[0].includes('\n')) return null;
  const startToken = `lstart:${match[2]}`;
  if (!START_TOKEN_PATTERN.test(startToken)) return null;
  const elapsedSeconds = parseEtime(match[1]!);
  return elapsedSeconds === undefined ? { startToken } : { startToken, elapsedSeconds };
}

function linuxStartToken(stat: string, bootIdRaw: string): string | null {
  const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
  const starttime = fields[19];
  const bootId = bootIdRaw.trim();
  if (!starttime || !/^\d+$/.test(starttime) || !bootId) return null;
  const token = `${bootId}:${starttime}`;
  return START_TOKEN_PATTERN.test(token) ? token : null;
}

/** Synchronous start observation for lock-held coordination checks. Null when it cannot be read. */
export function observeProcessStartSync(pid: number, platform: string = process.platform): ProcessStartObservation | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    if (platform === 'linux') {
      const token = linuxStartToken(readFileSync(`/proc/${pid}/stat`, 'utf8'), readFileSync('/proc/sys/kernel/random/boot_id', 'utf8'));
      return token ? { startToken: token } : null;
    }
    if (platform === 'darwin') {
      const stdout = execFileSync('ps', ['-o', 'etime=,lstart=', '-p', String(pid)], { env: { ...process.env, LC_ALL: 'C' }, timeout: 5000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      return parseDarwinStartObservation(stdout);
    }
    return null;
  } catch {
    return null;
  }
}

/** Asynchronous start observation, used outside coordination locks. Null when it cannot be read. */
export async function observeProcessStart(pid: number, platform: string = process.platform): Promise<ProcessStartObservation | null> {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    if (platform === 'linux') {
      const token = linuxStartToken(await fs.readFile(`/proc/${pid}/stat`, 'utf8'), await fs.readFile('/proc/sys/kernel/random/boot_id', 'utf8'));
      return token ? { startToken: token } : null;
    }
    if (platform === 'darwin') {
      const { stdout } = await execFileAsync('ps', ['-o', 'etime=,lstart=', '-p', String(pid)], { env: { ...process.env, LC_ALL: 'C' }, timeout: 5000 });
      return parseDarwinStartObservation(stdout);
    }
    return null;
  } catch {
    return null;
  }
}

/** Captures identity for a process that was just spawned. Returns null when the platform cannot prove it. */
export async function captureProcessIdentity(pid: number, now = new Date()): Promise<ProcessIdentity | null> {
  const platform = process.platform;
  if (!(PROCESS_IDENTITY_PLATFORMS as readonly string[]).includes(platform)) return null;
  const startToken = await readStartToken(pid, platform);
  if (!startToken || !START_TOKEN_PATTERN.test(startToken)) return null;
  return { version: PROCESS_IDENTITY_VERSION, pid, platform: platform as ProcessIdentityPlatform, startToken, capturedAt: now.toISOString() };
}

/** Validates a stored identity. Absent is allowed (legacy record). Present but malformed or unknown-version is refused. */
export function parseProcessIdentity(raw: unknown): ProcessIdentity | undefined | null {
  if (raw === undefined) return undefined;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  if (value.version !== PROCESS_IDENTITY_VERSION) return null;
  if (!Number.isInteger(value.pid) || Number(value.pid) <= 0) return null;
  if (!(PROCESS_IDENTITY_PLATFORMS as readonly string[]).includes(String(value.platform))) return null;
  if (typeof value.startToken !== 'string' || !START_TOKEN_PATTERN.test(value.startToken)) return null;
  if (typeof value.capturedAt !== 'string' || !Number.isFinite(Date.parse(value.capturedAt))) return null;
  return value as ProcessIdentity;
}

/**
 * Decides what a recorded identity says about a PID now. The identity must name the same PID and
 * platform, and the start token must be read again and match exactly.
 */
export async function verifyProcessIdentity(identity: ProcessIdentity | undefined, pid: number): Promise<ProcessIdentityVerdict> {
  if (!pidExists(pid)) return 'GONE';
  if (!identity) return 'UNVERIFIABLE';
  if (identity.pid !== pid || identity.platform !== process.platform) return 'UNVERIFIABLE';
  const current = await readStartToken(pid);
  if (current === null) return 'UNVERIFIABLE';
  return current === identity.startToken ? 'SAME' : 'REUSED';
}

/**
 * Immutable bindings: an identity, once recorded, never changes. A later record that differs in any
 * binding field is refused rather than merged.
 */
export function assertIdentityBindingUnchanged(before: ProcessIdentity | undefined, after: ProcessIdentity | undefined): void {
  if (before === undefined) return;
  if (!after || before.pid !== after.pid || before.platform !== after.platform || before.startToken !== after.startToken || before.capturedAt !== after.capturedAt || before.version !== after.version) {
    throw new Error('process identity is an immutable binding and cannot be changed');
  }
}
