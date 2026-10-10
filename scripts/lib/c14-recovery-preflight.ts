export const C14_ROOT = '/Users/andrew/dex-reach-c13-worker-repair';
export const RETAINED_RELEASE = '0.3.2-87a99494ebb3-2f44ae46b11b';
export const RETAINED_TREE = 'fcb78a6b99db10aac565a1b2b4af90faf142ef5bd5162523a662febeafd36b12';
export type Baseline = { previousReleaseId: string; previousDigest: string; observedDigest: string; previousExists: boolean; provenance: 'manifest-verified' | 'journal-bound' | 'unknown'; legacyProvenanceApproved: boolean; transactionId: string; state: 'prepared' | 'partial' | 'uncertain'; fresh: boolean; serviceReleaseIds: string[]; configVerified: boolean; inventoryVerified: boolean; helperIdle: boolean; rollbackActive: boolean };
export function baselineBlockers(b: Baseline): string[] {
  const errors: string[] = [];
  if (b.previousReleaseId !== RETAINED_RELEASE || !b.previousExists) errors.push('PREVIOUS_RELEASE_MISSING_OR_WRONG');
  if (b.previousDigest !== RETAINED_TREE || b.observedDigest !== b.previousDigest) errors.push('PREVIOUS_DIGEST_MISMATCH');
  if (b.provenance !== 'manifest-verified' && !(b.provenance === 'journal-bound' && b.legacyProvenanceApproved)) errors.push('PROVENANCE_UNAPPROVED');
  if (!/^[a-f0-9-]{36}$/.test(b.transactionId) || !b.fresh || b.state !== 'prepared') errors.push('CAPSULE_INCOMPLETE_OR_UNCERTAIN');
  if (b.serviceReleaseIds.length !== 5 || b.serviceReleaseIds.some(id => id !== b.previousReleaseId)) errors.push('MIXED_SERVICE_RELEASES');
  if (!b.configVerified || !b.inventoryVerified) errors.push('CONFIG_OR_PRESERVATION_INCOMPLETE');
  if (!b.helperIdle || b.rollbackActive) errors.push('RECOVERY_OPERATION_ACTIVE_OR_UNKNOWN');
  return errors;
}
export type SpacePlan = { candidateBytes: number; dependencyBytes: number; retainedBytes: number; backupBytes: number; restoreBytes: number; stagingBytes: number; reserveBytes: number };
/** Retention is existing storage, not additional free-space consumption. No relocation or deletion. */
export function requiredFreeBytes(p: SpacePlan): number {
  const values = Object.values(p);
  if (values.some(v => !Number.isSafeInteger(v) || v < 0) || p.reserveBytes < 2 * 1024 ** 3) throw new Error('INVALID_SPACE_PLAN');
  const total = p.candidateBytes + p.dependencyBytes + p.backupBytes + p.restoreBytes + p.stagingBytes + p.reserveBytes;
  if (!Number.isSafeInteger(total)) throw new Error('SPACE_PLAN_OVERFLOW');
  return total;
}
export type PreflightFacts = { hostname: string; model: string; platform: string; arch: string; user: string; uid: number; home: string; root: string; branch: string; head: string; remoteHead: string; dirty: boolean; approvedSha?: string; candidateVersion: string; approvedVersion?: string; ciHead?: string; ciChecks: Record<string, string>; installedIntact: boolean; installedRelease: string; servicesVerified: boolean; backupCertified: boolean; baseline: Baseline; restoreProof: { scope: 'synthetic' | 'installed'; sourceSha: string; passed: boolean }; taskCount: number; taskUnresolved: number; claimsKnown: boolean; claimsCount: number; ownerPreservationVerified: boolean; freeBytes: number; spaceMeasured: boolean; space: SpacePlan; exactLegacyPairingVerified: boolean; credentialsCompatible: boolean; requiredHostCapabilityAvailable: boolean; maintenanceAuthorized: boolean };
export function evaluatePreflight(f: PreflightFacts) {
  const checks: Record<string, boolean> = {
    EXACT_HOST: f.hostname === 'MacBook-Air.local' && f.model === 'MacBookAir10,1' && f.platform === 'darwin' && f.arch === 'arm64',
    EXACT_ACCOUNT: f.user === 'andrew' && f.uid === 501 && f.home === '/Users/andrew',
    EXACT_REPOSITORY: f.root === C14_ROOT,
    AUTHORIZED_BRANCH: f.branch === 'c14-chaos-recovery',
    CLEAN_SOURCE: !f.dirty && /^[a-f0-9]{40}$/.test(f.head),
    REMOTE_PARITY: f.head === f.remoteHead,
    HOSTED_CHECKS: f.ciHead === f.head && ['validate', 'runtime-proof', 'reproducible-build', 'analyze', 'CodeQL'].every(k => f.ciChecks[k] === 'SUCCESS'),
    APPROVED_SHA: f.approvedSha === f.head,
    INSTALLED_IDENTITY: f.installedIntact && f.installedRelease === RETAINED_RELEASE,
    FIVE_SERVICES: f.servicesVerified,
    BACKUP_COVERAGE: f.backupCertified,
    RECOVERY_BASELINE: baselineBlockers(f.baseline).length === 0,
    SYNTHETIC_RESTORE: f.restoreProof.scope === 'synthetic' && f.restoreProof.passed && f.restoreProof.sourceSha === f.head,
    NONTERMINAL_TASKS: Number.isInteger(f.taskCount) && f.taskCount >= 0 && f.taskUnresolved === 0 && f.taskCount === 0,
    COORDINATOR_CLAIMS: f.claimsKnown && f.claimsCount === 0,
    OWNER_PRESERVATION: f.ownerPreservationVerified,
    FREE_SPACE: false,
    LEGACY_COMPATIBILITY: f.exactLegacyPairingVerified && f.credentialsCompatible,
    CANDIDATE_VERSION: !!f.approvedVersion && f.candidateVersion === f.approvedVersion,
    MAINTENANCE_AUTHORITY: f.maintenanceAuthorized && f.requiredHostCapabilityAvailable
  };
  try { checks.FREE_SPACE = f.spaceMeasured && Number.isSafeInteger(f.freeBytes) && f.freeBytes >= requiredFreeBytes(f.space); } catch { /* Invalid estimates refuse. */ }
  const blockers = Object.entries(checks).filter(([, pass]) => !pass).map(([name]) => name);
  return { mode: 'READ_ONLY', installationExecuted: false, installationCommandAvailable: false, status: blockers.length ? 'BLOCKED' : 'PREREQUISITES_PASS_NO_INSTALLATION', checks, blockers, recoveryBlockers: baselineBlockers(f.baseline), syntheticIsInstalledProof: false };
}
