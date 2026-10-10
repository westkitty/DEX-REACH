import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { CapacityProfile } from './capacity-profile.js';

const execFileAsync = promisify(execFile);
const GIB = 1024 ** 3;

export type MemoryPressure = 'healthy' | 'warning' | 'critical' | 'unknown';
export type CpuPressure = 'healthy' | 'busy' | 'saturated' | 'unknown';
export type ThermalPressure = 'healthy' | 'limited' | 'unknown';

export type WorkloadClass = 'light' | 'medium' | 'heavy';
export type AccessClass = 'read' | 'mutate' | 'exclusive';

/** Raw host measurement. Every field is observed or explicitly unknown; nothing is assumed. */
export type HostProbe = {
  platform: NodeJS.Platform;
  physicalMemoryBytes: number;
  logicalCpuCount: number;
  loadAverage1m: number | null;
  memory: MemoryPressure;
  thermal: ThermalPressure;
  swapUsedBytes: number | null;
  probeErrors: string[];
};

export type ObservedWorkloads = {
  /** Substantial non-DEX jobs with no coordination lease. */
  uncoordinatedHeavy: number;
  /** Long-running DEX gateway/node services. They consume host resources but are not coding jobs. */
  dexServices: number;
  /** Ephemeral, local-only explanations for the current classification; command arguments are never retained. */
  uncoordinatedDetails?: ObservedProcess[];
  dexServiceDetails?: ObservedProcess[];
  /** 'unknown' when the process table could not be read: absence of rows is then not evidence of capacity. */
  processObservation?: 'observed' | 'unknown';
};

export type ObservedProcess = {
  pid: number;
  pids: number[];
  cpu: number;
  mem: number;
  processLabel: string;
  matchedBy: 'cpu' | 'memory';
};

export type MachineCapacity = {
  physicalMemoryBytes: number;
  logicalCpuCount: number;

  substantiveSlots: number;
  heavySlots: number;
  profile: CapacityProfile;
  interactiveReady: boolean;

  livePressure: {
    memory: MemoryPressure;
    cpu: CpuPressure;
    thermal: ThermalPressure;
  };

  activeCoordinated: number;
  activeHeavy: number;
  observedUncoordinatedHeavy: number;

  canAdmit: boolean;
  reasons: string[];
};

export type CapacityCounts = {
  activeSubstantive: number;
  activeHeavy: number;
  observedUncoordinatedHeavy: number;
  /** Omitted means observed (historical callers). 'unknown' queues substantive work conservatively. */
  processObservation?: 'observed' | 'unknown';
};

/**
 * Memory-derived substantive ceiling. These are ceilings, not targets: idle capacity is not a
 * reason to run more jobs. Machines at or under 12 GiB get exactly one substantive job.
 */
export function memorySubstantiveSlots(physicalMemoryBytes: number): number {
  const gib = physicalMemoryBytes / GIB;
  if (!Number.isFinite(gib) || gib <= 0) return 1;
  if (gib <= 12) return 1;
  if (gib <= 24) return 2;
  if (gib <= 48) return 3;
  return Math.min(4, Math.floor(gib / 12));
}

export function memoryHeavySlots(physicalMemoryBytes: number): number {
  const gib = physicalMemoryBytes / GIB;
  if (!Number.isFinite(gib) || gib <= 0) return 1;
  if (gib <= 24) return 1;
  if (gib <= 48) return 2;
  return Math.min(2, Math.floor(gib / 20));
}

/** CPU-derived ceiling. The smaller of the memory- and CPU-derived limits always wins. */
export function cpuSubstantiveSlots(logicalCpuCount: number): number {
  if (!Number.isFinite(logicalCpuCount) || logicalCpuCount <= 0) return 1;
  return Math.max(1, Math.floor(logicalCpuCount / 4));
}

export function substantiveSlotsFor(physicalMemoryBytes: number, logicalCpuCount: number): number {
  return Math.max(1, Math.min(memorySubstantiveSlots(physicalMemoryBytes), cpuSubstantiveSlots(logicalCpuCount)));
}

