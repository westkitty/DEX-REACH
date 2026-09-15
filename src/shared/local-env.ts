import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function loadLocalSecrets(): string | null {
  const file = process.env.DEX_REACH_ENV_FILE || path.join(os.homedir(), '.dex-reach', 'secrets.env');
  if (!fs.existsSync(file)) return null;
  process.loadEnvFile(file);
  return file;
}
