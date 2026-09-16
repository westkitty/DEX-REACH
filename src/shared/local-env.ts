import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function loadLocalSecrets(): string | null {
  const file = process.env.DEX_REACH_ENV_FILE || path.join(os.homedir(), '.dex-reach', 'secrets.env');
  if (!fs.existsSync(file)) return null;
  process.loadEnvFile(file);
  return file;
}

// All local DEX//REACH state (secrets, node credentials, access policy, audit, checkpoints) lives here.
// DEX_REACH_STATE_DIR lets an isolated second node run on the same machine without touching the real state.
export function stateDir(): string {
  return path.resolve(process.env.DEX_REACH_STATE_DIR || path.join(os.homedir(), '.dex-reach'));
}
