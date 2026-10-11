import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import type { SyntheticWorkspace } from '../../scripts/lib/recovery-rehearsal.js';
import type { HostProbe } from '../../scripts/lib/recovery-offline-capture.js';
import { captureOffline } from '../../scripts/lib/recovery-offline-capture.js';
import { TransactionEvidenceLog, ExpectationStore } from '../../scripts/lib/recovery-evidence.js';
import { inspectCoverage } from '../../scripts/lib/recovery-coverage.js';
import { recoveryStoragePlan } from '../../scripts/lib/recovery-storage.js';
import type { DestinationFacts } from '../../scripts/lib/recovery-destination.js';
import { COMPAT_HOME_PRESERVATION_RULE } from '../../scripts/lib/recovery-symlinks.js';

/** The compat-home preservation policy, used by the tests that need it explicitly. */
export const COMPAT_POLICY = { version: 1 as const, rules: [COMPAT_HOME_PRESERVATION_RULE] };

export const nodeId = 'macbook-air.local' as const;
export const quietProbe = (overrides: Partial<HostProbe> = {}): HostProbe => ({ launchctlPrint: async () => false, processTable: async () => '', selfPid: process.pid, ...overrides });

/** Offline-capture harness shared by recovery tests: private evidence roots, an approved synthetic destination, quiet host. */
export async function captureHarness(w: SyntheticWorkspace) {
  // The shared fixtures carry a stale coordinator lease; an offline window requires none.
  await fs.rm(path.join(w.source.state, 'coordinator/leases/synthetic.json'), { force: true });
  const priv = async (name: string) => { const d = path.join(w.directory, name); await fs.mkdir(d, { mode: 0o700 }); return d; };
  const root = await priv('backups'), evidenceRoot = await priv('evidence'), expectationRoot = await priv('expectations');
  const forbidden = [...Object.values(w.source), root];
  const log = await TransactionEvidenceLog.open(evidenceRoot, nodeId, forbidden);
  const expectations = await ExpectationStore.open(expectationRoot, nodeId, [...forbidden, evidenceRoot]);
  // Budget from the owner-excluded inventory: the owner-approved capture is what the destination must hold.
  const manifest = await inspectCoverage(w.source, 'inspection', undefined, { ownerExclusions: true });
  const st = await fs.lstat(root), v = await fs.statfs(root);
  const destination: DestinationFacts = { root, approvedRoot: root, approved: true, device: st.dev, approvedDevice: st.dev, inode: st.ino, approvedInode: st.ino, mountIdentity: 'synthetic-volume', approvedMountIdentity: 'synthetic-volume', ownerUid: st.uid, expectedUid: st.uid, mode: 0o700, writable: true, cloudSynced: false, cloudApproved: false, encrypted: true, durable: true, freeBytes: v.bavail * v.bsize, measured: true, space: recoveryStoragePlan(manifest), sources: w.source, gitRoots: ['/synthetic/git'] };
  const request = (overrides: Partial<Parameters<typeof captureOffline>[0]> = {}) => ({ nodeId, transactionId: crypto.randomUUID(), sourceSha: 'c'.repeat(40), roots: w.source, destination, log, expectations, probe: quietProbe(), ...overrides });
  return { w, root, log, expectations, destination, request, capture: (overrides: Partial<Parameters<typeof captureOffline>[0]> = {}) => captureOffline(request(overrides) as Parameters<typeof captureOffline>[0]) };
}
