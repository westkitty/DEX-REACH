import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { stateDir } from '../shared/local-env.js';
import { atomicWriteFile } from '../shared/state-io.js';
import { generateTransportKeyPair } from '../shared/node-transport-auth.js';

/**
 * Node transport authentication private keys. Distinct from receipt/evidence keys:
 * receipts live under receipts/<id>.ed25519.pem; transport keys live here.
 *
 * Storage is a node-local 0600 PEM file. That is weaker than an OS keychain/TPM and
 * is documented as such; a Keychain-backed store is not claimed as proven.
 */
export function transportPrivateKeyFile(nodeId: string, dir = stateDir()): string {
  return path.join(dir, 'nodes', `${nodeId}.transport.ed25519.pem`);
}

export function transportPublicKeyFile(nodeId: string, dir = stateDir()): string {
  return path.join(dir, 'nodes', `${nodeId}.transport.ed25519.pub.pem`);
}

export function receiptPrivateKeyFile(nodeId: string, dir = stateDir()): string {
  return path.join(dir, 'receipts', `${nodeId}.ed25519.pem`);
}

export async function loadOrCreateTransportKeys(nodeId: string, dir = stateDir()): Promise<{ privateKey: string; publicKey: string; created: boolean }> {
  const priv = transportPrivateKeyFile(nodeId, dir);
  try {
    const privateKey = await fs.readFile(priv, 'utf8');
    const publicKey = (await fs.readFile(transportPublicKeyFile(nodeId, dir), 'utf8').catch(() => null))
      ?? crypto.createPublicKey(privateKey).export({ type: 'spki', format: 'pem' }).toString();
    if (!privateKey.includes('PRIVATE KEY')) throw new Error('transport key file is not a private key');
    return { privateKey, publicKey, created: false };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const pair = generateTransportKeyPair();
    await atomicWriteFile(priv, pair.privateKey, 0o600);
    await atomicWriteFile(transportPublicKeyFile(nodeId, dir), pair.publicKey, 0o600);
    return { ...pair, created: true };
  }
}

export async function loadTransportKeys(nodeId: string, dir = stateDir()): Promise<{ privateKey: string; publicKey: string } | null> {
  try {
    const privateKey = await fs.readFile(transportPrivateKeyFile(nodeId, dir), 'utf8');
    const publicKey = await fs.readFile(transportPublicKeyFile(nodeId, dir), 'utf8');
    return { privateKey, publicKey };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}
