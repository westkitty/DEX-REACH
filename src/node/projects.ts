import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const DEFAULT_SKIP = new Set([
  '.git',
  '.Trash',
  'Library',
  'node_modules',
  'vendor',
  'dist',
  'build',
  '.cache',
  '.npm',
  '.pnpm-store'
]);

export type ProjectSummary = {
  name: string;
  path: string;
  branch: string;
  remote: string | null;
  dirty: boolean;
  changes: number;
  upstream: string | null;
  ahead: number | null;
  behind: number | null;
};

function safeEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(source).filter(([key, value]) =>
      value !== undefined && !/(TOKEN|PASSWORD|PASSWD|SECRET|AUTHORIZATION|COOKIE|API[_-]?KEY|PRIVATE[_-]?KEY|CREDENTIAL)/i.test(key)
    )
  );
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    timeout: 10_000,
    maxBuffer: 1024 * 1024,
    env: safeEnv()
  });
  return stdout.trim();
}

async function isGitRoot(dir: string): Promise<boolean> {
  try {
    const stat = await fs.stat(path.join(dir, '.git'));
    return stat.isDirectory() || stat.isFile();
  } catch {
    return false;
  }
}

export async function discoverGitProjects(
  roots: string[],
  options: { maxDepth?: number; maxProjects?: number } = {}
): Promise<string[]> {
  const maxDepth = Math.max(0, Math.min(options.maxDepth ?? 3, 8));
  const maxProjects = Math.max(1, Math.min(options.maxProjects ?? 500, 5000));
  const found = new Set<string>();
  const seen = new Set<string>();
  const queue: Array<{ dir: string; depth: number }> = roots.map(dir => ({ dir, depth: 0 }));

  while (queue.length && found.size < maxProjects) {
    const batch = queue.splice(0, 32);
    const results = await Promise.all(batch.map(async ({ dir, depth }) => {
      let canonical: string;
      try {
        canonical = await fs.realpath(dir);
      } catch {
        return null;
      }
      if (seen.has(canonical)) return null;
      seen.add(canonical);

      if (await isGitRoot(canonical)) {
        return { project: canonical, children: [] as Array<{ dir: string; depth: number }> };
      }
      if (depth >= maxDepth) return { project: null, children: [] as Array<{ dir: string; depth: number }> };

      let entries;
      try {
        entries = await fs.readdir(canonical, { withFileTypes: true });
      } catch {
        return null;
      }
      const children = entries
        .filter(entry =>
          entry.isDirectory() &&
          !entry.isSymbolicLink() &&
          !entry.name.startsWith('.') &&
          !DEFAULT_SKIP.has(entry.name)
        )
        .map(entry => ({ dir: path.join(canonical, entry.name), depth: depth + 1 }));
      return { project: null, children };
    }));

    for (const result of results) {
      if (!result) continue;
      if (result.project) {
        found.add(result.project);
        if (found.size >= maxProjects) break;
      } else {
        queue.push(...result.children);
      }
    }
  }

  return [...found].sort((a, b) => a.localeCompare(b));
}

function parseAheadBehind(raw: string): { ahead: number | null; behind: number | null } {
  const values = raw.trim().split(/\s+/).map(Number);
  const left = values[0];
  const right = values[1];
  return {
    ahead: typeof left === 'number' && Number.isFinite(left) ? left : null,
    behind: typeof right === 'number' && Number.isFinite(right) ? right : null
  };
}

export async function summarizeProject(projectPath: string): Promise<ProjectSummary> {
  const canonical = await fs.realpath(projectPath);
  const [branch, remote, porcelain, upstream] = await Promise.all([
    git(canonical, ['branch', '--show-current']).catch(() => ''),
    git(canonical, ['remote', 'get-url', 'origin']).catch(() => ''),
    git(canonical, ['status', '--porcelain']).catch(() => ''),
    git(canonical, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']).catch(() => '')
  ]);

  let ahead: number | null = null;
  let behind: number | null = null;
  if (upstream) {
    const counts = await git(canonical, ['rev-list', '--left-right', '--count', 'HEAD...@{upstream}']).catch(() => '');
    if (counts) ({ ahead, behind } = parseAheadBehind(counts));
  }

  const changes = porcelain ? porcelain.split('\n').filter(Boolean).length : 0;
  return {
    name: path.basename(canonical),
    path: canonical,
    branch: branch || '(detached)',
    remote: remote || null,
    dirty: changes > 0,
    changes,
    upstream: upstream || null,
    ahead,
    behind
  };
}

export async function portfolio(
  roots: string[],
  options: { maxDepth?: number; maxProjects?: number } = {}
): Promise<ProjectSummary[]> {
  const projects = await discoverGitProjects(roots, options);
  const summaries: ProjectSummary[] = [];
  for (let index = 0; index < projects.length; index += 16) {
    const batch = projects.slice(index, index + 16);
    summaries.push(...await Promise.all(batch.map(projectPath => summarizeProject(projectPath))));
  }
  return summaries.sort((a, b) => a.path.localeCompare(b.path));
}

export function resolveProject(query: string, projects: ProjectSummary[]): ProjectSummary {
  const needle = query.trim().toLowerCase();
  if (!needle) throw new Error('project query must not be empty');

  const exact = projects.filter(project =>
    project.path.toLowerCase() === needle ||
    project.name.toLowerCase() === needle ||
    project.remote?.toLowerCase() === needle
  );
  if (exact.length === 1) return exact[0]!;
  if (exact.length > 1) {
    throw new Error(`ambiguous project "${query}": ${exact.map(project => project.path).join(', ')}`);
  }

  const partial = projects.filter(project =>
    project.name.toLowerCase().includes(needle) ||
    project.path.toLowerCase().includes(needle) ||
    project.remote?.toLowerCase().includes(needle)
  );
  if (partial.length === 1) return partial[0]!;
  if (partial.length === 0) throw new Error(`project not found: ${query}`);
  throw new Error(`ambiguous project "${query}": ${partial.map(project => project.path).join(', ')}`);
}

export function defaultProjectRoots(): string[] {
  return [os.homedir()];
}
