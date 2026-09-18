import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';

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
};

export type MachineCapacity = {
  physicalMemoryBytes: number;
  logicalCpuCount: number;

  substantiveSlots: number;
  heavySlots: number;

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
  request?: { workload: WorkloadClass; access: AccessClass }
): MachineCapacity {
  const substantiveSlots = substantiveSlotsFor(probe.physicalMemoryBytes, probe.logicalCpuCount);
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
      livePressure: { memory: probe.memory, cpu, thermal: probe.thermal },
      activeCoordinated: counts.activeSubstantive,
      activeHeavy: counts.activeHeavy,
      observedUncoordinatedHeavy: counts.observedUncoordinatedHeavy,
      canAdmit: true,
      reasons: ['light read-only inspection does not consume a substantive slot']
    };
  }

  const usedSubstantive = counts.activeSubstantive + counts.observedUncoordinatedHeavy;
  if (usedSubstantive >= substantiveSlots) {
    reasons.push(
      `substantive slots exhausted (${usedSubstantive}/${substantiveSlots}` +
        (counts.observedUncoordinatedHeavy > 0 ? `, including ${counts.observedUncoordinatedHeavy} uncoordinated heavy workload(s)` : '') +
        ')'
    );
  }
  if (heavy && counts.activeHeavy >= heavySlots) {
    reasons.push(`heavy slots exhausted (${counts.activeHeavy}/${heavySlots})`);
  }

  if (probe.memory === 'critical') reasons.push('memory pressure critical');
  else if (probe.memory === 'warning' && heavy) reasons.push('memory pressure warning; heavy work queues');
  else if (probe.memory === 'unknown' && heavy) reasons.push('memory pressure unknown; heavy work queues conservatively');

  // Memory and CPU are the primary and secondary limiters, so an unmeasured reading of either
  // queues heavy work. Thermal has no portable signal at all (Linux reports none), so an unknown
  // thermal reading is not treated as pressure; that would make heavy work impossible off macOS.
  if (probe.thermal === 'limited' && heavy) reasons.push('thermal limiting observed; heavy work queues');
  if (cpu === 'saturated' && heavy) reasons.push('CPU saturated (1m load >= logical CPUs)');
  else if (cpu === 'busy' && heavy) reasons.push('CPU busy (1m load >= 75% of logical CPUs)');
  else if (cpu === 'unknown' && heavy) reasons.push('CPU load unknown; heavy work queues conservatively');

  if (!reasons.length) reasons.push('capacity available');

  return {
    physicalMemoryBytes: probe.physicalMemoryBytes,
    logicalCpuCount: probe.logicalCpuCount,
    substantiveSlots,
    heavySlots,
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
    const { stdout } = await execFileAsync(file, args, { timeout: 4000, maxBuffer: 1024 * 1024 });
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
    const level = await runProbe('sysctl', ['-n', 'kern.memorystatus_vm_pressure_level']);
    if (level) memory = parseDarwinPressureLevel(level);
    if (memory === 'unknown') {
      const pressure = await runProbe('memory_pressure', []);
      if (pressure) memory = parseDarwinMemoryPressure(pressure);
      else probeErrors.push('memory_pressure unavailable');
    }
    const swap = await runProbe('sysctl', ['-n', 'vm.swapusage']);
    if (swap) swapUsedBytes = parseDarwinSwapUsage(swap);
    const therm = await runProbe('pmset', ['-g', 'therm']);
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

export type ProcessRow = { pid: number; ppid: number; cpu: number; mem: number; command: string };

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
      command: match[6]!
    });
  }
  return rows;
}

/** Commands that indicate a substantial build/test/AI coding workload. */
const HEAVY_COMMAND_PATTERNS: readonly RegExp[] = [
  /\bclaude\b/, /\bcodex\b/, /\bgrok(bot)?\b/,
  /\btsc\b/, /\bvite\b/, /\bwebpack\b/, /\brollup\b/, /\besbuild\b/,
  /\bnpm\b/, /\bpnpm\b/, /\byarn\b/,
  /\bpytest\b/, /\bcargo\b/, /\bswift(c)?\b/, /\bxcodebuild\b/, /\bgradle\b/, /\bjava\b/, /\badb\b/
];

/**
 * Long-running DEX gateway/node services are not competing coding jobs, even though they are
 * processes and still consume host memory and CPU. Only the service entrypoints match: the
 * `dex-reach` control CLI is an ordinary short-lived command, not a service.
 */
const DEX_SERVICE_PATTERNS: readonly RegExp[] = [
  /src\/gateway\/main\.(ts|js)/, /src\/node\/main\.(ts|js)/
];

export function isDexServiceCommand(command: string): boolean {
  return DEX_SERVICE_PATTERNS.some(pattern => pattern.test(command));
}

export function looksHeavy(row: ProcessRow): boolean {
  if (isDexServiceCommand(row.command)) return false;
  if (!HEAVY_COMMAND_PATTERNS.some(pattern => pattern.test(row.command))) return false;
  // A named build tool that is consuming neither CPU nor memory is idle, not a competing job.
  return row.cpu >= 10 || row.mem >= 2;
}

/**
 * Processes that are the caller rather than a competitor: this process, the ancestors that launched
 * it, their own process tree below this process, and the tree beneath every already-leased PID.
 * Sibling agents are deliberately NOT excluded — those are exactly the workloads worth counting.
 */
export function collectExcludedPids(
  rows: readonly ProcessRow[],
  options: { leasedPids?: readonly number[]; selfPid?: number } = {}
): Set<number> {
  const selfPid = options.selfPid ?? process.pid;
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
  options: { leasedPids?: readonly number[]; selfPid?: number } = {}
): ObservedWorkloads {
  const excluded = collectExcludedPids(rows, options);
  let uncoordinatedHeavy = 0;
  let dexServices = 0;

  for (const row of rows) {
    if (isDexServiceCommand(row.command)) { dexServices += 1; continue; }
    if (excluded.has(row.pid)) continue;
    if (looksHeavy(row)) uncoordinatedHeavy += 1;
  }
  return { uncoordinatedHeavy, dexServices };
}

export async function observeWorkloads(options: { leasedPids?: readonly number[] } = {}): Promise<ObservedWorkloads> {
  const args = process.platform === 'darwin' ? ['-axo', 'pid,ppid,%cpu,%mem,etime,command'] : ['-eo', 'pid,ppid,%cpu,%mem,etime,args'];
  const stdout = await runProbe('ps', args);
  if (!stdout) return { uncoordinatedHeavy: 0, dexServices: 0 };
  return classifyObservedWorkloads(parseProcessTable(stdout), options);
}
