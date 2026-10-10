import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { stateDir } from '../src/shared/local-env.js';
import { atomicWriteFile, withFileLock } from '../src/shared/state-io.js';
import { workspaceWorkerConfigFile } from '../src/shared/workspace-worker.js';
import { readEnvFile } from './lib/node-files.js';
import { runtimeReleaseId } from './lib/runtime-release.js';
import { runtimeTreeSha256, validateRuntimeRollbackSnapshot, type RuntimeRollbackSnapshot } from './lib/runtime-rollback.js';
import { launchdIsAbsent, launchdIsRunning, launchdServiceIsEnabled } from './lib/launchctl.js';
import { acceptCandidate, QueueProofFailure, freshTask, validateConnectorReadback, installStatusFresh, assertTarget, installedReady, recoveryDecision, type Observation } from './lib/c13-acceptance.js';
import { installedQueueProof } from './lib/c13-queue-proof.js';
import type { ReachTaskRecord } from '../src/node/task-store.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const expectedRoot = '/Users/andrew/dex-reach-c13-worker-repair';
const previousId = '0.3.2-175d58b8cce5-2f44ae46b11b-dirty-1791501412637';
const previousHash = 'b60194780c0cb0e05e65fc5496bcb76b458094381bff55d29f9de4e85fc3bb4b';
const nodeId = 'macbook-air.local';
const localState = stateDir();
const agents = path.join(os.homedir(), 'Library/LaunchAgents');
const domain = `gui/${process.getuid?.()}`;
const labels = ['coordinator', 'worker', 'gateway', 'node', 'oauth-canary'].map(n => `com.stinkyweasel.dex-reach.${n}`);
const services = labels.map(label => ({ label, target: path.join(agents, `${label}.plist`) }));
const helper = 'com.stinkyweasel.dex-reach.install-reloader-once';
const journalPath = path.join(localState, 'runtime/c13-maintenance.json');
const runFile = promisify(execFile);
async function run(command: string, args: string[], timeout = 15000): Promise<string> {
  return (await runFile(command, args, { cwd: root, timeout, maxBuffer: 4 * 1024 * 1024 })).stdout;
}
async function git(...args: string[]): Promise<string> { return (await run('/usr/bin/git', args)).trim(); }
async function json(file: string): Promise<any> { return JSON.parse(await fs.readFile(file, 'utf8')); }
const protectedFiles = ['secrets.env', `nodes/${nodeId}.env`, `nodes/${nodeId}.access.json`, `nodes/${nodeId}.budget-policy.json`];
async function protectedHash(): Promise<string> {
  const entries = await Promise.all(protectedFiles.map(async file => {
    try { return [file, hash(await fs.readFile(path.join(localState, file)))]; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT' && file.endsWith('.budget-policy.json')) return [file, null]; throw error; }
  }));
  return hash(Buffer.from(JSON.stringify(entries)));
}
async function baseline(): Promise<Record<string, string>> {
  return Object.fromEntries(await Promise.all([...services.map(s => s.target), workspaceWorkerConfigFile()].map(async file => [file, hash(await fs.readFile(file))])));
}
const hash = (bytes: Buffer) => crypto.createHash('sha256').update(bytes).digest('hex');
type Journal = { transactionId: string; head: string; candidateId: string; startedAt: string; taskSince?: string; taskId?: string; connectorReadbackHash?: string; installUncertain?: boolean; queueCleanupRoot?: string; baseline?: Record<string, string>; protectedHash?: string; decision?: string; error?: string; history?: Journal[] };
async function save(j: Journal): Promise<void> { await atomicWriteFile(journalPath, JSON.stringify(j, null, 2) + '\n', 0o600); }
async function identity(clean = true, expectedHead?: string): Promise<string> {
  if (root !== expectedRoot || os.platform() !== 'darwin' || os.arch() !== 'arm64' || os.hostname() !== 'MacBook-Air.local' || os.userInfo().username !== 'andrew' || localState !== '/Users/andrew/.dex-reach') throw new Error('incorrect host, checkout or state root');
  const model = await run('/usr/sbin/sysctl', ['-n', 'hw.model']);
  if (model.trim() !== 'MacBookAir10,1') throw new Error('incorrect MacBook model');
  if (await git('rev-parse', '--show-toplevel') !== root || await git('branch', '--show-current') !== 'c13-worker-repair' || await git('remote', 'get-url', 'origin') !== 'git@github.com:westkitty/DEX-REACH.git') throw new Error('repository/branch/remote mismatch');
  const head = await git('rev-parse', 'HEAD');
  if (expectedHead && head !== expectedHead) throw new Error('expected HEAD mismatch');
  if (clean && await git('status', '--porcelain')) throw new Error('clean committed worktree required; publication needs separate authorization');
  const remoteHead = (await git('ls-remote', 'origin', 'refs/heads/c13-worker-repair')).split(/\s/)[0] ?? '';
  assertTarget({ root, platform: os.platform(), arch: os.arch(), hostname: os.hostname(), user: os.userInfo().username, branch: await git('branch', '--show-current'), head, remoteHead, expectedHead: expectedHead ?? head, dirty: clean && !!await git('status', '--porcelain') });
  const enrollment = await readEnvFile(path.join(localState, 'nodes', `${nodeId}.env`));
  if (enrollment.DEX_REACH_NODE_ID !== nodeId) throw new Error('enrollment node identity mismatch');
  for (const file of ['secrets.env', `nodes/${nodeId}.access.json`]) await fs.access(path.join(localState, file));
  return head;
}
async function helperIdle(): Promise<boolean> {
  const processes = await run('/bin/ps', ['-axo', 'command=']);
  if (processes.split('\n').some(row => /(?:^|\s)(?:\S*\/)?scripts\/(?:install-macos\.ts|rollback-macos\.ts|reload-launchagents\.js)(?:\s|$)/.test(row) || /(?:^|\s)(?:\/bin\/)?launchctl\s+(?:bootstrap|bootout|kickstart|remove|enable|disable)\b/.test(row))) return false;
  for (const label of [helper, 'com.stinkyweasel.dex-reach.install-reloader']) {
    try {
      const text = await run('/bin/launchctl', ['print', `${domain}/${label}`]);
      // A waiting/scheduled helper is also dangerous even before it has a PID.
      if (!/\blast exit code = -?\d+\b/.test(text) || !/active count = 0\b/.test(text) || /\bpid = \d+\b/.test(text) || /state = (?:running|waiting|spawn scheduled)/.test(text)) return false;
    } catch (error) { if (!launchdIsAbsent(error)) throw error; }
  }
  return true;
}
async function runtimeMatches(id: string): Promise<boolean> {
  const release = path.join(localState, 'runtime/releases', id);
  const disabled = await run('/bin/launchctl', ['print-disabled', domain]);
  const pids = new Set<number>();
  const all = await run('/bin/ps', ['-axo', 'uid=,pid=,command=']);
  for (const service of services) {
    const text = await fs.readFile(service.target, 'utf8');
    if (!text.includes(`<key>Label</key><string>${service.label}</string>`) || !text.includes(`<key>WorkingDirectory</key><string>${release}</string>`) || !launchdServiceIsEnabled(disabled, service.label)) return false;
    const observed = await run('/bin/launchctl', ['print', `${domain}/${service.label}`]);
    if (!observed.includes(`working directory = ${release}`)) return false;
    if (service.label.endsWith('.oauth-canary')) {
      if (launchdIsRunning(observed) || !/\blast exit code = 0\b/.test(observed)) return false;
      continue;
    }
    if (!launchdIsRunning(observed)) return false;
    const pid = Number(observed.match(/\bpid = (\d+)\b/)?.[1]);
    if (!pid || pids.has(pid)) return false;
    pids.add(pid);
    const name = service.label.split('.').at(-1);
    const rows = all.split('\n').filter(row => row.includes(`/dist/src/${name}/main.js`));
    if (rows.length !== 1 || !new RegExp(`^\\s*${process.getuid?.()}\\s+${pid}\\s`).test(rows[0]!) || !rows[0]!.includes(release)) return false;
  }
  return true;
}
async function preflight(): Promise<{ head: string; candidateId: string }> {
  const head = await identity();
  if (!await helperIdle() || !await runtimeMatches(previousId)) throw new Error('previous service ownership/revision or installer helper state unproven');
  if (await runtimeTreeSha256(path.join(localState, 'runtime/releases', previousId)) !== previousHash) throw new Error('previous runtime integrity mismatch');
  const candidateId = await runtimeReleaseId(root, '0.3.2');
  const snapshot = path.join(localState, 'runtime/rollback', candidateId);
  try { await fs.access(snapshot); throw new Error('existing candidate capsule; reconcile prior attempt before installation'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  // Inspect persisted coordination without invoking status/pruning or acquiring a lease.
  for (const directory of ['leases', 'queue']) {
    if ((await fs.readdir(path.join(localState, 'coordinator', directory))).length) throw new Error('coordination reservations present; owner idle window required');
  }
  return { head, candidateId };
}
function restoreInput(j: Journal) {
  return { snapshotPath: path.join(localState, 'runtime/rollback', j.candidateId, 'snapshot.json'), stateDir: localState, agentsDir: agents, workerConfigPath: workspaceWorkerConfigFile(), services, candidateReleaseId: j.candidateId };
}
async function observe(j: Journal): Promise<Observation> {
  await identity(true, j.head);
  if (j.protectedHash && await protectedHash() !== j.protectedHash) throw new Error('protected enrollment/secrets/policy changed; REQUIRES OWNER INPUT');
  const o: Observation = { statusFresh: false, complete: false, helperIdle: await helperIdle(), snapshotValid: false, previousIntact: false, candidateIntact: false, definitionsKnown: false, previousRunning: false, candidateRunning: false };
  o.previousIntact = await runtimeTreeSha256(path.join(localState, 'runtime/releases', previousId)) === previousHash;
  o.previousRunning = await runtimeMatches(previousId).catch(() => false);
  o.candidateRunning = await runtimeMatches(j.candidateId).catch(() => false);
  o.snapshotPresent = await fs.access(restoreInput(j).snapshotPath).then(() => true).catch(error => { if (error.code === 'ENOENT') return false; throw error; });
  o.cleanupPending = !!j.queueCleanupRoot;
  const status = await json(path.join(localState, 'install-macos.status.json')).catch(() => null);
  o.statusFresh = installStatusFresh(status, j.transactionId, path.join(localState, 'runtime/releases', j.candidateId), j.startedAt);
  o.complete = o.statusFresh && status.state === 'complete';
  o.uncertainOperation = !!j.installUncertain && !(o.statusFresh && ['complete', 'failed'].includes(status.state) && o.helperIdle);
  try {
    const input = restoreInput(j);
    const previous = await validateRuntimeRollbackSnapshot(input);
    const snapshot = await json(input.snapshotPath) as RuntimeRollbackSnapshot;
    if (previous !== previousId || snapshot.previousReleaseSha256 !== previousHash || Date.parse(snapshot.preparedAt) < Date.parse(j.startedAt)) throw new Error('snapshot previous identity/freshness mismatch');
    o.snapshotValid = o.definitionsKnown = true;
    o.candidateIntact = await runtimeTreeSha256(path.join(localState, 'runtime/releases', j.candidateId)) === snapshot.candidateReleaseSha256;
  } catch {
    o.definitionsKnown = o.previousRunning && !!j.baseline && JSON.stringify(await baseline()) === JSON.stringify(j.baseline);
  }
  const processes = await run('/bin/ps', ['-axo', 'command=']);
  for (const name of ['coordinator', 'worker', 'gateway', 'node', 'oauth-canary']) {
    if (processes.split('\n').filter(row => row.includes(`/dist/src/${name}/main.js`)).length > 1) o.definitionsKnown = false;
    try {
      const loaded = await run('/bin/launchctl', ['print', `${domain}/com.stinkyweasel.dex-reach.${name}`]);
      if (name === 'oauth-canary' && launchdIsRunning(loaded)) o.helperIdle = false;
      if (![previousId, j.candidateId].some(id => loaded.includes(`working directory = ${path.join(localState, 'runtime/releases', id)}`))) o.definitionsKnown = false;
    } catch (error) { if (!launchdIsAbsent(error)) o.definitionsKnown = false; }
  }
  return o;
}
async function installedCli(j: Journal, args: string[]): Promise<any> {
  return JSON.parse(await run(process.execPath, [path.join(localState, 'runtime/releases', j.candidateId, 'dist/scripts/dex-reach.js'), ...args]));
}
async function verifyRuntime(j: Journal): Promise<void> {
  if (!installedReady(await observe(j))) throw new Error('candidate activation/status/integrity not proven');
  const env = await readEnvFile(path.join(localState, 'secrets.env'));
  const port = Number(env.DEX_REACH_GATEWAY_PORT || 8787);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('invalid gateway port');
  const response = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(2000) });
  const health = await response.json() as { onlineNodes?: number };
  if (!response.ok || !Number.isInteger(health.onlineNodes) || Number(health.onlineNodes) < 1) throw new Error('runtime health failed');
}
const command = process.argv[2];
const authorized = process.argv.includes('--authorize-live');
try {
  if (command === 'preflight') console.log(JSON.stringify({ state: 'INSTALLATION READY', ...await preflight(), liveExecuted: false }, null, 2));
  else if (command === 'report') {
    const j = await json(journalPath) as Journal;
    const observation = await observe(j);
    console.log(JSON.stringify({ ...j, recoveryEligibility: recoveryDecision(observation), observation, c13: 'NOT PASS', e7: 'BLOCKED — HOST CAPABILITY' }, null, 2));
  } else {
    if (!['install', 'observe', 'record-task', 'reconcile-install', 'reconcile-queue', 'accept', 'rollback'].includes(command ?? '')) throw new Error('usage: c13-maintenance.ts preflight|install|observe|record-task|reconcile-install|reconcile-queue|accept|rollback|report [--authorize-live]');
    if (['install', 'accept', 'rollback'].includes(command!) && !authorized) throw new Error('explicit --authorize-live required for this stage');
    await withFileLock(path.join(localState, 'runtime/c13-maintenance.lock'), async () => {
      if (command === 'install') {
        const prior = await json(journalPath).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
        if (prior && recoveryDecision(await observe(prior)) !== 'SAFE TO RETRY') throw new Error('existing maintenance attempt; observe/reconcile rather than replay');
        const p = await preflight();
        const j: Journal = { transactionId: crypto.randomUUID(), head: p.head, candidateId: p.candidateId, startedAt: new Date().toISOString(), installUncertain: true, baseline: await baseline(), protectedHash: await protectedHash(), ...(prior ? { history: [...(prior.history ?? []), prior] } : {}) };
        await save(j); // journal is durable before the first installer action
        try {
          await run(process.execPath, ['--import', 'tsx', 'scripts/install-macos.ts', '--transaction-id', j.transactionId, '--expected-release-id', j.candidateId], 180000);
          j.installUncertain = false; j.decision = 'NEEDS RECONCILIATION';
        } catch (error) { j.error = (error as Error).message; if (!(error as any).killed && !(error as any).signal && (error as any).code !== 'ETIMEDOUT') j.installUncertain = false; j.decision = recoveryDecision(await observe(j).catch(() => ({ statusFresh: false, complete: false, helperIdle: false, snapshotValid: false, previousIntact: false, candidateIntact: false, definitionsKnown: false, previousRunning: false, candidateRunning: false })));  }
        await save(j); console.log(JSON.stringify(j, null, 2));
        if (j.error) process.exitCode = 1;
      } else {
        const j = await json(journalPath) as Journal;
        try {
          if (command === 'reconcile-install') {
            const observation = await observe(j);
            if (!observation.helperIdle || !observation.definitionsKnown || !observation.previousIntact || j.queueCleanupRoot || (!observation.snapshotValid && !observation.previousRunning)) throw new Error('installer effects not reconciled; owner input required');
            j.installUncertain = false;
            j.decision = recoveryDecision(await observe(j));
          } else if (command === 'reconcile-queue') {
            await identity(true, j.head);
            if (!j.queueCleanupRoot || !path.basename(j.queueCleanupRoot).startsWith('dex-c13-queue-') || path.dirname(j.queueCleanupRoot) !== await fs.realpath(os.tmpdir())) throw new Error('no valid recorded queue cleanup root');
            for (const directory of ['leases', 'queue']) {
              for (const name of await fs.readdir(path.join(localState, 'coordinator', directory))) {
                const claim = await json(path.join(localState, 'coordinator', directory, name));
                if (claim.repositoryRoot === j.queueCleanupRoot) throw new Error('test reservations remain; preserve evidence and wait for normal stale recovery or owner-scoped cleanup');
              }
            }
            delete j.queueCleanupRoot;
            j.decision = recoveryDecision(await observe(j));
          } else if (command === 'observe') {
            await verifyRuntime(j);
            j.taskSince ??= new Date().toISOString();
            j.decision = 'REQUIRES OWNER INPUT';
            console.log('Candidate ready for fresh connector task; run accept after same-ID result retrieval.');
          } else if (command === 'record-task') {
            await verifyRuntime(j);
            if (!j.taskSince) throw new Error('observe stage required before recording task');
            const task = freshTask(await installedCli(j, ['tasks', '--json', '--limit', '200']), j.taskSince, nodeId);
            const local = await installedCli(j, ['task', task.taskId, 'result', '--json']);
            const chunks: Buffer[] = []; let size = 0;
            for await (const chunk of process.stdin) { size += chunk.length; if (size > 256 * 1024) throw new Error('connector readback too large'); chunks.push(Buffer.from(chunk)); }
            const evidence = Buffer.concat(chunks);
            validateConnectorReadback(JSON.parse(evidence.toString('utf8')), task, local.result);
            j.taskId = task.taskId; j.connectorReadbackHash = hash(evidence);
          } else if (command === 'accept') {
            if (!j.taskSince) throw new Error('observe stage required before fresh task creation');
            j.decision = await acceptCandidate({ runtime: () => verifyRuntime(j), task: async () => {
              const task = freshTask(await installedCli(j, ['tasks', '--json', '--limit', '200']) as ReachTaskRecord[], j.taskSince!, nodeId);
              if (j.taskId !== task.taskId || !j.connectorReadbackHash) throw new Error('record-task connector same-ID readback required');
              const result = await installedCli(j, ['task', task.taskId, 'result', '--json']);
              if (result.taskId !== task.taskId || result.resultRef !== task.resultRef || result.resultHash !== task.resultHash || result.result?.nodeId !== nodeId || result.result?.hostname !== 'MacBook-Air.local' || result.result?.platform !== 'darwin' || result.result?.arch !== 'arm64' || result.result?.user !== 'andrew' || result.result?.cwd !== root || result.result?.repositoryRoot !== root || result.result?.branch !== 'c13-worker-repair') throw new Error('fresh same-ID result identity mismatch or expired result');
            }, queue: () => installedQueueProof(path.join(localState, 'runtime/releases', j.candidateId), { onRoot: async root => { j.queueCleanupRoot = root; await save(j); }, onClean: async () => { delete j.queueCleanupRoot; await save(j); } }) });
            delete j.error;
          } else if (command === 'rollback') {
            if (recoveryDecision(await observe(j)) !== 'SAFE TO ROLLBACK') throw new Error('rollback not safe; owner reconciliation required');
            j.decision = 'NEEDS RECONCILIATION'; await save(j);
            await run(process.execPath, ['--import', 'tsx', 'scripts/rollback-macos.ts', '--candidate-release-id', j.candidateId], 600000);
            const status = await json(path.join(localState, 'runtime/rollback', j.candidateId, 'rollback-status.json'));
            if (status.state !== 'complete' || status.restoredReleaseId !== previousId || Date.parse(status.startedAt) < Date.parse(j.startedAt) || !await runtimeMatches(previousId) || await runtimeTreeSha256(path.join(localState, 'runtime/releases', previousId)) !== previousHash) throw new Error('exact previous runtime restoration unproven');
            j.decision = 'ROLLED BACK'; delete j.error;
          }
        } catch (error) {
          j.error = (error as Error).message;
          if (error instanceof QueueProofFailure && error.cleanupFailed) j.queueCleanupRoot = error.repositoryRoot;
          j.decision = command === 'rollback' ? 'NEEDS RECONCILIATION' : recoveryDecision(await observe(j).catch(() => ({ statusFresh: false, complete: false, helperIdle: false, snapshotValid: false, previousIntact: false, candidateIntact: false, definitionsKnown: false, previousRunning: false, candidateRunning: false })));
          process.exitCode = 1;
        }
        await save(j); console.log(JSON.stringify(j, null, 2));
      }
    }, { timeoutMs: 1000 });
  }
} catch (error) { console.error(`NOT COMPLETE: ${(error as Error).message}`); process.exitCode = 1; }
