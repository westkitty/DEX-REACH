import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';

export type InstallLock = {
  path: string;
  release: () => Promise<void>;
};

type LockOwner = { pid: number; startedAt: string };

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function readOwner(lockDir: string): Promise<LockOwner | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(path.join(lockDir, 'owner.json'), 'utf8')) as LockOwner;
    if (!Number.isInteger(parsed.pid) || typeof parsed.startedAt !== 'string') return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Only one macOS install may own service staging/replacement at a time.
 * A crashed installer leaves a directory behind; the next installer may reclaim it only when its
 * recorded PID is no longer alive. We deliberately do not "wait and then also install": concurrent
 * retries must collapse to one owner rather than serialize into repeated service cycles.
 */
export async function acquireInstallLock(stateDir: string): Promise<InstallLock> {
  const lockDir = path.join(stateDir, 'runtime', 'install.lock');
  await fs.mkdir(path.dirname(lockDir), { recursive: true, mode: 0o700 });

  try {
    await fs.mkdir(lockDir, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const owner = await readOwner(lockDir);
    if (owner && pidAlive(owner.pid)) {
      throw new Error(`another DEX//REACH macOS install is already active (pid ${owner.pid})`);
    }
    await fs.rm(lockDir, { recursive: true, force: true });
    await fs.mkdir(lockDir, { mode: 0o700 });
  }

  await fs.writeFile(
    path.join(lockDir, 'owner.json'),
    JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }) + '\n',
    { mode: 0o600 }
  );

  let released = false;
  const releaseSync = () => {
    if (released) return;
    released = true;
    try { fsSync.rmSync(lockDir, { recursive: true, force: true }); } catch {}
  };
  process.once('exit', releaseSync);

  return {
    path: lockDir,
    release: async () => {
      if (released) return;
      released = true;
      process.removeListener('exit', releaseSync);
      await fs.rm(lockDir, { recursive: true, force: true });
    }
  };
}
