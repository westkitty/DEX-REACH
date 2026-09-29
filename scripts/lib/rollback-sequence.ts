export type RollbackTarget = { label: string };

export type RollbackFailure = {
  label: string;
  error: string;
};

export type RollbackSequenceResult<R> = {
  results: R[];
  failures: RollbackFailure[];
  attempted: string[];
};

export function recoveryPriority(label: string): number {
  if (label.endsWith('.gateway')) return 0;
  if (label.endsWith('.coordinator')) return 1;
  if (label.endsWith('.worker')) return 2;
  if (label.endsWith('.node')) return 3;
  return 4;
}

/**
 * Recovery is deliberately best-effort per service: one failed restore is evidence to report,
 * never authority to skip restoring the remaining control-plane services.
 */
export async function runIndependentRollback<T extends RollbackTarget, R>(
  services: readonly T[],
  restore: (service: T) => Promise<R>
): Promise<RollbackSequenceResult<R>> {
  const results: R[] = [];
  const failures: RollbackFailure[] = [];
  const attempted: string[] = [];
  const ordered = [...services].sort((a, b) => recoveryPriority(a.label) - recoveryPriority(b.label));

  for (const service of ordered) {
    attempted.push(service.label);
    try {
      results.push(await restore(service));
    } catch (error) {
      failures.push({
        label: service.label,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  return { results, failures, attempted };
}
