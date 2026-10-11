import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { DEX_MODIFIERS, DEX_SCOPES } from '../src/shared/dex-canonical-contract.js';
import { loadRoutableManifest } from '../src/shared/dex-command-router.js';
import { REACH_AUTHORITATIVE_MAPPINGS } from '../src/shared/dex-reach-mappings.js';

// Conformance of REACH's canonical-manifest adapter against a REAL checkout of westkitty/DEX.
//
//   npm run conformance:dex -- --dex-checkout <path> [--expect-count 50]
//
// DEX is a private repository and REACH is public, so no DEX source or roster is stored here. This script
// reads a checkout the operator already has, runs its `DEX_COMMAND_MANIFEST` through the REACH adapter and the
// shipped mapping table, and prints provenance and counts only. It never prints command names or effects.
// It is not part of `npm run verify`, because hosted CI has no access to DEX. Importing the checkout's
// manifest.ts executes that file (pure data in manifest 1.0.0); use it only on a checkout you trust.

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
report.verdict = failures.length ? `FAIL: ${failures.join('; ')}` : 'PASS';
console.log(JSON.stringify(report, null, 2));
process.exit(failures.length ? 1 : 0);
