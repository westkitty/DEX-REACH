import fs from 'node:fs/promises';
import path from 'node:path';

export type InstallLock = {
  path: string;
  handoff: () => Promise<void>;
  release: () => Promise<void>;
};

type LockOwner = {
  pid: number;
  startedAt: string;
  state: 'installer' | 'handoff' | 'helper';
  handoffAt?: string;
};

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

async function writeOwner(lockDir: string, owner: LockOwner): Promise<void> {
  await fs.writeFile(path.join(lockDir, 'owner.json'), JSON.stringify(owner) + '\n', { mode: 0o600 });
}

function recentHandoff(owner: LockOwner | null, now = Date.now()): boolean {
  if (owner?.state !== 'handoff' || !owner.handoffAt) return false;
  const at = Date.parse(owner.handoffAt);
  return Number.isFinite(at) && now - at < 60_000;
}

/**
 * Only one macOS install may own service staging/replacement at a time.
 * Concurrent retries fail quickly instead of serializing into repeated builds/service cycles.
 */
export async function acquireInstallLock(stateDir: string): Promise<InstallLock> {
  const lockDir = path.join(stateDir, 'runtime', 'install.lock');
  await fs.mkdir(path.dirname(lockDir), { recursive: true, mode: 0o700 });

  try {
    await fs.mkdir(lockDir, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const owner = await readOwner(lockDir);
    if ((owner && pidAlive(owner.pid)) || recentHandoff(owner)) {
      throw new Error(`another DEX//REACH macOS install is already active${owner ? ` (pid ${owner.pid}, state ${owner.state})` : ''}`);
    }
    await fs.rm(lockDir, { recursive: true, force: true });
    await fs.mkdir(lockDir, { mode: 0o700 });
  }

  const startedAt = new Date().toISOString();
  await writeOwner(lockDir, { pid: process.pid, startedAt, state: 'installer' });

  return {
    path: lockDir,
    handoff: async () => {
      await writeOwner(lockDir, {
        pid: process.pid,
        startedAt,
        state: 'handoff',
        handoffAt: new Date().toISOString()
      });
    },
    release: async () => {
      await fs.rm(lockDir, { recursive: true, force: true });
    }
  };
}

/** The one-shot helper claims the install lock for its own lifetime. */
export async function claimInstallLock(lockDir: string): Promise<void> {
  const owner = await readOwner(lockDir);
  if (!owner) throw new Error('install lock disappeared before helper claimed it');
  await writeOwner(lockDir, {
    pid: process.pid,
    startedAt: owner.startedAt,
    state: 'helper',
    handoffAt: owner.handoffAt
  });
}

export async function releaseInstallLock(lockDir: string | undefined): Promise<void> {
  if (!lockDir) return;
  await fs.rm(lockDir, { recursive: true, force: true });
}
