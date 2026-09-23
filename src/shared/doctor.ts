import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DEX_REACH_VERSION } from './version.js';
import { inspectAccessPolicyFile, loadAccessState, resolveMode } from './access.js';
import { inspectBudgetPolicy } from './budget-policy.js';
import { listCapabilityRequests } from './capability-requests.js';
import { loadPolicyAssertions } from './policy-assertions.js';
import { invariantManifest } from './invariants.js';
import { redactWorkStatusForShare, workStatus } from './work-coordinator.js';
import { listSecretAliases } from './secrets.js';
import { stateDir } from './local-env.js';
import { inspectOAuthState, readOAuthCanaryStatus, readOAuthRuntimeHealth } from './oauth-diagnostics.js';

const execFileAsync = promisify(execFile);

export type DoctorOptions = {
  json?: boolean;
  deep?: boolean;
  share?: boolean;
  repoRoot?: string;
  nodeId?: string;
  dir?: string;
};

async function git(repo: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', repo, ...args], { timeout: 5000 });
    return stdout.trim();
  } catch {
    return '';
  }
}

async function launchdState(label: string): Promise<'loaded' | 'missing' | 'unknown'> {
  try {
    await execFileAsync('launchctl', ['print', `gui/${process.getuid?.() ?? 0}/${label}`], { timeout: 4000 });
    return 'loaded';
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/Could not find|no such process|not found/i.test(message)) return 'missing';
    return 'unknown';
  }
}

