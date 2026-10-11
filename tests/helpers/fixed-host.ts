import { classifyObservedWorkloads, parseProcessTable } from '../../src/shared/machine-capacity.js';
import type { CapacitySnapshot } from '../../src/shared/work-coordinator.js';

/**
 * A deterministic host profile for coordinator fixtures: 8 logical CPUs, 16 GiB, healthy pressure and
 * no competing workload. The bundle budget is derived from the host, so a fixture that admits two
 * light leases must not inherit the CPU count of whichever machine runs it. A 2-CPU host has a
 * one-unit budget and would queue the second lease; that is the sandbox's shape, not the behaviour under test.
 */
export async function fixedHostSnapshot(): Promise<CapacitySnapshot> {
  return {
    physicalMemoryBytes: 16 * 1024 ** 3,
    logicalCpuCount: 8,
    loadAverage1m: 0.5,
    memory: 'healthy',
    thermal: 'healthy',
    observed: classifyObservedWorkloads(parseProcessTable('PID PPID %CPU %MEM ELAPSED COMMAND\n'), { selfPid: 9999 })
  };
}
