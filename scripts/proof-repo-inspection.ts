/** Matched Phase 1 serial inspection versus one bounded inspection request; isolated real MCP. */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { startLivePair, type LivePair, type LiveCallResult } from './lib/live-reach.js';
import { verifyReceiptChain } from '../src/shared/receipts.js';
import { parseRepoInspection } from '../src/shared/repo-inspection.js';
const exec = promisify(execFile);
const args = process.argv.slice(2);
const value = (name: string) => args[args.indexOf(name) + 1];
if (!args.includes('--baseline') || !args.includes('--out')) throw new Error('usage: tsx scripts/proof-repo-inspection.ts --baseline <Phase-1-checkout> --out <evidence.json>');
const baseline = path.resolve(value('--baseline')!);
const output = path.resolve(value('--out')!);
const candidate = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const nodeId = `inspection-proof-${Date.now().toString(36)}`;
const pairs: LivePair[] = [];
const fixtures: Record<string, string> = {
  'src/access.ts': 'export function checkAccess(mode: string) {\n  return mode !== "off";\n}\nexport const modes = ["off", "read-only", "on"];\n',
  'src/router.ts': 'import { checkAccess } from "./access.js";\nexport function requireNode(id: string) {\n  if (!id) throw new Error("explicit node required");\n  return id;\n}\nexport const route = requireNode;\n',
  'src/client.ts': 'import { requireNode } from "./router.js";\nexport const read = (id: string) => ({ node_id: requireNode(id) });\nexport const limits = { bytes: 4096, files: 3 };\n'
};
const patterns = ['checkAccess', 'requireNode'];
const parseText = (result: LiveCallResult) => {
  assert.ok(result.ok, result.text);
  const parsed = JSON.parse(result.text);
  if (Array.isArray(parsed.content)) return parsed.content.map((item: { text?: string }) => item.text ?? '').join('\n');
  return parsed;
};
type Observation = { calls: number; serialClientAwaitBoundaries: number; elapsedMs: number; responseUtf8Bytes: number; resultContinuationCalls: number; searchRetrievalCalls: number; routedMs: number[]; equivalentEvidence: boolean };
async function createFixture(pair: LivePair) {
  for (const [file, content] of Object.entries(fixtures)) {
    await fs.mkdir(path.dirname(path.join(pair.roots, file)), { recursive: true });
    await fs.writeFile(path.join(pair.roots, file), content);
  }
  await exec('git', ['init', '-b', 'fixture'], { cwd: pair.roots });
  await exec('git', ['add', 'src'], { cwd: pair.roots });
  await exec('git', ['-c', 'user.name=Proof', '-c', 'user.email=proof@example.invalid', 'commit', '-m', 'bounded inspection fixture'], {
    cwd: pair.roots, env: { ...process.env, GIT_AUTHOR_DATE: '2026-10-02T12:00:00Z', GIT_COMMITTER_DATE: '2026-10-02T12:00:00Z' }
  });
  // Configure only the disposable test node; installed owner policy is never consulted or changed.
  await pair.dexCli(['read-only', '--node', nodeId]);
}
const expectedSearch = (pattern: string) => Object.entries(fixtures).flatMap(([file, contents]) => contents.split('\n').flatMap((line, index) => line.includes(pattern) ? [{ path: file, line: index + 1, text: line }] : []));
const normalizeInfo = (info: Record<string, unknown>) => ({ branch: info.branch, remote: info.remote, status: info.status, log: info.log });
let referenceInfo: ReturnType<typeof normalizeInfo> | undefined;
async function workflow(pair: LivePair, bundled: boolean): Promise<Observation> {
  const observation: Observation = { calls: 0, serialClientAwaitBoundaries: 0, elapsedMs: 0, responseUtf8Bytes: 0, resultContinuationCalls: 0, searchRetrievalCalls: 0, routedMs: [], equivalentEvidence: false };
  const call = async (tool: string, input: Record<string, unknown>) => {
    const start = performance.now(); const result = await pair.call(tool, { node_id: nodeId, ...input });
    observation.routedMs.push(performance.now() - start); observation.calls += 1;
    observation.serialClientAwaitBoundaries += 1;
    observation.responseUtf8Bytes += Buffer.byteLength(result.text, 'utf8');
    assert.ok(result.ok, result.text); assert.ok(result.traceId); assert.equal(result.structuredOutput, undefined);
    assert.ok(!result.text.includes('resultTruncated'), 'unexpected result continuation');
    return result;
  };
  const compat = async (tool: string, input: Record<string, unknown>) => parseText(await call('reach_call', { tool, arguments: input })) as string;
  const started = performance.now();
  if (bundled) {
    const operations = [
      { kind: 'tree', path: path.join(pair.roots, 'src'), depth: 2, maxEntries: 20 },
      ...patterns.map(pattern => ({ kind: 'search', paths: [path.join(pair.roots, 'src')], patterns: [pattern], maxMatches: 20, contextLines: 0, maxBytes: 4096 })),
      ...Object.keys(fixtures).map(file => ({ kind: 'read', path: path.join(pair.roots, file), startLine: 1, maxLines: 6, maxBytes: 4096 }))
    ];
    const inspection = parseRepoInspection({ operations, maxResultBytes: 8192, timeoutMs: 5000 });
    const info = parseText(await call('reach_repo_info', { cwd: pair.roots, inspection }));
    assert.equal(info.inspection.context.node_id, nodeId); assert.equal(info.inspection.context.repositoryRoot, await fs.realpath(pair.roots));
    assert.deepEqual(normalizeInfo(info), referenceInfo);
    const results = info.inspection.results;
    assert.deepEqual(results[0].entries.map((entry: { path: string }) => entry.path).sort(), Object.keys(fixtures).sort());
    assert.equal(results[0].truncated, false);
    for (const [index, pattern] of patterns.entries()) {
      assert.deepEqual(results[index + 1].matches.map(({ path, line, text }: { path: string; line: number; text: string }) => ({ path, line, text })).sort((a: any, b: any) => a.path.localeCompare(b.path) || a.line - b.line), expectedSearch(pattern).sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line));
      assert.equal(results[index + 1].truncated, false);
    }
    for (const [index, [file, contents]] of Object.entries(fixtures).entries()) {
      assert.deepEqual(results[index + 3].lines.map((line: { text: string }) => line.text), contents.trimEnd().split('\n'));
      assert.equal(results[index + 3].truncated, false);
    }
  } else {
    const info = parseText(await call('reach_repo_info', { cwd: pair.roots }));
    const normalized = normalizeInfo(info);
    if (!referenceInfo) referenceInfo = normalized; else assert.deepEqual(normalized, referenceInfo);
    const tree = await compat('list_directory', { path: path.join(pair.roots, 'src'), depth: 2 });
    assert.deepEqual(tree.split('\n').filter(Boolean).map(line => line.replace(/^\[FILE\] /, '')).sort(), Object.keys(fixtures).map(file => path.basename(file)).sort());
    // Start both searches before known-file reads; avoid adding artificial rediscovery or idle waits.
    const searches = [];
    for (const pattern of patterns) searches.push({ pattern, text: await compat('start_search', { path: path.join(pair.roots, 'src'), pattern, searchType: 'content', ignoreCase: false, literalSearch: true, maxResults: 20, contextLines: 0, timeout_ms: 5000 }) });
    for (const [file, contents] of Object.entries(fixtures)) {
      const text = await compat('read_file', { path: path.join(pair.roots, file), offset: 0, length: 6 });
      assert.ok(text.endsWith(contents.trimEnd()), 'baseline ranged read differs');
    }
    for (const search of searches) {
      let text = search.text;
      const sessionId = text.match(/session: (search_[^\s]+)/)?.[1]; assert.ok(sessionId);
      const deadline = performance.now() + 6000;
      while (!text.includes('Status: COMPLETED')) {
        assert.ok(performance.now() < deadline, 'baseline search did not finish');
        text = await compat('get_more_search_results', { sessionId, offset: 0, length: 100 });
        observation.searchRetrievalCalls += 1;
        if (!text.includes('Status: COMPLETED')) await new Promise(resolve => setTimeout(resolve, 100));
      }
      const expected = expectedSearch(search.pattern);
      for (const match of expected) assert.ok(text.includes(`${path.join(pair.roots, match.path)}:${match.line} - ${search.pattern}`), `baseline search missing ${match.path}:${match.line}`);
      const total = text.match(/Total results(?: found)?: (\d+)/); assert.ok(total); assert.equal(Number(total[1]), expected.length);
      assert.ok(!text.includes('More results available'));
    }
  }
  observation.elapsedMs = performance.now() - started; observation.equivalentEvidence = true;
  return observation;
}
try {
  for (const repoRoot of [baseline, candidate]) {
    const workspace = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'dex-phase2-proof-'));
    const pair = await startLivePair({ repoRoot, workspace, nodeIds: [nodeId], timeoutMs: 90000 }); pairs.push(pair);
    await createFixture(pair);
    const nodes = parseText(await pair.call('reach_list_nodes', {})); assert.equal(nodes.length, 1); assert.equal(nodes[0].nodeId, nodeId);
  }
  const warmups = [await workflow(pairs[0]!, false), await workflow(pairs[1]!, true)];
  const measured: { baseline: Observation[]; candidate: Observation[] } = { baseline: [], candidate: [] };
  for (let round = 0; round < 5; round += 1) for (const index of round % 2 ? [1, 0] : [0, 1]) measured[index ? 'candidate' : 'baseline'].push(await workflow(pairs[index]!, Boolean(index)));
  // Additional real node refusals outside timing, followed by policy-preservation and audit checks.
  const pair = pairs[1]!;
  const refusalCases = [
    { cwd: pair.roots, inspection: { operations: [{ kind: 'read', path: path.join(pair.stateDir, 'secrets.env') }] } },
    { cwd: pair.roots, inspection: { operations: [{ kind: 'read', path: '/etc/hosts' }] } },
    { cwd: pair.roots, inspection: { operations: [{ kind: 'tree', path: pair.roots, depth: 5 }] } }
  ];
  for (const input of refusalCases) assert.equal((await pair.call('reach_repo_info', { node_id: nodeId, ...input })).ok, false);
  assert.equal((await pair.call('reach_repo_info', { node_id: 'unknown-explicit-node', cwd: pair.roots })).ok, false);
  for (const pair of pairs) {
    const receipts = (await fs.readFile(path.join(pair.stateDir, 'receipts', `${nodeId}.jsonl`), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    assert.ok(verifyReceiptChain(receipts));
    const audit = await fs.readFile(path.join(pair.stateDir, 'audit.jsonl'), 'utf8');
    if (pair === pairs[1]) {
      assert.ok(!audit.includes('"patterns": ["checkAccess"]'));
      assert.ok(audit.includes('search patterns omitted'));
      const nodes = parseText(await pair.call('reach_list_nodes', {})); assert.equal(nodes[0].aiAccess.mode, 'read-only');
    }
  }
  const summarize = (observations: Observation[]) => {
    const elapsed = observations.map(item => item.elapsedMs).sort((a,b) => a-b);
    return { workflows: observations.length, callsPerIntent: observations.map(item => item.calls), medianWallMs: elapsed[2], medianResponseUtf8Bytes: observations.map(item => item.responseUtf8Bytes).sort((a,b) => a-b)[2], resultContinuationRequired: false };
  };
  const evidence = { baselineCommit: '935e7a6f0a1fb5e38e7f47045043d9a0cca7dcfe', candidateBase: '935e7a6f0a1fb5e38e7f47045043d9a0cca7dcfe', transport: 'real OAuth-authorized MCP Streamable HTTP; loopback ephemeral ports', fixtureUtf8Bytes: Object.values(fixtures).reduce((sum,text)=>sum+Buffer.byteLength(text),0), fixtureFiles: Object.keys(fixtures), intent: 'repo info + depth-2 tree + two literal searches + three six-line reads', discoveryCallsExcludedPerVersion: 1, initializationExcluded: true, warmups, measured, summary: { baseline: summarize(measured.baseline), candidate: summarize(measured.candidate) }, equivalentEvidence: true, signedReceiptChainsValid: true, explicitUnknownNodeRefused: true, nodeScopeRefusals: true, installedClientExperience: 'UNVERIFIED', modelReasoningTimeSavings: 'not measured' };
  await fs.writeFile(output, JSON.stringify(evidence,null,2)+'\n'); console.log(JSON.stringify(evidence.summary));
} finally { for (const pair of [...pairs].reverse()) { await pair.stop(); await fs.rm(pair.workspace,{recursive:true,force:true}); } }
