import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import type { ReachProfile } from './protocol.js';
import { stateDir } from './local-env.js';
import { atomicWriteFile, withFileLock } from './state-io.js';

/**
 * EXPERIMENTAL node-local secret broker.
 *
 * The model never sees a secret value. It names an alias; the node resolves that alias to a value
 * after final authorization and immediately before the local invocation, injects it as an
 * environment variable for that one child process, and scrubs it from whatever comes back.
 *
 * What this is not: a reason to trust arbitrary shell. A command that receives a secret in its
 * environment can do anything a command can do with it, including print it somewhere DEX cannot
 * scrub. Controlled injection narrows where a value travels; it does not make the thing it is
 * injected into safe. `secret.use` is an independent capability precisely because holding
 * `process.shell` must not imply the authority to hand a credential to a process.
 *
 * Where values are never allowed to go: the gateway, MCP, request creation, planning, plans,
 * audit entries, receipts, traces, evidence bundles, share reports, and Git. Aliases travel; values
 * do not leave this file and the one child process they are injected into.
 */

export type SecretAliasInfo = {
  alias: string;
  /** Environment variable the value is injected as, for that one child process. */
  env: string;
  createdAt: string;
  updatedAt: string;
  /**
   * Store-local identity of the value, so an owner can tell whether two aliases hold the same thing
   * and whether a value changed, without the record being an offline oracle for the value itself.
   * It is an HMAC under a random per-store key, not a bare hash: a bare hash of a short or
   * guessable secret is brute-forceable by anyone who reads the file.
   */
  fingerprint: string;
};

type StoredSecret = { alias: string; env: string; value: string; createdAt: string; updatedAt: string };
type SecretStoreFile = { version: 1; fingerprintKey: string; secrets: StoredSecret[] };

export class SecretStoreCorruptError extends Error {
  constructor(file: string) {
    super(`secret store is corrupt and was not overwritten: ${file}. Move it aside to start a fresh store.`);
    this.name = 'SecretStoreCorruptError';
  }
}

/** Environment variable names DEX will inject under. Deliberately narrow and shell-safe. */
const ENV_NAME = /^[A-Z][A-Z0-9_]{0,63}$/;
const ALIAS_NAME = /^[a-z][a-z0-9-]{0,63}$/;

/**
 * Names DEX refuses to inject under, because they steer a child process rather than feed it: PATH
 * and friends would let a secret alias redirect which binary runs, and the LD_/DYLD_ family injects
 * code into it. A broker that can rewrite these is a code-execution primitive, not a secret store.
 */
const FORBIDDEN_ENV = /^(PATH|HOME|SHELL|IFS|ENV|BASH_ENV|LD_[A-Z_]*|DYLD_[A-Z_]*|NODE_OPTIONS|PYTHONPATH|PERL5LIB|GIT_[A-Z_]*|DEX_REACH_[A-Z_]*)$/;

/** Shortest value the output scrubber can act on without turning common text into [REDACTED]. */
export const MIN_SCRUBBABLE_SECRET_LENGTH = 6;

export function secretsFile(nodeId: string, dir = stateDir()): string {
  return path.join(dir, 'nodes', `${nodeId}.secrets.json`);
}

function secretsLockFile(nodeId: string, dir = stateDir()): string {
  return `${secretsFile(nodeId, dir)}.lock`;
}

export function isSecretAlias(value: unknown): value is string {
  return typeof value === 'string' && ALIAS_NAME.test(value);
}

export function secretEnvNameRefusal(env: string): string | null {
  if (!ENV_NAME.test(env)) return `environment variable name must match ${ENV_NAME.source}`;
  if (FORBIDDEN_ENV.test(env)) return `DEX will not inject a secret as ${env}; that variable steers the child process rather than feeding it`;
  return null;
}

function emptyStore(): SecretStoreFile {
  return { version: 1, fingerprintKey: crypto.randomBytes(32).toString('base64'), secrets: [] };
}

function decodeStore(parsed: unknown): SecretStoreFile | null {
  if (!parsed || typeof parsed !== 'object') return null;
  const raw = parsed as Partial<SecretStoreFile>;
  if (Number(raw.version) !== 1) return null;
  if (typeof raw.fingerprintKey !== 'string' || !raw.fingerprintKey) return null;
  if (!Array.isArray(raw.secrets)) return null;
  const secrets: StoredSecret[] = [];
  const seen = new Set<string>();
  for (const entry of raw.secrets) {
    if (!entry || typeof entry !== 'object') return null;
    const item = entry as Partial<StoredSecret>;
    if (!isSecretAlias(item.alias)) return null;
    if (typeof item.env !== 'string' || secretEnvNameRefusal(item.env)) return null;
    if (typeof item.value !== 'string' || !item.value) return null;
    if (typeof item.createdAt !== 'string' || typeof item.updatedAt !== 'string') return null;
    if (seen.has(item.alias)) return null;
    seen.add(item.alias);
    secrets.push({ alias: item.alias, env: item.env, value: item.value, createdAt: item.createdAt, updatedAt: item.updatedAt });
  }
  return { version: 1, fingerprintKey: raw.fingerprintKey, secrets };
}

