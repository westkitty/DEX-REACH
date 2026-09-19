import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  HARDWARE_NOT_AVAILABLE,
  buildProofRun,
  describeProofRun,
  type EnvironmentAvailability,
  type ProofEnvironment,
  type ProofObservation
} from '../src/shared/proof-matrix.js';
import type { RequestActor } from '../src/shared/protocol.js';
import type { LivePair } from './lib/live-reach.js';
import { arg, flag } from './lib/node-files.js';

/**
 * Run every DEX//REACH proof this machine can actually establish, and record the rest as
 * explicitly unverified.
 *
 * The rule the whole script is built around: a proof is what was observed here, now. Nothing is
 * carried over from a previous run, nothing is inferred from a test suite having passed, and no
 * item is reported as established because the code that would establish it exists. Where the
 * hardware is absent the line says so in those words, and `reconcileProofRun` enforces that even
 * if this file tried to claim otherwise.
 */

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tsx = path.join(repoRoot, 'node_modules/tsx/dist/cli.mjs');

// Isolate every piece of node-local state before anything reads it. The owner's real state
// directory is never opened by this script, so a proof run cannot disturb a working install.
const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'dex-reach-proof-'));
const stateDir = path.join(workspace, 'state');
const roots = path.join(workspace, 'roots');
await fs.mkdir(stateDir, { recursive: true, mode: 0o700 });
await fs.mkdir(roots, { recursive: true, mode: 0o700 });
process.env.DEX_REACH_STATE_DIR = stateDir;

const { loadAccessState, authorizeOperation, saveAccessState, defaultAccessState, createGrant, reserveOperation, classifyClient } = await import('../src/shared/access.js');
const { executionFingerprint } = await import('../src/shared/fingerprint.js');
const { workspaceSafeOperationRefusal, workspaceSafeToolRefusal } = await import('../src/shared/profiles.js');
const { nativeCall } = await import('../src/node/native.js');
const { upsertBudgetRule, makeBudgetRule } = await import('../src/shared/budget-policy.js');
const { appendReceipt, listReceipts, verifyReceipt, verifyReceiptChain } = await import('../src/shared/receipts.js');
const { newTraceId, newSpanId, recordSpan, readTrace } = await import('../src/shared/trace.js');
const { exportEvidenceBundle, verifyEvidenceBundle, serializeEvidenceBundle } = await import('../src/shared/evidence.js');
const { snapshotCapacity } = await import('../src/shared/work-coordinator.js');
const { substantiveSlotsFor } = await import('../src/shared/machine-capacity.js');
const { remoteCompatibilityTools, remoteBlockedCompatibilityTools } = await import('../src/shared/operations.js');
const { DEX_RELEASE_INVARIANTS } = await import('../src/shared/invariants.js');
const { startLivePair } = await import('./lib/live-reach.js');

const observations: ProofObservation[] = [];

/**
 * Run one proof. A thrown error is a failed proof, not a crashed run: the other eighteen items are
 * still worth establishing, and a runner that aborts on the first failure reports less the worse
 * things are.
 */
async function prove(id: string, fn: () => Promise<string[]>): Promise<void> {
  try {
    const observed = await fn();
    observations.push({ id, status: 'pass', detail: 'Established in this run.', observed });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    observations.push({ id, status: 'fail', detail: `Not established: ${message}`, observed: [] });
  }
}

