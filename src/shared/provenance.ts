import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { DEX_REACH_VERSION } from './version.js';

/**
 * Release provenance.
 *
 * The question this answers is narrow and worth stating plainly: are the artifacts in `dist/` a
 * function of the tracked source at one commit, and nothing else? Not "did the build succeed" —
 * a build succeeds just as happily when it quietly depends on an untracked file, a leftover `dist`,
 * a globally installed package or an absolute path from someone's home directory. Each of those
 * produces a release that cannot be rebuilt by anyone else, and the failure shows up much later as
 * "it works on the machine it was built on".
 *
 * So the central check is a rebuild from `git archive` of one commit into a directory with a
 * different absolute path, with a fresh dependency install and no `dist` to start from, compared
 * file by file by hash. A difference names the file rather than reporting that something drifted.
 *
 * Everything else here is record-keeping around that: what was checked, what the artifacts hash to,
 * what the dependency tree was, and — held to the same standard as the evidence bundles — what this
 * record does not establish. A release manifest that quietly implied a live deployment had been
 * exercised would be the same category of mistake as an evidence bundle that said VERIFIED.
 */

export const RELEASE_MANIFEST_VERSION = 1;

export type ReleaseCheckStatus = 'pass' | 'fail' | 'skipped' | 'unverified';

export type ReleaseCheck = {
  name: string;
  status: ReleaseCheckStatus;
  detail: string;
};

export type ArtifactChecksum = { path: string; sha256: string; bytes: number };

export type PlatformClaim = {
  platform: string;
  status: 'verified' | 'unverified';
  detail: string;
};

export type ReleaseManifest = {
  version: typeof RELEASE_MANIFEST_VERSION;
  generatedAt: string;
  packageVersion: string;
  source: {
    commit: string;
    /** False means the manifest describes a tree that is not any commit. Stated, never hidden. */
    clean: boolean;
    branch: string | null;
  };
  toolchain: { node: string; npm: string; platform: string };
  checks: ReleaseCheck[];
  artifacts: ArtifactChecksum[];
  /** Hash of the normalized SBOM, so the manifest commits to a dependency tree it does not inline. */
  sbom: { format: string; normalizedSha256: string; components: number } | null;
  platforms: PlatformClaim[];
  limitations: string[];
};

/**
 * What a release manifest does not say. Kept with the manifest rather than in a document, because
 * the manifest is the thing that travels.
 */
export const RELEASE_LIMITATIONS: readonly string[] = [
  'These checks describe a build. They do not describe a deployment: nothing here exercises a live public gateway, a real MCP client session, or an installed service.',
  'A clean-build comparison proves the artifacts are a function of the tracked source at this commit. It does not prove the source is correct, only that it is what was built.',
  'Dependency integrity rests on package-lock.json and the registry that served it. A compromised upstream package produces a perfectly reproducible build of compromised code.',
  'The audit reflects advisories known to the registry at the moment it ran. It is not a statement about vulnerabilities nobody has published yet.',
  'Artifact checksums cover the emitted build output. They are not signatures, and nothing here proves who produced them.'
];

/**
 * Platforms the project claims to support, and what has actually been exercised.
 *
 * A platform is only ever moved to `verified` by a run that really happened on it. The default is
 * unverified, so a platform nobody tested reads as untested rather than as passing by omission.
 */
export function platformClaims(currentPlatform: string, checksPassed: boolean): PlatformClaim[] {
  const linuxVerified = currentPlatform.startsWith('linux') && checksPassed;
  const macVerified = currentPlatform.startsWith('darwin') && checksPassed;
  return [
    {
      platform: 'linux',
      status: linuxVerified ? 'verified' : 'unverified',
      detail: linuxVerified
        ? 'Typecheck, tests, build and the clean-build comparison ran on this Linux host.'
        : 'UNVERIFIED — not exercised by this run. Real Linux proof requires running these checks on a real Linux host.'
    },
    {
      platform: 'macos',
      status: macVerified ? 'verified' : 'unverified',
      detail: macVerified
        ? 'Typecheck, tests, build and the clean-build comparison ran on this macOS host.'
        : 'UNVERIFIED — HARDWARE NOT AVAILABLE. launchd services, Keychain and the macOS capacity probes cannot be exercised from here.'
    },
    {
      platform: 'android',
      status: 'unverified',
      detail: 'UNVERIFIED — HARDWARE NOT AVAILABLE. ADB paths require a real attached Android device.'
    },
    {
      platform: 'second-machine',
      status: 'unverified',
      detail: 'UNVERIFIED — HARDWARE NOT AVAILABLE. Enrollment, revocation and re-enrollment across machines require a real independent second machine; a second process on one host is simulation.'
    }
  ];
}

