import fs from 'node:fs/promises';
import path from 'node:path';
import { stateDir } from '../shared/local-env.js';
import { atomicWriteFile } from '../shared/state-io.js';
import type { AccessSnapshot } from '../shared/protocol.js';

/** Written by the running node every few seconds so the local CLI can report state without the gateway. */
export type RuntimeStatus = {
  pid: number;
  connected: boolean;
  gateway: string;
  access: AccessSnapshot;
  updatedAt: string;
};

export function runtimeFile(nodeId: string, dir = stateDir()): string {
  return path.join(dir, 'nodes', `${nodeId}.runtime.json`);
}

export async function writeRuntimeStatus(nodeId: string, status: RuntimeStatus, dir = stateDir()): Promise<void> {
  const file = runtimeFile(nodeId, dir);
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await atomicWriteFile(file, JSON.stringify(status) + '\n', 0o600);
}

/** Returns null when no node process has reported recently (stale after `maxAgeMs`). */
export async function readRuntimeStatus(nodeId: string, dir = stateDir(), maxAgeMs = 15_000): Promise<RuntimeStatus | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(runtimeFile(nodeId, dir), 'utf8')) as RuntimeStatus;
    if (Date.now() - Date.parse(parsed.updatedAt) > maxAgeMs) return null;
    return parsed;
  } catch {
    return null;
  }
}
