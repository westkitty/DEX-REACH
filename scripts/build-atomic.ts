import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';

const execFileAsync = promisify(execFile);

export async function replaceBuiltDirectory(root: string, stagedDir: string, finalDir: string, backupDir: string): Promise<void> {
  let movedCurrent = false;
  try {
    try {
      await fs.rename(finalDir, backupDir);
      movedCurrent = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }

    try {
      await fs.rename(stagedDir, finalDir);
    } catch (error) {
      if (movedCurrent) await fs.rename(backupDir, finalDir).catch(() => undefined);
      throw error;
    }

    if (movedCurrent) await fs.rm(backupDir, { recursive: true, force: true });
  } finally {
    await fs.rm(stagedDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

export async function atomicBuild(root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')): Promise<void> {
  const finalDir = path.join(root, 'dist');
  const stagedDir = path.join(root, `.dist-build-${process.pid}`);
  const backupDir = path.join(root, `.dist-previous-${process.pid}`);
  const lockDir = path.join(root, '.dist-build.lock');

  try {
    await fs.mkdir(lockDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error('another DEX//REACH build is already staging output; refusing a concurrent dist replacement');
    }
    throw error;
  }

  try {
    await fs.rm(stagedDir, { recursive: true, force: true });
    await fs.rm(backupDir, { recursive: true, force: true });

    const tsc = path.join(root, 'node_modules', 'typescript', 'bin', 'tsc');
    await execFileAsync(process.execPath, [tsc, '-p', path.join(root, 'tsconfig.json'), '--outDir', stagedDir], {
      cwd: root,
      maxBuffer: 16 * 1024 * 1024
    });

    // The live dist tree remains untouched for the entire TypeScript compile. Only after a
    // successful clean build do we replace it, so launchd can never spend the compile window
    // repeatedly respawning services against a deliberately deleted dist directory.
    await replaceBuiltDirectory(root, stagedDir, finalDir, backupDir);
  } finally {
    await fs.rm(lockDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (import.meta.url === invokedPath) {
  await atomicBuild();
}