/**
 * Strip the fields that change on every run so an SBOM can be compared across builds.
 *
 * `npm sbom` stamps a fresh UUID serial number and a wall-clock timestamp into every document. Both
 * are correct for a single artifact and useless for answering "is this the same dependency tree as
 * yesterday", which is the only question worth asking of an SBOM in a reproducibility check. They
 * are removed for hashing only; the document written to disk keeps them.
 */
export function normalizeSbom(value: unknown): unknown {
  if (!value || typeof value !== 'object') return value;
  const document = { ...(value as Record<string, unknown>) };
  delete document.serialNumber;
  const metadata = document.metadata;
  if (metadata && typeof metadata === 'object' && !Array.isArray(metadata)) {
    const copy = { ...(metadata as Record<string, unknown>) };
    delete copy.timestamp;
    document.metadata = copy;
  }
  return document;
}

export function countSbomComponents(value: unknown): number {
  if (!value || typeof value !== 'object') return 0;
  const components = (value as { components?: unknown }).components;
  return Array.isArray(components) ? components.length : 0;
}

export async function hashFile(file: string): Promise<{ sha256: string; bytes: number }> {
  const bytes = await fs.readFile(file);
  return { sha256: crypto.createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length };
}

/**
 * Hash every file under a directory, relative to it and sorted.
 *
 * Relative and sorted are both load-bearing. Relative because the whole point is to compare two
 * trees that live at different absolute paths, and sorted because the comparison must not depend on
 * the order a filesystem happens to return entries in.
 */
export async function checksumTree(root: string): Promise<ArtifactChecksum[]> {
  const out: ArtifactChecksum[] = [];
  const walk = async (current: string): Promise<void> => {
    let entries;
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      const relative = path.relative(root, full).split(path.sep).join('/');
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) {
        const { sha256, bytes } = await hashFile(full);
        out.push({ path: relative, sha256, bytes });
      } else if (entry.isSymbolicLink()) {
        // A symlink is content too. Skipping it would make a tree that has one and a tree that does
        // not compare equal, which is exactly the kind of invisible difference this check exists for.
        const target = await fs.readlink(full);
        out.push({
          path: relative,
          sha256: crypto.createHash('sha256').update(`symlink:${target}`).digest('hex'),
          bytes: Buffer.byteLength(target)
        });
      }
    }
  };
  await walk(root);
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

export type TreeDifference = {
  path: string;
  kind: 'only-in-reference' | 'only-in-rebuild' | 'content-differs';
  detail: string;
};

/** Compare two checksum trees and name every file that differs, rather than reporting a verdict. */
export function compareTrees(reference: ArtifactChecksum[], rebuild: ArtifactChecksum[]): TreeDifference[] {
  const byPathReference = new Map(reference.map(entry => [entry.path, entry]));
  const byPathRebuild = new Map(rebuild.map(entry => [entry.path, entry]));
  const differences: TreeDifference[] = [];
  for (const entry of reference) {
    const other = byPathRebuild.get(entry.path);
    if (!other) {
      differences.push({
        path: entry.path,
        kind: 'only-in-reference',
        detail: 'Present in the working-tree build and absent from a clean rebuild, so it comes from something not tracked at this commit: an untracked file, a leftover artifact, or a dependency the lockfile does not pin.'
      });
    } else if (other.sha256 !== entry.sha256) {
      differences.push({
        path: entry.path,
        kind: 'content-differs',
        detail: `Built differently from the same source (${entry.sha256.slice(0, 12)} vs ${other.sha256.slice(0, 12)}). Common causes are an absolute path, a hostname, a timestamp or an environment value being baked into the output.`
      });
    }
  }
  for (const entry of rebuild) {
    if (!byPathReference.has(entry.path)) {
      differences.push({
        path: entry.path,
        kind: 'only-in-rebuild',
        detail: 'Produced by a clean rebuild and missing from the working-tree build, so the working tree\'s output is stale or was pruned by hand.'
      });
    }
  }
  return differences.sort((a, b) => a.path.localeCompare(b.path));
}

