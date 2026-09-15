import path from 'node:path';
import crypto from 'node:crypto';
import type { ReachProfile } from './protocol.js';

const MUTATING_TOOLS = new Set([
  'write_file', 'write_pdf', 'create_directory', 'move_file', 'edit_block',
  'set_config_value', 'force_terminate', 'kill_process'
]);

const ALWAYS_BLOCKED_COMMANDS = [
  /(^|\s)sudo(\s|$)/i,
  /(^|\s)rm\s+-[^\n]*r[^\n]*f/i,
  /(^|\s)(mkfs|fdisk|parted|diskutil\s+erase|shutdown|reboot|halt|poweroff)(\s|$)/i,
  /(^|\s)dd\s+[^\n]*of=/i,
  /git\s+reset\s+--hard/i,
  /git\s+clean\s+-[^\n]*f/i,
  /git\s+push\s+[^\n]*(--force|-f)(\s|$)/i
];

const READ_ONLY_COMMANDS = [
  /^\s*(pwd|whoami|id|hostname|uname|which|command\s+-v|ls|find|rg|grep|cat|head|tail|wc|stat|file|ps|env|printenv)(\s|$)/,
  /^\s*git\s+(status|diff|log|show|branch|remote|rev-parse|ls-files)(\s|$)/,
  /^\s*(node|python3?|npm|npx)\s+--version(\s|$)/
];

export function timingSafeEqualText(a: string, b: string): boolean {
  const aa = Buffer.from(a);
  const bb = Buffer.from(b);
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}

export function commandGuard(command: string, profile: ReachProfile): string | null {
  for (const pattern of ALWAYS_BLOCKED_COMMANDS) {
    if (pattern.test(command)) return `command blocked by REACH Guard: ${pattern}`;
  }
  if (profile === 'read-only' && !READ_ONLY_COMMANDS.some(pattern => pattern.test(command))) {
    return 'read-only profile permits only recognized inspection commands';
  }
  return null;
}
export function toolGuard(tool: string, args: Record<string, unknown>, profile: ReachProfile, roots: string[]): string | null {
  if (profile === 'read-only' && MUTATING_TOOLS.has(tool)) {
    return `tool ${tool} is not permitted by read-only profile`;
  }
  if (tool === 'start_process' && typeof args.command === 'string') {
    const blocked = commandGuard(args.command, profile);
    if (blocked) return blocked;
  }
  for (const candidate of extractPaths(args)) {
    if (!pathAllowed(candidate, roots)) return `path outside allowed roots: ${candidate}`;
  }
  return null;
}

export function pathAllowed(candidate: string, roots: string[]): boolean {
  if (!path.isAbsolute(candidate)) return true;
  const resolved = path.resolve(candidate);
  return roots.some(root => {
    const base = path.resolve(root);
    return resolved === base || resolved.startsWith(base + path.sep);
  });
}

function extractPaths(value: unknown, key = ''): string[] {
  if (typeof value === 'string' && /(path|file|directory|destination|source)$/i.test(key)) return [value];
  if (Array.isArray(value)) return value.flatMap(v => extractPaths(v, key));
  if (value && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>).flatMap(([k, v]) => extractPaths(v, k));
  }
  return [];
}

export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [
      k,
      /(token|password|secret|authorization|cookie|key)$/i.test(k) ? '[REDACTED]' : redact(v)
    ]));
  }
  if (typeof value === 'string' && /Bearer\s+[A-Za-z0-9._~-]+/i.test(value)) return '[REDACTED]';
  return value;
}
