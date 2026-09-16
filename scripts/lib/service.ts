import os from 'node:os';
import path from 'node:path';

/** Escapes text for a launchd plist. */
export function xml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export type ServiceSpec = { label: string; entry: string; envFile?: string; stateDir?: string; root: string; nodeBin: string; logsDir: string };

/** macOS LaunchAgent (verified on Andrew's Mac). */
export function launchdPlist(spec: ServiceSpec): string {
  const out = path.join(spec.logsDir, `${spec.label}.log`);
  const err = path.join(spec.logsDir, `${spec.label}.err.log`);
  const env: string[] = [];
  if (spec.envFile) env.push(`<key>DEX_REACH_ENV_FILE</key><string>${xml(spec.envFile)}</string>`);
  if (spec.stateDir) env.push(`<key>DEX_REACH_STATE_DIR</key><string>${xml(spec.stateDir)}</string>`);
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

/**
 * systemd user unit for Linux. Generated and unit-tested for shape only; it has NOT been exercised on a
 * real Linux host yet (see docs/SECOND_DEVICE_QUICKSTART.md).
 */
export function systemdUnit(spec: ServiceSpec): string {
  const env: string[] = [];
  if (spec.envFile) env.push(`Environment=DEX_REACH_ENV_FILE=${spec.envFile}`);
  if (spec.stateDir) env.push(`Environment=DEX_REACH_STATE_DIR=${spec.stateDir}`);
  return `[Unit]
Description=DEX//REACH node (${spec.label})
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${spec.root}
ExecStart=${spec.nodeBin} ${path.join(spec.root, spec.entry)}
${env.join('\n')}
Restart=always
RestartSec=5
NoNewPrivileges=true

[Install]
WantedBy=default.target
`;
}

export function launchAgentsDir(): string {
  return path.join(os.homedir(), 'Library', 'LaunchAgents');
}

export function systemdUserDir(): string {
  return path.join(os.homedir(), '.config', 'systemd', 'user');
}
