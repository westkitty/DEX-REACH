import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import type { AccessMode, ClientKind } from './protocol.js';
import type { ReachCapability } from './capabilities.js';
import { REACH_CAPABILITIES } from './capabilities.js';
import { stateDir } from './local-env.js';
import { atomicWriteFile, withFileLock } from './state-io.js';
import { hashValue } from './hash.js';

/**
 * Custom policy assertions are regression tests against the real policy engine, not a second
 * authorization engine. They run on candidate owner-policy state before persist.
 */

export const ASSERTION_CLIENTS = ['chatgpt', 'claude', 'smoke', 'other'] as const;

export type PolicyAssertion = {
  id: string;
  client: ClientKind;
  forbidCapabilities: ReachCapability[];
  writeRoots: string[];
  note: string;
  createdAt: string;
};

export type PolicyAssertionFile = {
  version: 1;
  assertions: PolicyAssertion[];
};

type GrantLike = {
  client: string;
  capabilities: string[];
  roots: string[];
};

export type AssertionState = {
  mode: AccessMode;
  clients: Partial<Record<ClientKind, AccessMode>>;
  grantRequired: Partial<Record<ClientKind, boolean>>;
  grants: GrantLike[];
};

const RANK: Record<AccessMode, number> = { off: 0, 'read-only': 1, on: 2 };

export function policyAssertionFile(nodeId: string, dir = stateDir()): string {
  return path.join(dir, 'nodes', `${nodeId}.policy-assertions.json`);
}

export function policyHistoryFile(nodeId: string, dir = stateDir()): string {
  return path.join(dir, 'nodes', `${nodeId}.policy-history.jsonl`);
}

function assertionLockFile(nodeId: string, dir = stateDir()): string {
  return `${policyAssertionFile(nodeId, dir)}.lock`;
}

function emptyAssertions(): PolicyAssertionFile {
  return { version: 1, assertions: [] };
}

function decodeAssertion(value: unknown): PolicyAssertion | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Partial<PolicyAssertion>;
  if (typeof raw.id !== 'string' || !raw.id) return null;
  if (!(ASSERTION_CLIENTS as readonly string[]).includes(String(raw.client))) return null;
  if (!Array.isArray(raw.forbidCapabilities) || !raw.forbidCapabilities.every(cap => (REACH_CAPABILITIES as readonly string[]).includes(cap))) return null;
  if (!Array.isArray(raw.writeRoots) || !raw.writeRoots.every(root => typeof root === 'string' && path.isAbsolute(root))) return null;
  if (typeof raw.note !== 'string' || !raw.note.trim()) return null;
  if (typeof raw.createdAt !== 'string') return null;
  return {
    id: raw.id,
    client: raw.client as ClientKind,
    forbidCapabilities: raw.forbidCapabilities,
    writeRoots: raw.writeRoots.map(root => path.resolve(root)),
    note: raw.note.trim(),
    createdAt: raw.createdAt
  };
}