function expect(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

/**
 * Compare two surfaces and say exactly how they differ.
 *
 * A bare count check passes when one tool is swapped for another, and that is the interesting
 * failure: a surface that grew by one withheld tool and shrank by one intended one.
 */
function assertSameSurface(actual: readonly string[], expected: readonly string[], what: string): void {
  const extra = actual.filter(name => !expected.includes(name));
  const missing = expected.filter(name => !actual.includes(name));
  expect(!extra.length && !missing.length,
    `the ${what} are not the contracted set: ${extra.length ? `unexpected ${extra.join(', ')}` : ''}${extra.length && missing.length ? '; ' : ''}${missing.length ? `missing ${missing.join(', ')}` : ''}`);
}

/** The contracted first-class surface, restated here so a proof run is not checking a value against itself. */
const EXPECTED_MCP_ACTIONS = [
  'reach_list_nodes', 'reach_list_tools', 'reach_call', 'reach_fingerprint', 'reach_trust_report',
  'reach_repo_info', 'reach_adb_devices', 'reach_checkpoint', 'reach_file_read', 'reach_file_write',
  'reach_process_run', 'reach_plan', 'reach_commit_plan', 'reach_receipts', 'reach_result_read', 'reach_revoke_node'
] as const;

async function refusalOf(fn: () => Promise<unknown>, what: string): Promise<string> {
  try {
    await fn();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error(`${what} was admitted; it must be refused`);
}

const ACTOR: RequestActor = { clientName: 'Claude proof run', clientId: 'proof-run-client', kind: classifyClient('claude') };

// ---------------------------------------------------------------------------
// Proofs that this process can establish against the real modules
// ---------------------------------------------------------------------------

async function inProcessProofs(): Promise<void> {
  await prove('initial-access-off', async () => {
    const fresh = await loadAccessState('never-configured-node', stateDir);
    expect(fresh.mode === 'off', `a node with no policy file resolved to ${fresh.mode}`);
    const refused = authorizeOperation(fresh, ACTOR, 'dex.fingerprint', 'development');
    expect(!refused.allowed, 'a node with no policy file admitted an operation');

    // Fails closed rather than open: a policy file that cannot be parsed must not become a
    // permissive default, which is the single most consequential way this could be wrong.
    await fs.mkdir(path.join(stateDir, 'nodes'), { recursive: true, mode: 0o700 });
    await fs.writeFile(path.join(stateDir, 'nodes', 'corrupt-node.access.json'), '{ this is not json', { mode: 0o600 });
    const corrupt = await loadAccessState('corrupt-node', stateDir);
    expect(corrupt.mode === 'off', `a corrupt policy file resolved to ${corrupt.mode}`);

    // The starting mode comes from the enrollment file, which the owner can edit. A value that is
    // not a recognised mode must land on OFF rather than on whatever the string happened to be.
    const previous = process.env.DEX_REACH_INITIAL_ACCESS;
    try {
      process.env.DEX_REACH_INITIAL_ACCESS = 'off';
      expect(defaultAccessState().mode === 'off', 'an initial access of off did not resolve to off');
      process.env.DEX_REACH_INITIAL_ACCESS = 'enabled-please';
      expect(defaultAccessState().mode === 'off', `an unrecognised initial access resolved to ${defaultAccessState().mode}`);
    } finally {
      if (previous === undefined) delete process.env.DEX_REACH_INITIAL_ACCESS;
      else process.env.DEX_REACH_INITIAL_ACCESS = previous;
    }

    return [
      `no policy file → mode ${fresh.mode}; ${'reason' in refused ? refused.reason : ''}`.trim(),
      `unparseable policy file → mode ${corrupt.mode}`,
      'an unrecognised DEX_REACH_INITIAL_ACCESS value → mode off'
    ];
  });

  await prove('identity-fingerprint', async () => {
    const fingerprint = await executionFingerprint('proof-node', repoRoot);
    expect(fingerprint.hostname === os.hostname(), 'the fingerprint hostname is not this host');
    expect(fingerprint.platform === process.platform, 'the fingerprint platform is not this platform');
    expect(fingerprint.user === os.userInfo().username, 'the fingerprint user is not this user');
    expect(fingerprint.repositoryRoot === repoRoot, `the fingerprint repository root is ${fingerprint.repositoryRoot}`);
    return [
      `platform ${fingerprint.platform}/${fingerprint.arch}, node ${fingerprint.nodeVersion}`,
      `repository ${fingerprint.repositoryRoot} on branch ${fingerprint.branch ?? '(detached)'}`
    ];
  });

  await prove('read-only-mode', async () => {
    const state = { ...defaultAccessState(), mode: 'read-only' as const };
    const inspect = authorizeOperation(state, ACTOR, 'dex.fingerprint', 'development');
    expect(inspect.allowed, 'READ-ONLY refused inspection, so it is a disguised OFF');
    expect(inspect.allowed && inspect.effectiveProfile === 'read-only', 'READ-ONLY admitted inspection under a wider profile');
    const read = authorizeOperation(state, ACTOR, 'dex.file.read', 'development');
    expect(read.allowed, 'READ-ONLY refused a file read');
    return [`dex.fingerprint admitted with effective profile ${inspect.allowed ? inspect.effectiveProfile : ''}`, 'dex.file.read admitted'];
  });

  await prove('workspace-safe-profile', async () => {
    const shell = workspaceSafeOperationRefusal('workspace-safe', 'dex.process.run');
    expect(shell, 'workspace-safe admitted dex.process.run');
    const write = workspaceSafeOperationRefusal('workspace-safe', 'dex.file.write');
    expect(!write, 'workspace-safe refused a typed file write, which is inside its grammar');
    const tool = workspaceSafeToolRefusal('workspace-safe', 'start_process');
    expect(tool, 'workspace-safe admitted a compatibility tool that would widen it');
    return [shell!.slice(0, 160), `dex.file.write admitted`, tool!.slice(0, 160)];
  });

  await prove('typed-mutation', async () => {
    const inside = path.join(roots, 'typed-mutation.txt');
    await nativeCall('proof-node', 'dex.file.write', { path: inside, text: 'written by the proof run\n', mode: 'rewrite' }, [roots], 'workspace-safe');
    const contents = await fs.readFile(inside, 'utf8');
    expect(contents.includes('written by the proof run'), 'the typed write did not land');

    const outsideTarget = path.join(workspace, 'outside-every-root.txt');
    const outside = await refusalOf(
      () => nativeCall('proof-node', 'dex.file.write', { path: outsideTarget, text: 'escaped', mode: 'rewrite' }, [roots], 'workspace-safe'),
      'a write outside every allowed root'
    );

    // A symlink inside the roots pointing out of them is the interesting case: a string-prefix
    // check on the requested path passes it, and only canonicalization catches it.
    const link = path.join(roots, 'escape-link');
    // Not best-effort. If the symlink is not there, the write below is refused because its parent
    // directory does not exist, and this proof passes without ever testing a symlink escape.
    await fs.symlink(workspace, link);
    expect(await fs.realpath(link) === await fs.realpath(workspace), 'the escape symlink does not point out of the roots');
    const viaLink = await refusalOf(
      () => nativeCall('proof-node', 'dex.file.write', { path: path.join(link, 'escaped-by-symlink.txt'), text: 'escaped', mode: 'rewrite' }, [roots], 'workspace-safe'),
      'a write that leaves the roots through a symlink'
    );
    await fs.access(path.join(workspace, 'escaped-by-symlink.txt')).then(
      () => { throw new Error('the symlinked write actually created a file outside the roots'); },
      () => undefined
    );

    return [`wrote ${path.basename(inside)} inside the allowed root`, outside.slice(0, 160), viaLink.slice(0, 160)];
  });

  await prove('arbitrary-shell-refusal', async () => {
    const underReadOnly = await refusalOf(
      () => nativeCall('proof-node', 'dex.process.run', { command: 'echo proof', cwd: roots }, [roots], 'read-only'),
      'a shell command under the read-only profile'
    );
    const underWorkspaceSafe = await refusalOf(
      () => nativeCall('proof-node', 'dex.process.run', { command: 'echo proof', cwd: roots }, [roots], 'workspace-safe'),
      'a shell command under the workspace-safe profile'
    );
    return [underReadOnly.slice(0, 160), underWorkspaceSafe.slice(0, 160)];
  });

  await prove('temporary-grant', async () => {
    const nodeId = 'grant-proof-node';
    const base = { ...defaultAccessState(), mode: 'on' as const };
    // One use, and a life measured in seconds. Both limits are proved, not just the one that is
    // easier to trigger.
    const granted = createGrant(base, ACTOR.kind, ['file.write'], [roots], 4000, 1);
    await saveAccessState(nodeId, granted, stateDir);

    const target = { path: path.join(roots, 'granted.txt'), text: 'granted\n', mode: 'rewrite' };
    const first = await reserveOperation(nodeId, ACTOR, 'dex.file.write', 'development', target, { dir: stateDir });
    expect(first.decision.allowed, 'a live grant refused the operation it was created for');

    const exhausted = await refusalOf(
      () => reserveOperation(nodeId, ACTOR, 'dex.file.write', 'development', target, { dir: stateDir }),
      'a second use of a single-use grant'
    );

    const secondNode = 'grant-expiry-node';
    // Already expired when written, so the expiry branch is exercised without a sleep that would
    // make the run flaky on a loaded machine.
    const expiring = createGrant({ ...defaultAccessState(), mode: 'on' as const }, ACTOR.kind, ['file.write'], [roots], 1, null);
    const backdated = {
      ...expiring,
      grants: expiring.grants.map(grant => ({ ...grant, until: new Date(Date.now() - 1000).toISOString() }))
    };
    await saveAccessState(secondNode, backdated, stateDir);
    const expired = await refusalOf(
      () => reserveOperation(secondNode, ACTOR, 'dex.file.write', 'development', target, { dir: stateDir }),
      'an operation under an expired grant'
    );

    return [`grant ${first.decision.grantId} admitted one use`, exhausted.slice(0, 160), expired.slice(0, 160)];
  });

  await prove('rolling-budget-exhaustion', async () => {
    const nodeId = 'budget-proof-node';
    await saveAccessState(nodeId, { ...defaultAccessState(), mode: 'on' }, stateDir);
    await upsertBudgetRule(nodeId, 'shared', makeBudgetRule('shared', 60 * 60_000, { maxOperations: 2 }), stateDir);

    const args = { path: path.join(roots, 'budgeted.txt'), text: 'x', mode: 'rewrite' };
    await reserveOperation(nodeId, ACTOR, 'dex.file.write', 'development', args, { dir: stateDir });
    await reserveOperation(nodeId, ACTOR, 'dex.file.write', 'development', args, { dir: stateDir });
    const refused = await refusalOf(
      () => reserveOperation(nodeId, ACTOR, 'dex.file.write', 'development', args, { dir: stateDir }),
      'a third operation against a two-operation rolling budget'
    );

    // The concurrency ceiling, proved across real processes rather than inside this event loop.
    const concurrentNode = 'concurrency-proof-node';
    await saveAccessState(concurrentNode, { ...defaultAccessState(), mode: 'on' }, stateDir);
    await upsertBudgetRule(concurrentNode, 'shared', makeBudgetRule('shared', 60 * 60_000, { maxConcurrent: 5 }), stateDir);
    const contenders = 20;
    const outcomes = await runContenders(Array.from({ length: contenders }, () => ({
      mode: 'budget-slot', stateDir, nodeId: concurrentNode, client: ACTOR.kind
    })));
    const admitted = outcomes.filter(entry => entry.outcome === 'admitted').length;
    const errored = outcomes.filter(entry => entry.outcome === 'error');
    expect(!errored.length, `${errored.length} contender process(es) errored: ${errored[0]?.detail ?? ''}`);
    expect(admitted === 5, `${contenders} processes against a 5-slot ceiling admitted ${admitted}`);

    return [
      refused.slice(0, 160),
      `${contenders} separate OS processes against a 5-slot concurrency ceiling: ${admitted} admitted, ${contenders - admitted} refused`,
      `distinct pids observed: ${new Set(outcomes.map(entry => entry.pid)).size}`
    ];
  });

  await prove('machine-queue-admission', async () => {
    const measured = await snapshotCapacity();
    // The machine's own memory and CPU, but a fixed reading of everything transient. Admission
    // subtracts uncoordinated heavy workloads from the ceiling, and twenty contender processes on
    // a small container are themselves uncoordinated heavy workloads -- so measuring live pressure
    // here would make this proof a measurement of the proof run. What is under proof is the
    // coordinator's arithmetic against a stated host, and that is what is stated.
    const snapshot = {
      ...measured,
      loadAverage1m: 0,
      memory: 'healthy' as const,
      thermal: 'healthy' as const,
      observed: { uncoordinatedHeavy: 0, dexServices: 0 }
    };
    const slots = substantiveSlotsFor(snapshot.physicalMemoryBytes, snapshot.logicalCpuCount);
    const contenders = slots + 6;
    const repositories = await Promise.all(Array.from({ length: contenders }, async (_ignored, index) => {
      const dir = path.join(workspace, 'repos', `repo-${index}`);
      await fs.mkdir(dir, { recursive: true, mode: 0o700 });
      return dir;
    }));
    const outcomes = await runContenders(repositories.map(repositoryRoot => ({
      mode: 'work-acquire', stateDir, repositoryRoot, access: 'mutate', workload: 'medium', snapshot
    })));
    const admitted = outcomes.filter(entry => entry.outcome === 'admitted').length;
    const errored = outcomes.filter(entry => entry.outcome === 'error');
    expect(!errored.length, `${errored.length} contender process(es) errored: ${errored[0]?.detail ?? ''}`);
    expect(admitted === slots, `${contenders} processes against ${slots} substantive slot(s) admitted ${admitted}`);
    const refusal = outcomes.find(entry => entry.outcome === 'refused')?.detail ?? '';
    return [
      `host measured at ${(snapshot.physicalMemoryBytes / 1024 ** 3).toFixed(1)} GiB and ${snapshot.logicalCpuCount} logical CPUs, with transient pressure fixed at healthy → ${slots} substantive slot(s)`,
      `${contenders} separate OS processes: ${admitted} admitted, ${contenders - admitted} queued`,
      refusal.slice(0, 160)
    ];
  });

  await prove('execution-trace', async () => {
    const traceId = newTraceId();
    const root = newSpanId();
    const stages = ['mcp', 'gateway', 'node', 'authorize', 'execute', 'receipt'] as const;
    let parent: string | undefined;
    for (const stage of stages) {
      const spanId = stage === 'mcp' ? root : newSpanId();
      await recordSpan({
        traceId, spanId, parentSpanId: parent, stage, at: new Date().toISOString(),
        operation: 'dex.file.write', nodeId: 'proof-node', actorKind: ACTOR.kind, ok: true, durationMs: 1,
        // Offered deliberately. A span must not be able to carry content, and the only way to know
        // that is to hand it some and look for it afterwards.
        ...({ command: 'echo THIS-MUST-NOT-BE-RECORDED', text: 'THIS-MUST-NOT-BE-RECORDED' } as Record<string, unknown>)
      });
      parent = spanId;
    }
    const spans = await readTrace(traceId);
    expect(spans.length === stages.length, `recorded ${stages.length} spans and read back ${spans.length}`);
    expect(spans.every(span => span.traceId === traceId), 'spans did not share one trace id');
    const chained = spans.slice(1).every((span, index) => span.parentSpanId === spans[index]!.spanId);
    expect(chained, 'spans were not linked parent to child');
    const serialized = JSON.stringify(spans);
    expect(!serialized.includes('THIS-MUST-NOT-BE-RECORDED'), 'a trace span carried content offered to it');
    return [
      `trace ${traceId} carries ${spans.length} linked spans: ${spans.map(span => span.stage).join(' → ')}`,
      'content offered to every span was not written to the trace'
    ];
  });

  await prove('signed-receipt-chain', async () => {
    const nodeId = 'receipt-proof-node';
    const written = [];
    for (let index = 0; index < 3; index += 1) {
      written.push(await appendReceipt({
        nodeId, actor: ACTOR, operation: 'dex.file.write',
        args: { path: path.join(roots, `receipt-${index}.txt`), text: 'secret content that must not appear' },
        ok: true, result: { written: true }, durationMs: 2, policy: { mode: 'on' }
      }));
    }
    const readBack = await listReceipts(nodeId, 10);
    expect(readBack.length === 3, `wrote 3 receipts and read back ${readBack.length}`);
    expect(readBack.every(receipt => verifyReceipt(receipt)), 'a receipt failed its own signature check');
    expect(verifyReceiptChain(readBack), 'the receipt chain did not verify');
    expect(!JSON.stringify(readBack).includes('secret content that must not appear'), 'a receipt carried request content');

    const edited = readBack.map((receipt, index) => index === 1 ? { ...receipt, operation: 'dex.process.run' } : receipt);
    expect(!verifyReceiptChain(edited), 'an edited receipt still verified');
    const reordered = [readBack[1]!, readBack[0]!, readBack[2]!];
    expect(!verifyReceiptChain(reordered), 'a reordered chain still verified');

    return [
      `3 receipts signed by ${written[0]!.publicKey.split('\n')[1]?.slice(0, 16)}… and chained`,
      'editing one field broke verification; reordering the log broke verification',
      'request arguments appear only as hashes'
    ];
  });

  await prove('evidence-export-verify', async () => {
    const nodeId = 'evidence-proof-node';
    await appendReceipt({
      nodeId, actor: ACTOR, operation: 'dex.file.write',
      args: { path: path.join(roots, 'evidence.txt'), text: 'CONTENT-THAT-MUST-NOT-TRAVEL' },
      ok: true, result: { written: true }, durationMs: 3, policy: { mode: 'on' }
    });
    const bundle = await exportEvidenceBundle({ nodeId, limit: 10 });
    const serialized = serializeEvidenceBundle(bundle);
    expect(!serialized.includes('CONTENT-THAT-MUST-NOT-TRAVEL'), 'the evidence bundle carried file content');

    // Verified from the serialized bytes, with no access to the node's key material or state,
    // because that is the only form in which this claim means anything.
    const verification = verifyEvidenceBundle(JSON.parse(serialized));
    expect(verification.summary.fail === 0, `${verification.summary.fail} claim(s) failed on an untampered bundle`);
    const notProven = verification.claims.filter(claim => claim.status === 'not-proven').map(claim => claim.claim);
    expect(notProven.length > 0, 'every claim reported as proven, which no bundle can honestly do');

    const tampered = JSON.parse(serialized) as { receipts: { operation: string }[] };
    tampered.receipts[0]!.operation = 'dex.process.run';
    const broken = verifyEvidenceBundle(tampered);
    expect(broken.summary.fail > 0, 'an edited bundle still verified cleanly');

    return [
      `${bundle.receipts.length} receipt(s) exported; ${verification.summary.pass} claim(s) pass, ${verification.summary.fail} fail`,
      `claims that no bundle can establish and which stay unproven: ${notProven.join(', ')}`,
      `editing one receipt turned ${broken.summary.fail} claim(s) red`
    ];
  });
}

type WorkerOutcome = { pid: number; outcome: 'admitted' | 'refused' | 'error'; detail: string };

/**
 * Run a set of contenders as real processes and hold every one of them until all have reported.
 *
 * The obvious way to write this -- let each worker sleep for a fixed time and then exit -- quietly
 * decides the answer on a loaded machine. If the last worker starts after the first has exited, its
 * slot was already released and more contenders are admitted than the ceiling allows, so the proof
 * fails for a reason that has nothing to do with the ceiling. Worse, the reverse can happen too and
 * the run passes without ever having had all the contenders alive at once. Nobody is released here
 * until everybody has spoken, so the count is the count.
 */
async function runContenders(jobs: Record<string, unknown>[]): Promise<WorkerOutcome[]> {
  const children = jobs.map(job => spawn(process.execPath, [tsx, path.join(repoRoot, 'scripts/lib/proof-worker.ts'), JSON.stringify(job)], {
    cwd: repoRoot,
    env: { ...process.env, DEX_REACH_STATE_DIR: stateDir },
    stdio: ['pipe', 'pipe', 'inherit']
  }));
  try {
    return await Promise.all(children.map((child, index) => new Promise<WorkerOutcome>(resolve => {
      let buffer = '';
      const timer = setTimeout(() => resolve({ pid: child.pid ?? -1, outcome: 'error', detail: `contender ${index} never reported` }), 180_000);
      timer.unref();
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', chunk => {
        buffer += chunk;
        const line = buffer.split('\n').find(Boolean);
        if (!line) return;
        clearTimeout(timer);
        try { resolve(JSON.parse(line) as WorkerOutcome); }
        catch { resolve({ pid: child.pid ?? -1, outcome: 'error', detail: `contender ${index} wrote ${line.slice(0, 120)}` }); }
      });
      child.once('exit', code => {
        clearTimeout(timer);
        resolve({ pid: child.pid ?? -1, outcome: 'error', detail: `contender ${index} exited with code ${code} before reporting` });
      });
    })));
  } finally {
    // Closing stdin is the release signal; the kill is the backstop for a worker that ignored it.
    for (const child of children) {
      child.stdin.end();
      child.kill('SIGTERM');
    }
  }
}