/** Interactive mode expands only a one-slot host after the owner-selected sustained-health gate. */
export function substantiveSlotsForProfile(
  physicalMemoryBytes: number,
  logicalCpuCount: number,
  profile: CapacityProfile = 'conservative',
  interactiveReady = false
): number {
  const base = substantiveSlotsFor(physicalMemoryBytes, logicalCpuCount);
  if (profile === 'interactive' && interactiveReady && base === 1 && physicalMemoryBytes >= 8 * GIB && logicalCpuCount >= 4) return 2;
  return base;
}

export function heavySlotsFor(physicalMemoryBytes: number, logicalCpuCount: number): number {
  return Math.max(1, Math.min(memoryHeavySlots(physicalMemoryBytes), substantiveSlotsFor(physicalMemoryBytes, logicalCpuCount)));
}

export function classifyCpuPressure(loadAverage1m: number | null, logicalCpuCount: number): CpuPressure {
  if (loadAverage1m === null || !Number.isFinite(loadAverage1m) || loadAverage1m < 0) return 'unknown';
  if (!Number.isFinite(logicalCpuCount) || logicalCpuCount <= 0) return 'unknown';
  if (loadAverage1m >= logicalCpuCount) return 'saturated';
  if (loadAverage1m >= logicalCpuCount * 0.75) return 'busy';
  return 'healthy';
}

/** A job is substantive unless it is passive light inspection that cannot interfere with a repository. */
export function isSubstantive(workload: WorkloadClass, access: AccessClass): boolean {
  return workload !== 'light' || access !== 'read';
}

/**
 * Deterministic, inspectable admission decision. This answers "can this run NOW?" only; it never
 * answers "is this ALLOWED?" (DEX-INV-022). Unknown pressure is treated conservatively for heavy work.
 */
