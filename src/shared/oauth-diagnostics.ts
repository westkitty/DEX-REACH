import fs from 'node:fs/promises';
import path from 'node:path';
import { atomicWriteFile } from './state-io.js';

export type OAuthRuntimeHealth = {
  version: 1;
  startedAt: string;
  tokenRequests: number;
  token2xx: number;
  token4xx: number;
  token5xx: number;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  lastFailureCode: string | null;
};


export type OAuthCanaryStatus = {
  version: 1;
  checkedAt: string;
  ok: boolean;
  publicBaseUrl: string;
  nodeOnline: boolean;
  refreshCredentialPresent: boolean;
  failureClass: string | null;
};

export type OAuthStateSummary = {
  exists: boolean;
  valid: boolean;
  clients: number;
  activeAccessTokens: number;
  activeRefreshTokens: number;
  expiredAccessTokens: number;
  expiredRefreshTokens: number;
  error: string | null;
};

type PersistedTokenRecord = { expiresAt?: number };
type PersistedOAuthState = {
  clients?: Record<string, unknown>;
  access?: Record<string, PersistedTokenRecord>;
  refresh?: Record<string, PersistedTokenRecord>;
};

const healthFile = (dir: string) => path.join(dir, 'oauth-health.json');
const stateFile = (dir: string) => path.join(dir, 'oauth.json');

export class OAuthHealthRecorder {
  private state: OAuthRuntimeHealth;
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly dir: string) {
    this.state = {
      version: 1,
      startedAt: new Date().toISOString(),
      tokenRequests: 0,
      token2xx: 0,
      token4xx: 0,
      token5xx: 0,
      lastSuccessAt: null,
      lastFailureAt: null,
      lastFailureCode: null
    };
  }

  async initialize(): Promise<void> {
    await this.persist();
  }

  async record(status: number, errorCode: string | null = null): Promise<void> {
    const now = new Date().toISOString();
    this.state.tokenRequests += 1;
    if (status >= 200 && status < 300) {
      this.state.token2xx += 1;
      this.state.lastSuccessAt = now;
    } else if (status >= 400 && status < 500) {
      this.state.token4xx += 1;
      this.state.lastFailureAt = now;
      this.state.lastFailureCode = errorCode;
    } else if (status >= 500) {
      this.state.token5xx += 1;
      this.state.lastFailureAt = now;
      this.state.lastFailureCode = errorCode;
    }
    await this.persist();
  }

  snapshot(): OAuthRuntimeHealth {
    return structuredClone(this.state);
  }

  private async persist(): Promise<void> {
    const snapshot = JSON.stringify(this.state, null, 2) + '\n';
    const next = this.queue.catch(() => undefined).then(() => atomicWriteFile(healthFile(this.dir), snapshot, 0o600));
    this.queue = next;
    await next;
  }
}

export async function readOAuthRuntimeHealth(dir: string): Promise<OAuthRuntimeHealth | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(healthFile(dir), 'utf8')) as OAuthRuntimeHealth;
    if (parsed.version !== 1) return null;
    return parsed;
  } catch {
    return null;
  }
}


export async function readOAuthCanaryStatus(dir: string): Promise<OAuthCanaryStatus | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(path.join(dir, 'oauth-canary-status.json'), 'utf8')) as OAuthCanaryStatus;
    return parsed.version === 1 ? parsed : null;
  } catch {
    return null;
  }
}

export async function inspectOAuthState(dir: string): Promise<OAuthStateSummary> {
  try {
    const raw = JSON.parse(await fs.readFile(stateFile(dir), 'utf8')) as PersistedOAuthState;
    const now = Date.now();
    const access = Object.values(raw.access ?? {});
    const refresh = Object.values(raw.refresh ?? {});
    const active = (records: PersistedTokenRecord[]) => records.filter(record => typeof record.expiresAt === 'number' && record.expiresAt >= now).length;
    const expired = (records: PersistedTokenRecord[]) => records.filter(record => typeof record.expiresAt !== 'number' || record.expiresAt < now).length;
    return {
      exists: true,
      valid: Boolean(raw.clients && raw.access && raw.refresh),
      clients: Object.keys(raw.clients ?? {}).length,
      activeAccessTokens: active(access),
      activeRefreshTokens: active(refresh),
      expiredAccessTokens: expired(access),
      expiredRefreshTokens: expired(refresh),
      error: null
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
      return {
        exists: false,
        valid: false,
        clients: 0,
        activeAccessTokens: 0,
        activeRefreshTokens: 0,
        expiredAccessTokens: 0,
        expiredRefreshTokens: 0,
        error: null
      };
    }
    return {
      exists: true,
      valid: false,
      clients: 0,
      activeAccessTokens: 0,
      activeRefreshTokens: 0,
      expiredAccessTokens: 0,
      expiredRefreshTokens: 0,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}
