import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runtimeTreeSha256, TRUSTED_RUNTIME_RELEASES } from './lib/runtime-rollback.js';
import { arg } from './lib/node-files.js';

/**
 * Rebuild an immutable runtime release from its source commit in a disposable directory and report
 * its complete-tree digest.
 *
 * A digest recorded on the host is only as trustworthy as the host. This one is derived from reviewed
 * Git history and lockfile-pinned dependencies, so anyone can repeat it and get the same answer. The
 * receipt is deliberately unsigned and says so; it becomes a trust anchor only when its digest is
 * pinned in TRUSTED_RUNTIME_RELEASES through a reviewed change.
 *
 *   npm run release:reproduce -- --source <full sha> --release-id <id> [--compare <tree>] [--out <file>]
 */

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RESERVE_BYTES = 2 * 1024 ** 3;
const WORKING_BYTES = 1024 ** 3;

async function run(command: string, args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync(command, args, { cwd, timeout: 20 * 60_000, maxBuffer: 64 * 1024 * 1024 });
  return stdout.trim();
}

async function main(): Promise<void> {
  const sourceSha = arg('--source') ?? '';
  const releaseId = arg('--release-id') ?? '';
  const compare = arg('--compare');
  const out = arg('--out');
  if (!/^[a-f0-9]{40}$/.test(sourceSha) || !releaseId) {
    throw new Error('usage: --source <full 40-hex commit> --release-id <runtime release id> [--compare <tree>] [--out <file>]');
  }

  // Two copies of node_modules exist at the peak (checkout and release). Refuse rather than eat the reserve.
  const space = await fs.statfs(os.tmpdir());
  const available = space.bavail * space.bsize;
  if (available < RESERVE_BYTES + WORKING_BYTES) {
    throw new Error(`only ${(available / 1024 ** 3).toFixed(2)} GiB free; reproduction needs 1 GiB above the 2 GiB reserve`);
  }

  const onMainline = await run('git', ['merge-base', '--is-ancestor', sourceSha, 'origin/main'], repoRoot).then(() => true, () => false);
  const work = await fs.mkdtemp(path.join(os.tmpdir(), 'dex-reach-reproduce-'));
  try {
    const source = path.join(work, 'source');
    await fs.mkdir(source);
    await run('git', ['archive', '--format=tar', '-o', path.join(work, 'source.tar'), sourceSha], repoRoot);
    await run('tar', ['-xf', path.join(work, 'source.tar'), '-C', source], work);

    const version = (JSON.parse(await fs.readFile(path.join(source, 'package.json'), 'utf8')) as { version: string }).version;
    const lockfile = await fs.readFile(path.join(source, 'package-lock.json'));
    const lockfileSha256 = crypto.createHash('sha256').update(lockfile).digest('hex');
    const derived = `${version}-${sourceSha.slice(0, 12)}-${lockfileSha256.slice(0, 12)}`;
    if (derived !== releaseId) throw new Error(`release id ${releaseId} does not derive from ${sourceSha}; that commit yields ${derived}`);

    // npm's default script policy, exactly as the installer's checkout was prepared: esbuild's postinstall
    // rewrites its own bin/, so skipping scripts would measure a tree that was never installed.
    await run('npm', ['ci', '--no-audit', '--no-fund'], source);
    // Each commit is built by its own builder: the procedure changed when the native backend was staged.
    const builder = await import(pathToFileURL(path.join(source, 'scripts/lib/runtime-release.ts')).href) as {
      buildRuntimeRelease: (sourceRoot: string, stateDir: string, releaseId: string) => Promise<string>;
    };
    const tree = await builder.buildRuntimeRelease(source, path.join(work, 'state'), releaseId);
    const treeSha256 = await runtimeTreeSha256(tree);

    const pinned = Object.prototype.hasOwnProperty.call(TRUSTED_RUNTIME_RELEASES, releaseId) ? TRUSTED_RUNTIME_RELEASES[releaseId] : undefined;
    const comparedSha256 = compare ? await runtimeTreeSha256(compare) : undefined;
    const receipt = {
      schema: 'dex-reach.runtime-release-receipt/1',
      releaseId,
      sourceSha,
      onMainline,
      lockfileSha256,
      treeSha256,
      procedure: [
        `git archive ${sourceSha}`,
        'npm ci --no-audit --no-fund (npm default install-script policy; npm version recorded below)',
        `buildRuntimeRelease from that commit's scripts/lib/runtime-release.ts`,
        'runtimeTreeSha256 (paths, modes, file contents and link targets; no timestamps)'
      ],
      environment: { node: process.version, npm: await run('npm', ['--version'], work), platform: `${process.platform}/${process.arch}` },
      producedAt: new Date().toISOString(),
      comparisons: {
        pinned: pinned ? { treeSha256: pinned.treeSha256, match: pinned.treeSha256 === treeSha256 } : null,
        compared: compare ? { path: path.resolve(compare), treeSha256: comparedSha256, match: comparedSha256 === treeSha256 } : null
      },
      signature: null,
      trust: 'Unsigned. This receipt is a reproducible measurement, not an attestation: trust comes from repeating the procedure against reviewed source and from pinning treeSha256 in TRUSTED_RUNTIME_RELEASES through a reviewed change.'
    };
    const text = `${JSON.stringify(receipt, null, 2)}\n`;
    if (out) await fs.writeFile(out, text, { mode: 0o600 });
    process.stdout.write(text);
    if (receipt.comparisons.pinned?.match === false || receipt.comparisons.compared?.match === false || !onMainline) process.exitCode = 1;
  } finally {
    await fs.rm(work, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(`runtime release reproduction failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 2;
});
