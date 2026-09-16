import fs from 'node:fs/promises';
import path from 'node:path';
import { atomicWriteFile, withFileLock } from './state-io.js';

function fileFor(stateDir: string): string {
  return path.join(stateDir, 'revoked-nodes.json');
}

function lockFor(stateDir: string): string {
  return `${fileFor(stateDir)}.lock`;
}

function normalize(value: unknown): Set<string> {
  if (!Array.isArray(value)) return new Set();
  return new Set(value.filter((item): item is string => typeof item === 'string' && item.length > 0));
}

export async function loadRevokedNodes(stateDir: string): Promise<Set<string>> {
  try {
    return normalize(JSON.parse(await fs.readFile(fileFor(stateDir), 'utf8')) as unknown);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new Set();
    throw error;
  }
}

async function mutate(stateDir: string, fn: (nodes: Set<string>) => void): Promise<Set<string>> {
  return withFileLock(lockFor(stateDir), async () => {
    const nodes = await loadRevokedNodes(stateDir);
    fn(nodes);
    await atomicWriteFile(fileFor(stateDir), JSON.stringify([...nodes].sort(), null, 2) + '\n', 0o600);
    return nodes;
  });
}

export async function addRevokedNode(stateDir: string, nodeId: string): Promise<Set<string>> {
  return mutate(stateDir, nodes => nodes.add(nodeId));
}

export async function removeRevokedNode(stateDir: string, nodeId: string): Promise<Set<string>> {
  return mutate(stateDir, nodes => nodes.delete(nodeId));
}
