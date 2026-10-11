import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { inspectTasks, publicTaskReport, realDirectory } from './lib/recovery-reconciliation.js';
import { inspectCoverage, publicCoverage } from './lib/recovery-coverage.js';
import { runtimeTreeSha256 } from './lib/runtime-rollback.js';
import { captureOffline, hostProbe, offlineQuiescenceBlockers } from './lib/recovery-offline-capture.js';
import { readCapturePointer, readWindowAuthorization, verifyWindowEvidence, WINDOW } from './lib/c14-window-evidence.js';
import { appendQuarantine, type QuarantinedTaskIdentity } from '../src/shared/task-quarantine.js';
import { TransactionEvidenceLog, ExpectationStore } from './lib/recovery-evidence.js';
import { COMPAT_HOME_PRESERVATION_RULE, defaultLinkPolicy } from './lib/recovery-symlinks.js';
import { recoveryStoragePlan } from './lib/recovery-storage.js';
import type { DestinationFacts } from './lib/recovery-destination.js';
import { C14_ROOT, RETAINED_RELEASE, RETAINED_TREE, aggregateCheckRuns, evaluatePreflight, type PreflightFacts } from './lib/c14-recovery-preflight.js';

const runFile = promisify(execFile);
async function run(bin: string, args: string[]): Promise<string> { return (await runFile(bin, args, { cwd: C14_ROOT, timeout: 20_000, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } })).stdout.trim(); }
export async function assertLiveTarget(): Promise<void> {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  if (root !== C14_ROOT || os.hostname() !== 'MacBook-Air.local' || os.platform() !== 'darwin' || os.arch() !== 'arm64' || os.userInfo().username !== 'andrew' || process.geteuid?.() !== 501 || os.homedir() !== '/Users/andrew' || process.env.DEX_REACH_STATE_DIR && process.env.DEX_REACH_STATE_DIR !== '/Users/andrew/.dex-reach') throw new Error('WRONG_ENVIRONMENT');
  if (await run('/usr/bin/git', ['branch', '--show-current']) !== 'c14-chaos-recovery') throw new Error('WRONG_BRANCH');
  if (await run('/usr/sbin/sysctl', ['-n', 'hw.model']) !== 'MacBookAir10,1' || await run('/usr/bin/git', ['rev-parse', '--show-toplevel']) !== C14_ROOT || await run('/usr/bin/git', ['remote', 'get-url', 'origin']) !== 'git@github.com:westkitty/DEX-REACH.git') throw new Error('WRONG_HOST_OR_REPOSITORY');
}
const liveRoots = { state: '/Users/andrew/.dex-reach', agents: '/Users/andrew/Library/LaunchAgents', worker: '/Users/andrew/.dex-reach-worker' };
export async function liveTaskReport() {
  await assertLiveTarget();
  return inspectTasks({ root: liveRoots.state, expectedRoot: liveRoots.state, nodeId: 'macbook-air.local', processMatches: async (pid, startedAt) => {
    if (!Number.isInteger(pid) || pid < 1 || !Number.isFinite(Date.parse(startedAt))) return 'unknown';
    try {
      const out = await run('/bin/ps', ['-p', String(pid), '-o', 'uid=,lstart=']);
      const match = out.match(/^\s*(\d+)\s+(.+)$/);
      if (!match || Number(match[1]) !== 501 || !Number.isFinite(Date.parse(match[2]!))) return 'unknown';
      // PID existence alone is insufficient; match the recorded process birth time.
      return Math.abs(Date.parse(match[2]!) - Date.parse(startedAt)) <= 2000 ? 'matching' : 'unknown';
    } catch (error) { return (error as any).code === 1 ? 'absent' : 'unknown'; }
  } });
}
async function livePreflight() {
  await assertLiveTarget();
  const head = await run('/usr/bin/git', ['rev-parse', 'HEAD']);
  const branch = await run('/usr/bin/git', ['branch', '--show-current']);
  const remoteHead = (await run('/usr/bin/git', ['ls-remote', 'origin', 'refs/heads/c14-chaos-recovery'])).split(/\s/)[0] ?? '';
  const dirty = !!await run('/usr/bin/git', ['status', '--porcelain']);
  const pr = JSON.parse(await run('gh', ['pr', 'view', '16', '--repo', 'westkitty/DEX-REACH', '--json', 'headRefOid,statusCheckRollup,isDraft,baseRefName']));
  const rows = await liveTaskReport();
  const releaseRoot = path.join(liveRoots.state, 'runtime/releases', RETAINED_RELEASE);
  let observedDigest = '', installedIntact = false;
  try { observedDigest = await runtimeTreeSha256(releaseRoot); installedIntact = observedDigest === RETAINED_TREE; } catch { /* Missing release refuses. */ }
  const serviceReleaseIds: string[] = []; let servicesVerified = true, helperIdle = false;
  const disabled = await run('/bin/launchctl', ['print-disabled', 'gui/501']);
  const processTable = await run('/bin/ps', ['-axo', 'uid=,pid=,command=']);
  for (const role of ['coordinator', 'worker', 'gateway', 'node', 'oauth-canary']) {
    try {
      const label = `com.stinkyweasel.dex-reach.${role}`, plist = await fs.readFile(path.join(liveRoots.agents, `${label}.plist`), 'utf8');
      const loaded = await run('/bin/launchctl', ['print', `gui/501/${label}`]);
      serviceReleaseIds.push(loaded.match(/working directory = .*\/runtime\/releases\/([^\n]+)/)?.[1] ?? 'unknown');
      if (new RegExp(`"${label.replaceAll('.', '\\.')}"\\s*=>\\s*true`).test(disabled)) servicesVerified = false;
      if (!plist.includes(releaseRoot) || !loaded.includes(`working directory = ${releaseRoot}`)) servicesVerified = false;
      if (role !== 'oauth-canary') {
        const pid = loaded.match(/\bpid = (\d+)/)?.[1];
        const matches = processTable.split('\n').filter(l => l.includes(`/dist/src/${role}/main.js`));
        if (!pid || !/state = running/.test(loaded) || matches.length !== 1 || !new RegExp(`^\\s*501\\s+${pid}\\s`).test(matches[0]!)) servicesVerified = false;
      } else if (!/last exit code = 0/.test(loaded) || /\bpid = \d+/.test(loaded)) servicesVerified = false;
    } catch { servicesVerified = false; serviceReleaseIds.push('unknown'); }
  }
  try { const helper = await run('/bin/launchctl', ['print', 'gui/501/com.stinkyweasel.dex-reach.install-reloader-once']); helperIdle = /active count = 0/.test(helper) && /last exit code = 0/.test(helper) && !/\bpid = \d+/.test(helper); } catch { /* Unknown helper refuses. */ }
  const recoveryActive = /scripts\/(?:install-macos|rollback-macos|reload-launchagents)\.(?:ts|js)(?:\s|$)/m.test(processTable);
  let claimsKnown = true, claimsCount = 0;
  for (const name of ['leases', 'queue']) { try { const dir = path.join(liveRoots.state, 'coordinator', name); await realDirectory(dir); claimsCount += (await fs.readdir(dir)).length; } catch { claimsKnown = false; } }
  const stat = await fs.statfs(liveRoots.state), freeBytes = stat.bavail * stat.bsize;
  const pkg = JSON.parse(await fs.readFile(path.join(C14_ROOT, 'package.json'), 'utf8'));
  const store = JSON.parse(await fs.readFile(path.join(liveRoots.state, 'tasks', 'store.json'), 'utf8')) as { records: Record<string, QuarantinedTaskIdentity> };
  const authorization = await readWindowAuthorization();
  const window = await verifyWindowEvidence({ head, sourceRoot: C14_ROOT, nodeId: 'macbook-air.local', roots: liveRoots, tasks: rows, storeRecords: store.records, authorization, captureTransactionId: await readCapturePointer() });
  const ciChecks = aggregateCheckRuns(pr.statusCheckRollup);
  // The exact-head synthetic capture/restore suites run inside the hosted validate job.
  const syntheticAtHead = pr.headRefOid === head && ciChecks.validate === 'SUCCESS';
  const approved = !!authorization && authorization.approvedSha === head;
  const facts: PreflightFacts = {
    hostname: os.hostname(), model: 'MacBookAir10,1', platform: os.platform(), arch: os.arch(), user: os.userInfo().username, uid: process.geteuid!(), home: os.homedir(), root: C14_ROOT, branch, head, remoteHead, dirty,
    candidateVersion: pkg.version, ciHead: pr.headRefOid, ciChecks,
    ...(approved ? { approvedSha: authorization!.approvedSha, approvedVersion: authorization!.approvedVersion } : {}),
    installedIntact, installedRelease: RETAINED_RELEASE, servicesVerified, backupCertified: window.backupCertified,
    baseline: { previousReleaseId: RETAINED_RELEASE, previousDigest: RETAINED_TREE, observedDigest, previousExists: installedIntact, provenance: 'journal-bound', legacyProvenanceApproved: approved && authorization!.retainC13, transactionId: window.backupCertified ? window.captureTransactionId! : '', state: window.backupCertified ? 'prepared' : 'uncertain', fresh: window.backupCertified, serviceReleaseIds, configVerified: window.provenance?.configDigest === window.provenance?.expectedConfigDigest && !!window.provenance, inventoryVerified: window.ownerPreservationVerified, helperIdle: helperIdle && !recoveryActive, rollbackActive: recoveryActive, ...(window.provenance ? { provenanceDetails: window.provenance } : {}) },
    restoreProof: { scope: 'synthetic', sourceSha: syntheticAtHead ? head : '', passed: syntheticAtHead },
    taskCount: rows.length, taskUnresolved: window.unresolved, taskQuarantined: window.quarantined, claimsKnown, claimsCount, ownerPreservationVerified: window.ownerPreservationVerified, freeBytes,
    spaceMeasured: window.spaceMeasured,
    space: window.space ?? { candidateBytes: 512 * 1024 ** 2, dependencyBytes: 0, retainedBytes: 0, backupBytes: 1024 ** 3, restoreBytes: 1024 ** 3, stagingBytes: 512 * 1024 ** 2, reserveBytes: 2 * 1024 ** 3 },
    exactLegacyPairingVerified: window.exactLegacyPairingVerified, credentialsCompatible: window.exactLegacyPairingVerified,
    // E7 (hosted connector interruption) is unavailable; only the owner-approved local/runtime-only scope is admissible.
    requiredHostCapabilityAvailable: approved && authorization!.releaseScope === 'local-runtime-only',
    maintenanceAuthorized: approved && authorization!.maintenanceWindow, releaseScope: 'local-runtime-only', boundary: window.boundary
  };
  return { ...evaluatePreflight(facts), head, installedTreeVerified: installedIntact, freeBytes, spaceEstimate: window.spaceMeasured ? 'MEASURED_FROM_CERTIFIED_CAPTURE' : 'PLANNING_ONLY_REQUIRES_OWNER_BUDGET', windowBlockers: window.blockers, quarantined: window.quarantined, tasks: publicTaskReport(rows), prDraft: pr.isDraft, prBase: pr.baseRefName };
}
/**
 * Owner-run offline capture of the STOPPED installation. Flags are the owner's approval of one exact
 * destination identity; every fact that can be measured is measured and must match. It never stops,
 * starts or restarts a service, never installs, and never retries a transaction id.
 */
