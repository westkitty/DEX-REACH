import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { nativeCall } from '../src/node/native.js';
import { requiredCapabilities, requestPaths } from '../src/shared/capabilities.js';
import { requestedAuthorityCost } from '../src/shared/operations.js';
import { workspaceWorkerEligible } from '../src/shared/workspace-worker.js';
const exec = promisify(execFile);
async function fixture(fn: (root: string, outside: string) => Promise<void>) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dex-inspection-'));
  const root = path.join(dir, 'repo'); const outside = path.join(dir, 'outside');
  const previous = process.env.DEX_REACH_STATE_DIR;
  try {
    await fs.mkdir(path.join(root, 'src', 'deep'), { recursive: true }); await fs.mkdir(outside);
    await fs.writeFile(path.join(root, 'src', 'a.ts'), 'first\nneedle one\nlast\n');
    await fs.writeFile(path.join(root, 'src', 'b.ts'), 'needle two\nother\n');
    await fs.writeFile(path.join(root, 'src', 'deep', 'c.ts'), 'deep\n');
    await fs.writeFile(path.join(root, 'src', 'binary.bin'), Buffer.from([0, 255, 0]));
    await fs.mkdir(path.join(root, 'src', 'node_modules')); await fs.writeFile(path.join(root, 'src', 'node_modules', 'vendor.ts'), 'needle vendor');
    await fs.writeFile(path.join(outside, 'outside.txt'), 'outside');
    await fs.symlink(outside, path.join(root, 'src', 'escape'));
    process.env.DEX_REACH_STATE_DIR = path.join(root, 'private');
    await fs.mkdir(process.env.DEX_REACH_STATE_DIR); await fs.writeFile(path.join(process.env.DEX_REACH_STATE_DIR, 'secrets.env'), 'PRIVATE=value');
    await exec('git', ['init', '-b', 'fixture'], { cwd: root });
    await exec('git', ['-c', 'user.name=Proof', '-c', 'user.email=proof@example.invalid', 'commit', '--allow-empty', '-m', 'fixture'], { cwd: root });
    await fn(await fs.realpath(root), await fs.realpath(outside));
  } finally {
    if (previous === undefined) delete process.env.DEX_REACH_STATE_DIR; else process.env.DEX_REACH_STATE_DIR = previous;
    await fs.rm(dir, { recursive: true, force: true });
  }
}
const inspect = (root: string, operations: unknown[], extra: Record<string, unknown> = {}) => nativeCall('explicit-node', 'dex.repoInfo', { cwd: root, inspection: { operations, ...extra } }, [root], 'read-only') as Promise<any>;

test('old repoInfo remains compatible; one bounded bundle is deterministic, read-only and skips vendor/binary/symlink entries', async () => fixture(async root => {
  const old = await nativeCall('explicit-node', 'dex.repoInfo', { cwd: root }, [root], 'read-only');
  assert.deepEqual(Object.keys(old as object).sort(), ['branch', 'log', 'remote', 'root', 'status']);
  const beforeIndex = await fs.readFile(path.join(root, '.git', 'index')).catch(() => null);
  const operations = [
    { kind: 'tree', path: path.join(root, 'src'), depth: 2, maxEntries: 20 },
    { kind: 'search', paths: [path.join(root, 'src')], patterns: ['needle'], maxMatches: 10, contextLines: 1 },
    { kind: 'read', path: path.join(root, 'src', 'a.ts'), startLine: 2, maxLines: 1, maxBytes: 128 },
    { kind: 'read', path: path.join(root, 'src', 'binary.bin') }
  ];
  const result = await inspect(root, operations);
  assert.equal(result.root, root); assert.equal(result.branch, 'fixture');
  assert.equal(result.inspection.context.node_id, 'explicit-node');
  assert.equal(result.inspection.context.repositoryRoot, root);
  assert.equal(result.inspection.results[0].entries.some((e: any) => e.path.includes('vendor') || e.path.includes('escape') || e.path.includes('node_modules')), false);
  assert.deepEqual(result.inspection.results[1].matches.map((m: any) => [m.path, m.line, m.text]), [['src/a.ts', 2, 'needle one'], ['src/b.ts', 1, 'needle two']]);
  assert.deepEqual(result.inspection.results[2].lines, [{ line: 2, text: 'needle one' }]);
  assert.equal(result.inspection.results[3].binary, true); assert.deepEqual(result.inspection.results[3].lines, []);
  const repeated = await inspect(root, operations);
  assert.deepEqual(repeated.inspection.results, result.inspection.results);
  assert.deepEqual(await fs.readFile(path.join(root, '.git', 'index')).catch(() => null), beforeIndex);
  assert.equal(await fs.readFile(path.join(root, 'src', 'a.ts'), 'utf8'), 'first\nneedle one\nlast\n');
}));

