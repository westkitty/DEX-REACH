import fs from 'node:fs/promises';
import path from 'node:path';
import { realDirectory } from './recovery-reconciliation.js';

export const SYMLINK_POLICY_VERSION = 1;
export type LinkPolicy = { version: 1; rules: Array<{ prefix: string; boundary: string; role: 'runtime-dependency' | 'internal-alias'; requiredTarget: true }> };
export function defaultLinkPolicy(): LinkPolicy { return { version: 1, rules: [] }; }
/** Default narrow rule: each dependency link stays inside its own immutable release dependencies. */
export function policyForLink(relative: string, supplied: LinkPolicy): LinkPolicy['rules'][number] | undefined {
  if (supplied.version !== 1) throw new Error('LINK_POLICY_VERSION');
  const dependency = relative.match(/^(runtime\/releases\/[a-z0-9][a-z0-9._-]{0,119}\/node_modules)\//);
  if (dependency) return { prefix: `${dependency[1]}/`, boundary: dependency[1]!, role: 'runtime-dependency', requiredTarget: true };
  return supplied.rules.find(r => relative.startsWith(r.prefix));
}
const within = (root: string, value: string) => value === root || value.startsWith(root + path.sep);
export async function inspectLink(root: string, relative: string, supplied: LinkPolicy) {
  const rule = policyForLink(relative, supplied);
  if (!rule || !rule.requiredTarget || path.isAbsolute(rule.boundary) || rule.boundary.split('/').some(p => !p || p === '.' || p === '..') || !rule.prefix.startsWith(rule.boundary + '/')) throw new Error('UNAPPROVED_LINK');
  await realDirectory(root);
  const file = path.join(root, relative), boundary = path.join(root, rule.boundary), before = await fs.lstat(file);
  await realDirectory(boundary);
  const target = await fs.readlink(file);
  if (path.isAbsolute(target)) throw new Error('ABSOLUTE_LINK_REFUSED');
  if (!within(boundary, path.dirname(file))) throw new Error('LINK_ESCAPE');
  // Resolve physically, one component at a time, exactly as the kernel does: a symlinked component is
  // expanded before any following '..' applies. Lexical collapse would accept `a/../x` where `a` is a link.
  // `directory` only ever holds a verified real directory inside the boundary, so '..' is a true parent.
  const observed = new Map<string, { ino: number; ctimeMs: number; dev: number; mode: number }>();
  const seen = new Set([file]), split = (p: string) => p.split('/').filter(Boolean);
  const pending = [...split(path.relative(boundary, path.dirname(file))), ...split(target)];
  let directory = boundary, hops = 0, targetStat = await fs.lstat(boundary);
  while (pending.length) {
    const part = pending.shift()!;
    if (part === '.') continue;
    if (part === '..') { if (directory === boundary) throw new Error('LINK_ESCAPE'); directory = path.dirname(directory); targetStat = await fs.lstat(directory); continue; }
    const cursor = path.join(directory, part), st = await fs.lstat(cursor).catch(() => { throw new Error('LINK_DANGLING'); });
    observed.set(cursor, { ino: st.ino, ctimeMs: st.ctimeMs, dev: st.dev, mode: st.mode });
    if (st.dev !== before.dev) throw new Error('LINK_CROSS_VOLUME');
    if (st.isSymbolicLink()) {
      if (seen.has(cursor)) throw new Error('LINK_CYCLE');
      if (++hops > 64) throw new Error('LINK_DEPTH');
      seen.add(cursor);
      const hop = await fs.readlink(cursor); if (path.isAbsolute(hop)) throw new Error('ABSOLUTE_LINK_REFUSED');
      pending.unshift(...split(hop)); continue;
    }
    if (pending.length && !st.isDirectory()) throw new Error('LINK_TARGET_TYPE');
    directory = cursor; targetStat = st;
  }
  const current = directory, after = await fs.lstat(file);
  if ((!targetStat.isFile() && !targetStat.isDirectory()) || targetStat.dev !== before.dev) throw new Error('LINK_TARGET_TYPE_OR_VOLUME');
  // A directory link to itself or an ancestor makes every dereferencing traversal infinite.
  if (targetStat.isDirectory() && within(current, file)) throw new Error('LINK_CYCLE');
  if (!after.isSymbolicLink() || after.ino !== before.ino || after.ctimeMs !== before.ctimeMs || await fs.readlink(file) !== target) throw new Error('LINK_CHANGED');
  for (const [file, identity] of observed) {
    const now = await fs.lstat(file);
    if (now.ino !== identity.ino || now.ctimeMs !== identity.ctimeMs || now.dev !== identity.dev || now.mode !== identity.mode) throw new Error('LINK_HOP_CHANGED');
  }
  return { target, resolvedRelative: path.relative(root, current), targetType: targetStat.isDirectory() ? 'directory' as const : 'file' as const, role: rule.role, dereference: false as const, requiredTarget: true as const };
}
