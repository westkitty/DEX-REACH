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
  const facts: PreflightFacts = {
    hostname: os.hostname(), model: 'MacBookAir10,1', platform: os.platform(), arch: os.arch(), user: os.userInfo().username, uid: process.geteuid!(), home: os.homedir(), root: C14_ROOT, branch, head, remoteHead, dirty,
    candidateVersion: pkg.version, ciHead: pr.headRefOid, ciChecks: aggregateCheckRuns(pr.statusCheckRollup),
    installedIntact, installedRelease: RETAINED_RELEASE, servicesVerified, backupCertified: false,
    baseline: { previousReleaseId: RETAINED_RELEASE, previousDigest: RETAINED_TREE, observedDigest, previousExists: installedIntact, provenance: 'journal-bound', legacyProvenanceApproved: false, transactionId: '', state: 'uncertain', fresh: false, serviceReleaseIds, configVerified: false, inventoryVerified: false, helperIdle: helperIdle && !recoveryActive, rollbackActive: recoveryActive },
    restoreProof: { scope: 'synthetic', sourceSha: '', passed: false }, taskCount: rows.length, taskUnresolved: rows.length, claimsKnown, claimsCount, ownerPreservationVerified: false, freeBytes, spaceMeasured: false,
    // Conservative planning placeholder, explicitly not a measured live-backup budget.
    space: { candidateBytes: 512 * 1024 ** 2, dependencyBytes: 0, retainedBytes: 0, backupBytes: 1024 ** 3, restoreBytes: 1024 ** 3, stagingBytes: 512 * 1024 ** 2, reserveBytes: 2 * 1024 ** 3 },
    exactLegacyPairingVerified: false, credentialsCompatible: false, requiredHostCapabilityAvailable: false, maintenanceAuthorized: false
  };
  return { ...evaluatePreflight(facts), head, installedTreeVerified: installedIntact, freeBytes, spaceEstimate: 'PLANNING_ONLY_REQUIRES_OWNER_BUDGET', tasks: publicTaskReport(rows), prDraft: pr.isDraft, prBase: pr.baseRefName };
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
  const outcome = await captureOffline({ nodeId: 'macbook-air.local', transactionId: transactionId!, roots: liveRoots, destination, log, expectations, probe, linkPolicy });
  console.log(JSON.stringify(outcome, null, 2));
  return outcome.status === 'OFFLINE_BACKUP_CERTIFIED' ? 0 : outcome.status === 'REFUSED' ? 2 : 3;
}
async function main() {
  const command = process.argv[2] ?? 'preflight';
  if (command === 'capture-offline') { await assertLiveTarget(); process.exitCode = await offlineCaptureCommand(process.argv.slice(3)); return; }
  if (!['preflight', 'tasks', 'coverage'].includes(command) || process.argv.slice(3).some(a => a !== '--private')) throw new Error('usage: c14-recovery.ts preflight|tasks|coverage [--private for task IDs only] | capture-offline (owner-run, services stopped); no installation command exists');
  await assertLiveTarget();
  if (command === 'tasks') { const rows = await liveTaskReport(); console.log(JSON.stringify(process.argv.includes('--private') ? { mode: 'READ_ONLY_PRIVATE', records: rows } : publicTaskReport(rows), null, 2)); }
  else if (command === 'coverage') console.log(JSON.stringify(publicCoverage(await inspectCoverage(liveRoots)), null, 2));
  else { const report = await livePreflight(); console.log(JSON.stringify(report, null, 2)); if (report.status === 'BLOCKED') process.exitCode = 2; }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) void main().catch(() => { console.error('RECOVERY_INSPECTION_REFUSED: invalid, unavailable or untrusted evidence; no mutation executed'); process.exitCode = 1; });
