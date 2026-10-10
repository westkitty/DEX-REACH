import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { hashValue } from '../../src/shared/hash.js';
import { realDirectory } from './recovery-reconciliation.js';
import { inspectCoverage, verifyCoverage, withFencedLocks, type Manifest, type Roots } from './recovery-coverage.js';
import { defaultLinkPolicy, type LinkPolicy } from './recovery-symlinks.js';
import { recoveryStoragePlan } from './recovery-storage.js';
import { requiredFreeBytes } from './c14-recovery-preflight.js';
import { destinationBlockers, type DestinationFacts } from './recovery-destination.js';
import { verifyRestoredApplication } from './recovery-application.js';
import { artifactDigest, type ExpectationStore, type TransactionEvidenceLog } from './recovery-evidence.js';
import { materializeManifest, syncDirectories, durableWrite, stagingRoots } from './recovery-capture.js';
import { WRITER_OWNERSHIP, nestedLocks, refusalCode } from './recovery-checkpoint.js';

const execFileAsync = promisify(execFile);
export const SERVICE_ROLES = ['coordinator', 'worker', 'gateway', 'node', 'oauth-canary'] as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
/** Any process that can write DEX state: services (compiled or tsx), the adapter child, maintenance scripts. */
const WRITER_PROCESS = /(?:dist\/src|\bsrc)\/(?:gateway|node|coordinator|worker)\/main\.(?:js|ts)(?:\s|$)|scripts\/oauth-canary\.(?:js|ts)(?:\s|$)|\/runtime\/releases\/\S*desktop-commander/m;

export type HostProbe = { launchctlPrint(label: string): Promise<boolean>; processTable(): Promise<string>; selfPid: number };
/** Production probe. `launchctlPrint` is true when launchd still has the job loaded in the user domain. */
export function hostProbe(uid = process.getuid?.() ?? -1): HostProbe {
  return {
    launchctlPrint: async label => execFileAsync('/bin/launchctl', ['print', `gui/${uid}/${label}`], { timeout: 10_000 }).then(() => true, (error: NodeJS.ErrnoException & { killed?: boolean }) => {
      // launchctl exits non-zero with "Could not find service" for a booted-out job; a timeout or a
      // missing launchctl is not proof of absence.
      if (error.killed || error.code === 'ENOENT') throw new Error('QUIESCENCE_UNOBSERVABLE');
      return false;
    }),
    processTable: async () => (await execFileAsync('/bin/ps', ['-axo', 'pid=,command='], { timeout: 10_000, maxBuffer: 16 * 1024 * 1024 })).stdout,
    selfPid: process.pid
  };
}

/**
 * Offline quiescence: every DEX LaunchAgent booted out and no process able to write DEX state. This is
 * the strongest boundary available for the installed C13 runtime, which has no checkpoint participant.
 * It is only ever observed; this module never stops, starts or signals anything.
 */
export async function offlineQuiescenceBlockers(probe: HostProbe, state: string): Promise<string[]> {
  const blockers: string[] = [];
  for (const role of SERVICE_ROLES) if (await probe.launchctlPrint(`com.stinkyweasel.dex-reach.${role}`)) blockers.push(`SERVICE_LOADED:${role}`);
  const rows = (await probe.processTable()).split('\n').map(l => l.trim()).filter(Boolean);
  const installer = WRITER_OWNERSHIP.find(m => m.group === 'runtime-installer')!.processAbsence!;
  for (const row of rows) {
    const [pid] = row.split(/\s+/, 1);
    if (Number(pid) === probe.selfPid) continue;
    if (WRITER_PROCESS.test(row)) blockers.push('WRITER_PROCESS_PRESENT');
    else if (installer.test(row)) blockers.push('MAINTENANCE_PROCESS_PRESENT');
  }
  for (const name of ['leases', 'queue']) {
    const entries = await fs.readdir(path.join(state, 'coordinator', name)).catch((e: NodeJS.ErrnoException) => e.code === 'ENOENT' ? [] : Promise.reject(e));
    if (entries.length) blockers.push('COORDINATOR_CLAIM_PRESENT');
  }
  return [...new Set(blockers)];
}

