// Holder side of the multi-process checkpoint tests. Runs inside its own child process.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fixture } from './recovery-fixture.js';
import { inspectCoverage } from '../../scripts/lib/recovery-coverage.js';
import { recoveryStoragePlan } from '../../scripts/lib/recovery-storage.js';
import { runWriterCheckpoint, type CheckpointConfig } from '../../scripts/lib/recovery-checkpoint.js';
import { ExpectationStore, TransactionEvidenceLog, reconcileTransaction } from '../../scripts/lib/recovery-evidence.js';
import type { DestinationFacts } from '../../scripts/lib/recovery-destination.js';
import type { SyntheticWorkspace } from '../../scripts/lib/recovery-rehearsal.js';

const nodeId = 'macbook-air.local';
let w: SyntheticWorkspace | undefined, facts: DestinationFacts | undefined, log: TransactionEvidenceLog | undefined, expectations: ExpectationStore | undefined;
let paths: Record<string, string> = {};
const resumes = new Map<string, () => void>();
export function resume(name: string): void { resumes.get(name)?.(); resumes.delete(name); }

async function privateDir(prefix: string) { const d = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), prefix)); await fs.chmod(d, 0o700); return d; }
async function openStores() {
  const forbidden = [paths.destination!, paths.state!, paths.agents!, paths.worker!];
  log = await TransactionEvidenceLog.open(paths.evidence!, nodeId, [...forbidden, paths.expectations!]);
  expectations = await ExpectationStore.open(paths.expectations!, nodeId, [...forbidden, paths.evidence!]);
}
export async function handle(c: Record<string, unknown>, notify: (hook: string) => void): Promise<unknown> {
  if (c.cmd === 'setup') {
    w = await fixture();
    // The fixture's synthetic lease is coordinator activity; checkpoint admission requires none.
    await fs.rm(path.join(w.source.state, 'coordinator/leases/synthetic.json'));
    const destination = path.join(w.directory, 'backups'); await fs.mkdir(destination, { mode: 0o700 });
    paths = { workspace: w.directory, state: w.source.state, agents: w.source.agents, worker: w.source.worker, destination, control: await privateDir('dexcp-'), evidence: await privateDir('dexev-'), expectations: await privateDir('dexex-') };
    const st = await fs.lstat(destination), v = await fs.statfs(destination), plan = recoveryStoragePlan(await inspectCoverage(w.source, 'synthetic'));
    // Generous measured budget: participants add records before capture.
    const space = { ...plan, backupBytes: plan.backupBytes + 8 * 1024 ** 2, restoreBytes: plan.restoreBytes + 8 * 1024 ** 2 };
    facts = { root: destination, approvedRoot: destination, approved: true, device: st.dev, approvedDevice: st.dev, inode: st.ino, approvedInode: st.ino, mountIdentity: 'synthetic-volume', approvedMountIdentity: 'synthetic-volume', ownerUid: st.uid, expectedUid: st.uid, mode: 0o700, writable: true, cloudSynced: false, cloudApproved: false, encrypted: true, durable: true, freeBytes: v.bavail * v.bsize, measured: true, space, sources: w.source, gitRoots: ['/synthetic/git'] };
    await openStores();
    return paths;
  }
  if (c.cmd === 'attach') { paths = c.paths as Record<string, string>; await openStores(); return true; }
  if (c.cmd === 'run') {
    const hooks: CheckpointConfig['hooks'] = {};
    for (const [name, action] of Object.entries((c.hooks ?? {}) as Record<string, string>)) {
      (hooks as Record<string, () => Promise<void>>)[name] = async () => {
        if (action === 'crash') process.exit(7);
        if (action === 'throw') throw new Error(`SYNTHETIC_FAULT_${name}`);
        notify(name); await new Promise<void>(r => resumes.set(name, r));
      };
    }
    const o = (c.options ?? {}) as Partial<CheckpointConfig>;
    const destination = c.badBudget ? { ...facts!, space: { ...facts!.space, backupBytes: 1 } } : facts!;
    return runWriterCheckpoint({ workspace: w!, nodeId, controlDirectory: (c.control as string) ?? paths.control!, destination, log: log!, expectations: expectations!, holdMs: o.holdMs ?? 30_000, drainMs: o.drainMs ?? 3_000, responseMs: o.responseMs ?? 3_000, lockTimeoutMs: o.lockTimeoutMs ?? 1_500, processTable: async () => String(c.processTable ?? ''), hooks });
  }
  if (c.cmd === 'reconcile') return reconcileTransaction(log!, expectations!, paths.destination!, String(c.txn));
  if (c.cmd === 'evidence') return (await log!.read(String(c.txn))).map(r => r.state);
  if (c.cmd === 'cleanup') { await w?.cleanup().catch(() => undefined); for (const k of ['control', 'evidence', 'expectations']) if (paths[k]) await fs.rm(paths[k]!, { recursive: true, force: true }); return true; }
  throw new Error(`UNKNOWN_HOLDER_COMMAND:${String(c.cmd)}`);
}