export function evaluateCapacity(
  probe: Pick<HostProbe, 'physicalMemoryBytes' | 'logicalCpuCount' | 'loadAverage1m' | 'memory' | 'thermal'>,
  counts: CapacityCounts,
  request?: { workload: WorkloadClass; access: AccessClass; profile?: CapacityProfile; interactiveReady?: boolean }
): MachineCapacity {
  const profile = request?.profile ?? 'conservative';
  const interactiveReady = request?.interactiveReady ?? false;
  const substantiveSlots = substantiveSlotsForProfile(probe.physicalMemoryBytes, probe.logicalCpuCount, profile, interactiveReady);
  const heavySlots = heavySlotsFor(probe.physicalMemoryBytes, probe.logicalCpuCount);
  const cpu = classifyCpuPressure(probe.loadAverage1m, probe.logicalCpuCount);
  const reasons: string[] = [];

  const workload = request?.workload ?? 'medium';
  const access = request?.access ?? 'read';
  const substantive = isSubstantive(workload, access);
  const heavy = workload === 'heavy';

  // Passive light inspection never competes for a substantive slot.
  if (!substantive) {
    return {
      physicalMemoryBytes: probe.physicalMemoryBytes,
      logicalCpuCount: probe.logicalCpuCount,
      substantiveSlots,
      heavySlots,
      profile,
      interactiveReady,
      livePressure: { memory: probe.memory, cpu, thermal: probe.thermal },
      activeCoordinated: counts.activeSubstantive,
      activeHeavy: counts.activeHeavy,
      observedUncoordinatedHeavy: counts.observedUncoordinatedHeavy,
      canAdmit: true,
      reasons: ['light read-only inspection does not consume a substantive slot']
    };
  }

  // An unreadable process table proves nothing about competing work: queue rather than assume an idle host.
  if (counts.processObservation === 'unknown') reasons.push('process observation unavailable; substantive work queues conservatively');
  const usedSubstantive = counts.activeSubstantive + counts.observedUncoordinatedHeavy;
  if (usedSubstantive >= substantiveSlots) {
    reasons.push(
      `substantive slots exhausted (${usedSubstantive}/${substantiveSlots}` +
        (counts.observedUncoordinatedHeavy > 0 ? `, including ${counts.observedUncoordinatedHeavy} uncoordinated heavy workload(s)` : '') +
        ')'
    );
    if (profile === 'interactive' && !interactiveReady) reasons.push('interactive profile is warming; sustained healthy observations are required');
  }
  if (heavy && counts.activeHeavy >= heavySlots) {
    reasons.push(`heavy slots exhausted (${counts.activeHeavy}/${heavySlots})`);
  }

  if (probe.memory === 'critical') reasons.push('memory pressure critical');
  else if (probe.memory === 'warning' && heavy) reasons.push('memory pressure warning; heavy work queues');
  else if (probe.memory === 'unknown') reasons.push('memory pressure unknown; substantive work queues conservatively');

  // Memory and CPU are the primary and secondary limiters, so an unmeasured reading of either
  // queues substantive work. Thermal has no portable signal at all (Linux reports none), so an
  // unknown thermal reading is not treated as pressure; otherwise work could never run off macOS.
  if (probe.thermal === 'limited') reasons.push('thermal limiting observed; substantive work queues');
  if (cpu === 'saturated') reasons.push('CPU saturated (1m load >= logical CPUs)');
  else if (cpu === 'busy' && heavy) reasons.push('CPU busy (1m load >= 75% of logical CPUs)');
  else if (cpu === 'unknown') reasons.push('CPU load unknown; substantive work queues conservatively');

  if (!reasons.length) reasons.push('capacity available');

  return {
    physicalMemoryBytes: probe.physicalMemoryBytes,
    logicalCpuCount: probe.logicalCpuCount,
    substantiveSlots,
    heavySlots,
    profile,
    interactiveReady,
    livePressure: { memory: probe.memory, cpu, thermal: probe.thermal },
    activeCoordinated: counts.activeSubstantive,
    activeHeavy: counts.activeHeavy,
    observedUncoordinatedHeavy: counts.observedUncoordinatedHeavy,
    canAdmit: reasons.length === 1 && reasons[0] === 'capacity available',
    reasons
  };
}

// ---------------------------------------------------------------------------
// Platform probe parsers. Pure string -> value so they can be tested against
// recorded fixtures rather than only against whatever host happens to run them.
// ---------------------------------------------------------------------------

/** macOS `sysctl -n kern.memorystatus_vm_pressure_level`: 1 normal, 2 warning, 4 critical. */
export function parseDarwinPressureLevel(raw: string): MemoryPressure {
  const value = Number.parseInt(raw.trim(), 10);
  if (value === 1) return 'healthy';
  if (value === 2) return 'warning';
  if (value === 4) return 'critical';
  return 'unknown';
}

/** macOS `memory_pressure` free-percentage line, used when the sysctl level is unavailable. */
export function parseDarwinMemoryPressure(raw: string): MemoryPressure {
  const match = /System-wide memory free percentage:\s*(\d+)%/i.exec(raw);
  if (!match) return 'unknown';
  const free = Number.parseInt(match[1]!, 10);
  if (!Number.isFinite(free)) return 'unknown';
  if (free < 10) return 'critical';
  if (free < 20) return 'warning';
  return 'healthy';
}

/** macOS `sysctl -n vm.swapusage` -> bytes used, or null when unparseable. */
export function parseDarwinSwapUsage(raw: string): number | null {
  const match = /used\s*=\s*([\d.]+)([KMGT])/i.exec(raw);
  if (!match) return null;
  const value = Number.parseFloat(match[1]!);
  if (!Number.isFinite(value)) return null;
  const scale: Record<string, number> = { K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4 };
  return Math.round(value * (scale[match[2]!.toUpperCase()] ?? 1));
}