export type OfflineCaptureRequest = {
  nodeId: 'macbook-air.local';
  transactionId: string;
  roots: Roots;
  destination: DestinationFacts;
  log: TransactionEvidenceLog;
  expectations: ExpectationStore;
  probe: HostProbe;
  linkPolicy?: LinkPolicy;
  lockTimeoutMs?: number;
  /** Test-only fault seams; production callers pass nothing. */
  hooks?: Partial<Record<'afterFence' | 'afterCopy' | 'afterRestore', () => Promise<void>>>;
};
export type OfflineCaptureOutcome = Readonly<{
  status: 'OFFLINE_BACKUP_CERTIFIED' | 'REFUSED' | 'FAILED_UNCERTAIN'; transactionId: string; reason?: string;
  manifestDigest?: string; artifactDigest?: string; files?: number; bytes?: number; preservedNonterminalTasks?: number;
  retryAuthorized: false; installationAuthority: false; servicesRestarted: false;
}>;

async function nonterminalCount(state: string): Promise<number> {
  const raw = JSON.parse(await fs.readFile(path.join(state, 'tasks', 'store.json'), 'utf8')) as { records?: Record<string, { state?: string }> };
  return Object.values(raw.records ?? {}).filter(r => !['COMPLETED', 'FAILED', 'CANCELLED', 'AMBIGUOUS'].includes(r.state ?? '')).length;
}

/**
 * Capture the stopped installation once, into a fresh transaction directory, then certify it only after
 * an isolated application restore and an unchanged re-observation of the source. Any failure before the
 * copy starts is REFUSED; any failure after is FAILED_UNCERTAIN and is never retried here. The owner or
 * an operator stops and restarts services; this function does neither.
 */
