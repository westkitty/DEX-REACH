import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanBuildComparison, describeCleanBuild } from './lib/clean-build.js';
import { flag } from './lib/node-files.js';

/**
 * Prove the build is a function of tracked source and nothing else.
 *
 * Exit status distinguishes the two ways this does not pass, because they call for different
 * responses: a reproducibility difference is a repository problem to fix, and an install failure is
 * an environment problem that leaves the question unanswered. Reporting both as failure would send
 * someone hunting for a build defect that is not there.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function main(): Promise<void> {
  const result = await cleanBuildComparison({ repoRoot, keepWorkspace: flag('--keep', process.argv) });
  if (flag('--json', process.argv)) {
    console.log(JSON.stringify({ ok: result.ok, compared: result.compared, commit: result.commit, detail: result.detail, differences: result.differences }, null, 2));
  } else {
    for (const line of describeCleanBuild(result)) console.log(line);
  }
  if (result.ok) return;
  process.exitCode = result.compared ? 1 : 2;
  if (!result.compared) console.error('\nUNVERIFIED: the comparison did not run. This is not evidence that the build is irreproducible.');
}

main().catch(error => {
  console.error(`clean-build check failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 2;
});
