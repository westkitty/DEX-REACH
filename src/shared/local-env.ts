import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Authority-bearing and durable DEX//REACH state (secrets, node credentials, access policy, audit,
// plans, receipts, checkpoints) lives here. DEX_REACH_STATE_DIR provides a real isolation boundary
// for tests/nodes. Machine coordination/activity use machineStateDir() so an adapter's virtual HOME
// cannot split one physical account into multiple capacity/evidence namespaces.
export function stateDir(): string {
  return path.resolve(process.env.DEX_REACH_STATE_DIR || path.join(os.homedir(), '.dex-reach'));
}

/**
 * State that describes the physical machine rather than one virtualized process environment.
 *
 * Compatibility adapters deliberately replace HOME so their own config cannot pollute the owner's
 * account. Machine coordination and process-activity evidence must not split with that virtual HOME:
 * two agents on one Mac still share one capacity ledger. An explicit DEX_REACH_STATE_DIR remains the
 * isolation boundary for tests, proof runs, and separately staged nodes.
 */
export function machineStateDir(): string {
  return path.resolve(process.env.DEX_REACH_STATE_DIR || path.join(os.userInfo().homedir, '.dex-reach'));
}

/** Load the environment file explicitly selected for the current process (node or owner context). */
export function loadLocalSecrets(): string | null {
  const file = process.env.DEX_REACH_ENV_FILE || path.join(stateDir(), 'secrets.env');
  if (!fs.existsSync(file)) {
    if (process.env.DEX_REACH_ENV_FILE) throw new Error(`DEX_REACH_ENV_FILE is missing: ${file}`);
    return null;
  }
  process.loadEnvFile(file);
  return file;
}

/** Configuration failures stop before adapters/listeners start, with a safe key-specific error. */
export function loadServiceConfig<T>(loader: () => T): T {
  const file = process.env.DEX_REACH_ENV_FILE || path.join(stateDir(), 'secrets.env');
  try {
    loadLocalSecrets();
    return loader();
  } catch (error) {
    console.error(`DEX configuration error (${file}): ${error instanceof Error ? error.message : 'invalid configuration'}`);
    process.exit(78);
  }
}

/**
 * Load gateway-owner settings even when invoked as a child of a DEX node. Node-launched commands
 * inherit DEX_REACH_ENV_FILE pointing at that node's enrollment file; owner-side tools such as the
 * public smoke test must not silently treat that enrollment file as the gateway secrets file.
 */
export function loadOwnerSecrets(): string | null {
  const file = path.join(stateDir(), 'secrets.env');
  if (!fs.existsSync(file)) return null;
  process.loadEnvFile(file);
  return file;
}
