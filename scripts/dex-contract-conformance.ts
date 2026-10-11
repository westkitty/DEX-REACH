import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DEX_MODIFIERS, DEX_SCOPES } from '../src/shared/dex-canonical-contract.js';
import { loadRoutableManifest } from '../src/shared/dex-command-router.js';
import { REACH_AUTHORITATIVE_MAPPINGS } from '../src/shared/dex-reach-mappings.js';

// Conformance of REACH's canonical-manifest adapter against a REAL checkout of westkitty/DEX.
//
//   npm run conformance:dex -- --dex-checkout <path> [--expect-count 50] [--write-snapshot | --check-snapshot]
//
// DEX is a private repository and REACH is public. The owner approved committing the command ROSTER (identity and
// classification) as a test fixture, `tests/fixtures/dex-router/dex-roster-snapshot-v1.json`, and nothing else
// from DEX: `aliases`, `effect` and `appCommand` are deliberately blanked, and no source is copied.
// This script reads a checkout the operator already has, runs its `DEX_COMMAND_MANIFEST` through the REACH adapter
// and the shipped mapping table, and prints provenance and counts only. `--write-snapshot` regenerates the
// fixture and its provenance file; `--check-snapshot` fails if the fixture has drifted from that checkout.
// It is not part of `npm run verify`, because hosted CI has no access to DEX. Importing the checkout's
// manifest.ts executes that file (pure data in manifest 1.0.0); use it only on a checkout you trust.

const fixtureDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../tests/fixtures/dex-router');
const snapshotFile = path.join(fixtureDir, 'dex-roster-snapshot-v1.json');
const provenanceFile = path.join(fixtureDir, 'dex-roster-snapshot-v1.provenance.json');
type RosterEntry = Record<string, unknown>;
/** The approved projection: everything REACH validates except DEX's descriptive prose and commands. */
function project(entry: RosterEntry): RosterEntry {
  return { ...entry, aliases: [], effect: '', appCommand: null };
}

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

const checkout = arg('dex-checkout');
if (!checkout) {
  console.error('usage: conformance:dex --dex-checkout <path-to-DEX-checkout> [--expect-count 50]');
  process.exit(2);
}
const expectCount = Number(arg('expect-count') ?? 50);
const manifestPath = path.resolve(checkout, 'packages/router/src/manifest.ts');
if (!fs.existsSync(manifestPath)) {
  console.error(`not a DEX checkout: ${manifestPath} does not exist`);
  process.exit(2);
}

const git = (...args: string[]) => execFileSync('git', ['-C', path.resolve(checkout), ...args], { encoding: 'utf8' }).trim();
const sha256 = createHash('sha256').update(fs.readFileSync(manifestPath)).digest('hex');
const dexManifest = (await import(pathToFileURL(manifestPath).href)) as {
  DEX_COMMAND_MANIFEST: readonly unknown[];
  DEX_COMMAND_MANIFEST_VERSION: string;
  DEX_MODIFIERS: readonly string[];
};

const canonical = { manifestVersion: dexManifest.DEX_COMMAND_MANIFEST_VERSION, commands: dexManifest.DEX_COMMAND_MANIFEST };
const loaded = loadRoutableManifest({ canonical, mappings: REACH_AUTHORITATIVE_MAPPINGS, production: true });

const modifiersAgree = JSON.stringify([...dexManifest.DEX_MODIFIERS]) === JSON.stringify([...DEX_MODIFIERS]);
const scopeCounts: Record<string, number> = {};
if (loaded.ok) {
  for (const command of dexManifest.DEX_COMMAND_MANIFEST as ReadonlyArray<{ scope: string }>) {
    scopeCounts[command.scope] = (scopeCounts[command.scope] ?? 0) + 1;
  }
}
const snapshot = { manifestVersion: dexManifest.DEX_COMMAND_MANIFEST_VERSION, commands: (dexManifest.DEX_COMMAND_MANIFEST as RosterEntry[]).map(project) };
const snapshotText = JSON.stringify(snapshot, null, 2) + '\n';
const provenance = {
  note: 'Roster snapshot of the DEX command manifest: identity and classification only. aliases, effect and appCommand are blanked.',
  repository: 'westkitty/DEX', file: 'packages/router/src/manifest.ts', commit: git('rev-parse', 'HEAD'),
  fileSha256: sha256, manifestVersion: dexManifest.DEX_COMMAND_MANIFEST_VERSION, commandCount: snapshot.commands.length
};
const report = {
  source: {
    repository: 'westkitty/DEX',
    commit: git('rev-parse', 'HEAD'),
    dirty: git('status', '--porcelain', '--', 'packages/router/src/manifest.ts') !== '',
    file: 'packages/router/src/manifest.ts',
    fileSha256: sha256,
    manifestVersion: dexManifest.DEX_COMMAND_MANIFEST_VERSION
  },
  adapter: loaded.ok
    ? {
        loaded: true,
        canonicalCount: loaded.manifest.canonicalCount,
        routable: loaded.manifest.commands.size,
        unroutable: loaded.manifest.unroutable.size,
        scopeCounts,
        everyKnownScopeUsed: DEX_SCOPES.every(scope => (scopeCounts[scope] ?? 0) > 0),
        modifiersMatchReachPin: modifiersAgree
      }
    : { loaded: false, code: loaded.code, message: loaded.message },
  verdict: ''
};
const failures: string[] = [];
if (!loaded.ok) failures.push('the REACH adapter refused the DEX manifest');
else {
  if (loaded.manifest.canonicalCount !== expectCount) failures.push(`expected ${expectCount} commands, found ${loaded.manifest.canonicalCount}`);
  if (!modifiersAgree) failures.push('DEX modifier list differs from the REACH pin');
}
if (process.argv.includes('--write-snapshot')) {
  if (failures.length) { console.error('refusing to write a snapshot from a manifest that fails conformance'); }
  else { fs.writeFileSync(snapshotFile, snapshotText); fs.writeFileSync(provenanceFile, JSON.stringify(provenance, null, 2) + '\n'); }
}
if (process.argv.includes('--check-snapshot')) {
  const committed = fs.existsSync(snapshotFile) ? fs.readFileSync(snapshotFile, 'utf8') : '';
  if (committed !== snapshotText) failures.push('the committed roster snapshot differs from this DEX checkout; regenerate with --write-snapshot');
}
report.verdict = failures.length ? `FAIL: ${failures.join('; ')}` : 'PASS';
console.log(JSON.stringify(report, null, 2));
process.exit(failures.length ? 1 : 0);