async function offlineCaptureCommand(args: string[]): Promise<number> {
  const flag = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
  const known = new Set(['--transaction-id', '--destination', '--approved-device', '--approved-inode', '--approved-volume-uuid', '--evidence-root', '--expectation-root']);
  for (let i = 0; i < args.length; i++) { if (args[i] === '--preserve-compat-home-links') continue; if (!known.has(args[i]!) || !args[i + 1] || args[i + 1]!.startsWith('--')) throw new Error('USAGE'); i++; }
  const required = [...known].map(flag);
  if (required.some(v => !v)) throw new Error('USAGE');
  const [transactionId, destinationArg, approvedDevice, approvedInode, approvedVolume, evidenceRoot, expectationRoot] = required as string[];
  // Quiescence first: sizing needs a consistent snapshot, which a running installation cannot give.
  const probe = hostProbe(501), quiet = await offlineQuiescenceBlockers(probe, liveRoots.state);
  if (quiet.length) { console.log(JSON.stringify({ status: 'REFUSED', transactionId, reason: quiet[0], blockers: quiet, evidenceWritten: false, retryAuthorized: false, installationAuthority: false, servicesRestarted: false }, null, 2)); return 2; }
  const root = await realDirectory(path.resolve(destinationArg!)), st = await fs.lstat(root), volume = await fs.statfs(root);
  // diskutil describes volumes, not directories: resolve the destination's mount point first.
  const mount = (await run('/bin/df', ['-P', root])).split('\n').at(-1)!.split(/\s+/).slice(5).join(' ');
  const info = (key: string) => run('/usr/sbin/diskutil', ['info', '-plist', mount]).then(xml => xml.match(new RegExp(`<key>${key}</key>\\s*<(string|true|false)\\s*/?>([^<]*)`))).then(m => !m ? '' : m[1] === 'string' ? m[2]! : m[1]!);
  const home = os.userInfo().homedir, cloudSynced = [path.join(home, 'Library/Mobile Documents'), path.join(home, 'Library/CloudStorage')].some(c => root === c || root.startsWith(c + path.sep)) || /Dropbox|Google Drive|OneDrive/i.test(root);
  const linkPolicy = args.includes('--preserve-compat-home-links') ? { version: 1 as const, rules: [COMPAT_HOME_PRESERVATION_RULE] } : defaultLinkPolicy();
  const destination: DestinationFacts = {
    root, approvedRoot: root, approved: true, device: st.dev, approvedDevice: Number(approvedDevice), inode: st.ino, approvedInode: Number(approvedInode),
    mountIdentity: await info('VolumeUUID'), approvedMountIdentity: approvedVolume!, ownerUid: st.uid, expectedUid: 501, mode: st.mode & 0o777,
    writable: await fs.access(root, fs.constants.W_OK).then(() => true, () => false), cloudSynced, cloudApproved: false,
    encrypted: await info('FileVault') === 'true', durable: await info('FilesystemType') === 'apfs', freeBytes: volume.bavail * volume.bsize, measured: true,
    space: recoveryStoragePlan(await inspectCoverage(liveRoots, 'inspection', linkPolicy)), sources: liveRoots, gitRoots: [C14_ROOT, '/Users/andrew/DEX-REACH', '/Users/andrew/DEX']
  };
  const forbidden = [...Object.values(liveRoots), root, C14_ROOT];
  const log = await TransactionEvidenceLog.open(evidenceRoot!, 'macbook-air.local', forbidden);
  const expectations = await ExpectationStore.open(expectationRoot!, 'macbook-air.local', [...forbidden, log.root]);
  const sourceSha = await run('/usr/bin/git', ['rev-parse', 'HEAD']);
  if (await run('/usr/bin/git', ['status', '--porcelain'])) throw new Error('SOURCE_DIRTY');
  const outcome = await captureOffline({ nodeId: 'macbook-air.local', transactionId: transactionId!, sourceSha, roots: liveRoots, destination, log, expectations, probe, linkPolicy });
  // The window pointer only names the transaction; the preflight re-verifies everything it would imply.
  if (outcome.status === 'OFFLINE_BACKUP_CERTIFIED' && root === WINDOW.destination && log.root === WINDOW.evidence && expectations.root === WINDOW.expectations) {
    const handle = await fs.open(WINDOW.capture, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify({ version: 1, transactionId: outcome.transactionId }) + '\n'); await handle.sync(); } finally { await handle.close(); }
  }
  console.log(JSON.stringify(outcome, null, 2));
  return outcome.status === 'OFFLINE_BACKUP_CERTIFIED' ? 0 : outcome.status === 'REFUSED' ? 2 : 3;
}
/**
 * Owner-authorized quarantine of unresolved historical tasks. Only records that currently classify as
 * AMBIGUOUS_EFFECT or INSUFFICIENT_EVIDENCE with no live activity, lease or ticket are acknowledged.
 * Nothing is replayed, transitioned or resolved; the task records are not touched.
 */