// ---------------------------------------------------------------------------
// Proofs that need a real gateway and a real node agent
// ---------------------------------------------------------------------------

async function livePairProofs(pair: LivePair, nodeId: string): Promise<void> {
  await prove('explicit-node-target', async () => {
    const listed = await pair.call('reach_list_nodes', {});
    expect(listed.ok, `listing nodes failed: ${listed.text.slice(0, 200)}`);
    expect(listed.text.includes(nodeId), `the live node ${nodeId} was not listed`);

    await pair.dexCli(['enable', '--node', nodeId]);
    const named = await pair.call('reach_fingerprint', { node_id: nodeId });
    expect(named.ok, `a request naming the online node failed: ${named.text.slice(0, 200)}`);

    // The failure that matters is not an error message, it is a result: a gateway that answered
    // from whichever node happened to be online would look like success here.
    const unknown = await pair.call('reach_fingerprint', { node_id: 'a-node-that-does-not-exist' });
    expect(!unknown.ok, `a request naming an unknown node returned a result: ${unknown.text.slice(0, 200)}`);
    expect(!unknown.text.includes(os.hostname()), 'the refusal for an unknown node still leaked this host');

    return [
      `reach_fingerprint on ${nodeId} answered from the live node`,
      `reach_fingerprint on an unknown node id was refused: ${unknown.text.slice(0, 140).replace(/\s+/g, ' ')}`
    ];
  });

  await prove('live-mcp-surface', async () => {
    const { tools } = await pair.client.listTools();
    const names = tools.map(tool => tool.name);
    assertSameSurface(names, EXPECTED_MCP_ACTIONS, 'first-class MCP actions');
    expect(tools.every(tool => typeof tool.description === 'string' && tool.description.length > 20), 'a served action carries no usable description');

    const listed = await pair.call('reach_list_tools', { node_id: nodeId });
    expect(listed.ok, `listing the node's compatibility tools failed: ${listed.text.slice(0, 200)}`);
    const offered = (JSON.parse(listed.text) as { name: string }[]).map(tool => tool.name);
    assertSameSurface(offered, remoteCompatibilityTools(), 'compatibility tools offered to a remote client');
    // Absent rather than refused: a probe must not be able to tell a withheld tool from one that
    // does not exist, and "we refuse that" is itself information about what exists.
    for (const withheld of remoteBlockedCompatibilityTools()) {
      expect(!offered.includes(withheld), `the remote surface offers the withheld tool ${withheld}`);
    }

    const trust = await pair.call('reach_trust_report', { node_id: nodeId });
    expect(trust.ok, `the trust report failed: ${trust.text.slice(0, 200)}`);
    const report = JSON.parse(trust.text) as {
      verdict: string; certificateHash?: string; evidenceScope?: string;
      invariants?: { count?: number; ids?: string[]; liveEvaluatedIds?: string[] };
    };
    expect(typeof report.certificateHash === 'string' && report.certificateHash.length === 64, 'the trust report carries no certificate hash');
    expect(report.invariants?.count === DEX_RELEASE_INVARIANTS.length, `the trust report claims ${report.invariants?.count} invariants against ${DEX_RELEASE_INVARIANTS.length} in the manifest`);
    // The point of the report is that PASS is narrow. A verdict that did not say so would be read
    // as release proof by the only people who ever see it.
    expect(/does not replace/i.test(report.evidenceScope ?? ''), 'the trust report does not scope its own verdict');
    const live = report.invariants?.liveEvaluatedIds ?? [];
    expect(live.length > 0 && live.length < DEX_RELEASE_INVARIANTS.length, `the report claims to have live-evaluated ${live.length} of ${DEX_RELEASE_INVARIANTS.length} invariants`);

    return [
      `a real OAuth/PKCE MCP SDK client listed exactly ${names.length} first-class actions`,
      `the node offered exactly ${offered.length} compatibility tools; the ${remoteBlockedCompatibilityTools().length} withheld ones were absent, not refused`,
      `reach_trust_report returned ${report.verdict} scoped to ${live.length} live-evaluated invariant(s) of ${DEX_RELEASE_INVARIANTS.length}, with a certificate hash`
    ];
  });

  await prove('asymmetric-enrollment', async () => {
    const result = await pair.migrateNodeToAsymmetric(nodeId);
    expect(result.privateKeyRefused, 'the gateway accepted private key material at /node/enroll');
    expect(result.authMode === 'migrating', `enrollment reported auth mode ${result.authMode}`);
    const online = await pair.onlineNodeCount();
    expect(online >= 1, 'the node did not reconnect after migrating to its transport key');
    const bearer = await pair.bearerConnectRefused(nodeId);
    const listed = await pair.nodeCli(['list']);
    expect(/"authMode": "asymmetric"/.test(listed), `the credential store does not report asymmetric: ${listed.slice(0, 200)}`);
    return [
      'a one-use enrollment token registered a node-held Ed25519 public key; private key material was refused',
      'the node reconnected by signing a transport proof over a real websocket',
      `the same bearer token is now refused: ${bearer}`
    ];
  });

  await prove('mutation-refusal', async () => {
    await pair.dexCli(['read-only', '--node', nodeId]);
    const target = path.join(pair.roots, 'must-not-exist.txt');
    const refused = await pair.call('reach_file_write', { node_id: nodeId, path: target, text: 'should never land', mode: 'rewrite' });
    expect(!refused.ok, 'a write was admitted while the owner mode was READ-ONLY');
    expect(/NODE OWNER/.test(refused.text), `the refusal did not name the node owner: ${refused.text.slice(0, 200)}`);
    await fs.access(target).then(
      () => { throw new Error('the refused write created the file anyway') },
      () => undefined
    );
    const inspection = await pair.call('reach_fingerprint', { node_id: nodeId });
    expect(inspection.ok, 'READ-ONLY refused inspection through the live path');
    return [
      `write refused end to end: ${refused.text.slice(0, 160).replace(/\s+/g, ' ')}`,
      'the file was not created',
      'inspection through the same client still succeeded, so this is READ-ONLY rather than OFF'
    ];
  });

  await prove('kill-switch', async () => {
    await pair.dexCli(['enable', '--node', nodeId]);
    const before = await pair.call('reach_fingerprint', { node_id: nodeId });
    expect(before.ok, 'the node refused work before the kill switch was used');

    await pair.dexCli(['disable', '--node', nodeId]);
    const after = await pair.call('reach_fingerprint', { node_id: nodeId });
    expect(!after.ok, 'the node still served work after the owner disabled access');
    expect(/NODE OWNER/.test(after.text), `the refusal did not name the node owner: ${after.text.slice(0, 200)}`);

    // The client kept the same authorized MCP session across the flip. Nothing was reconnected,
    // re-authorized or restarted: the node simply stopped agreeing.
    return [
      'the same authorized MCP session was served before the flip',
      `and refused immediately after: ${after.text.slice(0, 160).replace(/\s+/g, ' ')}`,
      'no client or gateway cooperation was involved'
    ];
  });

  await prove('node-revocation', async () => {
    const online = await pair.onlineNodeCount();
    expect(online >= 1, 'no node was online to revoke');
    await pair.nodeCli(['revoke', nodeId]);
    await pair.waitForNodeCount(online - 1, 30_000);
    const refused = await pair.call('reach_fingerprint', { node_id: nodeId });
    expect(!refused.ok, 'a revoked node still served a request');
    // The agent is still running and retrying; it simply cannot get back in.
    await new Promise(resolve => setTimeout(resolve, 4000));
    expect(await pair.onlineNodeCount() === online - 1, 'a revoked node reconnected');
    return [
      'revocation dropped the live websocket within the gateway sweep interval',
      `requests naming it are refused: ${refused.text.slice(0, 140).replace(/\s+/g, ' ')}`,
      'the node agent kept retrying for four seconds and was not readmitted'
    ];
  });

  await prove('node-re-enrollment', async () => {
    await pair.stopNode(nodeId);
    await pair.nodeCli(['forget', nodeId]);
    await pair.nodeCli(['enroll', nodeId, '--profile', 'development', '--roots', pair.roots, '--gateway-ws', `ws://127.0.0.1:${pair.baseUrl.port}/node`]);
    await pair.startNode(nodeId);
    await pair.waitForNodeCount(1, 30_000);
    const listed = await pair.nodeCli(['list']);
    expect(/"revoked": false/.test(listed), `the re-enrolled node is still marked revoked: ${listed.slice(0, 200)}`);
    // Re-enrollment issues a fresh bearer credential and starts the node over at bearer auth: the
    // transport public key was forgotten with the rest of the record, so nothing survived the
    // revocation that could let the old credential back in.
    expect(/"transportKey": false/.test(listed), 'the forgotten node kept its old transport key');
    await pair.dexCli(['enable', '--node', nodeId]);
    const served = await pair.call('reach_fingerprint', { node_id: nodeId });
    expect(served.ok, `the re-enrolled node did not serve a request: ${served.text.slice(0, 200)}`);
    return [
      'an explicit forget plus a fresh enrollment brought the same node id back online',
      'the previous transport key did not survive the revocation',
      'the re-enrolled node served a request through the same MCP session'
    ];
  });
}