/** macOS `pmset -g therm`. A CPU speed limit below 100 means the host is being throttled. */
export function parseDarwinThermal(raw: string): ThermalPressure {
  const match = /CPU_Speed_Limit\s*=\s*(\d+)/i.exec(raw);
  if (!match) return 'unknown';
  const limit = Number.parseInt(match[1]!, 10);
  if (!Number.isFinite(limit)) return 'unknown';
  return limit >= 100 ? 'healthy' : 'limited';
}

/** Linux PSI `/proc/pressure/memory`. avg10 is the share of the last 10s spent stalled on memory. */
export function parseLinuxMemoryPsi(raw: string): MemoryPressure {
  const match = /^some\s+avg10=([\d.]+)/m.exec(raw);
  if (!match) return 'unknown';
  const avg10 = Number.parseFloat(match[1]!);
  if (!Number.isFinite(avg10)) return 'unknown';
  if (avg10 >= 20) return 'critical';
  if (avg10 >= 5) return 'warning';
  return 'healthy';
}

/** Linux `/proc/meminfo` fallback when PSI is not mounted. */
export function parseLinuxMemInfo(raw: string): { memory: MemoryPressure; swapUsedBytes: number | null } {
  const field = (name: string): number | null => {
    const match = new RegExp(`^${name}:\\s+(\\d+)\\s+kB`, 'm').exec(raw);
    return match ? Number.parseInt(match[1]!, 10) * 1024 : null;
  };
  const total = field('MemTotal');
  const available = field('MemAvailable');
  const swapTotal = field('SwapTotal');
  const swapFree = field('SwapFree');
  const swapUsedBytes = swapTotal !== null && swapFree !== null ? swapTotal - swapFree : null;

  if (total === null || available === null || total <= 0) return { memory: 'unknown', swapUsedBytes };
  const freeRatio = available / total;
  if (freeRatio < 0.1) return { memory: 'critical', swapUsedBytes };
  if (freeRatio < 0.2) return { memory: 'warning', swapUsedBytes };
  return { memory: 'healthy', swapUsedBytes };
}

async function runProbe(file: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(file, args, { timeout: 1000, maxBuffer: 1024 * 1024 });
    return stdout;
  } catch {
    return null;
  }
}

