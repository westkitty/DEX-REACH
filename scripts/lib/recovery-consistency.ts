import crypto from 'node:crypto';
import { hashValue } from '../../src/shared/hash.js';
import { inspectCoverage, type Manifest } from './recovery-coverage.js';
import { assertOwned, type SyntheticWorkspace } from './recovery-rehearsal.js';
import type { LinkPolicy } from './recovery-symlinks.js';

/** Required writer roster. Existing production writers do not yet acknowledge this contract. */
export const SNAPSHOT_WRITERS = ['tasks-results-events', 'receipts', 'coordinator', 'policy-grants-budgets-plans', 'enrollment-revocation', 'oauth', 'runtime-installer', 'activity-audit-trace-checkpoints'] as const;
export type SnapshotWriter = typeof SNAPSHOT_WRITERS[number];
export type SnapshotBoundary = Readonly<{ scope: 'synthetic'; transactionId: string; generation: number; manifest: Manifest }>;
/** One snapshot engine, two boundary owners: the synthetic cohort and the writer-checkpoint holder. */
export type BoundaryOwner = { readonly workspace: SyntheticWorkspace; validate(boundary: SnapshotBoundary): Promise<void> };
const boundaries = new WeakMap<object, { owner: BoundaryOwner; fingerprint: string }>();
/** Internal: mint a boundary object whose only authority is this process-local registration. */
export function registerBoundary(owner: BoundaryOwner, transactionId: string, generation: number, manifest: Manifest): SnapshotBoundary {
  const boundary = Object.freeze({ scope: 'synthetic' as const, transactionId, generation, manifest });
  boundaries.set(boundary, { owner, fingerprint: fingerprint(manifest) }); return boundary;
}
export function boundaryFingerprintMatches(boundary: SnapshotBoundary, manifest: Manifest): boolean {
  const held = boundaries.get(boundary); return !!held && fingerprint(manifest) === held.fingerprint && fingerprint(boundary.manifest) === held.fingerprint;
}
export const fingerprint = (m: Manifest) => hashValue({ entries: m.entries, directories: m.directories, families: m.families, volumes: m.volumes, roots: m.roots, linkPolicy: m.linkPolicy });
/** A test-owned source contract, not a production quiescence command or JSON approval mechanism. */
export class SyntheticWriterCohort {
  private generation = 0;
  private active = 0;
  private poisoned = false;
  private frozen = false;
  private checkpoints = new Map<SnapshotWriter, number>();
  constructor(readonly workspace: SyntheticWorkspace) {}
  async write(writer: SnapshotWriter, action: () => Promise<void>): Promise<void> {
    await assertOwned(this.workspace);
    if (!SNAPSHOT_WRITERS.includes(writer) || this.frozen || this.poisoned) throw new Error('WRITER_ADMISSION_BLOCKED');
    this.active++; this.checkpoints.clear();
    try { await action(); this.generation++; } catch (error) { this.poisoned = true; throw error; }
    finally { this.active--; }
  }
  checkpoint(writer: SnapshotWriter): void {
    if (!SNAPSHOT_WRITERS.includes(writer) || this.active || this.frozen || this.poisoned) throw new Error('CHECKPOINT_UNPROVEN');
    this.checkpoints.set(writer, this.generation);
  }
  writerDied(): void { this.poisoned = true; this.checkpoints.clear(); }
  async freeze(policy?: LinkPolicy): Promise<SnapshotBoundary> {
    await assertOwned(this.workspace);
    if (this.active || this.frozen || this.poisoned || SNAPSHOT_WRITERS.some(w => this.checkpoints.get(w) !== this.generation)) throw new Error('WRITER_BOUNDARY_INCOMPLETE');
    this.frozen = true;
    try {
      const manifest = await inspectCoverage(this.workspace.source, 'synthetic', policy);
      if (!manifest.consistent || manifest.problems.length) throw new Error('SNAPSHOT_UNPROVEN');
      return registerBoundary(this, crypto.randomUUID(), this.generation, manifest);
    } catch (error) { this.poisoned = true; throw error; }
  }
  async validate(boundary: SnapshotBoundary): Promise<void> {
    const held = boundaries.get(boundary);
    await assertOwned(this.workspace);
    if (!held || held.owner !== this || this.poisoned || !this.frozen || this.active || boundary.generation !== this.generation || fingerprint(boundary.manifest) !== held.fingerprint) throw new Error('SNAPSHOT_BOUNDARY_UNTRUSTED');
    const current = await inspectCoverage(this.workspace.source, 'synthetic', boundary.manifest.linkPolicy);
    if (!current.consistent || current.problems.length || fingerprint(current) !== held.fingerprint) { this.poisoned = true; throw new Error('SNAPSHOT_GENERATION_CHANGED'); }
  }
}
export async function validateBoundary(boundary: SnapshotBoundary, workspace: SyntheticWorkspace): Promise<void> {
  const held = boundaries.get(boundary);
  if (!held || held.owner.workspace !== workspace) throw new Error('SNAPSHOT_BOUNDARY_UNTRUSTED');
  await held.owner.validate(boundary);
}
export function liveSnapshotEligibility(): { eligible: false; reason: string } {
  return { eligible: false, reason: 'LIVE_WRITER_CHECKPOINT_ADAPTER_UNAVAILABLE_REQUIRES_SEPARATE_AUTHORITY' };
}
