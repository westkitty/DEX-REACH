import os from 'node:os';
import path from 'node:path';

/** Escapes text for a launchd plist. */
export function xml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function systemdQuote(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export type ServiceSpec = {
  label: string;
  entry: string;
  envFile?: string;
  stateDir?: string;
  pathEnv?: string;
  root: string;
  nodeBin: string;
  logsDir: string;
};

export type IntervalLaunchdSpec = {
  label: string;
  entry: string;
  envFile?: string;
  stateDir?: string;
  pathEnv?: string;
  root: string;
  nodeBin: string;
  logsDir: string;
  intervalSeconds: number;
  environment?: Record<string, string>;
};

export type OneShotLaunchdSpec = {
  label: string;
  programArguments: string[];
  workingDirectory: string;
  logsDir: string;
};

/** macOS LaunchAgent for long-running DEX services. */
export function launchdPlist(spec: ServiceSpec): string {
  const out = path.join(spec.logsDir, `${spec.label}.log`);
  const err = path.join(spec.logsDir, `${spec.label}.err.log`);
  const env: string[] = [];
  if (spec.envFile) env.push(`<key>DEX_REACH_ENV_FILE</key><string>${xml(spec.envFile)}</string>`);
  if (spec.stateDir) env.push(`<key>DEX_REACH_STATE_DIR</key><string>${xml(spec.stateDir)}</string>`);
  if (spec.pathEnv) env.push(`<key>PATH</key><string>${xml(spec.pathEnv)}</string>`);
  const envBlock = env.length ? `<key>EnvironmentVariables</key><dict>${env.join('')}</dict>\n` : '';
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${xml(spec.label)}</string>
<key>ProgramArguments</key><array><string>${xml(spec.nodeBin)}</string><string>${xml(path.join(spec.root, spec.entry))}</string></array>
<key>WorkingDirectory</key><string>${xml(spec.root)}</string>
${envBlock}<key>RunAtLoad</key><true/>
<key>KeepAlive</key><true/>
<key>ThrottleInterval</key><integer>5</integer>
<key>ProcessType</key><string>Background</string>
<key>StandardOutPath</key><string>${xml(out)}</string>
<key>StandardErrorPath</key><string>${xml(err)}</string>
</dict></plist>\n`;
}

/** Scheduled macOS LaunchAgent for bounded read-only health canaries. */
export function launchdIntervalPlist(spec: IntervalLaunchdSpec): string {
  const out = path.join(spec.logsDir, `${spec.label}.log`);
  const err = path.join(spec.logsDir, `${spec.label}.err.log`);
  const env: string[] = [];
  if (spec.envFile) env.push(`<key>DEX_REACH_ENV_FILE</key><string>${xml(spec.envFile)}</string>`);
  if (spec.stateDir) env.push(`<key>DEX_REACH_STATE_DIR</key><string>${xml(spec.stateDir)}</string>`);
  if (spec.pathEnv) env.push(`<key>PATH</key><string>${xml(spec.pathEnv)}</string>`);
  for (const [key, value] of Object.entries(spec.environment ?? {})) env.push(`<key>${xml(key)}</key><string>${xml(value)}</string>`);
  const envBlock = env.length ? `<key>EnvironmentVariables</key><dict>${env.join('')}</dict>\n` : '';
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${xml(spec.label)}</string>
<key>ProgramArguments</key><array><string>${xml(spec.nodeBin)}</string><string>${xml(path.join(spec.root, spec.entry))}</string></array>
<key>WorkingDirectory</key><string>${xml(spec.root)}</string>
${envBlock}<key>RunAtLoad</key><true/>
<key>StartInterval</key><integer>${Math.max(300, Math.floor(spec.intervalSeconds))}</integer>
<key>ProcessType</key><string>Background</string>
<key>StandardOutPath</key><string>${xml(out)}</string>
<key>StandardErrorPath</key><string>${xml(err)}</string>
</dict></plist>\n`;
}

/**
 * One-shot macOS LaunchAgent used for self-replacement work. It intentionally has no KeepAlive:
 * launchd starts it once when bootstrapped, and a successful exit is not respawned.
 */
export function launchdOneShotPlist(spec: OneShotLaunchdSpec): string {
  const out = path.join(spec.logsDir, `${spec.label}.log`);
  const err = path.join(spec.logsDir, `${spec.label}.err.log`);
  const args = spec.programArguments.map(value => `<string>${xml(value)}</string>`).join('');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${xml(spec.label)}</string>
<key>ProgramArguments</key><array>${args}</array>
<key>WorkingDirectory</key><string>${xml(spec.workingDirectory)}</string>
<key>RunAtLoad</key><true/>
<key>ProcessType</key><string>Background</string>
<key>StandardOutPath</key><string>${xml(out)}</string>
<key>StandardErrorPath</key><string>${xml(err)}</string>
</dict></plist>\n`;
}

/** Linux user unit. Generated/tested for shape; physical Linux verification remains separate. */
export function systemdUnit(spec: ServiceSpec): string {
  const env: string[] = [];
  if (spec.envFile) env.push(`Environment=${systemdQuote(`DEX_REACH_ENV_FILE=${spec.envFile}`)}`);
  if (spec.stateDir) env.push(`Environment=${systemdQuote(`DEX_REACH_STATE_DIR=${spec.stateDir}`)}`);
  if (spec.pathEnv) env.push(`Environment=${systemdQuote(`PATH=${spec.pathEnv}`)}`);
  return `[Unit]
Description=DEX//REACH node (${spec.label})
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${systemdQuote(spec.root)}
ExecStart=${systemdQuote(spec.nodeBin)} ${systemdQuote(path.join(spec.root, spec.entry))}
${env.join('\n')}
Restart=always
RestartSec=5
NoNewPrivileges=true

[Install]
WantedBy=default.target
`;
}

export function launchAgentsDir(): string { return path.join(os.homedir(), 'Library', 'LaunchAgents'); }
export function systemdUserDir(): string { return path.join(os.homedir(), '.config', 'systemd', 'user'); }

export function servicePath(nodeBin = process.execPath, inherited = process.env.PATH || ''): string {
  const entries = [path.dirname(nodeBin), '/opt/homebrew/bin', '/opt/homebrew/sbin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin', ...inherited.split(path.delimiter)];
  return [...new Set(entries.filter(Boolean))].join(path.delimiter);
}
