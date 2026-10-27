import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { buildRuntimeRelease, installLockFile, stageRuntimeRelease, verifyNativeCompatibilityPackage, verifyRuntimeRelease } from '../scripts/lib/runtime-release.js';
import { servicePath } from '../scripts/lib/service.js';
import { NativeCompatibilityAdapter } from '../src/node/adapters/native-compatibility.js';
import { AdapterRegistry } from '../src/shared/adapter-contract.js';

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
    const nativeRoot = path.join(source, 'dist/src/node/compat-runtime');
    const nativeFiles: Record<string, string> = {
      'package.json': JSON.stringify({ name: '@dex-reach/native-backend', version: 'test' }),
      'runtime-files.json': JSON.stringify(['index.js', 'server.js']),
      'LICENSE': 'test license', 'NOTICE.md': 'test notice',
      'runtime/index.js': 'test entry', 'runtime/server.js': 'test server'
    };
    const nativeHashes: Record<string, string> = {};
    for (const [file, text] of Object.entries(nativeFiles)) {
      await write(path.join(nativeRoot, file), text);
      nativeHashes[file] = crypto.createHash('sha256').update(text).digest('hex');
    }
    await write(path.join(nativeRoot, 'source-hashes.json'), JSON.stringify(nativeHashes));

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

test('runtime build stages an intact native backend and refuses damaged assets before activation', { timeout: 90000 }, async () => {
  const base = path.join(os.homedir(), `.dex-runtime-native-stage-${process.pid}-${crypto.randomUUID()}`);
  await fs.mkdir(base);
  const source = path.join(base, 'checkout');
  const state = path.join(base, 'state');
  const previousStateDir = process.env.DEX_REACH_STATE_DIR;
  try {
    await fs.mkdir(path.join(source, 'scripts'), { recursive: true });
    await fs.mkdir(path.join(source, 'src/node/compat-runtime'), { recursive: true });
    await fs.symlink(path.resolve('node_modules'), path.join(source, 'node_modules'));
    await fs.copyFile(path.resolve('package.json'), path.join(source, 'package.json'));
    await fs.copyFile(path.resolve('package-lock.json'), path.join(source, 'package-lock.json'));
    await fs.copyFile(path.resolve('scripts/package-native-backend.mjs'), path.join(source, 'scripts/package-native-backend.mjs'));
    await fs.cp(path.resolve('src/node/compat-runtime'), path.join(source, 'src/node/compat-runtime'), { recursive: true });
    await write(path.join(source, 'tsconfig.json'), JSON.stringify({
      compilerOptions: { target: 'ES2023', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true,
        skipLibCheck: true, rootDir: '.', types: ['node'], outDir: 'dist' },
      include: ['src/**/*.ts', 'scripts/**/*.ts']
    }));
    for (const entry of ['coordinator', 'worker', 'gateway', 'node']) {
      await write(path.join(source, `src/${entry}/main.ts`), 'export {};\n');
    }
    await write(path.join(source, 'scripts/oauth-canary.ts'), 'export {};\n');
    await write(path.join(source, 'scripts/reload-launchagents.ts'), 'export {};\n');

    const release = await buildRuntimeRelease(source, state, 'c15-native-stage-test');
    const packageRoot = path.join(release, 'dist/src/node/compat-runtime');
    await verifyRuntimeRelease(release);

    await fs.rm(path.join(source, 'src/node/compat-runtime/runtime/server.js'));
    await assert.rejects(buildRuntimeRelease(source, state, 'c15-native-stage-missing-source'));
    await assert.rejects(fs.stat(path.join(state, 'runtime/releases/c15-native-stage-missing-source')), { code: 'ENOENT' });
    assert.deepEqual(await fs.readdir(path.join(state, 'runtime/releases')), ['c15-native-stage-test']);

    const missing = path.join(base, 'missing-package');
    await fs.cp(packageRoot, missing, { recursive: true });
    await fs.rm(path.join(missing, 'runtime/server.js'));
    await assert.rejects(verifyNativeCompatibilityPackage(missing), /missing native backend asset runtime\/server\.js/);

    const corrupt = path.join(base, 'corrupt-package');
    await fs.cp(packageRoot, corrupt, { recursive: true });
    await fs.appendFile(path.join(corrupt, 'runtime/index.js'), '\n// damaged test asset\n');
    await assert.rejects(verifyNativeCompatibilityPackage(corrupt), /native backend asset runtime\/index\.js/);

    process.env.DEX_REACH_STATE_DIR = path.join(base, 'isolated-state');
    const rejectedRegistry = new AdapterRegistry();
    const rejectedAdapter = new NativeCompatibilityAdapter(rejectedRegistry, corrupt);
    await assert.rejects(rejectedAdapter.start([base]), /native backend source integrity mismatch: runtime\/index\.js/);
    assert.deepEqual(rejectedRegistry.remoteToolSurface(), [], 'invalid package must fail before adapter admission');

    const allowedRoot = path.join(base, 'allowed');
    await fs.mkdir(allowedRoot);
    await write(path.join(allowedRoot, 'proof.txt'), 'staged backend read\n');
    const registry = new AdapterRegistry();
    const adapter = new NativeCompatibilityAdapter(registry, packageRoot);
    try {
      await adapter.start([allowedRoot]);
      assert.equal(adapter.listTools().length, 22);
      const result = await adapter.callTool('read_file', { path: path.join(allowedRoot, 'proof.txt') }) as { isError?: boolean; content?: Array<{ text?: string }> };
      assert.notEqual(result.isError, true);
      assert.match(result.content?.map(item => item.text || '').join('\n') || '', /staged backend read/);
    } finally {
      await adapter.close();
    }
  } finally {
    if (previousStateDir === undefined) delete process.env.DEX_REACH_STATE_DIR;
    else process.env.DEX_REACH_STATE_DIR = previousStateDir;
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

test('macOS install has a revision-bound rollback capsule and explicit recovery command', async () => {
  const packageJson = JSON.parse(await fs.readFile(path.resolve('package.json'), 'utf8')) as { scripts?: Record<string, string> };
  const installer = await fs.readFile(path.resolve('scripts/install-macos.ts'), 'utf8');
  const rollback = await fs.readFile(path.resolve('scripts/rollback-macos.ts'), 'utf8');
  assert.equal(packageJson.scripts?.['rollback:macos'], 'tsx scripts/rollback-macos.ts');
  const snapshotAt = installer.indexOf('prepareRuntimeRollbackSnapshot(');
  const workerWriteAt = installer.indexOf('atomicWriteFile(workspaceWorkerConfigFile()');
  const plistWriteAt = installer.indexOf('atomicWriteFile(service.target, contents');
  const activationAt = installer.indexOf("args: ['bootstrap', domain, helperTarget]");
  assert.ok(snapshotAt >= 0 && snapshotAt < workerWriteAt);
  assert.ok(workerWriteAt < plistWriteAt && plistWriteAt < activationAt);
  assert.match(installer, /launchctl.*print-disabled/s);
  assert.match(installer, /withFileLock\(installLockFile\(localStateDir\), install/);
  assert.match(rollback, /withFileLock\(installLockFile\(localStateDir\), rollback/);
  assert.equal(installLockFile('/state'), path.join('/state', 'runtime', 'install.lock'));
  assert.match(installer, /do not have distinct running process identities/);
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