test('inspection refuses root, repository, symlink, private-state and secret-file escapes', async () => fixture(async (root, outside) => {
  for (const file of [path.join(outside, 'outside.txt'), path.join(root, 'src', 'escape', 'outside.txt'), path.join(root, 'private', 'secrets.env')]) {
    await assert.rejects(inspect(root, [{ kind: 'read', path: file }]), /scope|allowed roots|private/i);
  }
  await fs.writeFile(path.join(root, '.env'), 'TOKEN=secret-value');
  await assert.rejects(inspect(root, [{ kind: 'read', path: path.join(root, '.env') }]), /sensitive|excluded/);
  await assert.rejects(inspect(root, [{ kind: 'tree', path: path.join(root, '.git') }]), /excluded/);
}));

test('operation/path counts, requested ceilings and malformed inputs fail clearly', async () => fixture(async root => {
  const read = { kind: 'read', path: path.join(root, 'src', 'a.ts') };
  for (const operations of [[], Array(9).fill(read), [{ kind: 'shell', command: 'pwd' }], [{ ...read, unexpected: true }], [{ ...read, path: '../outside' }], [{ ...read, maxBytes: 32769 }], [{ ...read, startLine: 10001 }], [{ ...read, maxLines: 201 }], [{ kind: 'tree', path: root, depth: 5 }], [{ kind: 'tree', path: root, maxEntries: 201 }], [{ kind: 'search', paths: [root], patterns: Array(5).fill('x') }], [{ kind: 'search', paths: [root], patterns: ['x'], maxMatches: 101 }], [{ kind: 'search', paths: [root], patterns: ['x'], contextLines: 3 }]]) {
    await assert.rejects(inspect(root, operations), /inspection/i);
  }
  await assert.rejects(inspect(root, [read], { timeoutMs: 5001 }), /inspection/i);
  await assert.rejects(inspect(root, [read], { maxResultBytes: 16385 }), /inspection/i);
  await assert.rejects(inspect(root, Array(5).fill({ kind: 'search', paths: Array(4).fill(root), patterns: ['x'] })), /paths|inspection/i);
  await assert.rejects(nativeCall('n', 'dex.repoInfo', { cwd: root, inspection: null }, [root], 'read-only'), /inspection/i);
}));

test('tree, matches, range reads and aggregate output stop at explicit runtime bounds', async () => fixture(async root => {
  const tree = await inspect(root, [{ kind: 'tree', path: path.join(root, 'src'), depth: 1, maxEntries: 1 }]);
  assert.equal(tree.inspection.results[0].entries.length, 1); assert.equal(tree.inspection.results[0].truncated, true);
  const shallow = await inspect(root, [{ kind: 'tree', path: path.join(root, 'src'), depth: 1 }]);
  assert.equal(shallow.inspection.results[0].entries.some((e: any) => e.path === 'src/deep/c.ts'), false);
  const found = await inspect(root, [{ kind: 'search', paths: [path.join(root, 'src')], patterns: ['needle'], maxMatches: 1 }]);
  assert.equal(found.inspection.results[0].matches.length, 1); assert.equal(found.inspection.results[0].truncated, true);
  const read = await inspect(root, [{ kind: 'read', path: path.join(root, 'src', 'a.ts'), maxBytes: 6, maxLines: 1 }]);
  assert.ok(read.inspection.results[0].bytesRead <= 6); assert.equal(read.inspection.results[0].truncated, true);
  await fs.writeFile(path.join(root, 'large.txt'), 'z'.repeat(4000));
  await assert.rejects(inspect(root, [{ kind: 'read', path: path.join(root, 'large.txt'), maxBytes: 8192 }], { maxResultBytes: 1024 }), /aggregate|result.*limit/i);
  const metadata = await inspect(root, [{ kind: 'read', path: path.join(root, 'large.txt'), maxBytes: 8192 }]);
  assert.ok(Buffer.byteLength(JSON.stringify(metadata)) <= 16384);
}));

