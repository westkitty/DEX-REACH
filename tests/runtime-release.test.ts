import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { stageRuntimeRelease, verifyRuntimeRelease } from '../scripts/lib/runtime-release.js';
import { servicePath } from '../scripts/lib/service.js';

async function write(file: string, text: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, text);
}

test('immutable runtime release survives source dist and node_modules replacement', async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'dex-runtime-release-'));
  const source = path.join(base, 'checkout');
  const state = path.join(base, 'state');
  try {
    const entries: Record<string, string> = {
      'dist/src/coordinator/main.js': 'coordinator-v1',
      'dist/src/worker/main.js': 'worker-v1',
      'dist/src/gateway/main.js': 'gateway-v1',
      'dist/src/node/main.js': 'node-v1',
      'dist/scripts/oauth-canary.js': 'canary-v1',
      'dist/scripts/reload-launchagents.js': 'reload-v1',
      'node_modules/@modelcontextprotocol/client/package.json': '{"name":"@modelcontextprotocol/client","version":"2.0.0"}',
      'package.json': '{"name":"dex-reach"}',
      'package-lock.json': '{"lockfileVersion":3}'
    };
    for (const [file, text] of Object.entries(entries)) await write(path.join(source, file), text);

    const release = await stageRuntimeRelease(source, state, '0.3.2-test-release');
    await verifyRuntimeRelease(release);
    assert.match(release, /state\/runtime\/releases\/0\.3\.2-test-release$/);
    assert.equal(await fs.readFile(path.join(release, 'dist/src/node/main.js'), 'utf8'), 'node-v1');

    await fs.rm(path.join(source, 'dist'), { recursive: true, force: true });
    await fs.rm(path.join(source, 'node_modules'), { recursive: true, force: true });
    await write(path.join(source, 'dist/src/node/main.js'), 'node-v2');

    assert.equal(
      await fs.readFile(path.join(release, 'dist/src/node/main.js'), 'utf8'),
      'node-v1',
      'live runtime must not depend on the mutable checkout after installation'
    );

    const reused = await stageRuntimeRelease(source, state, '0.3.2-test-release');
    assert.equal(reused, release);
    assert.equal(await fs.readFile(path.join(reused, 'dist/src/node/main.js'), 'utf8'), 'node-v1');
  } finally {
    await fs.rm(base, { recursive: true, force: true });
  }
});

test('service PATH prefers immutable runtime binaries over mutable checkout binaries', () => {
  const runtime = '/Users/test/.dex-reach/runtime/releases/0.3.2-deadbeef';
  const sourceBin = '/Users/test/DEX-REACH/node_modules/.bin';
  const value = servicePath('/opt/homebrew/bin/node', `${sourceBin}:/custom/bin`, runtime);
  const entries = value.split(':');
  assert.equal(entries[1], `${runtime}/node_modules/.bin`);
  assert.ok(entries.includes('/custom/bin'));
});


test('macOS installer does not run the mutable checkout build before runtime staging', async () => {
  const packageJson = JSON.parse(await fs.readFile(path.resolve('package.json'), 'utf8')) as { scripts?: Record<string, string> };
  assert.equal(packageJson.scripts?.['install:macos'], 'tsx scripts/install-macos.ts');
  assert.doesNotMatch(packageJson.scripts?.['install:macos'] || '', /npm run build|prebuild/);
});


test('golden verification actively proves OAuth refresh recovery before health evaluation', async () => {
  const packageJson = JSON.parse(await fs.readFile(path.resolve('package.json'), 'utf8')) as { scripts?: Record<string, string> };
  const golden = packageJson.scripts?.['verify:golden'] || '';
  assert.match(golden, /npm run oauth:canary/);
  assert.ok(
    golden.indexOf('npm run smoke') < golden.indexOf('npm run oauth:canary') &&
    golden.indexOf('npm run oauth:canary') < golden.indexOf('npm run oauth:health'),
    'golden must prove public MCP first, force refresh recovery second, then evaluate token health'
  );
});
