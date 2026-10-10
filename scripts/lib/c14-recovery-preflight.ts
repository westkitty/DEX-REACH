export const C14_ROOT = '/Users/andrew/dex-reach-c13-worker-repair';
export const RETAINED_RELEASE = '0.3.2-87a99494ebb3-2f44ae46b11b';
export const RETAINED_TREE = 'fcb78a6b99db10aac565a1b2b4af90faf142ef5bd5162523a662febeafd36b12';
export const RETAINED_SOURCE = '87a99494ebb3471d3ecc3a79acd630ec18858a92';
export const RETAINED_TRANSACTION = '9bf5079f-397e-4cd8-af35-99f1550d3d68';
export type RetainedProvenance = { sourceSha: string; installTransaction: string; dependencyDigest: string; configDigest: string; expectedConfigDigest: string; policyDigest: string; expectedPolicyDigest: string; ownerManifestDigest: string; trustedManifestDigest: string; snapshotComplete: boolean; metadataVerified: boolean; reserveVerified: boolean };
export function retainedProvenanceBlockers(p?: RetainedProvenance): string[] {
  if (!p) return ['RETAINED_PROVENANCE_MISSING'];
  const issues: string[] = [];
  if (p.sourceSha !== RETAINED_SOURCE || p.installTransaction !== RETAINED_TRANSACTION) issues.push('RETAINED_SOURCE_OR_INSTALL_TRANSACTION');
  if (![p.dependencyDigest, p.configDigest, p.policyDigest, p.ownerManifestDigest].every(h => /^[a-f0-9]{64}$/.test(h)) || p.configDigest !== p.expectedConfigDigest || p.policyDigest !== p.expectedPolicyDigest || p.ownerManifestDigest !== p.trustedManifestDigest) issues.push('RETAINED_DEPENDENCY_CONFIG_POLICY_OR_COVERAGE');
  if (!p.snapshotComplete || !p.metadataVerified || !p.reserveVerified) issues.push('RETAINED_SNAPSHOT_METADATA_OR_RESERVE');
  return issues;
}
export type RecoveryBoundaryEvidence = Readonly<{ scope: 'live' | 'synthetic'; version: 1; symlinkPolicy: boolean; knownFamilies: boolean; consistency: boolean; manifestTrust: boolean; destination: boolean; durableBackup: boolean; restore: boolean; taskDisposition: boolean; provenance: boolean; candidateIdentity: boolean }>;
/** Production receipt/owner-authorization adapter intentionally unavailable. JSON is never authority. */
export function validateLiveBoundaryEvidence(_e?: RecoveryBoundaryEvidence): Record<string, boolean> {
  return Object.fromEntries(['SYMLINK_POLICY', 'KNOWN_FAMILIES', 'SNAPSHOT_CONSISTENCY', 'INDEPENDENT_MANIFEST_TRUST', 'BACKUP_DESTINATION', 'BACKUP_DURABILITY', 'APPLICATION_RESTORE', 'TASK_DISPOSITION', 'RETAINED_PROVENANCE', 'CANDIDATE_RELEASE_IDENTITY'].map(k => [k, false]));
}
export type Baseline = { previousReleaseId: string; previousDigest: string; observedDigest: string; previousExists: boolean; provenance: 'manifest-verified' | 'journal-bound' | 'unknown'; legacyProvenanceApproved: boolean; transactionId: string; state: 'prepared' | 'partial' | 'uncertain'; fresh: boolean; serviceReleaseIds: string[]; configVerified: boolean; inventoryVerified: boolean; helperIdle: boolean; rollbackActive: boolean; provenanceDetails?: RetainedProvenance };
export function baselineBlockers(b: Baseline): string[] {
  const errors: string[] = retainedProvenanceBlockers(b.provenanceDetails);
  if (b.previousReleaseId !== RETAINED_RELEASE || !b.previousExists) errors.push('PREVIOUS_RELEASE_MISSING_OR_WRONG');
  if (b.previousDigest !== RETAINED_TREE || b.observedDigest !== b.previousDigest) errors.push('PREVIOUS_DIGEST_MISMATCH');
  if (b.provenance !== 'manifest-verified' && !(b.provenance === 'journal-bound' && b.legacyProvenanceApproved)) errors.push('PROVENANCE_UNAPPROVED');
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(b.transactionId) || !b.fresh || b.state !== 'prepared') errors.push('CAPSULE_INCOMPLETE_OR_UNCERTAIN');
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
/** Each required check must appear exactly once and be completed; a duplicate name can never mask another run. */
export function aggregateCheckRuns(rows: unknown): Record<string, string> {
  const seen: Record<string, string> = {};
  for (const row of Array.isArray(rows) ? rows as Array<Record<string, unknown>> : []) {
    const name = typeof row.name === 'string' ? row.name : typeof row.context === 'string' ? row.context : '';
    if (!name) continue;
    const completed = row.status === undefined ? typeof row.state === 'string' : row.status === 'COMPLETED';
    const outcome = completed ? String(row.conclusion ?? row.state ?? '') : 'INCOMPLETE';
    seen[name] = name in seen ? 'AMBIGUOUS' : outcome;
  }
  return seen;
}
export type PreflightFacts = { hostname: string; model: string; platform: string; arch: string; user: string; uid: number; home: string; root: string; branch: string; head: string; remoteHead: string; dirty: boolean; approvedSha?: string; candidateVersion: string; approvedVersion?: string; ciHead?: string; ciChecks: Record<string, string>; installedIntact: boolean; installedRelease: string; servicesVerified: boolean; backupCertified: boolean; baseline: Baseline; restoreProof: { scope: 'synthetic' | 'installed'; sourceSha: string; passed: boolean }; taskCount: number; taskUnresolved: number; claimsKnown: boolean; claimsCount: number; ownerPreservationVerified: boolean; freeBytes: number; spaceMeasured: boolean; space: SpacePlan; exactLegacyPairingVerified: boolean; credentialsCompatible: boolean; requiredHostCapabilityAvailable: boolean; maintenanceAuthorized: boolean; boundary?: RecoveryBoundaryEvidence };
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
    MAINTENANCE_AUTHORITY: f.maintenanceAuthorized && f.requiredHostCapabilityAvailable,
    ...validateLiveBoundaryEvidence(f.boundary)
  };
  try { checks.FREE_SPACE = f.spaceMeasured && Number.isSafeInteger(f.freeBytes) && f.freeBytes >= requiredFreeBytes(f.space); } catch { /* Invalid estimates refuse. */ }
  const blockers = Object.entries(checks).filter(([, pass]) => !pass).map(([name]) => name);
  return { mode: 'READ_ONLY', installationExecuted: false, installationCommandAvailable: false, status: blockers.length ? 'BLOCKED' : 'PREREQUISITES_PASS_NO_INSTALLATION', checks, blockers, recoveryBlockers: baselineBlockers(f.baseline), syntheticIsInstalledProof: false, states: { source: checks.CLEAN_SOURCE && checks.HOSTED_CHECKS ? 'SOURCE_VALIDATED' : 'SOURCE_UNVERIFIED', backup: 'PRIVATE_BACKUP_UNVERIFIED', rollback: 'ROLLBACK_BASELINE_UNVERIFIED', installation: blockers.length ? 'INSTALLATION_BLOCKED' : 'INSTALLATION_PREREQUISITES_PASS' } };
}