async function readIfPresent(file: string): Promise<string | null> {
  try {
    return await fs.readFile(file, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Measure the host this process is actually running on. Never hard-codes a machine specification.
 * A probe that cannot run leaves its dimension 'unknown', which makes heavy admission conservative
 * rather than optimistic.
 */
export async function probeHost(): Promise<HostProbe> {
  const probeErrors: string[] = [];
  const platform = process.platform;
  const physicalMemoryBytes = os.totalmem();
  const logicalCpuCount = os.cpus().length || 1;
  const load = os.loadavg();
  // Windows reports a constant 0 load average; treat that as unmeasured rather than idle.
  const loadAverage1m = platform === 'win32' || !Number.isFinite(load[0]!) ? null : load[0]!;

  let memory: MemoryPressure = 'unknown';
  let thermal: ThermalPressure = 'unknown';
  let swapUsedBytes: number | null = null;

  if (platform === 'darwin') {
    // Independent probes run together; an unavailable optional thermal signal cannot
    // age healthy capacity evidence beyond the admission freshness window.
    const [level, swap, therm] = await Promise.all([
      runProbe('sysctl', ['-n', 'kern.memorystatus_vm_pressure_level']),
      runProbe('sysctl', ['-n', 'vm.swapusage']),
      runProbe('pmset', ['-g', 'therm'])
    ]);
    if (level) memory = parseDarwinPressureLevel(level);
    if (memory === 'unknown') {
      const pressure = await runProbe('memory_pressure', []);
      if (pressure) memory = parseDarwinMemoryPressure(pressure);
      else probeErrors.push('memory_pressure unavailable');
    }
    if (swap) swapUsedBytes = parseDarwinSwapUsage(swap);
    thermal = therm ? parseDarwinThermal(therm) : 'unknown';
  } else if (platform === 'linux') {
    const psi = await readIfPresent('/proc/pressure/memory');
    if (psi) memory = parseLinuxMemoryPsi(psi);
    const meminfo = await readIfPresent('/proc/meminfo');
    if (meminfo) {
      const parsed = parseLinuxMemInfo(meminfo);
      if (memory === 'unknown') memory = parsed.memory;
      swapUsedBytes = parsed.swapUsedBytes;
    } else {
      probeErrors.push('/proc/meminfo unavailable');
    }
    // No portable thermal signal on Linux; stay honest rather than claiming 'healthy'.
    thermal = 'unknown';
  } else {
    probeErrors.push(`no memory/thermal probe implemented for platform "${platform}"`);
  }

  return { platform, physicalMemoryBytes, logicalCpuCount, loadAverage1m, memory, thermal, swapUsedBytes, probeErrors };
}

// ---------------------------------------------------------------------------
// Uncoordinated workload observation.
// ---------------------------------------------------------------------------

export type ProcessRow = { pid: number; ppid: number; cpu: number; mem: number; command: string; elapsedSeconds?: number };

/** `ps` elapsed time `[[dd-]hh:]mm:ss` to seconds; undefined when it cannot be read exactly. */
export function parseElapsed(raw: string): number | undefined {
  const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(raw);
  if (!match) return undefined;
  const [, days, hours, minutes, seconds] = match;
  if (Number(minutes) > 59 || Number(seconds) > 59 || (hours !== undefined && Number(hours) > 23)) return undefined;
  return ((Number(days ?? 0) * 24 + Number(hours ?? 0)) * 60 + Number(minutes)) * 60 + Number(seconds);
}

/** Parse `ps -axo pid,ppid,%cpu,%mem,etime,command` (or the Linux `args` equivalent). */
export function parseProcessTable(raw: string): ProcessRow[] {
  const rows: ProcessRow[] = [];
  for (const line of raw.split('\n').slice(1)) {
    const match = /^\s*(\d+)\s+(\d+)\s+([\d.]+)\s+([\d.]+)\s+(\S+)\s+(.*)$/.exec(line);
    if (!match) continue;
    rows.push({
      pid: Number.parseInt(match[1]!, 10),
      ppid: Number.parseInt(match[2]!, 10),
      cpu: Number.parseFloat(match[3]!),
      mem: Number.parseFloat(match[4]!),
      command: match[6]!,
      ...(parseElapsed(match[5]!) !== undefined ? { elapsedSeconds: parseElapsed(match[5]!) } : {})
    });
  }
  return rows;
}

/* Workload identities are defined by AGENT_IDENTITIES and TOOL_IDENTITIES below. */

/**
 * Long-running DEX gateway/node services are not competing coding jobs, even though they are
 * processes and still consume host memory and CPU. Only the service entrypoints match: the
 * `dex-reach` control CLI is an ordinary short-lived command, not a service.
 */
const DEX_SERVICE_PATTERNS: readonly RegExp[] = [
  /src\/coordinator\/main\.(ts|js)/,
  /src\/worker\/main\.(ts|js)/,
  /src\/gateway\/main\.(ts|js)/,
  /src\/node\/main\.(ts|js)/
];

/**
 * Electron/Chromium helpers inherit their host application's command line, including strings such
 * as `codex-sandbox`. They are part of a desktop application's UI process tree, not independent
 * coding sessions. Keep this constrained to documented helper process types so a CLI command with
 * an unrelated `--type` flag remains eligible for ordinary workload classification.
 */

export function isDexServiceCommand(command: string): boolean {
  const script = /^\S*(?:node|nodejs|tsx|bun)\s+(?:--[\w-]+\s+)*(.+?\.(?:ts|js))(?=\s|$)/.exec(command.trim())?.[1];
  return !!script && DEX_SERVICE_PATTERNS.some(pattern => pattern.test(script) && /main\.(?:ts|js)$/.test(script));
}

export function dexServiceLabel(command: string): 'coordinator' | 'worker' | 'gateway' | 'node' {
  if (/src\/coordinator\/main\.(?:ts|js)/.test(command)) return 'coordinator';
  if (/src\/worker\/main\.(?:ts|js)/.test(command)) return 'worker';
  if (/src\/gateway\/main\.(?:ts|js)/.test(command)) return 'gateway';
  return 'node';
}

/** Bounded executable identity for local status; never expose the raw process command or arguments. */
export function safeProcessLabel(command: string): string {
  const token = command.trim().match(/^([^\s]+)/)?.[1] ?? '';
  const base = path.basename(token);
  return /^[A-Za-z0-9._+:-]{1,48}$/.test(base) ? base : 'process';
}

/**
 * Workload identity from the executable itself, never from arbitrary arguments: a wrapper whose
 * arguments mention `npm`, or a script given `--name claude`, is not that workload. The executable
 * is a macOS bundle's `Contents/MacOS/<name>` (paths may contain spaces), else the first token; for
 * interpreters it is the script (or `node --test`, `python -m <module>`). Unknown active identity remains an anonymous competitor; names never authorize an exclusion.
 */
const AGENT_IDENTITIES = new Set(['claude', 'codex', 'grok', 'grokbot']);
const TOOL_IDENTITIES = new Set(['tsc', 'vite', 'webpack', 'rollup', 'esbuild', 'npm', 'pnpm', 'yarn', 'pytest', 'cargo', 'swift', 'swiftc', 'xcodebuild', 'gradle', 'java', 'adb', 'node-test']);
const SCRIPT_ALIASES: Record<string, string> = { 'npm-cli': 'npm', 'pnpm.cjs': 'pnpm', 'yarn.js': 'yarn', 'tsc.js': 'tsc' };
const INTERPRETERS = /^(?:node|nodejs|bun|deno|python(?:\d+(?:\.\d+)?)?)$/;
const VALUE_FLAGS = new Set(['--import', '--require', '-r', '--loader', '--experimental-loader', '--conditions', '-C', '--input-type', '--env-file']);
export type WorkloadIdentity = { name: string; kind: 'agent' | 'tool' };
export function processWorkloadIdentity(command: string): WorkloadIdentity | null {
  const trimmed = command.trim();
  const bundle = /^(\/[^\0]*?\.app\/Contents\/MacOS\/[^/\s]+)(?=\s|$)/.exec(trimmed);
  const executable = bundle ? bundle[1]! : (trimmed.split(/\s+/)[0] ?? '');
  const rest = (bundle ? trimmed.slice(bundle[1]!.length) : trimmed.slice(executable.length)).trim().split(/\s+/).filter(Boolean);
  let name = path.basename(executable);
  if (INTERPRETERS.test(name)) {
    if (/^node|^nodejs|^bun|^deno/.test(name) && rest.includes('--test')) name = 'node-test';
    else {
      const moduleIndex = name.startsWith('python') ? rest.indexOf('-m') : -1;
      if (moduleIndex >= 0) name = rest[moduleIndex + 1] ?? '';
      else {
        let script = '';
        for (let i = 0; i < rest.length; i++) {
          const token = rest[i]!;
          if (VALUE_FLAGS.has(token)) { i++; continue; }
          if (token.startsWith('-')) continue;
          script = token; break;
        }
        // macOS ps prints unquoted script paths containing spaces. Recognize only a leading
        // absolute script path, not arbitrary later arguments. Unknown hot identities still count.
        const spacedScript = /^(\/[^\0]+?\/(?:tsc|npm-cli\.js|pnpm\.cjs|yarn\.js))(?=\s+-|$)/.exec(rest.join(' '))?.[1];
        const base = path.basename(spacedScript ?? script);
        name = SCRIPT_ALIASES[base] ?? base.replace(/\.(?:c|m)?(?:js|ts)$/, '');
        name = SCRIPT_ALIASES[name] ?? name;
      }
    }
  }
  if (AGENT_IDENTITIES.has(name)) return { name, kind: 'agent' };
  if (TOOL_IDENTITIES.has(name)) return { name, kind: 'tool' };
  return null;
}

function desktopBundle(command: string): string | null {
  return /^(\/[^\0]*?\.app)\/Contents\//.exec(command.trim())?.[1] ?? null;
}

export function looksHeavy(row: ProcessRow): boolean {
  if (isDexServiceCommand(row.command)) return false;
  // Anonymous high CPU and active desktop work cannot hide behind helper flags.
  if (row.cpu >= 80) return true;
  if (desktopBundle(row.command)) return row.cpu >= 10;
  const identity = processWorkloadIdentity(row.command);
  if (!identity) return row.cpu >= 10;
  // A resident agent session holds memory while idle; only sustained CPU shows it is doing work.
  // Host memory pressure is evaluated separately and still refuses work. Build/test tools keep the
  // historical CPU-or-memory rule: a memory-heavy compiler is a real competing job.
  if (identity.kind === 'agent') return row.cpu >= 10;
  return row.cpu >= 10 || row.mem >= 2;
}

/**
 * Processes that are the caller rather than a competitor: this process, the ancestors that launched
 * it, their own process tree below this process, and the tree beneath every already-leased PID.
 * Sibling agents are deliberately NOT excluded — those are exactly the workloads worth counting.
 */
export type LeaseIdentity = { pid: number; createdAt: string };
export type ExclusionOptions = { leasedPids?: readonly number[]; selfPid?: number; leases?: readonly LeaseIdentity[]; observedAt?: number };
/**
 * A lease covers a PID only when that process provably existed when the lease was created: a
 * process that started later reused the PID and is an unrelated job. Unknown start time is not proof.
 */
export function verifiedLeasePids(rows: readonly ProcessRow[], leases: readonly LeaseIdentity[], observedAt: number): number[] {
  const byPid = new Map(rows.map(row => [row.pid, row]));
  return leases.flatMap(lease => {
    const row = byPid.get(lease.pid), created = Date.parse(lease.createdAt);
    if (!row || row.elapsedSeconds === undefined || !Number.isFinite(created)) return [];
    const startedAt = observedAt - row.elapsedSeconds * 1000;
    // ps etime is rounded to seconds: only exclude when even the latest possible
    // start predates creation. Boundary/unknown identity is conservatively counted.
    return startedAt <= created ? [lease.pid] : [];
  });
}
export function collectExcludedPids(
  rows: readonly ProcessRow[],
  options: ExclusionOptions = {}
): Set<number> {
  const selfPid = options.selfPid ?? process.pid;
  options = { ...options, leasedPids: [...(options.leasedPids ?? []), ...verifiedLeasePids(rows, options.leases ?? [], options.observedAt ?? Date.now())] };
  const parentOf = new Map<number, number>();
  const childrenOf = new Map<number, number[]>();
  for (const row of rows) {
    parentOf.set(row.pid, row.ppid);
    childrenOf.set(row.ppid, [...(childrenOf.get(row.ppid) ?? []), row.pid]);
  }

  const excluded = new Set<number>([selfPid, ...(options.leasedPids ?? [])]);

  // The chain that launched this process is this session, not a competing job.
  let cursor = parentOf.get(selfPid);
  let guard = 0;
  while (cursor !== undefined && cursor > 1 && !excluded.has(cursor) && guard < 64) {
    excluded.add(cursor);
    cursor = parentOf.get(cursor);
    guard += 1;
  }

  // Work spawned beneath this process or beneath a coordinated lease belongs to that lease.
  const queue = [selfPid, ...(options.leasedPids ?? [])];
  while (queue.length) {
    const pid = queue.pop()!;
    for (const child of childrenOf.get(pid) ?? []) {
      if (excluded.has(child)) continue;
      excluded.add(child);
      queue.push(child);
    }
  }
  return excluded;
}

/**
 * Classify observed processes into anonymous heavy workloads and DEX services. Processes belonging
 * to a known lease, or to this process's own tree, are excluded so a coordinated job is never
 * counted against itself. This looks only at the process table; it never inspects another
 * conversation's content (DEX-INV-026).
 */
export function classifyObservedWorkloads(
  rows: readonly ProcessRow[],
  options: ExclusionOptions = {}
): ObservedWorkloads {
  const excluded = collectExcludedPids(rows, options);
  const byPid = new Map(rows.map(row => [row.pid, row]));
  const heavy = rows.filter(row => !excluded.has(row.pid) && !isDexServiceCommand(row.command) && looksHeavy(row));
  // One workload per session: busy tools under one agent (or one build) share that ancestor's slot,
  // whether or not the ancestor itself is busy. Independent sessions remain separate workloads.
  const heavyPids = new Set(heavy.map(row => row.pid));
  const workloadAncestor = (row: ProcessRow | undefined) => !!row && !excluded.has(row.pid) && !isDexServiceCommand(row.command) && (heavyPids.has(row.pid) || processWorkloadIdentity(row.command) !== null);
  const rootFor = (row: ProcessRow): number => {
    let root = row;
    // A desktop helper is one app workload, not one independent coding session per renderer.
    const bundle = desktopBundle(row.command);
    let parent = byPid.get(root.ppid);
    let guard = 0;
    while (parent && parent.pid !== root.pid && (workloadAncestor(parent) || (bundle !== null && desktopBundle(parent.command) === bundle)) && guard++ < 64) { root = parent; parent = byPid.get(root.ppid); }
    return root.pid;
  };
  const groups = new Map<number, ProcessRow[]>();
  for (const row of heavy) groups.set(rootFor(row), [...(groups.get(rootFor(row)) ?? []), row]);
  const uncoordinatedDetails = [...groups.entries()].map(([pid, group]): ObservedProcess => {
    const root = byPid.get(pid) ?? group[0]!;
    const cpu = Math.max(...group.map(row => row.cpu));
    const mem = Math.max(...group.map(row => row.mem));
    return { pid, pids: group.map(row => row.pid).sort((a, b) => a - b), cpu, mem, processLabel: processWorkloadIdentity(root.command)?.name ?? safeProcessLabel(root.command), matchedBy: cpu >= 10 ? 'cpu' : 'memory' };
  }).sort((a, b) => a.pid - b.pid);
  const dexServiceDetails = rows.filter(row => isDexServiceCommand(row.command)).map((row): ObservedProcess => ({
    pid: row.pid, pids: [row.pid], cpu: row.cpu, mem: row.mem,
    processLabel: dexServiceLabel(row.command), matchedBy: row.cpu >= 10 ? 'cpu' : 'memory'
  }));
  return { uncoordinatedHeavy: uncoordinatedDetails.length, dexServices: dexServiceDetails.length, uncoordinatedDetails, dexServiceDetails, processObservation: 'observed' };
}

/** null when the process table could not be read: callers must not treat it as an idle host. */
export async function observeProcessRows(): Promise<ProcessRow[] | null> {
  const args = process.platform === 'darwin' ? ['-axo', 'pid,ppid,%cpu,%mem,etime,command'] : ['-eo', 'pid,ppid,%cpu,%mem,etime,args'];
  const stdout = await runProbe('ps', args);
  if (!stdout) return null;
  const rows = parseProcessTable(stdout);
  return rows.length ? rows : null;
}
export async function observeWorkloadsResult(options: ExclusionOptions & { rows?: readonly ProcessRow[] | null } = {}): Promise<ObservedWorkloads> {
  const rows = options.rows === undefined ? await observeProcessRows() : options.rows;
  if (!rows) return { uncoordinatedHeavy: 0, dexServices: 0, uncoordinatedDetails: [], dexServiceDetails: [], processObservation: 'unknown' };
  return classifyObservedWorkloads(rows, options);
}

export async function observeWorkloads(options: ExclusionOptions & { rows?: readonly ProcessRow[] } = {}): Promise<ObservedWorkloads> {
  return observeWorkloadsResult(options);
}
