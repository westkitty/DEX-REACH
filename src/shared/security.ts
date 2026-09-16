import path from 'node:path';
import crypto from 'node:crypto';
import type { ReachProfile } from './protocol.js';
import { stateDir } from './local-env.js';

const READ_ONLY_TOOLS = new Set([
  'get_config', 'read_file', 'read_multiple_files', 'list_directory', 'start_search',
  'get_more_search_results', 'stop_search', 'list_searches', 'get_file_info', 'read_process_output',
  'list_sessions', 'list_processes', 'get_usage_stats', 'get_recent_tool_calls', 'get_prompts'
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

const READ_ONLY_PROGRAMS = new Set(['pwd','whoami','id','hostname','uname','which','ls','find','rg','grep','cat','head','tail','wc','stat','file','ps','git','node','python','python3','npm','npx']);
const READ_ONLY_GIT = new Set(['status','diff','log','show','branch','remote','rev-parse','ls-files']);
const SHELL_SYNTAX = /[;&|><`$(){}\[\]\n\r\\]/;

export type ReadonlyExec = { program: string; args: string[] };

/**
 * Parse the deliberately tiny shell-free inspection grammar used in read-only mode.
 * Quotes, substitutions, operators, redirections and escapes are rejected instead of interpreted.
 */
export function parseReadonlyCommand(command: string, roots: string[]): ReadonlyExec | null {
  const value = command.trim();
  if (!value || SHELL_SYNTAX.test(value) || /['"]/.test(value)) return null;
  const words = value.split(/\s+/);
  const program = words.shift()!;
  if (!READ_ONLY_PROGRAMS.has(program)) return null;
  if (program === 'git') {
    const sub = words[0];
    if (!sub || !READ_ONLY_GIT.has(sub)) return null;
  }
  if (['node','python','python3','npm','npx'].includes(program) && words.join(' ') !== '--version') return null;
  for (const word of words) {
    if (path.isAbsolute(word) && !pathAllowed(word, roots)) return null;
    if (word === '..' || word.startsWith('../') || word.includes('/../')) return null;
  }
  return { program, args: words };
}

export function timingSafeEqualText(a: string, b: string): boolean {
  const aa = Buffer.from(a);
  const bb = Buffer.from(b);
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}

export function commandGuard(command: string, profile: ReachProfile, roots: string[] = []): string | null {
  for (const pattern of ALWAYS_BLOCKED_COMMANDS) {
    if (pattern.test(command)) return `command blocked by REACH Guard: ${pattern}`;
  }
  if (profile === 'read-only' && !parseReadonlyCommand(command, roots)) {
    return 'read-only profile permits only shell-free recognized inspection commands inside allowed roots';
  }
  return null;
}

export function toolGuard(tool: string, args: Record<string, unknown>, profile: ReachProfile, roots: string[]): string | null {
  if (profile === 'read-only' && !READ_ONLY_TOOLS.has(tool)) return 'tool ' + tool + ' is not permitted by the read-only compatibility allowlist';
  if (tool === 'start_process' && typeof args.command === 'string') {
    const blocked = commandGuard(args.command, profile, roots);
    if (blocked) return blocked;
  }
  for (const candidate of extractPaths(args)) {
    if (!pathAllowed(candidate, roots)) return `path outside allowed roots: ${candidate}`;
  }
  return null;
}

export function pathAllowed(candidate: string, roots: string[]): boolean {
  if (!path.isAbsolute(candidate)) return false;
  const resolved = path.resolve(candidate);
  const privateState = path.resolve(stateDir());
  if (resolved === privateState || resolved.startsWith(privateState + path.sep)) return false;
  return roots.some(root => {
    const base = path.resolve(root);
    return resolved === base || resolved.startsWith(base + path.sep);
  });
}

function extractPaths(value: unknown, key = ''): string[] {
  if (typeof value === 'string' && /(path|file|directory|destination|source)$/i.test(key)) return [value];
  if (Array.isArray(value)) return value.flatMap(v => extractPaths(v, key));
  if (value && typeof value === 'object') return Object.entries(value as Record<string, unknown>).flatMap(([k, v]) => extractPaths(v, k));
  return [];
}

export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [
      k, /(token|password|secret|authorization|cookie|key|signature|privateKey)$/i.test(k) ? '[REDACTED]' : redact(v)
    ]));
  }
  if (typeof value === 'string' && /Bearer\s+[A-Za-z0-9._~-]+/i.test(value)) return '[REDACTED]';
  return value;
}
