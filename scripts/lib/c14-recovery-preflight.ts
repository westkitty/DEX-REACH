import { isVerifiedWindowEvidence } from './c14-window-evidence.js';
/**
 * The release candidate runs from a dedicated worktree checked out detached at the exact origin/main tip.
 * (main itself stays checked out in the owner's primary checkout, which holds unrelated uncommitted work.)
 */
export const RELEASE_ROOT = '/Users/andrew/dex-reach-release';
export const RELEASE_LINE = 'main';
/** @deprecated The C14 working branch is closed; kept as an alias so older evidence readers still resolve. */
export const C14_ROOT = RELEASE_ROOT;
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
const BOUNDARY_GATES = [['SYMLINK_POLICY', 'symlinkPolicy'], ['KNOWN_FAMILIES', 'knownFamilies'], ['SNAPSHOT_CONSISTENCY', 'consistency'], ['INDEPENDENT_MANIFEST_TRUST', 'manifestTrust'], ['BACKUP_DESTINATION', 'destination'], ['BACKUP_DURABILITY', 'durableBackup'], ['APPLICATION_RESTORE', 'restore'], ['TASK_DISPOSITION', 'taskDisposition'], ['RETAINED_PROVENANCE', 'provenance'], ['CANDIDATE_RELEASE_IDENTITY', 'candidateIdentity']] as const;
/**
 * Live boundary gates pass only for evidence minted by verifyWindowEvidence after it re-verified the
 * certified capture chain, its independent expectation, the destination, quarantine and provenance.
 * Supplied JSON or synthetic objects never pass, whatever their fields say.
 */
