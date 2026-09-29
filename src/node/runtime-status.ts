import fs from 'node:fs/promises';
import path from 'node:path';
import { stateDir } from '../shared/local-env.js';
import { atomicWriteFile } from '../shared/state-io.js';
import type { AccessSnapshot } from '../shared/protocol.js';

/** Written by the running node every few seconds so the local CLI can report state without the gateway. */
export type RuntimeStatus = {
  pid: number;
  /** Legacy field retained for backwards compatibility. */
  connected: boolean;
  socketConnected?: boolean;
  gatewayRegistered?: boolean;
  startedAt?: string;
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

export function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Returns null when no node process has reported recently or when the recorded PID is no longer
 * alive. Fresh bytes alone are not proof of a running daemon.
 */
export async function readRuntimeStatus(
  nodeId: string,
  dir = stateDir(),
  maxAgeMs = 15_000,
  isAlive: (pid: number) => boolean = processAlive
): Promise<RuntimeStatus | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(runtimeFile(nodeId, dir), 'utf8')) as RuntimeStatus;
    const updatedAt = Date.parse(parsed.updatedAt);
    if (!Number.isFinite(updatedAt) || Date.now() - updatedAt > maxAgeMs) return null;
    if (!isAlive(parsed.pid)) return null;
    return parsed;
  } catch {
    return null;
  }
}