async function quarantineCommand(): Promise<number> {
  const authorization = await readWindowAuthorization();
  if (!authorization?.historicalTaskQuarantine) throw new Error('QUARANTINE_NOT_AUTHORIZED');
  const rows = await liveTaskReport();
  const store = JSON.parse(await fs.readFile(path.join(liveRoots.state, 'tasks', 'store.json'), 'utf8')) as { records: Record<string, QuarantinedTaskIdentity> };
  const eligible = rows.filter(r => (r.classification === 'AMBIGUOUS_EFFECT' || r.classification === 'INSUFFICIENT_EVIDENCE') && !r.evidence.activity && !r.evidence.lease && !r.evidence.ticket && store.records[r.taskId]);
  const written = await appendQuarantine(liveRoots.state, eligible.map(r => ({ task: store.records[r.taskId]!, classification: r.classification })), { kind: 'owner-authorization', grantedAt: authorization.grantedAt, scope: 'Preserve historical task records; effect unknown; never replay, erase history or claim effects are known.' });
  console.log(JSON.stringify({ mode: 'APPEND_ONLY_QUARANTINE', quarantined: written.length, ineligible: rows.length - eligible.length, effect: 'UNKNOWN', replayAuthorized: false, taskRecordsModified: false }, null, 2));
  return rows.length === eligible.length ? 0 : 2;
}
async function main() {
  const command = process.argv[2] ?? 'preflight';
  // Exit explicitly: the outcome is already durable in the evidence chain, and nothing pending may hold the process.
  if (command === 'capture-offline') { await assertLiveTarget(); process.exit(await offlineCaptureCommand(process.argv.slice(3))); }
  if (command === 'quarantine' && process.argv.length === 3) { await assertLiveTarget(); process.exitCode = await quarantineCommand(); return; }
  if (!['preflight', 'tasks', 'coverage'].includes(command) || process.argv.slice(3).some(a => a !== '--private')) throw new Error('usage: c14-recovery.ts preflight|tasks|coverage [--private for task IDs only] | capture-offline (owner-run, services stopped); no installation command exists');
  await assertLiveTarget();
  if (command === 'tasks') { const rows = await liveTaskReport(); console.log(JSON.stringify(process.argv.includes('--private') ? { mode: 'READ_ONLY_PRIVATE', records: rows } : publicTaskReport(rows), null, 2)); }
  else if (command === 'coverage') console.log(JSON.stringify(publicCoverage(await inspectCoverage(liveRoots)), null, 2));
  else { const report = await livePreflight(); console.log(JSON.stringify(report, null, 2)); if (report.status === 'BLOCKED') process.exitCode = 2; }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) void main().catch(() => { console.error('RECOVERY_INSPECTION_REFUSED: invalid, unavailable or untrusted evidence; no mutation executed'); process.exitCode = 1; });
