import fs from 'node:fs/promises';
import path from 'node:path';
import { realDirectory } from './recovery-reconciliation.js';

export const SYMLINK_POLICY_VERSION = 1;
export type LinkRole = 'runtime-dependency' | 'internal-alias' | 'preserved-opaque';
export type LinkResolution = 'INTERNAL' | 'ESCAPES_BOUNDARY' | 'DANGLING' | 'CYCLE';
export type LinkPolicy = { version: 1; rules: Array<{ prefix: string; boundary: string; role: LinkRole; requiredTarget: boolean }> };
export function defaultLinkPolicy(): LinkPolicy { return { version: 1, rules: [] }; }
/**
 * Opaque preservation exists only for the desktop-commander isolated home, whose tool caches (pnpm store
 * project registries) hold links that may dangle or point outside it. Such links are kept as exact link
 * bytes and never dereferenced, so their targets need no coverage. Never part of the default policy:
 * applying it to live state is an owner decision.
 */
export const OPAQUE_LINK_BOUNDARIES: ReadonlySet<string> = new Set(['compat-home']);
export const COMPAT_HOME_PRESERVATION_RULE: LinkPolicy['rules'][number] = Object.freeze({ prefix: 'compat-home/', boundary: 'compat-home', role: 'preserved-opaque', requiredTarget: false });
/** Default narrow rule: each dependency link stays inside its own immutable release dependencies. */
export function policyForLink(relative: string, supplied: LinkPolicy): LinkPolicy['rules'][number] | undefined {
  if (supplied.version !== 1) throw new Error('LINK_POLICY_VERSION');
  const dependency = relative.match(/^(runtime\/releases\/[a-z0-9][a-z0-9._-]{0,119}\/node_modules)\//);
  if (dependency) return { prefix: `${dependency[1]}/`, boundary: dependency[1]!, role: 'runtime-dependency', requiredTarget: true };
  return supplied.rules.find(r => relative.startsWith(r.prefix));
}
const within = (root: string, value: string) => value === root || value.startsWith(root + path.sep);
function validRule(rule: LinkPolicy['rules'][number] | undefined): rule is LinkPolicy['rules'][number] {
  if (!rule || path.isAbsolute(rule.boundary) || rule.boundary.split('/').some(p => !p || p === '.' || p === '..') || !rule.prefix.startsWith(rule.boundary + '/')) return false;
  return rule.role === 'preserved-opaque' ? rule.requiredTarget === false && OPAQUE_LINK_BOUNDARIES.has(rule.boundary) : rule.requiredTarget === true && !OPAQUE_LINK_BOUNDARIES.has(rule.boundary);
}
type Identity = { ino: number; ctimeMs: number; dev: number; mode: number };
/**
 * Resolve physically, one component at a time, exactly as the kernel does: a symlinked component is
 * expanded before any following '..' applies. Lexical collapse would accept `a/../x` where `a` is a link.
 * `directory` only ever holds a verified real directory inside the boundary, so '..' is a true parent, and
 * nothing outside the boundary is ever examined.
 */
async function walk(boundary: string, file: string, target: string, device: number) {
  const observed = new Map<string, Identity>();
  const seen = new Set([file]), split = (p: string) => p.split('/').filter(Boolean);
  const pending = [...split(path.relative(boundary, path.dirname(file))), ...split(target)];
  let directory = boundary, hops = 0, targetStat = await fs.lstat(boundary);
  while (pending.length) {
    const part = pending.shift()!;
    if (part === '.') continue;
    if (part === '..') { if (directory === boundary) throw new Error('LINK_ESCAPE'); directory = path.dirname(directory); targetStat = await fs.lstat(directory); continue; }
    const cursor = path.join(directory, part), st = await fs.lstat(cursor).catch(() => { throw new Error('LINK_DANGLING'); });
    observed.set(cursor, { ino: st.ino, ctimeMs: st.ctimeMs, dev: st.dev, mode: st.mode });
    if (st.dev !== device) throw new Error('LINK_CROSS_VOLUME');
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
  return { directory, targetStat, observed };
}
async function unchanged(file: string, before: { ino: number; ctimeMs: number }, target: string, observed: Map<string, Identity>) {
  const after = await fs.lstat(file);
  if (!after.isSymbolicLink() || after.ino !== before.ino || after.ctimeMs !== before.ctimeMs || await fs.readlink(file) !== target) throw new Error('LINK_CHANGED');
  for (const [hop, identity] of observed) {
    const now = await fs.lstat(hop);
    if (now.ino !== identity.ino || now.ctimeMs !== identity.ctimeMs || now.dev !== identity.dev || now.mode !== identity.mode) throw new Error('LINK_HOP_CHANGED');
  }
}
/** Where a link would resolve, judged only inside `boundary` (root-relative; '' is the root). Never follows it out. */
async function classify(boundary: string, file: string, target: string, device: number): Promise<{ resolution: LinkResolution; observed: Map<string, Identity> }> {
  try { const { directory, targetStat, observed } = await walk(boundary, file, target, device); return { resolution: targetStat.isDirectory() && within(directory, file) ? 'CYCLE' : 'INTERNAL', observed }; }
  catch (error) {
    const code = (error as Error).message;
    if (code === 'LINK_ESCAPE') return { resolution: 'ESCAPES_BOUNDARY', observed: new Map() };
    // A missing component or a file used as a directory both fail in the kernel with no target.
    if (code === 'LINK_DANGLING' || code === 'LINK_TARGET_TYPE') return { resolution: 'DANGLING', observed: new Map() };
    if (code === 'LINK_CYCLE' || code === 'LINK_DEPTH') return { resolution: 'CYCLE', observed: new Map() };
    throw error;
  }
}
/** Classification for an unapproved link, used only to report why it was refused. */
export async function classifyLink(root: string, relative: string, boundaryRelative: string): Promise<LinkResolution> {
  const file = path.join(root, relative), boundary = path.join(root, boundaryRelative), before = await fs.lstat(file);
  if (!before.isSymbolicLink()) throw new Error('NOT_A_LINK');
  if (!within(boundary, path.dirname(file))) throw new Error('LINK_ESCAPE');
  const target = await fs.readlink(file);
  if (path.isAbsolute(target)) throw new Error('ABSOLUTE_LINK_REFUSED');
  return (await classify(boundary, file, target, before.dev)).resolution;
}
export async function inspectLink(root: string, relative: string, supplied: LinkPolicy) {
  const rule = policyForLink(relative, supplied);
  if (!validRule(rule)) throw new Error('UNAPPROVED_LINK');
  await realDirectory(root);
  const file = path.join(root, relative), boundary = path.join(root, rule.boundary), before = await fs.lstat(file);
  await realDirectory(boundary);
  const target = await fs.readlink(file);
  if (path.isAbsolute(target)) throw new Error('ABSOLUTE_LINK_REFUSED');
  if (!within(boundary, path.dirname(file))) throw new Error('LINK_ESCAPE');
  if (rule.role === 'preserved-opaque') {
    const { resolution, observed } = await classify(boundary, file, target, before.dev);
    await unchanged(file, before, target, observed);
    return { target, resolvedRelative: null, targetType: 'unresolved' as const, role: rule.role, dereference: false as const, requiredTarget: false as const, resolution };
  }
  const { directory: current, targetStat, observed } = await walk(boundary, file, target, before.dev);
  if ((!targetStat.isFile() && !targetStat.isDirectory()) || targetStat.dev !== before.dev) throw new Error('LINK_TARGET_TYPE_OR_VOLUME');
  // A directory link to itself or an ancestor makes every dereferencing traversal infinite.
  if (targetStat.isDirectory() && within(current, file)) throw new Error('LINK_CYCLE');
  await unchanged(file, before, target, observed);
  return { target, resolvedRelative: path.relative(root, current), targetType: targetStat.isDirectory() ? 'directory' as const : 'file' as const, role: rule.role, dereference: false as const, requiredTarget: true as const, resolution: 'INTERNAL' as LinkResolution };
}