// ---------------------------------------------------------------------------
// Which environments this run actually has
// ---------------------------------------------------------------------------

async function detectAndroid(): Promise<EnvironmentAvailability> {
  try {
    const { stdout } = await execFileAsync('adb', ['devices'], { timeout: 10_000 });
    const devices = stdout.split('\n').slice(1).map(line => line.trim()).filter(line => /\tdevice$/.test(line));
    return devices.length
      ? { available: true, reason: `${devices.length} device(s) attached over ADB` }
      : { available: false, reason: 'adb is installed but no device is attached' };
  } catch {
    return { available: false, reason: 'no adb on PATH and no Android device attached to this machine' };
  }
}

async function detectMacosHost(): Promise<EnvironmentAvailability> {
  if (process.platform !== 'darwin') {
    return { available: false, reason: `this run is on ${process.platform}, and the install path under proof is the macOS launchd service` };
  }
  // Being on macOS is not the same as being allowed to install a service here. The proof requires
  // a host the owner has offered for it, named explicitly, because installing a launch agent is
  // not something a proof run may decide to do to somebody's machine.
  return process.env.DEX_REACH_PROOF_ALLOW_INSTALL === '1'
    ? { available: true, reason: 'macOS host offered for a real install by DEX_REACH_PROOF_ALLOW_INSTALL=1' }
    : { available: false, reason: 'on macOS, but installing a launchd service was not authorized for this run (set DEX_REACH_PROOF_ALLOW_INSTALL=1 on a host you intend to install on)' };
}