async function readStoreUnlocked(nodeId: string, dir: string): Promise<SecretStoreFile> {
  let raw: string;
  try {
    raw = await fs.readFile(secretsFile(nodeId, dir), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyStore();
    throw new SecretStoreCorruptError(secretsFile(nodeId, dir));
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new SecretStoreCorruptError(secretsFile(nodeId, dir));
  }
  const decoded = decodeStore(parsed);
  // Corrupt state throws rather than returning an empty store. An empty read followed by a normal
  // write would silently destroy every stored value, and the owner would only find out when a
  // command that needed one failed for an unrelated-looking reason.
  if (!decoded) throw new SecretStoreCorruptError(secretsFile(nodeId, dir));
  return decoded;
}

async function writeStoreUnlocked(nodeId: string, store: SecretStoreFile, dir: string): Promise<void> {
  await atomicWriteFile(secretsFile(nodeId, dir), JSON.stringify(store, null, 2) + '\n', 0o600);
}

function fingerprint(key: string, value: string): string {
  return crypto.createHmac('sha256', Buffer.from(key, 'base64')).update(value).digest('hex').slice(0, 16);
}

function describe(store: SecretStoreFile, secret: StoredSecret): SecretAliasInfo {
  return {
    alias: secret.alias,
    env: secret.env,
    createdAt: secret.createdAt,
    updatedAt: secret.updatedAt,
    fingerprint: fingerprint(store.fingerprintKey, secret.value)
  };
}

/** Alias metadata only. There is deliberately no function anywhere that returns a value to a caller outside this module's resolve path. */
export async function listSecretAliases(nodeId: string, dir = stateDir()): Promise<SecretAliasInfo[]> {
  const store = await readStoreUnlocked(nodeId, dir);
  return store.secrets.map(secret => describe(store, secret)).sort((a, b) => a.alias.localeCompare(b.alias));
}

export type SetSecretResult = { info: SecretAliasInfo; replaced: boolean };

export async function setSecret(nodeId: string, alias: string, env: string, value: string, dir = stateDir()): Promise<SetSecretResult> {
  if (!isSecretAlias(alias)) throw new Error(`secret alias must match ${ALIAS_NAME.source}`);
  const envRefusal = secretEnvNameRefusal(env);
  if (envRefusal) throw new Error(envRefusal);
  if (!value) throw new Error('secret value must not be empty');
  if (/[\r\n\0]/.test(value)) throw new Error('secret value must not contain newlines or null bytes');
  // A value shorter than the scrubber's floor would be stored and injected but never removed from
  // returned output, and nothing would say so. Scrubbing is documented as best effort against a
  // command that transforms or forwards a value; it must not also silently do nothing against a
  // command that simply echoes one. Refusing here keeps the gap from being invisible.
  if (value.length < MIN_SCRUBBABLE_SECRET_LENGTH) {
    throw new Error(
      `secret value is shorter than ${MIN_SCRUBBABLE_SECRET_LENGTH} characters; DEX will not store a value it cannot scrub from command output`
    );
  }
  return withFileLock(secretsLockFile(nodeId, dir), async () => {
    const store = await readStoreUnlocked(nodeId, dir);
    const now = new Date().toISOString();
    const existing = store.secrets.find(secret => secret.alias === alias);
    const next: StoredSecret = existing
      ? { ...existing, env, value, updatedAt: now }
      : { alias, env, value, createdAt: now, updatedAt: now };
    const secrets = existing
      ? store.secrets.map(secret => (secret.alias === alias ? next : secret))
      : [...store.secrets, next];
    const updated: SecretStoreFile = { ...store, secrets };
    await writeStoreUnlocked(nodeId, updated, dir);
    return { info: describe(updated, next), replaced: Boolean(existing) };
  });
}

export async function removeSecret(nodeId: string, alias: string, dir = stateDir()): Promise<boolean> {
  return withFileLock(secretsLockFile(nodeId, dir), async () => {
    const store = await readStoreUnlocked(nodeId, dir);
    if (!store.secrets.some(secret => secret.alias === alias)) return false;
    await writeStoreUnlocked(nodeId, { ...store, secrets: store.secrets.filter(secret => secret.alias !== alias) }, dir);
    return true;
  });
}

/**
 * Whether a request asks the node to inject a stored secret. Malformed input counts as asking, so a
 * `secrets` field DEX cannot parse still requires the capability and still reaches the refusal below
 * rather than being dropped on the floor.
 *
 * A planned commit carries its target's arguments and a compatibility call nests them, so the field
 * is looked for where it will actually sit rather than only at the top level.
 */
export function requestNamesSecrets(args: Record<string, unknown>): boolean {
  const direct = (args as { secrets?: unknown }).secrets;
  if (direct !== undefined && direct !== null) return true;
  const nested = (args as { arguments?: unknown }).arguments;
  if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
    return requestNamesSecrets(nested as Record<string, unknown>);
  }
  return false;
}

/** The only operations whose execution path actually injects a resolved value into a child process. */
const SECRET_INJECTING_OPERATIONS = new Set(['dex.process.run']);

