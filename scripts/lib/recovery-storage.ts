import type { Manifest } from './recovery-coverage.js';
import type { SpacePlan } from './c14-recovery-preflight.js';
/** Conservative allocation budget; logical bytes alone undercount many small records. */
export function recoveryStoragePlan(m: Manifest, candidateBytes = 0, dependencyBytes = 0, retainedBytes = 0): SpacePlan {
  if (!m.consistent || m.problems.length) throw new Error('BACKUP_SIZE_UNKNOWN');
  const block = (n: number) => Math.max(4096, Math.ceil(n / 4096) * 4096);
  const payload = m.entries.reduce((n, e) => n + block(e.bytes), 0) + m.directories.length * 4096;
  const metadata = block(Buffer.byteLength(JSON.stringify(m))) + 64 * 1024;
  return { candidateBytes, dependencyBytes, retainedBytes, backupBytes: payload + metadata, restoreBytes: payload, stagingBytes: 128 * 1024 ** 2, reserveBytes: 2 * 1024 ** 3 };
}
/**
 * Admission-time size estimate before the writer fence exists, when a live scan cannot be consistent
 * (for example, dead-owner locks the fence will reclaim). It is never a certification input: the
 * capture re-plans from its fenced, consistent manifest and refuses if this estimate was too small.
 */
export function recoveryStorageEstimate(m: Manifest, candidateBytes = 0): SpacePlan {
  const block = (n: number) => Math.max(4096, Math.ceil(n / 4096) * 4096);
  const payload = Math.ceil((m.entries.reduce((n, e) => n + block(e.bytes), 0) + m.directories.length * 4096) * 1.1);
  const metadata = block(Buffer.byteLength(JSON.stringify(m))) + 64 * 1024;
  return { candidateBytes, dependencyBytes: 0, retainedBytes: 0, backupBytes: payload + metadata, restoreBytes: payload, stagingBytes: 128 * 1024 ** 2, reserveBytes: 2 * 1024 ** 3 };
}