export async function collectDoctorReport(options: DoctorOptions = {}): Promise<Record<string, unknown>> {
  const repoRoot = options.repoRoot ?? process.cwd();
  const dir = options.dir ?? stateDir();
  const branch = await git(repoRoot, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const head = await git(repoRoot, ['rev-parse', '--short', 'HEAD']);
  const dirty = await git(repoRoot, ['status', '--porcelain']);
  const upstream = await git(repoRoot, ['rev-parse', '--abbrev-ref', '@{upstream}']);
  const access = options.nodeId ? await inspectAccessPolicyFile(options.nodeId, dir) : null;
  const mode = access ? resolveMode(access.state) : null;
  const budget = options.nodeId ? await inspectBudgetPolicy(options.nodeId, dir) : null;
  const requests = options.nodeId ? await listCapabilityRequests(options.nodeId, dir) : [];
  const assertions = options.nodeId ? await loadPolicyAssertions(options.nodeId, dir).catch(() => []) : [];
  // Alias metadata only, and never a fingerprint: the point is that an owner can see the node holds
  // credentials at all. A corrupt store is reported as an error rather than as zero aliases, because
  // "no secrets stored" and "the secret store is unreadable" are very different things to be told.
  const secrets = options.nodeId
    ? await listSecretAliases(options.nodeId, dir).then(
        aliases => ({ count: aliases.length, aliases: aliases.map(entry => entry.alias), error: null as string | null }),
        error => ({ count: null, aliases: [] as string[], error: error instanceof Error ? error.message : String(error) })
      )
    : null;
  const grants = options.nodeId && access ? access.state.grants.length : 0;
  const coordination = await workStatus();
  const oauthState = await inspectOAuthState(dir);
  const oauthHealth = await readOAuthRuntimeHealth(dir);
  const oauthCanary = await readOAuthCanaryStatus(dir);
  const report: Record<string, unknown> = {
    generatedAt: new Date().toISOString(),
    readOnly: true,
    source: {
      repoRoot,
      branch: branch || null,
      head: head || null,
      dirty: Boolean(dirty),
      upstream: upstream || null
    },
    versions: {
      source: DEX_REACH_VERSION,
      note: 'source version is not proof the installed launchd services match this checkout'
    },
    invariants: {
      count: invariantManifest().count,
      ids: invariantManifest().entries.map(entry => entry.id)
    },
    ownerPolicy: access ? {
      exists: access.exists,
      valid: access.valid,
      mode,
      errors: access.errors,
      grants,
      clients: access.state.clients
    } : { exists: false, note: 'no node id supplied' },
    budgets: budget ? { unrestricted: budget.unrestricted, valid: budget.valid, exists: budget.exists } : null,
    capabilityRequests: { count: requests.length, pending: requests.filter(request => request.status === 'pending').length },
    secrets: secrets
      ? {
          // EXPERIMENTAL. Values never appear here, in any mode. Alias names are withheld from a
          // shareable report because a name like "acme-prod-deploy" describes infrastructure even
          // though it is not itself a credential.
          experimental: true,
          count: secrets.count,
          aliases: options.share ? undefined : secrets.aliases,
          error: secrets.error
        }
      : null,
    assertions: { count: assertions.length },
    coordinator: options.share ? redactWorkStatusForShare(coordination) : {
      substantiveSlots: coordination.capacity.substantiveSlots,
      heavySlots: coordination.capacity.heavySlots,
      livePressure: coordination.capacity.livePressure,
      activeLeases: coordination.leases.length,
      queueDepth: coordination.tickets.length,
      uncoordinatedHeavy: coordination.observed.uncoordinatedHeavy,
      dexServices: coordination.observed.dexServices,
      degraded: coordination.degraded
    },
    oauth: {
      discovery: {
        cimd: true,
        dcr: true,
        pkce: 'S256',
        scopes: ['mcp:tools', 'offline_access'],
        tokenEndpointAuthMethods: ['none']
      },
      state: oauthState,
      tokenEndpoint: oauthHealth,
      canary: oauthCanary
        ? options.share
          ? {
              version: oauthCanary.version,
              checkedAt: oauthCanary.checkedAt,
              ok: oauthCanary.ok,
              nodeOnline: oauthCanary.nodeOnline,
              refreshCredentialPresent: oauthCanary.refreshCredentialPresent,
              failureClass: oauthCanary.failureClass
            }
          : oauthCanary
        : null,
      note: 'counts and status classes only; no client ids, token values, hashes, owner credentials, or redirect URIs are exposed'
    },
    mcp: {
      publicActions: 16,
      note: 'configuration presence is not runtime proof; DEX-INV-005/009/017/021 remain PROOF STALE on this branch until golden smoke'
    },
    limitations: [
      'This report is evidence-scoped. It does not prove a live MCP client session.',
      'It does not prove hardware, Linux, or Android paths that were not exercised.',
      'Source checkout version is not installed-service proof.'
    ]
  };

  if (options.deep) {
    report.services = {
      gateway: await launchdState('com.stinkyweasel.dex-reach.gateway'),
      node: await launchdState('com.stinkyweasel.dex-reach.node'),
      note: 'launchd print success means the job is loaded, not that it served a healthy request'
    };
    if (options.nodeId) {
      try {
        await fs.access(path.join(dir, 'nodes', `${options.nodeId}.runtime.json`));
        report.runtimeFilePresent = true;
      } catch {
        report.runtimeFilePresent = false;
      }
    }
  }

  if (options.share) {
    const source = report.source as Record<string, unknown>;
    delete source.repoRoot;
    delete source.upstream;
    if (report.ownerPolicy && typeof report.ownerPolicy === 'object') {
      const policy = report.ownerPolicy as Record<string, unknown>;
      delete policy.clients;
    }
    report.hostname = 'redacted';
  } else {
    report.hostname = os.hostname();
    report.platform = `${process.platform}/${process.arch}`;
  }

  return report;
}

export function formatDoctorReport(report: Record<string, unknown>): string[] {
  const source = report.source as { branch: string | null; head: string | null; dirty: boolean };
  const policy = report.ownerPolicy as { mode: string | null; valid: boolean; grants: number };
  const coordinator = report.coordinator as { livePressure?: { memory: string; cpu: string }; activeLeases?: number; queueDepth?: number; substantiveSlots?: number };
  const lines = [
    'DEX//REACH doctor (read-only)',
    `Source:     ${source.branch ?? 'unknown'}@${source.head ?? '?'} dirty=${source.dirty}`,
    `Version:    ${(report.versions as { source: string }).source} (source; not installed-service proof)`,
    `Policy:     ${policy?.mode ?? 'n/a'} valid=${policy?.valid ?? false} grants=${policy?.grants ?? 0}`,
    `Coordinator: leases=${typeof coordinator.activeLeases === 'number' ? coordinator.activeLeases : 0} queue=${typeof coordinator.queueDepth === 'number' ? coordinator.queueDepth : 0}`,
    `OAuth:      state=${(report.oauth as any)?.state?.valid ? 'valid' : 'unverified'} refresh=${(report.oauth as any)?.state?.activeRefreshTokens ?? 0} token5xx=${(report.oauth as any)?.tokenEndpoint?.token5xx ?? 0}`,
    `MCP:        16 public actions; live client/golden smoke is a separate proof`,
    ...((report.limitations as string[]).map(item => `Note:       ${item}`))
  ];
  return lines;
}
