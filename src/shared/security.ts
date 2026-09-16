import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { ReachProfile } from './protocol.js';
import { stateDir } from './local-env.js';

const READ_ONLY_TOOLS = new Set([
  'get_config', 'read_file', 'read_multiple_files', 'list_directory', 'start_search',
  'get_more_search_results', 'stop_search', 'list_searches', 'get_file_info', 'read_process_output',
  'list_sessions', 'list_processes', 'get_usage_stats'
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
const PATH_KEY = /(?:^|_)(?:cwd|path|paths|file|files|directory|directories|destination|destinations|source|sources)$/i;

export type ReadonlyExec = { program: string; args: string[] };

/**
 * Resolve every existing ancestor through realpath, then append any not-yet-existing suffix. This
 * closes symlink escapes for both existing reads and future write destinations without requiring
 * the final file to exist already.
 */
export function canonicalPathForScope(value: string): string | null {
  if (!path.isAbsolute(value)) return null;
  let cursor = path.resolve(value);
  const suffix: string[] = [];
  while (true) {
    try {
      const real = fs.realpathSync.native(cursor);
      return path.resolve(real, ...suffix);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') return null;
      const parent = path.dirname(cursor);
      if (parent === cursor) return path.resolve(value);
      suffix.unshift(path.basename(cursor));
      cursor = parent;
    }
  }
}

export function pathAllowed(candidate: string, roots: string[]): boolean {
  const resolved = canonicalPathForScope(candidate);
  if (!resolved) return false;
  const privateState = canonicalPathForScope(stateDir());
  if (privateState && (resolved === privateState || resolved.startsWith(privateState + path.sep))) return false;
  return roots.some(root => {
    const base = canonicalPathForScope(root);
    return Boolean(base && (resolved === base || resolved.startsWith(base + path.sep)));
  });
}

/**
 * Parse the deliberately tiny shell-free inspection grammar used in read-only mode. Quotes,
 * substitutions, operators, redirections, escapes, traversal and symlink escapes are rejected.
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
  const privateState = stateDir();
  if (command.includes(privateState) || /(?:^|[\/\s'"$])\.dex-reach(?:[\/\s'"]|$)/i.test(command)) return 'command targets DEX private state and is blocked';
  if (/DEX_REACH_(?:NODE_TOKEN|OWNER_PASSWORD|ENV_FILE)/i.test(command)) return 'command requests DEX credential state and is blocked';
  for (const pattern of ALWAYS_BLOCKED_COMMANDS) {
    if (pattern.test(command)) return `command blocked by REACH Guard: ${pattern}`;
  }
  if (profile === 'read-only' && !parseReadonlyCommand(command, roots)) {
    return 'read-only profile permits only shell-free recognized inspection commands inside allowed roots';
  }
  return null;
}

export function toolGuard(tool: string, args: Record<string, unknown>, profile: ReachProfile, roots: string[]): string | null {
  if (['set_config_value', 'get_recent_tool_calls', 'give_feedback_to_desktop_commander', 'get_prompts'].includes(tool)) {
    return `compatibility tool ${tool} is node-owned/vendor-only and cannot be invoked remotely`;
  }
  if (tool === 'read_file' && args.isUrl === true) return 'compatibility URL reads are disabled; remote clients may not use the node as a URL fetch proxy';
  if (profile === 'read-only' && !READ_ONLY_TOOLS.has(tool)) return `tool ${tool} is not permitted by the read-only compatibility allowlist`;
  if (tool === 'start_process' && typeof args.command === 'string') {
    const blocked = commandGuard(args.command, profile, roots);
    if (blocked) return blocked;
  }
  for (const candidate of extractPaths(args)) {
    if (!pathAllowed(candidate, roots)) return `path outside allowed roots: ${candidate}`;
  }
  return null;
}

export function extractPaths(value: unknown, key = ''): string[] {
  const normalizedKey = key.replace(/([a-z0-9])([A-Z])/g, '$1_$2');
  if (typeof value === 'string' && PATH_KEY.test(normalizedKey)) return [value];
  if (Array.isArray(value)) return value.flatMap(child => extractPaths(child, key));
  if (value && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>).flatMap(([childKey, child]) => extractPaths(child, childKey));
  }
  return [];
}

export function redactSensitiveText(value: string): string {
  return value
    .replace(/Bearer\s+[A-Za-z0-9._~-]+/gi, '[REDACTED]')
    .replace(/\b((?:[A-Z0-9_]*(?:TOKEN|PASSWORD|SECRET|AUTHORIZATION|COOKIE|API_KEY|PRIVATE_KEY)[A-Z0-9_]*)\s*[=:]\s*)([^\s'";&]+)/gi, '$1[REDACTED]')
    .replace(/([?&](?:token|password|secret|authorization|api[_-]?key)=)[^&#\s]+/gi, '$1[REDACTED]');
}

export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, child]) => [
      key,
      /(token|password|secret|authorization|cookie|key|signature|privateKey)$/i.test(key) ? '[REDACTED]' : redact(child)
    ]));
  }
  if (typeof value === 'string') return redactSensitiveText(value);
  return value;
}