/**
 * Whether a request is allowed to name secrets at all. Checked before execution, independently of
 * the capability grant, and closing two separate failures.
 *
 * First: an operation DEX cannot inject into would otherwise run with the aliases quietly dropped.
 * The owner authorized a credential-bearing call and would get a credential-free one, which is the
 * same silent-missing-credential failure `resolveSecrets` refuses for an unknown alias -- a command
 * that authenticates as nobody, or falls back to an ambient identity nobody approved.
 *
 * Second: READ-ONLY admits `dex.process.run` through the read-only branch of `authorizeOperation`,
 * which returns before any capability grant is consulted. Without this refusal a client holding no
 * grant at all could name a stored alias in READ-ONLY mode and have its value injected into an
 * allowlisted inspection program's environment, with output scrubbing as the only thing between
 * that and disclosure -- and scrubbing is explicitly best effort, not a boundary. A read-only
 * inspection command has no use for a credential, so the injection is refused here rather than the
 * grant check being moved; moving it would change what READ-ONLY means for every other operation.
 */
export function secretInjectionRefusal(operation: string, profile: ReachProfile, args: Record<string, unknown>): string | null {
  if (!requestNamesSecrets(args)) return null;
  if (!SECRET_INJECTING_OPERATIONS.has(operation)) {
    return `${operation} cannot inject a stored secret; only ${[...SECRET_INJECTING_OPERATIONS].join(', ')} does, and DEX refuses rather than running the request without the credential it named`;
  }
  if (profile === 'read-only' || profile === 'workspace-safe') {
    return `the ${profile} profile does not inject stored secrets; it admits only commands that have no use for a credential`;
  }
  return null;
}

/** Aliases a request named, normalized and validated. Anything malformed is refused, not ignored. */
export function requestedSecretAliases(args: Record<string, unknown>): string[] {
  const raw = (args as { secrets?: unknown }).secrets;
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new Error('secrets must be an array of aliases');
  const aliases: string[] = [];
  for (const entry of raw) {
    if (!isSecretAlias(entry)) throw new Error(`invalid secret alias in request: ${JSON.stringify(entry)}`);
    if (!aliases.includes(entry)) aliases.push(entry);
  }
  return aliases;
}

export type ResolvedSecrets = {
  /** Environment fragment for exactly one child process. */
  env: Record<string, string>;
  /** The values, for scrubbing output. Never returned to a caller and never persisted. */
  values: string[];
  aliases: string[];
};

export const NO_SECRETS: ResolvedSecrets = { env: {}, values: [], aliases: [] };

/**
 * Resolve aliases to values.
 *
 * This is the only path from an alias to a value, and it is node-local by construction: it reads the
 * node's own 0600 store. Call it after final authorization and immediately before the invocation, so
 * a value exists in memory for as short a window as possible and never while a request is still
 * being authorized, planned or recorded.
 *
 * An alias that is not stored is an error rather than an empty injection: silently running the
 * command without the credential it asked for produces a confusing failure at best, and at worst a
 * command that behaves differently than the owner authorized.
 */
export async function resolveSecrets(nodeId: string, aliases: string[], dir = stateDir()): Promise<ResolvedSecrets> {
  if (!aliases.length) return NO_SECRETS;
  const store = await readStoreUnlocked(nodeId, dir);
  const env: Record<string, string> = {};
  const values: string[] = [];
  for (const alias of aliases) {
    const secret = store.secrets.find(entry => entry.alias === alias);
    if (!secret) throw new Error(`no secret alias "${alias}" on this node; the node owner stores secrets locally`);
    // Re-check at resolve time. A store edited by hand could name an environment variable that was
    // legal when written and is forbidden now, and this is the last point before injection.
    const refusal = secretEnvNameRefusal(secret.env);
    if (refusal) throw new Error(`secret alias "${alias}" cannot be injected: ${refusal}`);
    env[secret.env] = secret.value;
    values.push(secret.value);
  }
  return { env, values, aliases: [...aliases] };
}

/**
 * Remove known secret values from text on its way back to a caller.
 *
 * Best effort and honestly so: it catches a value echoed verbatim, which is the common accident. It
 * cannot catch a value the command transformed, encoded, split or sent somewhere else, which is why
 * injection is not a substitute for deciding whether the command should run at all.
 */
export function scrubSecretValues(text: string, values: readonly string[]): string {
  let output = text;
  // Longest first, so a value that contains another is replaced whole rather than leaving a fragment.
  for (const value of [...values].filter(item => item.length >= MIN_SCRUBBABLE_SECRET_LENGTH).sort((a, b) => b.length - a.length)) {
    output = output.split(value).join('[REDACTED]');
  }
  return output;
}

/** Recursively scrub secret values out of a result before it leaves the node. */
export function scrubSecretsDeep(value: unknown, values: readonly string[]): unknown {
  if (!values.length) return value;
  if (typeof value === 'string') return scrubSecretValues(value, values);
  if (Array.isArray(value)) return value.map(item => scrubSecretsDeep(item, values));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, child]) => [key, scrubSecretsDeep(child, values)]));
  }
  return value;
}