function detectSecondMachine(): EnvironmentAvailability {
  const host = process.env.DEX_REACH_PROOF_SECOND_MACHINE;
  return host
    ? { available: true, reason: `a second machine was named for this run: ${host}` }
    : { available: false, reason: 'no physically separate second machine was named for this run' };
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const skipLive = flag('--no-live', process.argv);
  let livePair: LivePair | null = null;
  let liveEnvironment: EnvironmentAvailability = { available: false, reason: 'the live gateway and node pair was not started' };

  if (!skipLive) {
    try {
      livePair = await startLivePair({ repoRoot, workspace: path.join(workspace, 'live'), nodeIds: ['proof-node-a'] });
      liveEnvironment = { available: true, reason: `a gateway and a node agent are running as separate processes on ${livePair.baseUrl.origin}` };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // Unverified, not failed. A pair that could not start says nothing about whether the routing
      // and policy rules hold; reporting it as failure would teach a reader to discount red lines.
      //
      // But on a machine that is supposed to be able to start one -- CI, above all -- silently
      // dropping six proofs to unverified and exiting zero would let exactly the integration this
      // job exists to watch rot unnoticed. `--require-live` says the pair is expected here, and is
      // handled after the report is written: the twelve proofs this process can still establish are
      // worth having, and a report is more use than a bare stack trace.
      liveEnvironment = { available: false, reason: `a live gateway and node pair could not be started here: ${message}` };
    }
  } else {
    liveEnvironment = { available: false, reason: 'no live gateway and node pair was started in this run, because --no-live was given' };
  }

  const environments: Record<ProofEnvironment, EnvironmentAvailability> = {
    'this-process': { available: true, reason: `this process on ${process.platform}/${process.arch}, against the real modules with an isolated state directory` },
    'local-pair': liveEnvironment,
    'macos-host': await detectMacosHost(),
    'android-device': await detectAndroid(),
    'second-machine': detectSecondMachine()
  };

  try {
    await inProcessProofs();
    if (livePair) await livePairProofs(livePair, 'proof-node-a');
  } finally {
    if (livePair) await livePair.stop();
  }

  const run = buildProofRun(observations, environments);
  const outDir = path.resolve(repoRoot, arg('--out', process.argv) || 'release');
  await fs.mkdir(outDir, { recursive: true });
  const file = path.join(outDir, 'proof-run.json');
  await fs.writeFile(file, JSON.stringify(run, null, 2) + '\n');

  if (flag('--json', process.argv)) console.log(JSON.stringify(run, null, 2));
  else for (const line of describeProofRun(run)) console.log(line);
  console.log(`\nWritten to ${file}`);
  console.log(`Items recorded as "${HARDWARE_NOT_AVAILABLE}" were not attempted here and are not claims about this or any other machine.`);

  if (!flag('--keep', process.argv)) await fs.rm(workspace, { recursive: true, force: true });
  else console.log(`Workspace kept at ${workspace}`);

  // A failed proof is a release blocker. An unverified one is a known gap, and exiting non-zero for
  // it would make the honest outcome indistinguishable from the broken one in CI.
  if (run.summary.fail > 0) process.exitCode = 1;
  if (flag('--require-live', process.argv) && !environments['local-pair'].available) {
    console.error(`\nThis run required a live gateway and node pair and did not get one: ${environments['local-pair'].reason}`);
    process.exitCode = 1;
  }
}

await main().catch(async error => {
  console.error(`proof run failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  await fs.rm(workspace, { recursive: true, force: true }).catch(() => undefined);
  process.exitCode = 2;
});
