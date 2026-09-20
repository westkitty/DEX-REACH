import fs from 'node:fs/promises';
import path from 'node:path';
import { machineStateDir } from './local-env.js';
import { atomicWriteFile, withFileLock } from './state-io.js';

export const CAPACITY_PROFILES = ['conservative', 'interactive'] as const;
export type CapacityProfile = (typeof CAPACITY_PROFILES)[number];
export const SUSTAINED_HEALTH_MS = 60_000;
const MAX_SAMPLE_GAP_MS = 90_000;

type ProfileRecord = { profile: CapacityProfile; updatedAt: string };
type HealthRecord = { healthySince: string | null; lastObservedAt: string };
export type CapacityHealth = { profile: CapacityProfile; interactiveReady: boolean; healthyForMs: number };

function directory(): string { return path.join(machineStateDir(), 'coordinator'); }
function profileFile(): string { return path.join(directory(), 'capacity-profile.json'); }
function healthFile(): string { return path.join(directory(), 'capacity-health.json'); }
function lockFile(): string { return path.join(directory(), 'capacity-profile.lock'); }

function validProfile(value: unknown): value is ProfileRecord {
  return Boolean(value) && typeof value === 'object' && CAPACITY_PROFILES.includes((value as ProfileRecord).profile) && typeof (value as ProfileRecord).updatedAt === 'string';
}

function validHealth(value: unknown): value is HealthRecord {
  return Boolean(value) && typeof value === 'object' && typeof (value as HealthRecord).lastObservedAt === 'string' &&
    ((value as HealthRecord).healthySince === null || typeof (value as HealthRecord).healthySince === 'string');
}

async function readJson(file: string): Promise<unknown | null> {
  try { return JSON.parse(await fs.readFile(file, 'utf8')) as unknown; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}

export async function loadCapacityProfile(): Promise<CapacityProfile> {
  const raw = await readJson(profileFile());
  return validProfile(raw) ? raw.profile : 'conservative';
}

export async function setCapacityProfile(profile: CapacityProfile): Promise<void> {
  await withFileLock(lockFile(), async () => {
    await atomicWriteFile(profileFile(), JSON.stringify({ profile, updatedAt: new Date().toISOString() } satisfies ProfileRecord) + '\n');
    // A changed profile must observe a fresh sustained window; old health evidence cannot be reused.
    await atomicWriteFile(healthFile(), JSON.stringify({ healthySince: null, lastObservedAt: new Date().toISOString() } satisfies HealthRecord) + '\n');
  });
}

export async function recordCapacityHealth(input: {
  memory: 'healthy' | 'warning' | 'critical' | 'unknown';
  cpu: 'healthy' | 'busy' | 'saturated' | 'unknown';
  thermal: 'healthy' | 'limited' | 'unknown';
  observedUncoordinatedHeavy: number;
  now?: number;
}): Promise<CapacityHealth> {
  return withFileLock(lockFile(), async () => {
    const now = input.now ?? Date.now();
    const profile = await loadCapacityProfile();
    const raw = await readJson(healthFile());
    const previous = validHealth(raw) ? raw : { healthySince: null, lastObservedAt: new Date(0).toISOString() };
    const previousAt = Date.parse(previous.lastObservedAt);
    const healthy = input.memory === 'healthy' && input.cpu === 'healthy' && input.thermal !== 'limited' && input.observedUncoordinatedHeavy === 0;
    const continuous = healthy && previous.healthySince !== null && Number.isFinite(previousAt) && now - previousAt <= MAX_SAMPLE_GAP_MS;
    const next: HealthRecord = { healthySince: healthy ? (continuous ? previous.healthySince : new Date(now).toISOString()) : null, lastObservedAt: new Date(now).toISOString() };
    await atomicWriteFile(healthFile(), JSON.stringify(next) + '\n');
    const healthyForMs = next.healthySince ? Math.max(0, now - Date.parse(next.healthySince)) : 0;
    return { profile, interactiveReady: profile === 'interactive' && healthyForMs >= SUSTAINED_HEALTH_MS, healthyForMs };
  });
}
