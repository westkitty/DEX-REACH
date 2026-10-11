import fs from 'node:fs/promises';
import path from 'node:path';
import { realDirectory } from './recovery-reconciliation.js';
import { requiredFreeBytes, type SpacePlan } from './c14-recovery-preflight.js';
import type { Roots } from './recovery-coverage.js';

export type DestinationFacts = { root: string; approvedRoot: string; approved: boolean; device: number; approvedDevice: number; inode: number; approvedInode: number; mountIdentity: string; approvedMountIdentity: string; ownerUid: number; expectedUid: number; mode: number; writable: boolean; cloudSynced: boolean; cloudApproved: boolean; encrypted: boolean; durable: boolean; freeBytes: number; measured: boolean; space: SpacePlan; sources: Roots; gitRoots: string[] };
const overlaps = (a: string, b: string) => a === b || a.startsWith(b + path.sep) || b.startsWith(a + path.sep);
export function destinationBlockers(f: DestinationFacts): string[] {
  const errors: string[] = [];
  if (!path.isAbsolute(f.root) || f.root !== path.resolve(f.root) || f.root !== f.approvedRoot || !f.approved) errors.push('DESTINATION_UNAPPROVED');
  if (!Number.isSafeInteger(f.device) || f.device !== f.approvedDevice || !Number.isSafeInteger(f.inode) || f.inode !== f.approvedInode || !f.mountIdentity || f.mountIdentity !== f.approvedMountIdentity) errors.push('DESTINATION_IDENTITY_CHANGED');
  if (f.ownerUid !== f.expectedUid || (f.mode & 0o077) !== 0 || !f.writable || !f.encrypted || !f.durable) errors.push('DESTINATION_PRIVACY_OR_DURABILITY_UNPROVEN');
  if (Object.values(f.sources).some(r => overlaps(path.resolve(r), f.root))) errors.push('DESTINATION_SOURCE_OVERLAP');
  if (!f.gitRoots.length || f.gitRoots.some(r => overlaps(path.resolve(r), f.root))) errors.push('DESTINATION_GIT_OVERLAP_OR_UNKNOWN');
  if (f.cloudSynced && !f.cloudApproved) errors.push('CLOUD_DESTINATION_UNAPPROVED');
  try { if (!f.measured || !Number.isSafeInteger(f.freeBytes) || f.freeBytes < requiredFreeBytes(f.space)) errors.push('DESTINATION_SPACE_UNPROVEN'); } catch { errors.push('DESTINATION_SPACE_UNPROVEN'); }
  return errors;
}
/** Read-only facts, no destination selection, mkdir, probe write, or owner approval inference. */
export async function inspectDestination(root: string) {
  await realDirectory(root); const st = await fs.lstat(root), volume = await fs.statfs(root);
  return { root: path.resolve(root), device: st.dev, inode: st.ino, uid: st.uid, mode: st.mode & 0o777, freeBytes: volume.bavail * volume.bsize, approval: 'UNVERIFIED', encryption: 'UNVERIFIED', durability: 'UNVERIFIED' };
}
