import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// All local DEX//REACH state (secrets, node credentials, access policy, audit, plans, receipts,
// checkpoints) lives here. DEX_REACH_STATE_DIR provides a real isolation boundary for tests/nodes.
export function stateDir(): string {
  return path.resolve(process.env.DEX_REACH_STATE_DIR || path.join(os.homedir(), '.dex-reach'));
}

/** Load the environment file explicitly selected for the current process (node or owner context). */
export function loadLocalSecrets(): string | null {
  const file = process.env.DEX_REACH_ENV_FILE || path.join(stateDir(), 'secrets.env');
  if (!fs.existsSync(file)) return null;
  process.loadEnvFile(file);
  return file;
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
