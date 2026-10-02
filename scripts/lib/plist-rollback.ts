import fs from 'node:fs/promises';
import path from 'node:path';
import { atomicWriteFile } from '../../src/shared/state-io.js';

export async function snapshotPlist(target: string, backup: string): Promise<boolean> {
  try {
    const bytes = await fs.readFile(target);
    await fs.mkdir(path.dirname(backup), { recursive: true, mode: 0o700 });
    await atomicWriteFile(backup, bytes, 0o600);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

export async function restorePlist(target: string, backup?: string): Promise<'restored' | 'removed'> {
  if (!backup) {
    await fs.rm(target, { force: true });
    return 'removed';
  }
  const bytes = await fs.readFile(backup);
  await atomicWriteFile(target, bytes, 0o600);
  return 'restored';
}