export function check(name: string, status: ReleaseCheckStatus, detail: string): ReleaseCheck {
  return { name, status, detail };
}

export type BuildManifestInput = {
  commit: string;
  clean: boolean;
  branch: string | null;
  node: string;
  npm: string;
  platform: string;
  checks: ReleaseCheck[];
  artifacts: ArtifactChecksum[];
  sbom: ReleaseManifest['sbom'];
};

export function buildReleaseManifest(input: BuildManifestInput): ReleaseManifest {
  // Nothing failed, rather than everything passed. A manifest deliberately carries checks that can
  // never read PASS -- "live deployment" is unverified by construction -- and requiring every check
  // to pass would silently hold every platform at unverified forever, which reads as "we tested
  // nothing" on a run that tested plenty.
  const checksPassed = input.clean && !input.checks.some(entry => entry.status === 'fail');
  return {
    version: RELEASE_MANIFEST_VERSION,
    generatedAt: new Date().toISOString(),
    packageVersion: DEX_REACH_VERSION,
    source: { commit: input.commit, clean: input.clean, branch: input.branch },
    toolchain: { node: input.node, npm: input.npm, platform: input.platform },
    checks: input.checks,
    artifacts: input.artifacts,
    sbom: input.sbom,
    platforms: platformClaims(input.platform, checksPassed),
    limitations: [...RELEASE_LIMITATIONS]
  };
}

const STATUS_LABEL: Record<ReleaseCheckStatus, string> = {
  pass: 'PASS',
  fail: 'FAIL',
  skipped: 'SKIPPED',
  unverified: 'UNVERIFIED'
};

export function describeReleaseManifest(manifest: ReleaseManifest): string[] {
  const width = Math.max(1, ...manifest.checks.map(entry => entry.name.length));
  const lines = [
    `DEX//REACH ${manifest.packageVersion} release provenance`,
    `Commit:    ${manifest.source.commit}${manifest.source.clean ? '' : '  (WORKING TREE NOT CLEAN)'}`,
    `Branch:    ${manifest.source.branch ?? '(detached)'}`,
    `Toolchain: node ${manifest.toolchain.node}, npm ${manifest.toolchain.npm}, ${manifest.toolchain.platform}`,
    ''
  ];
  if (!manifest.source.clean) {
    lines.push(
      'The working tree had uncommitted changes, so this manifest does not describe the named commit.',
      'Treat it as a local record, not as release provenance.',
      ''
    );
  }
  for (const entry of manifest.checks) {
    lines.push(`${entry.name.padEnd(width)}  ${STATUS_LABEL[entry.status]}`);
    lines.push(`${' '.repeat(width)}  ${entry.detail}`);
  }
  lines.push('', `Artifacts: ${manifest.artifacts.length} file(s) checksummed`);
  if (manifest.sbom) lines.push(`SBOM:      ${manifest.sbom.components} production component(s), normalized sha256 ${manifest.sbom.normalizedSha256.slice(0, 16)}...`);
  else lines.push('SBOM:      NOT GENERATED');
  lines.push('', 'Platforms:');
  for (const claim of manifest.platforms) lines.push(`  ${claim.platform.padEnd(16)} ${claim.status.toUpperCase()}  ${claim.detail}`);
  lines.push('', 'What this does not say:');
  for (const limitation of manifest.limitations) lines.push(`  - ${limitation}`);
  return lines;
}
