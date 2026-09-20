import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { checksumTree, compareTrees, type ArtifactChecksum, type TreeDifference } from '../../src/shared/provenance.js';

const execFileAsync = promisify(execFile);

/**
 * Rebuild one commit from tracked source alone and compare the result, file by file.
 *
 * Four things a passing build routinely hides, and how each is caught here:
 *
 *   - an untracked file the build reads: `git archive` exports only tracked content, so the rebuild
 *     simply does not have it;
 *   - a stale `dist/`: the export has no build output at all, so anything left over in the working
 *     tree shows up as a file only the reference build has;
 *   - a globally installed package the workflow never installs: the rebuild's `npm ci` installs
 *     exactly the lockfile, so a build that needs more fails there;
 *   - an absolute path, hostname or timestamp baked into the output: the rebuild runs under a
 *     different temporary directory, so a leaked path changes the file's hash.
 *
 * `npm ci` needs the registry, so a network failure is reported as UNVERIFIED rather than as a
 * reproducibility failure. Those are different facts and must not be collapsed.
 */

export type CleanBuildResult = {
  ok: boolean;
  /** True only when the comparison actually ran to completion. */
  compared: boolean;
  commit: string;
  outputDir: string;
  reference: ArtifactChecksum[];
  rebuild: ArtifactChecksum[];
  differences: TreeDifference[];
  detail: string;
};

async function git(repo: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', repo, ...args], { maxBuffer: 16 * 1024 * 1024 });
  return stdout.trim();
}

export async function cleanBuildComparison(options: {
  repoRoot: string;
  outputDir?: string;
  commit?: string;
  keepWorkspace?: boolean;
}): Promise<CleanBuildResult> {
  const repoRoot = path.resolve(options.repoRoot);
  const outputDir = options.outputDir ?? 'dist';
  const commit = options.commit ?? (await git(repoRoot, ['rev-parse', 'HEAD']));

  // A dirty tree makes the comparison meaningless rather than failing: the working-tree build is a
  // build of uncommitted work, and the rebuild is a build of HEAD, so every difference would be an
  // artifact of that gap. Reporting those as reproducibility failures is how a check becomes noise
  // during ordinary development and then gets ignored on the one day it matters.
  const dirty = options.commit ? '' : await git(repoRoot, ['status', '--porcelain']);
  if (dirty) {
    return {
      ok: false, compared: false, commit, outputDir, reference: [], rebuild: [], differences: [],
      detail: `The working tree has uncommitted changes, so its build is not a build of ${commit.slice(0, 12)} and the two cannot be compared. Commit first, or pass an explicit commit to compare a committed state.`
    };
  }

  const reference = await checksumTree(path.join(repoRoot, outputDir));
  if (!reference.length) {
    return {
      ok: false, compared: false, commit, outputDir, reference, rebuild: [], differences: [],
      detail: `No build output under ${outputDir}/ to compare against. Run the build first; comparing against nothing would pass for the wrong reason.`
    };
  }

  // A distinctly different absolute path, so anything that bakes one in shows up as a hash change.
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'dex-reach-cleanbuild-'));
  const tree = path.join(workspace, 'source-tree-with-a-deliberately-different-path');
  try {
    await fs.mkdir(tree, { recursive: true });
    // Tracked content only. This is the step that makes the whole check meaningful. Note that
    // `git archive` also honours `export-ignore` in .gitattributes, so a tracked file excluded that
    // way would look untracked here; this repository has no .gitattributes, and adding one that
    // excludes build inputs would need this check revisited.
    const archive = path.join(workspace, 'source.tar');
    await execFileAsync('git', ['-C', repoRoot, 'archive', '--format=tar', '-o', archive, commit], { maxBuffer: 64 * 1024 * 1024 });
    await execFileAsync('tar', ['-xf', archive, '-C', tree]);

    try {
      await execFileAsync('npm', ['ci', '--no-audit', '--no-fund'], { cwd: tree, timeout: 15 * 60_000, maxBuffer: 64 * 1024 * 1024 });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        ok: false, compared: false, commit, outputDir, reference, rebuild: [], differences: [],
        detail: `Dependencies could not be installed into a clean tree, so reproducibility was not tested. This is an install failure, not a reproducibility failure: ${message.split('\n')[0]}`
      };
    }

    try {
      await execFileAsync('npm', ['run', 'build'], { cwd: tree, timeout: 15 * 60_000, maxBuffer: 64 * 1024 * 1024 });
    } catch (error) {
      // A clean tree that cannot build at all is the strongest form of what this check looks for,
      // not a reason to report that the check did not run. Letting it escape as an exception would
      // send it out under the "could not be tested" exit code and read as an environment problem.
      const message = error instanceof Error ? error.message : String(error);
      return {
        ok: false, compared: true, commit, outputDir, reference, rebuild: [], differences: [],
        detail: `The build fails in a clean checkout of ${commit.slice(0, 12)} even though it succeeds in the working tree, so it depends on something not tracked at this commit: ${message.split('\n').slice(0, 3).join(' ').slice(0, 400)}`
      };
    }

    const rebuild = await checksumTree(path.join(tree, outputDir));
    const differences = compareTrees(reference, rebuild);
    return {
      ok: differences.length === 0,
      compared: true,
      commit,
      outputDir,
      reference,
      rebuild,
      differences,
      detail: differences.length === 0
        ? `${reference.length} artifact(s) rebuilt byte-for-byte from tracked source at ${commit.slice(0, 12)} in a different directory with a fresh dependency install.`
        : `${differences.length} artifact(s) differ between the working-tree build and a clean rebuild of ${commit.slice(0, 12)}.`
    };
  } finally {
    if (!options.keepWorkspace) await fs.rm(workspace, { recursive: true, force: true });
  }
}

export function describeCleanBuild(result: CleanBuildResult): string[] {
  const lines = [
    `Clean-build reproducibility for ${result.commit.slice(0, 12)}`,
    result.detail,
    ''
  ];
  if (!result.differences.length) return lines;
  lines.push('Differences:');
  for (const difference of result.differences) {
    lines.push(`  ${difference.path}  [${difference.kind}]`);
    lines.push(`    ${difference.detail}`);
  }
  return lines;
}
