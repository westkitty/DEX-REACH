import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { discoverGitProjects, portfolio, resolveProject } from '../src/node/projects.js';

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync('git', args, { cwd });
}

test('project discovery finds bounded git roots and reports dirty state', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dex-projects-'));
  try {
    const a = path.join(root, 'Alpha');
    const nested = path.join(root, 'group', 'Beta');
    await fs.mkdir(a, { recursive: true });
    await fs.mkdir(nested, { recursive: true });
    await git(a, ['init']);
    await git(nested, ['init']);
    await fs.writeFile(path.join(a, 'README.md'), 'alpha\n');
    await git(a, ['add', 'README.md']);

    const found = await discoverGitProjects([root], { maxDepth: 3 });
    assert.deepEqual(found.sort(), [await fs.realpath(a), await fs.realpath(nested)].sort());

    const summaries = await portfolio([root], { maxDepth: 3 });
    const alpha = summaries.find(project => project.name === 'Alpha');
    assert.ok(alpha);
    assert.equal(alpha.dirty, true);
    assert.ok(alpha.changes >= 1);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('project resolver requires a unique match', () => {
  const projects = [
    { name: 'Alpha', path: '/tmp/one/Alpha', branch: 'main', remote: 'git@github.com:x/Alpha.git', dirty: false, changes: 0, upstream: null, ahead: null, behind: null },
    { name: 'Alpha-tools', path: '/tmp/two/Alpha-tools', branch: 'main', remote: 'git@github.com:x/Alpha-tools.git', dirty: false, changes: 0, upstream: null, ahead: null, behind: null }
  ];
  assert.equal(resolveProject('Alpha', projects).path, '/tmp/one/Alpha');
  assert.throws(() => resolveProject('alp', projects), /ambiguous project/);
  assert.throws(() => resolveProject('missing', projects), /project not found/);
});
