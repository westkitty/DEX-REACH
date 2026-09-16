import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

export async function atomicWriteFile(file: string, data: string | Buffer, mode = 0o600): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    await fs.writeFile(temp, data, { mode });
    await fs.rename(temp, file);
  } finally {
    await fs.rm(temp, { force: true }).catch(() => undefined);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

type LockOwner = { pid: number; createdAt: number; token: string };
type HeldLock = { handle: fs.FileHandle; token: string; dev: number; ino: number };

async function exists(file: string): Promise<boolean> {
  try { await fs.access(file); return true; } catch { return false; }
}

async function openOwnedLock(file: string): Promise<HeldLock> {
  const token = crypto.randomUUID();
  const handle = await fs.open(file, 'wx', 0o600);
  try {
    await handle.writeFile(JSON.stringify({ pid: process.pid, createdAt: Date.now(), token } satisfies LockOwner) + '\n');
    const stat = await handle.stat();
    return { handle, token, dev: stat.dev, ino: stat.ino };
  } catch (error) {
    await handle.close().catch(() => undefined);
    await fs.rm(file, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function releaseOwnedLock(file: string, held: HeldLock): Promise<void> {
  await held.handle.close().catch(() => undefined);
  try {
    const stat = await fs.stat(file);
    // Never unlink a replacement lock created after this owner lost its path.
    if (stat.dev === held.dev && stat.ino === held.ino) await fs.unlink(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

async function lockCanBeRecovered(file: string, staleMs: number): Promise<boolean> {
  try {
    const raw = JSON.parse(await fs.readFile(file, 'utf8')) as Partial<LockOwner>;
    if (typeof raw.pid === 'number' && Number.isInteger(raw.pid) && raw.pid > 0) {
      try {
        process.kill(raw.pid, 0);
        return false;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'EPERM') return false;
        if (code === 'ESRCH') return true;
      }
    }
    const createdAt = typeof raw.createdAt === 'number' ? raw.createdAt : 0;
    return createdAt > 0 && Date.now() - createdAt > staleMs;
  } catch (error) {
    // A disappearing lock is normal handoff, not evidence of staleness. Returning true here was a
    // TOCTOU bug: a waiter could observe the old lock vanish, then unlink a newer owner's lock.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    try {
      const stat = await fs.stat(file);
      return Date.now() - stat.mtimeMs > staleMs;
    } catch (statError) {
      if ((statError as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw statError;
    }
  }
}

async function acquireRecoveryGuard(file: string): Promise<fs.FileHandle | null> {
  try {
    return await fs.open(`${file}.recovery`, 'wx', 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return null;
    throw error;
  }
}

async function recoverAndAcquire(file: string, staleMs: number): Promise<HeldLock | null> {
  const recoveryFile = `${file}.recovery`;
  const recovery = await acquireRecoveryGuard(file);
  if (!recovery) return null;
  try {
    // While the recovery guard exists, normal acquirers that race through an earlier check must
    // relinquish any primary lock they obtain. Re-check after taking the guard; another recovery
    // attempt may already have replaced the stale owner.
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (await exists(file)) {
        if (!(await lockCanBeRecovered(file, staleMs))) return null;
        await fs.unlink(file).catch(error => {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        });
      }
      try {
        return await openOwnedLock(file);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        // A normal acquirer may have crossed the recovery-guard check immediately before we
        // created the guard. It will see the guard after acquiring and release; give it a moment.
        await sleep(5);
      }
    }
    return null;
  } finally {
    await recovery.close().catch(() => undefined);
    await fs.rm(recoveryFile, { force: true }).catch(() => undefined);
  }
}

/**
 * Cross-process lock for short DEX state mutations. A crashed owner is recoverable; a live owner is
 * never evicted merely for being slow. Recovery is serialized and normal acquirers re-check the
 * recovery guard after creation, preventing a stale-lock waiter from deleting a replacement lock.
 */
export async function withFileLock<T>(
  file: string,
  fn: () => Promise<T>,
  options: { timeoutMs?: number; staleMs?: number } = {}
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 5000;
  const staleMs = options.staleMs ?? 60_000;
  const started = Date.now();
  const recoveryFile = `${file}.recovery`;
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });

  while (true) {
    let held: HeldLock | null = null;
    try {
      if (await exists(recoveryFile)) {
        await sleep(10);
        continue;
      }
      held = await openOwnedLock(file);
      if (await exists(recoveryFile)) {
        await releaseOwnedLock(file, held);
        held = null;
        await sleep(10);
        continue;
      }
      try {
        return await fn();
      } finally {
        await releaseOwnedLock(file, held);
        held = null;
      }
    } catch (error) {
      if (held) await releaseOwnedLock(file, held).catch(() => undefined);
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST') throw error;

      if (await lockCanBeRecovered(file, staleMs)) {
        const recovered = await recoverAndAcquire(file, staleMs);
        if (recovered) {
          try {
            return await fn();
          } finally {
            await releaseOwnedLock(file, recovered);
          }
        }
      }

      if (Date.now() - started >= timeoutMs) throw new Error(`timed out waiting for DEX state lock: ${path.basename(file)}`);
      await sleep(15 + Math.floor(Math.random() * 20));
    }
  }
}
