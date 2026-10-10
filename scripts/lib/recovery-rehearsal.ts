import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { inspectCoverage, verifyCoverage, type Manifest, type Roots } from './recovery-coverage.js';
import { realDirectory, safeRead } from './recovery-reconciliation.js';
import { verifyRestoredApplication } from './recovery-application.js';

const owned = new WeakMap<object, { directory: string; roots: Roots; inode: number }>();
export type SyntheticWorkspace = { directory: string; source: Roots; cleanup(): Promise<void> };
/** The only restore-write capability is minted here, under the real OS temporary directory. */
export async function createSyntheticWorkspace(): Promise<SyntheticWorkspace> {
  const directory = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'dex-c14-recovery-'));
  await fs.chmod(directory, 0o700);
  const source: Roots = { state: path.join(directory, 'source/state'), agents: path.join(directory, 'source/agents'), worker: path.join(directory, 'source/worker') };
  for (const root of Object.values(source)) await fs.mkdir(root, { recursive: true, mode: 0o700 });
  const workspace: SyntheticWorkspace = { directory, source, cleanup: async () => { await assertOwned(workspace); await fs.rm(directory, { recursive: true }); owned.delete(workspace); } };
  owned.set(workspace, { directory, roots: { ...source }, inode: (await fs.lstat(directory)).ino }); return workspace;
}
async function assertOwned(workspace: SyntheticWorkspace): Promise<void> {
  const original = owned.get(workspace);
  if (!original) throw new Error('UNOWNED_FIXTURE');
  if (workspace.directory !== original.directory || JSON.stringify(workspace.source) !== JSON.stringify(original.roots) || (await fs.lstat(original.directory)).ino !== original.inode) throw new Error('FIXTURE_IDENTITY_CHANGED');
  await realDirectory(workspace.directory);
  for (const [key, root] of Object.entries(workspace.source)) {
    if (root !== path.join(workspace.directory, 'source', key)) throw new Error('FIXTURE_ROOT_CHANGED');
    await realDirectory(root);
  }
}
/** Copy only certified synthetic data to a new, empty tool-owned destination. Never launches services. */
export async function rehearseRestore(workspace: SyntheticWorkspace, manifest: Manifest, trustedDigest: string): Promise<{ scope: 'synthetic'; passed: true; roots: Roots }> {
  await assertOwned(workspace);
  if (manifest.scope !== 'synthetic' || JSON.stringify(manifest.roots) !== JSON.stringify(workspace.source)) throw new Error('LIVE_OR_FOREIGN_SNAPSHOT_REFUSED');
  await verifyCoverage(manifest, workspace.source, trustedDigest);
  const target = await fs.mkdtemp(path.join(workspace.directory, 'restore-'));
  const roots: Roots = { state: path.join(target, 'state'), agents: path.join(target, 'agents'), worker: path.join(target, 'worker') };
  for (const root of Object.values(roots)) await fs.mkdir(root, { mode: 0o700 });
  try {
    for (const d of manifest.directories) {
      const destination = path.join(roots[d.root], d.relative);
      await fs.mkdir(destination, { recursive: true, mode: d.mode });
      await realDirectory(destination); await fs.chmod(destination, d.mode);
    }
    for (const e of manifest.entries) {
      await assertOwned(workspace);
      const destination = path.join(roots[e.root], e.relative);
      await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
      await realDirectory(path.dirname(destination));
      const bytes = await safeRead(workspace.source[e.root], e.relative, 512 * 1024 * 1024);
      await fs.writeFile(destination, bytes, { flag: 'wx', mode: e.mode });
      await fs.chmod(destination, e.mode);
    }
    await verifyCoverage(manifest, roots, trustedDigest);
    await verifyRestoredApplication(roots);
    await verifyCoverage(manifest, workspace.source, trustedDigest);
    return { scope: 'synthetic', passed: true, roots };
  } catch (error) { await fs.rm(target, { recursive: true }); throw error; }
}