export async function captureOffline(req: OfflineCaptureRequest): Promise<OfflineCaptureOutcome> {
  const { transactionId: txn, roots, destination: facts, log } = req;
  const base = { transactionId: txn, retryAuthorized: false as const, installationAuthority: false as const, servicesRestarted: false as const };
  if (req.nodeId !== 'macbook-air.local' || !UUID.test(txn)) return Object.freeze({ ...base, status: 'REFUSED' as const, reason: 'OFFLINE_REQUEST_INVALID' });
  await log.append(txn, 'PREPARED', { mode: 'offline-services-stopped' });
  let started = false;
  const refuse = async (reason: string) => { await log.append(txn, 'REFUSED', { reason }); return Object.freeze({ ...base, status: 'REFUSED' as const, reason }); };
  const fail = async (reason: string) => { await log.append(txn, 'FAILED', { reason }); return Object.freeze({ ...base, status: 'FAILED_UNCERTAIN' as const, reason }); };
  try {
    if (JSON.stringify(facts.sources) !== JSON.stringify(roots)) return await refuse('DESTINATION_SOURCE_BINDING');
    const destinationIssues = destinationBlockers(facts);
    if (destinationIssues.length) return await refuse(destinationIssues[0]!);
    const quiet = await offlineQuiescenceBlockers(req.probe, roots.state);
    if (quiet.length) return await refuse(quiet[0]!);
    await log.append(txn, 'ACKNOWLEDGED', { quiescence: 'SERVICES_BOOTED_OUT_NO_WRITER_PROCESSES', services: SERVICE_ROLES.length });

    const locks: string[] = [];
    for (const m of WRITER_OWNERSHIP) for (const file of m.locks(roots.state, req.nodeId)) if (await fs.lstat(path.dirname(file)).then(s => s.isDirectory(), () => false)) locks.push(file);
    return await nestedLocks(locks, req.lockTimeoutMs ?? 2_000, async () => {
      await log.append(txn, 'FENCED', { lockCount: locks.length });
      await req.hooks?.afterFence?.();
      const heldLocks = new Set(locks.map(f => path.resolve(f)));
      return await withFencedLocks(heldLocks, async () => {
        const observe = () => inspectCoverage(roots, 'inspection', req.linkPolicy ?? defaultLinkPolicy(), { heldLocks });
        const manifest: Manifest = await observe();
        if (!manifest.consistent || manifest.problems.length) return await refuse('SNAPSHOT_UNPROVEN');
        const reprove = async () => {
          const again = await offlineQuiescenceBlockers(req.probe, roots.state);
          if (again.length) throw new Error('QUIESCENCE_LOST');
        };
        await reprove();
        const plan = recoveryStoragePlan(manifest);
        if (facts.space.backupBytes < plan.backupBytes || facts.space.restoreBytes < plan.restoreBytes || facts.space.stagingBytes < plan.stagingBytes) return await refuse('CAPTURE_BUDGET_UNDERESTIMATED');
        const before = await fs.lstat(await realDirectory(facts.root)), capacity = await fs.statfs(facts.root);
        if (before.ino !== facts.approvedInode || before.dev !== facts.approvedDevice || before.uid !== facts.expectedUid || (before.mode & 0o077)) return await refuse('DESTINATION_CHANGED');
        if (capacity.bavail * capacity.bsize < requiredFreeBytes(facts.space)) return await refuse('CAPTURE_CAPACITY_CHANGED');
        const staging = path.join(facts.root, txn), restoreCheck = path.join(facts.root, `${txn}.restore-check`);
        if (await fs.lstat(staging).then(() => true, () => false) || await fs.lstat(restoreCheck).then(() => true, () => false)) return await refuse('TRANSACTION_ALREADY_EXISTS_INSPECT_ONLY');
        const preserved = await nonterminalCount(roots.state);
        const generation = hashValue({ mode: 'offline-services-stopped', manifestDigest: manifest.digest, services: SERVICE_ROLES });
        // Independent expectation first: the backup can never supply the digest it is checked against.
        await req.expectations.record(txn, manifest.digest, generation);

        await log.append(txn, 'CAPTURING', {});
        started = true;
        const captured = await materializeManifest(manifest, roots, staging);
        await req.hooks?.afterCopy?.();
        await verifyCoverage(manifest, captured, manifest.digest);
        await durableWrite(path.join(staging, 'manifest.private.json'), Buffer.from(JSON.stringify(manifest)), 0o600);
        await syncDirectories(staging);
        const parent = await fs.open(facts.root, 'r'); try { await parent.sync(); } finally { await parent.close(); }
        const artifact = await artifactDigest(staging);
        await log.append(txn, 'CAPTURED', { manifestDigest: manifest.digest, artifactDigest: artifact });

        // Isolated application restore from the backup bytes, never from the live source.
        const restored = await materializeManifest(manifest, captured, restoreCheck);
        await verifyCoverage(manifest, restored, manifest.digest);
        await verifyRestoredApplication(restored);
        await req.hooks?.afterRestore?.();
        await fs.rm(restoreCheck, { recursive: true });
        await log.append(txn, 'RESTORE_VERIFIED', {});

        // Last word: still quiescent, source unchanged, backup bytes unchanged, destination unchanged.
        await reprove();
        await verifyCoverage(manifest, roots, manifest.digest);
        if (await artifactDigest(staging) !== artifact) throw new Error('ARTIFACT_CHANGED_BEFORE_CERTIFICATION');
        const now = await fs.lstat(facts.root);
        if (now.ino !== before.ino || now.dev !== before.dev || now.mode !== before.mode || now.uid !== before.uid) throw new Error('DESTINATION_CHANGED');
        await log.append(txn, 'CERTIFIED', { manifestDigest: manifest.digest, artifactDigest: artifact });
        const files = manifest.entries.length, bytes = manifest.totalBytes;
        return Object.freeze({ ...base, status: 'OFFLINE_BACKUP_CERTIFIED' as const, manifestDigest: manifest.digest, artifactDigest: artifact, files, bytes, preservedNonterminalTasks: preserved });
      });
    });
  } catch (error) {
    const code = refusalCode(error);
    return started ? await fail(code) : await refuse(code);
  }
}
export { stagingRoots };
