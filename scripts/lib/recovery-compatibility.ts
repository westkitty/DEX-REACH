import fs from 'node:fs/promises';
import path from 'node:path';
import { NodeAuthStore } from '../../src/gateway/node-auth.js';
import { encodeNodeProof, expectedProofDefaults, signNodeProof } from '../../src/shared/node-transport-auth.js';
import { inspectAccessPolicyFile } from '../../src/shared/access.js';
import { verifyReceiptChain, type ExecutionReceipt } from '../../src/shared/receipts.js';
import type { Roots } from './recovery-coverage.js';

/**
 * The candidate's own code must accept the existing owner state: the enrolled node's real transport key
 * authenticates against the real enrollment, the access policy parses and is valid, and the signed
 * receipt chain verifies. Run only against an isolated restored copy: authentication records a nonce.
 */
export async function verifyLegacyCompatibility(restored: Roots, nodeId = 'macbook-air.local'): Promise<{ authMode: 'asymmetric'; policyValid: true; receipts: number }> {
  const auth = new NodeAuthStore(restored.state); await auth.initialize();
  if (auth.authMode(nodeId) !== 'asymmetric') throw new Error('LEGACY_ENROLLMENT_NOT_ASYMMETRIC');
  const key = await fs.readFile(path.join(restored.state, 'nodes', `${nodeId}.transport.ed25519.pem`), 'utf8');
  const proof = await auth.authenticateProof(nodeId, encodeNodeProof(signNodeProof(key, expectedProofDefaults(nodeId))));
  if (!proof.ok) throw new Error('LEGACY_TRANSPORT_PROOF_REFUSED');
  const policy = await inspectAccessPolicyFile(nodeId, restored.state);
  if (!policy.valid) throw new Error('LEGACY_ACCESS_POLICY_INVALID');
  const raw = await fs.readFile(path.join(restored.state, 'receipts', `${nodeId}.jsonl`), 'utf8');
  const receipts = raw.split('\n').filter(Boolean).map(line => JSON.parse(line) as ExecutionReceipt);
  if (!verifyReceiptChain(receipts)) throw new Error('LEGACY_RECEIPT_CHAIN_INVALID');
  return { authMode: 'asymmetric', policyValid: true, receipts: receipts.length };
}