export function validateLiveBoundaryEvidence(e?: RecoveryBoundaryEvidence): Record<string, boolean> {
  const genuine = !!e && e.scope === 'live' && isVerifiedWindowEvidence(e);
  return Object.fromEntries(BOUNDARY_GATES.map(([gate, field]) => [gate, genuine && e![field] === true]));
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
/** The hosted gates a release candidate needs, read for its exact commit. */
export const REQUIRED_HOSTED_CHECKS = ['validate', 'runtime-proof', 'reproducible-build', 'analyze', 'CodeQL'] as const;
/**
 * Normalise exact-SHA evidence from GitHub's REST API into aggregateCheckRuns rows. Check runs give the CI jobs and
 * CodeQL's analyze job. A push to main has no separate "CodeQL" code-scanning check, so that gate is the CodeQL
 * workflow run for the same commit. Only runs whose head_sha is exactly `sha` count; anything else is ignored.
 */
export function exactShaCheckRows(sha: string, checkRuns: unknown, workflowRuns: unknown): Array<{ name: string; status: string; conclusion: string }> {
  if (!/^[a-f0-9]{40}$/.test(sha)) return [];
  const c = checkRuns as { total_count?: number; check_runs?: unknown[] } | null;
  const w = workflowRuns as { total_count?: number; workflow_runs?: unknown[] } | null;
  if (!c || !w || !Array.isArray(c.check_runs) || !Array.isArray(w.workflow_runs) ||
      c.total_count !== c.check_runs.length || w.total_count !== w.workflow_runs.length) return [];
  const rows: Array<{ name: string; status: string; conclusion: string }> = [];
  const workflows: Array<Record<string, any>> = [];
  for (const raw of w.workflow_runs) {
    if (!raw || typeof raw !== 'object') return [];
    const r = raw as Record<string, any>;
    if (typeof r.head_sha !== 'string' || typeof r.name !== 'string' || typeof r.path !== 'string' || !Number.isSafeInteger(r.check_suite_id) || typeof r.status !== 'string' || !r.repository || typeof r.repository.full_name !== 'string') return [];
    if (r.head_sha === sha && r.event === 'push' && r.head_branch === RELEASE_LINE && r.repository.full_name.toLowerCase() === 'westkitty/dex-reach') workflows.push(r);
  }
  for (const [name, workflow, file] of [['validate', 'DEX validation', '.github/workflows/ci.yml'], ['runtime-proof', 'DEX validation', '.github/workflows/ci.yml'], ['reproducible-build', 'DEX validation', '.github/workflows/ci.yml'], ['analyze', 'CodeQL', '.github/workflows/codeql.yml'], ['CodeQL', 'CodeQL', '.github/workflows/codeql.yml']]) {
    const matches = workflows.filter(r => r.name === workflow && r.path === file);
    if (matches.length !== 1) { rows.push({ name: name!, status: 'COMPLETED', conclusion: matches.length ? 'AMBIGUOUS' : 'MISSING' }); continue; }
    const owner = matches[0]!;
    if (name === 'CodeQL') { rows.push({ name, status: owner.status.toUpperCase(), conclusion: String(owner.conclusion ?? '').toUpperCase() }); continue; }
    if (owner.status !== 'completed' || owner.conclusion !== 'success') { rows.push({ name: name!, status: 'COMPLETED', conclusion: 'WORKFLOW_NOT_SUCCESS' }); continue; }
    for (const raw of c.check_runs) {
      if (!raw || typeof raw !== 'object') return [];
      const r = raw as Record<string, any>;
      if (typeof r.name !== 'string' || typeof r.head_sha !== 'string' || typeof r.status !== 'string' || !r.check_suite || !Number.isSafeInteger(r.check_suite.id) || !r.app || typeof r.app.slug !== 'string') return [];
      if (r.name === name && r.head_sha === sha && r.check_suite.id === owner.check_suite_id && r.app.slug === 'github-actions') rows.push({ name: name!, status: r.status.toUpperCase(), conclusion: String(r.conclusion ?? '').toUpperCase() });
    }
  }
  return rows;
}
/** Git resolves approved URL rewrites before this parser sees the transport URL. */
export function isCanonicalRepository(remote: string): boolean {
  return /^(?:git@github\.com:|ssh:\/\/git@github\.com\/|https:\/\/github\.com\/)westkitty\/DEX-REACH(?:\.git)?\/?$/i.test(remote);
}
export type ReleaseCandidateIdentity = Readonly<{ version: 1; repository: 'westkitty/DEX-REACH'; line: 'main'; checkout: typeof RELEASE_ROOT; sha: string; packageVersion: string; hostedEvent: 'push' }>;
export function releaseCandidateIdentity(f: Pick<PreflightFacts, 'root' | 'branch' | 'head' | 'remoteHead' | 'dirty' | 'repositoryUrl' | 'approvedSha' | 'candidateVersion' | 'approvedVersion'>): ReleaseCandidateIdentity | null {
  if (f.root !== RELEASE_ROOT || !['', RELEASE_LINE].includes(f.branch) || f.dirty || !isCanonicalRepository(f.repositoryUrl ?? '') || !/^[a-f0-9]{40}$/.test(f.head) || f.head !== f.remoteHead || f.head !== f.approvedSha || !/^\d+\.\d+\.\d+$/.test(f.candidateVersion) || f.candidateVersion !== f.approvedVersion) return null;
  return Object.freeze({ version: 1, repository: 'westkitty/DEX-REACH', line: 'main', checkout: RELEASE_ROOT, sha: f.head, packageVersion: f.candidateVersion, hostedEvent: 'push' });
}
export async function readReleaseHostedEvidence(sha: string, api: (endpoint: string) => Promise<string>): Promise<{ rows: ReturnType<typeof exactShaCheckRows>; available: boolean }> {
  if (!/^[a-f0-9]{40}$/.test(sha)) return { rows: [], available: false };
  try {
    const checks = JSON.parse(await api(`repos/westkitty/DEX-REACH/commits/${sha}/check-runs?filter=all&per_page=100`));
    const workflows = JSON.parse(await api(`repos/westkitty/DEX-REACH/actions/runs?head_sha=${sha}&per_page=100`));
    const rows = exactShaCheckRows(sha, checks, workflows);
    return { rows, available: rows.length > 0 };
  } catch { return { rows: [], available: false }; }
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
export type PreflightFacts = { hostname: string; model: string; platform: string; arch: string; user: string; uid: number; home: string; root: string; repositoryUrl?: string; branch: string; head: string; remoteHead: string; dirty: boolean; approvedSha?: string; candidateVersion: string; approvedVersion?: string; ciHead?: string; ciChecks: Record<string, string>; installedIntact: boolean; installedRelease: string; servicesVerified: boolean; backupCertified: boolean; baseline: Baseline; restoreProof: { scope: 'synthetic' | 'installed'; sourceSha: string; passed: boolean }; taskCount: number; taskUnresolved: number; taskQuarantined?: number; releaseScope?: 'local-runtime-only'; claimsKnown: boolean; claimsCount: number; ownerPreservationVerified: boolean; freeBytes: number; spaceMeasured: boolean; space: SpacePlan; exactLegacyPairingVerified: boolean; credentialsCompatible: boolean; requiredHostCapabilityAvailable: boolean; maintenanceAuthorized: boolean; boundary?: RecoveryBoundaryEvidence };
export function evaluatePreflight(f: PreflightFacts) {
  const checks: Record<string, boolean> = {
    EXACT_HOST: f.hostname === 'MacBook-Air.local' && f.model === 'MacBookAir10,1' && f.platform === 'darwin' && f.arch === 'arm64',
    EXACT_ACCOUNT: f.user === 'andrew' && f.uid === 501 && f.home === '/Users/andrew',
    EXACT_REPOSITORY: f.root === RELEASE_ROOT && isCanonicalRepository(f.repositoryUrl ?? ''),
    // The release line is main: either main itself or a detached HEAD, and REMOTE_PARITY pins it to main's exact tip.
    AUTHORIZED_BRANCH: f.branch === RELEASE_LINE || f.branch === '',
    CLEAN_SOURCE: !f.dirty && /^[a-f0-9]{40}$/.test(f.head),
    REMOTE_PARITY: f.head === f.remoteHead,
    HOSTED_CHECKS: f.ciHead === f.head && REQUIRED_HOSTED_CHECKS.every(k => f.ciChecks[k] === 'SUCCESS'),
    APPROVED_SHA: /^[a-f0-9]{40}$/.test(f.head) && f.approvedSha === f.head,
    INSTALLED_IDENTITY: f.installedIntact && f.installedRelease === RETAINED_RELEASE,
    FIVE_SERVICES: f.servicesVerified,
    BACKUP_COVERAGE: f.backupCertified,
    RECOVERY_BASELINE: baselineBlockers(f.baseline).length === 0,
    SYNTHETIC_RESTORE: f.restoreProof.scope === 'synthetic' && f.restoreProof.passed && f.restoreProof.sourceSha === f.head,
    // Every nonterminal record is either absent or owner-quarantined with a still-matching entry.
    NONTERMINAL_TASKS: Number.isInteger(f.taskCount) && f.taskCount >= 0 && f.taskUnresolved === 0 && f.taskCount === (f.taskQuarantined ?? 0),
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
  return { candidate: releaseCandidateIdentity(f), mode: 'READ_ONLY', installationExecuted: false, installationCommandAvailable: false, status: blockers.length ? 'BLOCKED' : 'PREREQUISITES_PASS_NO_INSTALLATION', releaseScope: f.releaseScope ?? 'unscoped', e7Verified: false, checks, blockers, recoveryBlockers: baselineBlockers(f.baseline), syntheticIsInstalledProof: false, states: { source: checks.CLEAN_SOURCE && checks.HOSTED_CHECKS ? 'SOURCE_VALIDATED' : 'SOURCE_UNVERIFIED', backup: checks.BACKUP_COVERAGE ? 'PRIVATE_BACKUP_CERTIFIED' : 'PRIVATE_BACKUP_UNVERIFIED', rollback: checks.RECOVERY_BASELINE ? 'ROLLBACK_BASELINE_VERIFIED' : 'ROLLBACK_BASELINE_UNVERIFIED', installation: blockers.length ? 'INSTALLATION_BLOCKED' : 'INSTALLATION_PREREQUISITES_PASS' } };
}
/**
 * The one-shot reload helper is idle when launchd shows it loaded, exited 0 and pid-less, or when launchd
 * has no such job at all (it is not kept across reboots) and no reload or installer process exists.
 * Any other launchctl failure is unknown and refuses.
 */
export function reloadHelperIdle(print: { output: string } | { notFound: true } | { error: true }, processTable: string): boolean {
  const reloading = /scripts\/(?:install-macos|rollback-macos|reload-launchagents)\.(?:ts|js)(?:\s|$)/m.test(processTable);
  if ('error' in print) return false;
  if ('notFound' in print) return !reloading;
  return /active count = 0/.test(print.output) && /last exit code = 0/.test(print.output) && !/\bpid = \d+/.test(print.output) && !reloading;
}
