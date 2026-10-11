import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { NodeTaskStore } from '../../src/node/task-store.js';
import { ResultStore } from '../../src/node/result-store.js';
import { appendReceipt } from '../../src/shared/receipts.js';
import { workspaceWorkerRootsHash } from '../../src/shared/workspace-worker.js';
import { NodeAuthStore } from '../../src/gateway/node-auth.js';
import { createSyntheticWorkspace, rehearseRestore, type SyntheticWorkspace } from '../../scripts/lib/recovery-rehearsal.js';
const nodeId = 'macbook-air.local', hash = 'a'.repeat(64);
export async function fixture(): Promise<SyntheticWorkspace> {
  const w = await createSyntheticWorkspace(), state = w.source.state;
  const previous = process.env.DEX_REACH_STATE_DIR; process.env.DEX_REACH_STATE_DIR = state;
  try {
    async function write(relative: string, value: unknown, mode = 0o600) {
      const file = path.join(state, relative); await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
      await fs.writeFile(file, typeof value === 'string' ? value : JSON.stringify(value), { mode });
    }
    for (const relative of ['plans/fixture.json', 'recovery/fixture.json', 'runtime/transactions/fixture.json', 'checkpoints/fixture.json', 'install-macos.status.json']) await write(relative, { version: 1, fixture: true });
    for (const name of ['leases', 'queue']) await fs.mkdir(path.join(state, 'coordinator', name), { recursive: true, mode: 0o700 });
    await write('activity/processes.json', []); await write('audit.jsonl', '{}\n');
    await write('secrets.env', 'SYNTHETIC_ONLY=not-a-production-credential\n');
    await write('oauth.json', { clients: {}, access: {}, refresh: {} });
    await write(`nodes/${nodeId}.env`, `DEX_REACH_NODE_ID=${nodeId}\nSYNTHETIC_ONLY=true\n`);
    await write(`nodes/${nodeId}.access.json`, { version: 3, revision: 1, mode: 'read-only', until: null, revertTo: null, clients: {}, grantRequired: {}, grants: [], updatedAt: new Date().toISOString() });
    const transport = crypto.generateKeyPairSync('ed25519', { privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
    await write(`nodes/${nodeId}.transport.ed25519.pem`, transport.privateKey);
    await write(`nodes/${nodeId}.transport.ed25519.pub.pem`, transport.publicKey, 0o644);
    const auth = new NodeAuthStore(state); await auth.initialize(); await auth.importLegacy(nodeId, 'synthetic-token-'.repeat(4));
    const token = await auth.createEnrollmentToken(nodeId); await auth.consumeEnrollment(nodeId, token, transport.publicKey); await auth.completeMigration(nodeId);
    await write('revoked-nodes.json', ['revoked-synthetic-node']);
    await write('coordinator/history/events.jsonl', JSON.stringify({ cursor: 1, at: new Date().toISOString(), event: 'lease-released' }) + '\n');
    await fs.writeFile(path.join(w.source.worker, 'config.json'), JSON.stringify({ version: 1, nodeId, allowedRoots: ['/synthetic/workspace'], rootsHash: workspaceWorkerRootsHash(['/synthetic/workspace']) }), { mode: 0o600 });
    for (const role of ['coordinator', 'worker', 'gateway', 'node', 'oauth-canary']) await fs.writeFile(path.join(w.source.agents, `com.stinkyweasel.dex-reach.${role}.plist`), '<plist>synthetic fixture only</plist>', { mode: 0o600 });
    const store = new NodeTaskStore(state), results = new ResultStore(64 * 1024, 60 * 60_000, state);
    const task = await store.create({ actorId: 'synthetic-actor', nodeId, operation: 'dex.fingerprint', idempotencyKey: 'synthetic-recovery', payloadSha256: hash, safetyClass: 'PURE_READ_IDEMPOTENT', mutationLevel: 'NONE' });
    await store.transition(task.taskId, 'PREPARING'); await store.transition(task.taskId, 'RUNNING');
    const result = { synthetic: true }, bound = await results.boundWithReference(result, task.taskId);
    await store.update(task.taskId, { resultRef: bound.metadata.handle, resultHash: bound.metadata.resultHash });
    await write('coordinator/leases/synthetic.json', { id: 'synthetic', taskId: task.taskId, attempt: task.attemptNumber, pid: 1234, executor: 'codex', access: 'read', workload: 'light', createdAt: '2020-01-01T00:00:00Z', heartbeatAt: '2020-01-01T00:00:00Z' });
    await appendReceipt({ nodeId, operation: task.operation, args: {}, result, ok: true, durationMs: 1, policy: {} });
    return w;
  } catch (error) { await w.cleanup(); throw error; }
  finally { if (previous === undefined) delete process.env.DEX_REACH_STATE_DIR; else process.env.DEX_REACH_STATE_DIR = previous; }
}

/** Canonical authority-bearing data, confined to the minted fixture; no owner credentials. */
export async function expandedFixture(): Promise<SyntheticWorkspace> {
  const w = await fixture(), state = w.source.state;
  const previous = process.env.DEX_REACH_STATE_DIR; process.env.DEX_REACH_STATE_DIR = state;
  try {
    const { createGrant } = await import('../../src/shared/access.js');
    const { createPlan, consumePlan } = await import('../../src/shared/plans.js');
    const { makeBudgetRule, upsertBudgetRule } = await import('../../src/shared/budget-policy.js');
    const { runtimeTreeSha256 } = await import('../../scripts/lib/runtime-rollback.js');
    const store = new NodeTaskStore(state), results = new ResultStore(64 * 1024, 60 * 60_000, state);
    const parent = (await store.list())[0]!;
    const child = await store.create({ actorId: parent.actorId, nodeId, parentTaskId: parent.taskId, operation: 'dex.fingerprint', idempotencyKey: 'synthetic-child', payloadSha256: hash, safetyClass: 'PURE_READ_IDEMPOTENT', mutationLevel: 'NONE' });
    await store.transition(child.taskId, 'PREPARING'); await store.transition(child.taskId, 'RUNNING');
    const bound = await results.boundWithReference({ synthetic: 'child' }, child.taskId);
    await store.update(child.taskId, { resultRef: bound.metadata.handle, resultHash: bound.metadata.resultHash });
    await store.transition(child.taskId, 'COMPLETED');
    const ambiguous = await store.create({ actorId: parent.actorId, nodeId, operation: 'dex.process.run', idempotencyKey: 'synthetic-ambiguous', payloadSha256: hash, safetyClass: 'PROCESS_UNKNOWN_EFFECT', mutationLevel: 'PROCESS' });
    await store.transition(ambiguous.taskId, 'PREPARING'); await store.transition(ambiguous.taskId, 'RUNNING');
    await store.update(ambiguous.taskId, { failureClass: 'AMBIGUOUS_EFFECT' }); await store.transition(ambiguous.taskId, 'AMBIGUOUS');
    const policyFile = path.join(state, `nodes/${nodeId}.access.json`);
    const policy = createGrant(JSON.parse(await fs.readFile(policyFile, 'utf8')), 'chatgpt', ['file.write'], ['/synthetic/workspace'], 60_000, 1, 'expired-synthetic');
    policy.grants[0]!.until = '2020-01-01T00:00:00Z';
    await fs.writeFile(policyFile, JSON.stringify(policy), { mode: 0o600 });
    await upsertBudgetRule(nodeId, 'shared', makeBudgetRule('shared', 60_000, { maxOperations: 1 }), state);
    await fs.writeFile(path.join(state, `nodes/${nodeId}.budget-usage.json`), JSON.stringify({ version: 1, samples: [{ at: Date.now(), client: 'chatgpt', operations: 1, mutations: 0, shellCalls: 0, requestedWriteBytes: 0, requestedProcessMs: 0 }], inflight: [] }), { mode: 0o600 });
    const plan = await createPlan({ nodeId, actor: { kind: 'chatgpt', clientId: 'synthetic', clientName: 'synthetic' }, operation: 'dex.file.write', args: { path: '/synthetic/workspace/file', content: 'synthetic' }, policyHash: hash, checkpointId: null });
    await consumePlan(plan.id);
    const auth = new NodeAuthStore(state); await auth.initialize(); await auth.importLegacy('revoked-synthetic-node', 'synthetic-revoked-token'.repeat(4)); await auth.revoke('revoked-synthetic-node');
    const releaseId = 'synthetic-retained', release = path.join(state, 'runtime/releases', releaseId);
    await fs.mkdir(release, { recursive: true, mode: 0o700 }); await fs.writeFile(path.join(release, 'package.json'), JSON.stringify({ version: '0.3.2' }), { mode: 0o600 });
    await fs.writeFile(path.join(state, 'runtime/retained-evidence.json'), JSON.stringify({ version: 1, releaseId, sourceSha: 'a'.repeat(40), treeDigest: await runtimeTreeSha256(release) }), { mode: 0o600 });
    for (const role of ['coordinator','worker','gateway','node','oauth-canary']) {
      const label = `com.stinkyweasel.dex-reach.${role}`;
      await fs.writeFile(path.join(w.source.agents, `${label}.plist`), `<plist><dict><key>Label</key><string>${label}</string><key>WorkingDirectory</key><string>${release}</string><key>ProgramArguments</key><array><string>/synthetic/node</string><string>${release}/${role === 'oauth-canary' ? 'dist/scripts/oauth-canary.js' : `dist/src/${role}/main.js`}</string></array></dict></plist>`, { mode: 0o600 });
    }
    const preservation = path.join(state,'macos-hardening-rollback-fIxT01'); await fs.mkdir(preservation,{mode:0o700});
    for (const role of ['coordinator','worker','gateway','node','oauth-canary']) await fs.writeFile(path.join(preservation,`com.stinkyweasel.dex-reach.${role}.plist`),'<plist>historical missing release, preserve only</plist>',{mode:0o600});
    return w;
  } catch (error) { await w.cleanup(); throw error; }
  finally { if (previous === undefined) delete process.env.DEX_REACH_STATE_DIR; else process.env.DEX_REACH_STATE_DIR = previous; }
}
