import test from 'node:test';
import assert from 'node:assert/strict';
import { exactShaCheckRows, aggregateCheckRuns, REQUIRED_HOSTED_CHECKS, RELEASE_ROOT, isCanonicalRepository, releaseCandidateIdentity, readReleaseHostedEvidence } from '../scripts/lib/c14-recovery-preflight.js';
const sha = 'a'.repeat(40);
function evidence() {
  const workflows = [{ name: 'DEX validation', path: '.github/workflows/ci.yml', check_suite_id: 1 }, { name: 'CodeQL', path: '.github/workflows/codeql.yml', check_suite_id: 2 }].map(w => ({ ...w, head_sha: sha, event: 'push', head_branch: 'main', status: 'completed', conclusion: 'success', repository: { full_name: 'westkitty/DEX-REACH' } }));
  const checks = ['validate', 'runtime-proof', 'reproducible-build', 'analyze'].map(name => ({ name, head_sha: sha, status: 'completed', conclusion: 'success', check_suite: { id: name === 'analyze' ? 2 : 1 }, app: { slug: 'github-actions' } }));
  return { c: { total_count: checks.length, check_runs: checks }, w: { total_count: workflows.length, workflow_runs: workflows } };
}
function passes(e: ReturnType<typeof evidence>) { const rows = aggregateCheckRuns(exactShaCheckRows(sha, e.c, e.w)); return REQUIRED_HOSTED_CHECKS.every(k => rows[k] === 'SUCCESS'); }
test('exact main push jobs and CodeQL workflow prove source CI only', () => { assert.ok(passes(evidence())); });
for (const fault of ['pr', 'wrong-branch', 'wrong-repo', 'stale-sha', 'missing-codeql', 'skipped', 'failed', 'cancelled', 'pending', 'duplicate-check', 'duplicate-workflow', 'wrong-app', 'wrong-suite', 'truncated', 'malformed']) {
 test(`release CI refuses ${fault}`, () => {
  const e = evidence();
  if (fault === 'pr') e.w.workflow_runs[0]!.event = 'pull_request';
  if (fault === 'wrong-branch') e.w.workflow_runs[0]!.head_branch = 'release/0.4.0-prep';
  if (fault === 'wrong-repo') e.w.workflow_runs[0]!.repository.full_name = 'someone/DEX-REACH';
  if (fault === 'stale-sha') e.c.check_runs[0]!.head_sha = 'b'.repeat(40);
  if (fault === 'missing-codeql') { e.w.workflow_runs.pop(); e.w.total_count--; }
  if (['skipped', 'failed', 'cancelled'].includes(fault)) e.c.check_runs[0]!.conclusion = fault;
  if (fault === 'pending') e.c.check_runs[0]!.status = 'in_progress';
  if (fault === 'duplicate-check') { e.c.check_runs.push({ ...e.c.check_runs[0]! }); e.c.total_count++; }
  if (fault === 'duplicate-workflow') { e.w.workflow_runs.push({ ...e.w.workflow_runs[0]! }); e.w.total_count++; }
  if (fault === 'wrong-app') e.c.check_runs[0]!.app.slug = 'third-party';
  if (fault === 'wrong-suite') e.c.check_runs[0]!.check_suite.id = 999;
  if (fault === 'truncated') e.c.total_count++;
  if (fault === 'malformed') e.c.check_runs[0] = null as any;
  assert.equal(passes(e), false);
 });
}
test('missing credentials, unavailable API and malformed GitHub JSON fail closed', async () => {
 for (const api of [async () => { throw new Error('unavailable'); }, async () => '{', async () => '{}']) assert.deepEqual(await readReleaseHostedEvidence(sha, api), { rows: [], available: false });
 const e = evidence(); assert.equal((await readReleaseHostedEvidence(sha, async endpoint => JSON.stringify(endpoint.includes('check-runs') ? e.c : e.w))).available, true);
});
const facts = () => ({ root: RELEASE_ROOT, branch: '', head: sha, remoteHead: sha, dirty: false, repositoryUrl: 'git@github.com:westkitty/DEX-REACH.git', approvedSha: sha, candidateVersion: '0.4.0', approvedVersion: '0.4.0' });
test('versioned release identity separates source approval from maintenance authority', () => {
 assert.deepEqual(releaseCandidateIdentity(facts()), { version: 1, repository: 'westkitty/DEX-REACH', line: 'main', checkout: RELEASE_ROOT, sha, packageVersion: '0.4.0', hostedEvent: 'push' });
});
for (const [field, value] of [['root', '/other'], ['branch', 'release/0.4.0-prep'], ['head', 'b'.repeat(40)], ['remoteHead', 'b'.repeat(40)], ['approvedSha', 'short'], ['repositoryUrl', 'git@github.com:other/DEX-REACH.git'], ['dirty', true], ['approvedVersion', '0.3.2']]) test(`candidate refuses ${field}`, () => { assert.equal(releaseCandidateIdentity({ ...facts(), [field as string]: value }), null); });
test('canonical repository accepts resolved approved transport rewrites without accepting lookalikes', () => {
 for (const url of ['git@github.com:westkitty/DEX-REACH.git', 'ssh://git@github.com/westkitty/DEX-REACH.git', 'https://github.com/westkitty/DEX-REACH']) assert.ok(isCanonicalRepository(url));
 for (const url of ['https://github.com.evil/westkitty/DEX-REACH', 'https://github.com/westkitty/DEX', 'git@other:westkitty/DEX-REACH.git']) assert.equal(isCanonicalRepository(url), false);
});