async function readAssertionsUnlocked(nodeId: string, dir: string): Promise<{ file: PolicyAssertionFile; valid: boolean; exists: boolean }> {
  try {
    const parsed = JSON.parse(await fs.readFile(policyAssertionFile(nodeId, dir), 'utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Number((parsed as { version?: number }).version) !== 1) {
      return { file: emptyAssertions(), valid: false, exists: true };
    }
    const raw = parsed as { assertions?: unknown };
    if (!Array.isArray(raw.assertions)) return { file: emptyAssertions(), valid: false, exists: true };
    const assertions: PolicyAssertion[] = [];
    for (const entry of raw.assertions) {
      const decoded = decodeAssertion(entry);
      if (!decoded) return { file: emptyAssertions(), valid: false, exists: true };
      assertions.push(decoded);
    }
    return { file: { version: 1, assertions }, valid: true, exists: true };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { file: emptyAssertions(), valid: true, exists: false };
    return { file: emptyAssertions(), valid: false, exists: true };
  }
}

export async function loadPolicyAssertions(nodeId: string, dir = stateDir()): Promise<PolicyAssertion[]> {
  const read = await readAssertionsUnlocked(nodeId, dir);
  if (read.exists && !read.valid) throw new Error('policy assertions file is corrupt; refusing to persist owner authority');
  return read.file.assertions;
}

export function evaluateCustomAssertions(state: AssertionState, assertions: PolicyAssertion[]): string[] {
  const errors: string[] = [];
  for (const assertion of assertions) {
    const ceiling = state.clients[assertion.client];
    const effective: AccessMode = ceiling && RANK[ceiling] < RANK[state.mode] ? ceiling : state.mode;
    const grants = state.grants.filter(grant => grant.client === assertion.client);
    for (const capability of assertion.forbidCapabilities) {
      if (grants.some(grant => grant.capabilities.includes(capability))) {
        errors.push(`${assertion.id}: ${assertion.client} must not hold ${capability} (${assertion.note})`);
      }
      if (capability === 'process.shell' && effective === 'on' && !state.grantRequired[assertion.client]) {
        errors.push(`${assertion.id}: ${assertion.client} would have unrestricted shell authority (${assertion.note})`);
      }
    }
    if (assertion.writeRoots.length) {
      const writeGrants = grants.filter(grant => grant.capabilities.includes('file.write'));
      for (const grant of writeGrants) {
        const covered = grant.roots.every(root => assertion.writeRoots.some(base => root === base || root.startsWith(base + path.sep)));
        if (!covered) errors.push(`${assertion.id}: ${assertion.client} write roots escape the asserted project (${assertion.note})`);
      }
      if (effective === 'on' && !state.grantRequired[assertion.client]) {
        errors.push(`${assertion.id}: ${assertion.client} would have unrestricted write authority (${assertion.note})`);
      }
    }
  }
  return errors;
}

export async function addPolicyAssertion(
  nodeId: string,
  input: { client: ClientKind; forbidCapabilities?: ReachCapability[]; writeRoots?: string[]; note: string },
  dir = stateDir()
): Promise<PolicyAssertion> {
  const note = input.note.trim();
  if (!note) throw new Error('assertion note is required');
  if (!(input.forbidCapabilities?.length) && !(input.writeRoots?.length)) {
    throw new Error('assertion requires --forbid or --write-root');
  }
  const assertion: PolicyAssertion = {
    id: crypto.randomUUID(),
    client: input.client,
    forbidCapabilities: input.forbidCapabilities ?? [],
    writeRoots: (input.writeRoots ?? []).map(root => path.resolve(root)),
    note,
    createdAt: new Date().toISOString()
  };
  await withFileLock(assertionLockFile(nodeId, dir), async () => {
    const read = await readAssertionsUnlocked(nodeId, dir);
    if (read.exists && !read.valid) throw new Error('policy assertions file is corrupt');
    const next: PolicyAssertionFile = { version: 1, assertions: [...read.file.assertions, assertion] };
    await atomicWriteFile(policyAssertionFile(nodeId, dir), JSON.stringify(next, null, 2) + '\n', 0o600);
  });
  return assertion;
}

export async function clearPolicyAssertion(nodeId: string, id: string, dir = stateDir()): Promise<void> {
  await withFileLock(assertionLockFile(nodeId, dir), async () => {
    const read = await readAssertionsUnlocked(nodeId, dir);
    if (read.exists && !read.valid) throw new Error('policy assertions file is corrupt');
    if (!read.file.assertions.some(assertion => assertion.id === id)) throw new Error(`no assertion ${id}`);
    const next: PolicyAssertionFile = { version: 1, assertions: read.file.assertions.filter(assertion => assertion.id !== id) };
    await atomicWriteFile(policyAssertionFile(nodeId, dir), JSON.stringify(next, null, 2) + '\n', 0o600);
  });
}

export type PolicyHistoryEntry = {
  revision: number;
  at: string;
  hash: string;
  restoredFrom: number | null;
  state: unknown;
};

export async function appendPolicyHistory(nodeId: string, state: { revision: number }, restoredFrom: number | null = null, dir = stateDir()): Promise<void> {
  const entry: PolicyHistoryEntry = {
    revision: state.revision,
    at: new Date().toISOString(),
    hash: hashValue(state),
    restoredFrom,
    state
  };
  await fs.mkdir(path.dirname(policyHistoryFile(nodeId, dir)), { recursive: true, mode: 0o700 });
  await fs.appendFile(policyHistoryFile(nodeId, dir), JSON.stringify(entry) + '\n', { mode: 0o600 });
}

export async function listPolicyHistory(nodeId: string, limit = 20, dir = stateDir()): Promise<PolicyHistoryEntry[]> {
  try {
    const lines = (await fs.readFile(policyHistoryFile(nodeId, dir), 'utf8')).split('\n').filter(Boolean);
    const entries: PolicyHistoryEntry[] = [];
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line) as PolicyHistoryEntry;
        if (typeof parsed.revision === 'number' && typeof parsed.hash === 'string') entries.push(parsed);
      } catch {
        continue;
      }
    }
    return entries.slice(-Math.max(1, limit));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

export async function historyEntry(nodeId: string, revision: number, dir = stateDir()): Promise<PolicyHistoryEntry> {
  const entries = await listPolicyHistory(nodeId, 10_000, dir);
  const found = entries.find(entry => entry.revision === revision);
  if (!found) throw new Error(`no policy history revision ${revision}`);
  return found;
}