test('bundles preserve file-read grants, logical operation budgets and the worker boundary', () => {
  const args = { cwd: '/repo', inspection: { operations: [{ kind: 'read', path: '/repo/a.ts' }, { kind: 'search', paths: ['/repo/src'], patterns: ['x'] }] } };
  assert.deepEqual(requiredCapabilities('dex.repoInfo', args), ['inspect', 'file.read']);
  assert.deepEqual(requestPaths(args), ['/repo', '/repo/a.ts', '/repo/src']);
  assert.equal(requestedAuthorityCost('dex.repoInfo', args).operations, 4);
  assert.equal(requestedAuthorityCost('dex.repoInfo', { cwd: '/repo' }).operations, 1);
  assert.equal(workspaceWorkerEligible('dex.repoInfo', args), false);
  assert.equal(workspaceWorkerEligible('dex.repoInfo', { cwd: '/repo' }), true);
});


test('inspection search patterns are absent from audit diagnostics and credentials are redacted from evidence', async () => fixture(async root => {
  const { summarizeContent } = await import('../src/shared/audit.js');
  const query = 'PRIVATE_PATTERN_VALUE';
  assert.ok(!JSON.stringify(summarizeContent({ inspection: { operations: [{ kind: 'search', patterns: [query] }] } })).includes(query));
  await fs.writeFile(path.join(root, 'src', 'credential.ts'), 'API_TOKEN=credential-value\n');
  const read = await inspect(root, [{ kind: 'read', path: path.join(root, 'src', 'credential.ts') }]);
  assert.ok(!JSON.stringify(read).includes('credential-value'));
}));

test('grants cannot authorize bundle reads with inspect alone or outside grant roots', async () => {
  const { authorizeOperation, defaultAccessState, createGrant } = await import('../src/shared/access.js');
  const actor = { kind: 'chatgpt' as const, clientId: 'c', clientName: 'test' };
  let state = defaultAccessState(); state.mode = 'on'; state.grantRequired.chatgpt = true;
  state = createGrant(state, 'chatgpt', ['inspect'], ['/repo'], 60000, null);
  const args = { cwd: '/repo', inspection: { operations: [{ kind: 'read', path: '/repo/a' }] } };
  assert.equal(authorizeOperation(state, actor, 'dex.repoInfo', 'development', Date.now(), args).allowed, false);
  state = createGrant(state, 'chatgpt', ['inspect', 'file.read'], ['/repo'], 60000, null);
  assert.equal(authorizeOperation(state, actor, 'dex.repoInfo', 'development', Date.now(), args).allowed, true);
  assert.equal(authorizeOperation(state, actor, 'dex.repoInfo', 'development', Date.now(), { ...args, inspection: { operations: [{ kind: 'read', path: '/outside/a' }] } }).allowed, false);
});

test('inspection deadline cancels metadata work without returning partial success', async () => fixture(async root => {
  const { inspectRepository } = await import('../src/node/repo-inspection.js');
  let signal!: AbortSignal;
  await assert.rejects(inspectRepository('n', root, [root], { operations: [{ kind: 'tree', path: root }], timeoutMs: 100 }, async (_cwd, observed) => {
    signal = observed;
    await new Promise(resolve => setTimeout(resolve, 150));
    return { root, branch: 'fixture' };
  }, value => value), /timeout/);
  assert.equal(signal.aborted, true);
}));

test('traversal and scan ceilings refuse oversized work instead of accumulating unbounded results', async () => fixture(async root => {
  const wide = path.join(root, 'wide'); await fs.mkdir(wide);
  for (let i = 0; i < 1025; i += 1) await fs.writeFile(path.join(wide, `f${i}`), 'x');
  await assert.rejects(inspect(root, [{ kind: 'tree', path: wide }]), /traversal.*limit/);
  const many = path.join(root, 'many'); await fs.mkdir(many);
  for (let i = 0; i < 65; i += 1) await fs.writeFile(path.join(many, `f${i}`), 'no match');
  await assert.rejects(inspect(root, [{ kind: 'search', paths: [many], patterns: ['absent'] }]), /file.*limit/);
}));
