import type { AccessClass, WorkloadClass } from './machine-capacity.js';

export type WorkBundle = {
  cpuUnits: number;
  memoryMiB: number;
  io: 'low' | 'normal' | 'high';
  network: 'none' | 'light' | 'heavy';
  repositoryWrite: boolean;
  machineExclusive: boolean;
};

const IO = ['low', 'normal', 'high'] as const;
const NETWORK = ['none', 'light', 'heavy'] as const;

export function legacyWorkBundle(workload: WorkloadClass, access: AccessClass): WorkBundle {
  const base = workload === 'light'
    ? { cpuUnits: 1, memoryMiB: 512, io: 'low' as const, network: 'none' as const }
    : workload === 'medium'
      ? { cpuUnits: 2, memoryMiB: 2048, io: 'normal' as const, network: 'light' as const }
      : { cpuUnits: 4, memoryMiB: 4096, io: 'high' as const, network: 'heavy' as const };
  return { ...base, repositoryWrite: access !== 'read', machineExclusive: access === 'exclusive' };
}

export function isWorkBundle(value: unknown): value is WorkBundle {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return Number.isInteger(item.cpuUnits) && Number(item.cpuUnits) >= 1 && Number(item.cpuUnits) <= 64
    && Number.isInteger(item.memoryMiB) && Number(item.memoryMiB) >= 64 && Number(item.memoryMiB) <= 1_048_576
    && IO.includes(item.io as WorkBundle['io']) && NETWORK.includes(item.network as WorkBundle['network'])
    && typeof item.repositoryWrite === 'boolean' && typeof item.machineExclusive === 'boolean';
}

/** Caller overrides are narrow resource declarations, never an authority grant. */
export function normalizeWorkBundle(workload: WorkloadClass, access: AccessClass, value?: WorkBundle): WorkBundle {
  if (!value) return legacyWorkBundle(workload, access);
  if (!isWorkBundle(value)) throw new Error('work bundle is malformed');
  if (access !== 'read' && !value.repositoryWrite) throw new Error('mutating work bundle must declare repositoryWrite');
  if (access === 'exclusive' && !value.machineExclusive) throw new Error('exclusive work bundle must declare machineExclusive');
  return value;
}

export function bundleBudget(physicalMemoryBytes: number, logicalCpuCount: number): Pick<WorkBundle, 'cpuUnits' | 'memoryMiB'> {
  return {
    cpuUnits: Math.max(1, Math.floor(Math.max(1, logicalCpuCount) * 0.75)),
    memoryMiB: Math.max(1024, Math.floor((Math.max(0, physicalMemoryBytes) / 1024 ** 2) * 0.6))
  };
}
