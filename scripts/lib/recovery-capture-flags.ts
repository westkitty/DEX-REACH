/**
 * Parses the opt-in exclusion flags of `c14-recovery.ts capture-offline`. Both default to off. An unknown or
 * repeated exclusion flag is refused rather than ignored, so an operator never believes a policy applied when
 * it did not.
 */
export const CAPTURE_EXCLUSION_FLAGS = ['--exclude-owner-policy', '--exclude-superseded-runtime'] as const;
export type CaptureExclusionFlags = { ownerPolicy: boolean; runtimeReleases: 'all' | 'current-and-rollback' };

export function parseCaptureExclusionFlags(args: readonly string[]): CaptureExclusionFlags {
  const seen = new Set<string>();
  for (const arg of args) {
    if (!arg.startsWith('--exclude-')) continue;
    if (!(CAPTURE_EXCLUSION_FLAGS as readonly string[]).includes(arg)) throw new Error('USAGE_UNKNOWN_EXCLUSION_FLAG');
    if (seen.has(arg)) throw new Error('USAGE_DUPLICATE_EXCLUSION_FLAG');
    seen.add(arg);
  }
  return {
    ownerPolicy: seen.has('--exclude-owner-policy'),
    runtimeReleases: seen.has('--exclude-superseded-runtime') ? 'current-and-rollback' : 'all'
  };
}
