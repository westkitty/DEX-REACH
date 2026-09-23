import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const REQUIRED_RUNTIME_ENTRIES = [
  'dist/src/coordinator/main.js',
  'dist/src/worker/main.js',
  'dist/src/gateway/main.js',
  'dist/src/node/main.js',
  'dist/scripts/oauth-canary.js',
  'dist/scripts/reload-launchagents.js',
  'node_modules/@modelcontextprotocol/client/package.json'
] as const;

function safeId(value: string): string {
  const clean = value.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  if (!clean) throw new Error('runtime release id is empty');
  return clean.slice(0, 120);
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

export async function runtimeReleaseId(sourceRoot: string, version: string): Promise<string> {
  let commit = 'nogit';
  let dirty = false;
  try {
    const [{ stdout: head }, { stdout: status }] = await Promise.all([
      execFileAsync('/usr/bin/git', ['-C', sourceRoot, 'rev-parse', '--verify', 'HEAD']),
      execFileAsync('/usr/bin/git', ['-C', sourceRoot, 'status', '--porcelain'])
    ]);
    commit = head.trim().slice(0, 12) || 'nogit';
    dirty = Boolean(status.trim());
  } catch {
    dirty = true;
  }

  let lockHash = 'nolock';
  try {
    lockHash = crypto.createHash('sha256')
      .update(await fs.readFile(path.join(sourceRoot, 'package-lock.json')))
      .digest('hex')
      .slice(0, 12);
  } catch {}

  const suffix = dirty ? `-dirty-${Date.now()}` : '';
  return safeId(`${version}-${commit}-${lockHash}${suffix}`);
}

export function runtimeReleasesDir(stateDir: string): string {
  return path.join(stateDir, 'runtime', 'releases');
}

export async function verifyRuntimeRelease(root: string): Promise<void> {
  for (const entry of REQUIRED_RUNTIME_ENTRIES) {
    if (!await exists(path.join(root, entry))) {
      throw new Error(`runtime release is incomplete: missing ${entry}`);
    }
  }
}

async function createRuntimeRelease(
  sourceRoot: string,
  stateDir: string,
  releaseId: string,
  writeDist: (staging: string) => Promise<void>
): Promise<string> {
  const releases = runtimeReleasesDir(stateDir);
  await fs.mkdir(releases, { recursive: true, mode: 0o700 });
  await fs.chmod(path.dirname(releases), 0o700).catch(() => undefined);
  await fs.chmod(releases, 0o700).catch(() => undefined);

  const target = path.join(releases, safeId(releaseId));
  if (await exists(target)) {
    await verifyRuntimeRelease(target);
    return target;
  }

  const staging = path.join(releases, `.${path.basename(target)}.staging-${process.pid}-${crypto.randomUUID()}`);
  await fs.rm(staging, { recursive: true, force: true });
  await fs.mkdir(staging, { recursive: true, mode: 0o700 });

  try {
    await writeDist(staging);
    await fs.cp(path.join(sourceRoot, 'node_modules'), path.join(staging, 'node_modules'), {
      recursive: true,
      dereference: false,
      verbatimSymlinks: true
    });
    for (const file of ['package.json', 'package-lock.json']) {
      const from = path.join(sourceRoot, file);
      if (await exists(from)) await fs.copyFile(from, path.join(staging, file));
    }
    await verifyRuntimeRelease(staging);
    try {
      await fs.rename(staging, target);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST' && code !== 'ENOTEMPTY') throw error;
      await verifyRuntimeRelease(target);
    }
    await verifyRuntimeRelease(target);
    return target;
  } finally {
    await fs.rm(staging, { recursive: true, force: true }).catch(() => undefined);
  }
}

export async function stageRuntimeRelease(sourceRoot: string, stateDir: string, releaseId: string): Promise<string> {
  return createRuntimeRelease(sourceRoot, stateDir, releaseId, async staging => {
    await fs.cp(path.join(sourceRoot, 'dist'), path.join(staging, 'dist'), {
      recursive: true,
      dereference: false,
      verbatimSymlinks: true
    });
  });
}

/**
 * Compile directly into the private release staging directory.
 *
 * This is deliberately different from `npm run build`: the installed legacy launchd services may
 * still be executing from the checkout's current `dist/`. Deleting that tree before the immutable
 * runtime is active recreates the exact outage this installer is meant to repair.
 */
export async function buildRuntimeRelease(
  sourceRoot: string,
  stateDir: string,
  releaseId: string,
  nodeBin = process.execPath
): Promise<string> {
  return createRuntimeRelease(sourceRoot, stateDir, releaseId, async staging => {
    const compiler = path.join(sourceRoot, 'node_modules', 'typescript', 'bin', 'tsc');
    if (!await exists(compiler)) throw new Error('runtime install requires the local TypeScript compiler; run npm ci only when no legacy DEX service depends on this checkout');
    await execFileAsync(nodeBin, [
      compiler,
      '-p', path.join(sourceRoot, 'tsconfig.json'),
      '--outDir', path.join(staging, 'dist')
    ], {
      cwd: sourceRoot,
      maxBuffer: 10 * 1024 * 1024
    });
  });
}
