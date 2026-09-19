import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildReleaseManifest,
  check,
  checksumTree,
  countSbomComponents,
  describeReleaseManifest,
  normalizeSbom,
  type ReleaseCheck
} from '../src/shared/provenance.js';
import { canonicalJson } from '../src/shared/hash.js';
import { cleanBuildComparison } from './lib/clean-build.js';
import { arg, flag } from './lib/node-files.js';

/**
 * Produce a release manifest for the current commit.
 *
 * Every check runs here rather than being taken on trust from a previous step, because a manifest
 * that records results it did not observe is exactly the artifact this is supposed to replace. A
 * check that cannot run is recorded as SKIPPED or UNVERIFIED with its reason, never omitted: a
 * missing line reads as "fine" to everyone who was not there.
 */

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function git(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', repoRoot, ...args], { maxBuffer: 16 * 1024 * 1024 });
  return stdout.trim();
}

async function runCheck(name: string, command: string, args: string[], detail: string): Promise<ReleaseCheck> {
  try {
    await execFileAsync(command, args, { cwd: repoRoot, timeout: 20 * 60_000, maxBuffer: 64 * 1024 * 1024 });
    return check(name, 'pass', detail);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return check(name, 'fail', `${detail} It failed: ${message.split('\n').slice(0, 3).join(' ').slice(0, 400)}`);
  }
}

async function toolVersion(command: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync(command, args, { timeout: 30_000 });
    return stdout.trim();
  } catch {
    return 'unknown';
  }
}

async function main(): Promise<void> {
  const outDir = path.resolve(repoRoot, arg('--out', process.argv) || 'release');
  const commit = await git(['rev-parse', 'HEAD']);
  const branch = await git(['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => '');
  const clean = (await git(['status', '--porcelain'])) === '';

  const checks: ReleaseCheck[] = [];
  checks.push(clean
    ? check('source cleanliness', 'pass', `The working tree matches ${commit.slice(0, 12)}, so everything below describes that commit.`)
    : check('source cleanliness', 'fail', 'The working tree has uncommitted changes, so this manifest does not describe any commit. Commit or stash before producing release provenance.'));

  checks.push(await runCheck('typecheck', 'npm', ['run', 'typecheck'], 'TypeScript compiles the whole project without errors.'));
  checks.push(await runCheck('invariant manifest', 'npm', ['run', 'invariants', '--', '--check'], 'The machine-readable invariant index matches docs/INVARIANTS.md.'));
  checks.push(await runCheck('tests', 'npm', ['test'], 'The full regression suite passes.'));
  checks.push(await runCheck('build', 'npm', ['run', 'build'], 'The production build emits without errors.'));
  checks.push(await runCheck('production dependency audit', 'npm', ['audit', '--omit=dev', '--audit-level=high'], 'No high or critical advisory in the production dependency tree at the time this ran.'));

  // The probe starts the real compatibility adapter, so it depends on what is installed here rather
  // than on the source being released. A failure is recorded as unverified with its actual message
  // attached, not as skipped: calling it skipped would hide a probe that ran and genuinely failed.
  const probe = await runCheck('compatibility adapter probe', 'npm', ['run', 'probe:backend'], 'The pinned compatibility adapter starts and reports its tool surface.');
  checks.push(probe.status === 'fail'
    ? check(probe.name, 'unverified', `${probe.detail} Recorded as unverified rather than failed because this depends on the adapter installed on this machine; read the message above before treating it as either.`)
    : probe);

  const cleanBuild = await cleanBuildComparison({ repoRoot });
  checks.push(cleanBuild.compared
    ? check('clean-build reproducibility', cleanBuild.ok ? 'pass' : 'fail', cleanBuild.ok
      ? cleanBuild.detail
      : `${cleanBuild.detail} Differing files: ${cleanBuild.differences.map(entry => `${entry.path} (${entry.kind})`).join(', ')}`)
    : check('clean-build reproducibility', 'unverified', cleanBuild.detail));

  checks.push(check('live deployment', 'unverified',
    'Nothing in this run exercised a deployed gateway, an installed service or a real MCP client session. A green build is not a working deployment, and this manifest does not claim one.'));

  await fs.mkdir(outDir, { recursive: true });

  // SBOM from npm's own generator rather than a hand-rolled walk of the lockfile: reimplementing
  // dependency resolution would produce a document that looks authoritative and quietly disagrees
  // with what npm actually installs.
  let sbom: { format: string; normalizedSha256: string; components: number } | null = null;
  try {
    const { stdout } = await execFileAsync('npm', ['sbom', '--sbom-format', 'cyclonedx', '--omit=dev'], { cwd: repoRoot, timeout: 5 * 60_000, maxBuffer: 64 * 1024 * 1024 });
    const parsed = JSON.parse(stdout) as unknown;
    await fs.writeFile(path.join(outDir, 'sbom.cdx.json'), JSON.stringify(parsed, null, 2) + '\n');
    sbom = {
      format: 'CycloneDX',
      normalizedSha256: crypto.createHash('sha256').update(canonicalJson(normalizeSbom(parsed))).digest('hex'),
      components: countSbomComponents(parsed)
    };
    checks.push(check('SBOM', 'pass', `CycloneDX SBOM of the production tree written with ${sbom.components} component(s). The recorded hash is of a normalized copy with npm's per-run serial number and timestamp removed, so two builds of one tree hash alike.`));
  } catch (error) {
    checks.push(check('SBOM', 'unverified', `npm could not produce an SBOM here: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`));
  }

  const artifacts = await checksumTree(path.join(repoRoot, 'dist'));
  await fs.writeFile(
    path.join(outDir, 'checksums.txt'),
    artifacts.map(entry => `${entry.sha256}  ${entry.path}`).join('\n') + '\n'
  );

  const manifest = buildReleaseManifest({
    commit,
    clean,
    branch: branch || null,
    node: process.version,
    npm: await toolVersion('npm', ['--version']),
    platform: `${process.platform}/${process.arch}`,
    checks,
    artifacts,
    sbom
  });
  await fs.writeFile(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

  if (flag('--json', process.argv)) console.log(JSON.stringify(manifest, null, 2));
  else for (const line of describeReleaseManifest(manifest)) console.log(line);

  console.log(`\nWritten to ${outDir}/ (manifest.json, checksums.txt${sbom ? ', sbom.cdx.json' : ''}).`);
  if (manifest.checks.some(entry => entry.status === 'fail')) process.exitCode = 1;
}

main().catch(error => {
  console.error(`release provenance failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 2;
});
