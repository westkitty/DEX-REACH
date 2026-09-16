import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import type { ExecutionFingerprint } from '../src/shared/protocol.js';
import {
  assertExecutionIdentityExpectation,
  assertExecutionIdentityStable,
  executionIdentityHash,
  parseExecutionIdentityExpectation
} from '../src/shared/execution-identity.js';
import { DEX_RELEASE_INVARIANTS, invariantManifest } from '../src/shared/invariants.js';

const fingerprint: ExecutionFingerprint = {
  nodeId: 'macbook-air.local',
  hostname: 'MacBook-Air.local',
  platform: 'darwin',
  arch: 'arm64',
  user: 'andrew',
  home: '/Users/andrew',
  cwd: '/Users/andrew/DEX-REACH',
  repositoryRoot: '/Users/andrew/DEX-REACH',
  branch: 'main',
  remote: 'git@github.com:westkitty/DEX-REACH.git',
  nodeVersion: 'v26.7.0',
  pythonVersion: 'Python 3.14.7'
};

test('execution identity expectations reject the wrong node or repository state', () => {
  const expected = parseExecutionIdentityExpectation({ nodeId: 'macbook-air.local', branch: 'main' });
  assert.doesNotThrow(() => assertExecutionIdentityExpectation(expected, fingerprint));
  assert.throws(
    () => assertExecutionIdentityExpectation(parseExecutionIdentityExpectation({ nodeId: 'other-node' }), fingerprint),
    /execution identity preflight failed: nodeId/
  );
  assert.throws(
    () => assertExecutionIdentityExpectation(parseExecutionIdentityExpectation({ repositoryRoot: '/tmp/not-this-repo' }), fingerprint),
    /repositoryRoot/
  );
  assert.throws(() => parseExecutionIdentityExpectation({ nope: 'x' }), /unsupported field/);
});

test('planned execution identity detects drift before mutation', () => {
  assert.doesNotThrow(() => assertExecutionIdentityStable(fingerprint, { ...fingerprint }));
  assert.throws(() => assertExecutionIdentityStable(fingerprint, { ...fingerprint, branch: 'trust-work' }), /branch/);
  assert.throws(() => assertExecutionIdentityStable(fingerprint, { ...fingerprint, user: 'someone-else' }), /user/);
  assert.equal(executionIdentityHash(fingerprint), executionIdentityHash({ ...fingerprint }));
});

test('machine invariant manifest is unique and synchronized with docs', async () => {
  const manifest = invariantManifest();
  const ids = manifest.entries.map(entry => entry.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(manifest.count, DEX_RELEASE_INVARIANTS.length);
  const docs = await fs.readFile('docs/INVARIANTS.md', 'utf8');
  const documented = [...new Set(docs.match(/DEX-INV-\d{3}/g) ?? [])].sort();
  assert.deepEqual(documented, [...ids].sort());
});
