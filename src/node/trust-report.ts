import path from 'node:path';
import type { ReachProfile, ToolDescriptor } from '../shared/protocol.js';
import { executionFingerprint } from '../shared/fingerprint.js';
import { inspectAccessPolicyFile, snapshot } from '../shared/access.js';
import { REMOTE_BLOCKED_COMPATIBILITY_TOOLS } from '../shared/compatibility.js';
import { invariantManifest } from '../shared/invariants.js';
import { executionIdentityHash } from '../shared/execution-identity.js';
import { hashValue } from '../shared/hash.js';

export type RuntimeTrustCheck = {
  id: string;
  invariantIds: string[];
  status: 'PASS' | 'BLOCKED';
  detail: string;
};

export async function collectNodeTrustReport(input: {
  nodeId: string;
  profile: ReachProfile;
  allowedRoots: string[];
  gatewayWs: string;
  tools: ToolDescriptor[];
  agentVersion: string;
}): Promise<Record<string, unknown>> {
  const fingerprint = await executionFingerprint(input.nodeId);
  const policy = await inspectAccessPolicyFile(input.nodeId);
  const compatNames = new Set(input.tools.map(tool => tool.name));
  const exposedBlocked = REMOTE_BLOCKED_COMPATIBILITY_TOOLS.filter(name => compatNames.has(name));
  const gateway = new URL(input.gatewayWs);
  const gatewayHost = gateway.hostname.toLowerCase();
  const gatewayIsLoopback = ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(gatewayHost);
  const rootsValid = input.allowedRoots.length > 0 && input.allowedRoots.every(root => path.isAbsolute(root));

  const checks: RuntimeTrustCheck[] = [
    {
      id: 'TRUST-IDENTITY',
      invariantIds: ['DEX-INV-001'],
      status: fingerprint.nodeId === input.nodeId ? 'PASS' : 'BLOCKED',
      detail: fingerprint.nodeId === input.nodeId ? 'fresh fingerprint matches the selected node' : 'fresh fingerprint does not match the selected node'
    },
    {
      id: 'TRUST-POLICY',
      invariantIds: ['DEX-INV-002', 'DEX-INV-003'],
      status: policy.valid ? 'PASS' : 'BLOCKED',
      detail: policy.valid ? `owner policy schema and assertions pass at revision ${policy.state.revision}` : policy.errors.join('; ')
    },
    {
      id: 'TRUST-ROOTS',
      invariantIds: ['DEX-INV-004'],
      status: rootsValid ? 'PASS' : 'BLOCKED',
      detail: rootsValid ? `${input.allowedRoots.length} absolute allowed root(s) are configured` : 'allowed roots are missing or not absolute'
    },
    {
      id: 'TRUST-COMPATIBILITY',
      invariantIds: ['DEX-INV-005'],
      status: exposedBlocked.length === 0 ? 'PASS' : 'BLOCKED',
      detail: exposedBlocked.length === 0 ? 'node-owned/vendor-only compatibility tools are not remotely exposed' : `blocked compatibility tools exposed: ${exposedBlocked.join(', ')}`
    },
    {
      id: 'TRUST-TRANSPORT',
      invariantIds: ['DEX-INV-009'],
      status: gatewayIsLoopback || gateway.protocol === 'wss:' ? 'PASS' : 'BLOCKED',
      detail: gatewayIsLoopback ? 'node gateway transport is loopback-local' : gateway.protocol === 'wss:' ? 'remote node gateway transport uses WSS' : 'remote node gateway transport is cleartext'
    }
  ];

  const manifest = invariantManifest();
  const access = snapshot(policy.state);
  const certificateBody = {
    schemaVersion: 1,
    nodeId: input.nodeId,
    agentVersion: input.agentVersion,
    profile: input.profile,
    allowedRoots: input.allowedRoots,
    identityHash: executionIdentityHash(fingerprint),
    access,
    checks
  };

  return {
    schemaVersion: 1,
    verdict: checks.every(check => check.status === 'PASS') ? 'PASS' : 'BLOCKED',
    generatedAt: new Date().toISOString(),
    certificateHash: hashValue(certificateBody),
    nodeId: input.nodeId,
    agentVersion: input.agentVersion,
    profile: input.profile,
    allowedRoots: input.allowedRoots,
    fingerprint,
    identityHash: certificateBody.identityHash,
    access,
    checks,
    invariants: {
      schemaVersion: manifest.schemaVersion,
      releaseBlocking: manifest.releaseBlocking,
      count: manifest.count,
      ids: manifest.entries.map(entry => entry.id),
      liveEvaluatedIds: [...new Set(checks.flatMap(check => check.invariantIds))]
    },
    evidenceScope: 'This live report evaluates only the listed runtime checks. It does not replace the full release regression, deployment, hardware, or hosted-CI proof required by docs/INVARIANTS.md.'
  };
}
