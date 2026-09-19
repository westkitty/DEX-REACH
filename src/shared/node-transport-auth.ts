import crypto from 'node:crypto';
import { canonicalJson } from './hash.js';
import { REACH_PROTOCOL_VERSION } from './protocol.js';

/**
 * Node *transport* authentication. This is a separate cryptographic domain from
 * receipt/evidence signing. Callers must never pass receipt key material here.
 */

export const NODE_PROOF_MAX_AGE_MS = 5 * 60_000;
export const NODE_PROOF_FUTURE_SKEW_MS = 30_000;
export const NODE_PROOF_PATH = '/node';

export type NodeAuthProof = {
  nodeId: string;
  timestamp: number;
  nonce: string;
  path: string;
  protocolVersion: number;
  signature: string;
};

export type NodeProofFields = Omit<NodeAuthProof, 'signature'>;

export function randomNonce(): string {
  return crypto.randomBytes(16).toString('base64url');
}

export function generateTransportKeyPair(): { privateKey: string; publicKey: string } {
  return crypto.generateKeyPairSync('ed25519', {
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' }
  });
}

export function proofPayload(fields: NodeProofFields): string {
  return canonicalJson({
    nodeId: fields.nodeId,
    timestamp: fields.timestamp,
    nonce: fields.nonce,
    path: fields.path,
    protocolVersion: fields.protocolVersion
  });
}

export function signNodeProof(privateKeyPem: string, fields: NodeProofFields): NodeAuthProof {
  const signature = crypto.sign(null, Buffer.from(proofPayload(fields)), privateKeyPem).toString('base64url');
  return { ...fields, signature };
}

export type ProofFailure =
  | 'unknown-node'
  | 'revoked'
  | 'wrong-key'
  | 'tampered'
  | 'stale-timestamp'
  | 'future-timestamp'
  | 'replay'
  | 'wrong-node-id'
  | 'wrong-path'
  | 'incompatible-protocol'
  | 'malformed';

export function decodeNodeProof(raw: string): NodeAuthProof | null {
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as Partial<NodeAuthProof>;
    if (typeof parsed.nodeId !== 'string' || !parsed.nodeId) return null;
    if (typeof parsed.timestamp !== 'number' || !Number.isFinite(parsed.timestamp)) return null;
    if (typeof parsed.nonce !== 'string' || parsed.nonce.length < 16) return null;
    if (typeof parsed.path !== 'string' || !parsed.path) return null;
    if (typeof parsed.protocolVersion !== 'number' || !Number.isInteger(parsed.protocolVersion)) return null;
    if (typeof parsed.signature !== 'string' || !parsed.signature) return null;
    return parsed as NodeAuthProof;
  } catch {
    return null;
  }
}

export function encodeNodeProof(proof: NodeAuthProof): string {
  return Buffer.from(JSON.stringify(proof)).toString('base64url');
}

export function encodeAuthorizationProof(proof: NodeAuthProof): string {
  return `DexNodeEd25519 ${encodeNodeProof(proof)}`;
}

export function checkProofTiming(timestamp: number, now = Date.now()): ProofFailure | null {
  if (now - timestamp > NODE_PROOF_MAX_AGE_MS) return 'stale-timestamp';
  if (timestamp - now > NODE_PROOF_FUTURE_SKEW_MS) return 'future-timestamp';
  return null;
}

export function verifyNodeProofSignature(publicKeyPem: string, proof: NodeAuthProof): boolean {
  try {
    const fields: NodeProofFields = {
      nodeId: proof.nodeId,
      timestamp: proof.timestamp,
      nonce: proof.nonce,
      path: proof.path,
      protocolVersion: proof.protocolVersion
    };
    return crypto.verify(null, Buffer.from(proofPayload(fields)), publicKeyPem, Buffer.from(proof.signature, 'base64url'));
  } catch {
    return false;
  }
}

export function expectedProofDefaults(nodeId: string, now = Date.now()): NodeProofFields {
  return {
    nodeId,
    timestamp: now,
    nonce: randomNonce(),
    path: NODE_PROOF_PATH,
    protocolVersion: REACH_PROTOCOL_VERSION
  };
}
