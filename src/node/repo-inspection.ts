import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { canonicalPathForScope, pathAllowed } from '../shared/security.js';
import { INSPECTION_LIMITS as LIMITS, parseRepoInspection } from '../shared/repo-inspection.js';

const EXCLUDED_DIRS = new Set(['.git', 'node_modules', 'vendor', 'dist', 'build', 'coverage', '.next', '__pycache__', '.dex-reach']);
function excludedPart(name: string): boolean {
  return EXCLUDED_DIRS.has(name) || (name === '.env' || name.startsWith('.env.')) && name !== '.env.example'
    || /\.(pem|key|p12|pfx)$/i.test(name) || /^(credentials|secrets)(\.|$)/i.test(name);
}
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;

/** A bounded evidence query, not an atomic filesystem snapshot or an execution authority. */
export async function inspectRepository(
  nodeId: string, cwd: string, roots: string[], raw: unknown,
  info: (cwd: string, signal: AbortSignal) => Promise<Record<string, unknown>>,
  safeText: (text: string) => string
): Promise<Record<string, unknown>> {
  const request = parseRepoInspection(raw);
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const deadline = performance.now() + request.timeoutMs;
  const check = () => { if (performance.now() >= deadline || controller.signal.aborted) throw new Error('inspection execution timeout'); };
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(new Error('inspection execution timeout')); }, request.timeoutMs);
    timer.unref();
  });
  const execute = async () => {
    const metadata = await info(cwd, controller.signal); check();
    const resolvedRoot = canonicalPathForScope(String(metadata.root));
    if (!resolvedRoot || !pathAllowed(resolvedRoot, roots)) throw new Error('repository root outside allowed roots');
    const root: string = resolvedRoot;
    for (const key of ['branch', 'remote', 'status', 'log']) {
      if (typeof metadata[key] === 'string') metadata[key] = safeText(metadata[key] as string).replace(/(:\/\/)[^/\s@]+@/g, '$1[REDACTED]@');
    }
    let visitedEntries = 0; let scannedFiles = 0; let scannedBytes = 0;
    const relative = (file: string) => path.relative(root, file).split(path.sep).join('/');
    const scoped = (file: string): string => {
      check();
      const canonical = canonicalPathForScope(file);
      if (!canonical || !pathAllowed(canonical, roots) || !pathAllowed(canonical, [root])) throw new Error('inspection path outside repository scope or allowed roots/private-state boundary');
      if ([...path.relative(root, file).split(path.sep), ...path.relative(root, canonical).split(path.sep)].some(excludedPart)) throw new Error('inspection path is sensitive or excluded');
      return canonical;
    };
    const output: Record<string, any> = { ...metadata, inspection: { results: [], context: { node_id: nodeId, repositoryRoot: root, branch: metadata.branch, observedAt: new Date().toISOString(), advisory: true, selectionRequired: true, snapshotAtomic: false } } };
    const boundOutput = () => { if (Buffer.byteLength(JSON.stringify(output), 'utf8') > request.maxResultBytes) throw new Error('inspection aggregate result byte limit exceeded'); };
    boundOutput();
    async function entries(directory: string) {
      const dir = await fs.opendir(scoped(directory));
      const result = [];
      try {
        for await (const entry of dir) {
          check(); if (++visitedEntries > LIMITS.visitedEntries) throw new Error('inspection traversal entry limit exceeded');
          if (entry.isSymbolicLink() || excludedPart(entry.name)) continue;
          const file = path.join(directory, entry.name);
          // Inaccessible private-state children are omitted rather than traversed.
          if (!pathAllowed(file, roots) || !pathAllowed(file, [root])) continue;
          result.push(entry);
        }
      } finally { await dir.close().catch(() => undefined); }
      return result.sort((a, b) => compare(a.name, b.name));
    }
    async function* walk(directory: string, depth: number): AsyncGenerator<{ file: string; kind: 'file' | 'directory' }> {
      for (const entry of await entries(directory)) {
        check(); const file = path.join(directory, entry.name);
        if (entry.isFile()) yield { file, kind: 'file' };
        else if (entry.isDirectory()) {
          yield { file, kind: 'directory' };
          if (depth > 1) yield* walk(file, depth - 1);
        }
      }
    }
    async function textFile(file: string, maxBytes: number) {
      const canonical = scoped(file);
      if (++scannedFiles > LIMITS.scannedFiles) throw new Error('inspection scanned file limit exceeded');
      const initial = await fs.lstat(canonical); check();
      if (!initial.isFile()) throw new Error('inspection read requires a regular file');
      const handle = await fs.open(canonical, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        check(); const stat = await handle.stat();
        if (!stat.isFile()) throw new Error('inspection read requires a regular file');
        scoped(file); // Recheck scope after opening, before consuming data.
        const buffer = Buffer.alloc(Math.min(stat.size, maxBytes));
        if (scannedBytes + buffer.length > LIMITS.scannedBytes) throw new Error('inspection aggregate scanned byte limit exceeded');
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0); check();
        scannedBytes += bytesRead;
        if (scannedBytes > LIMITS.scannedBytes) throw new Error('inspection aggregate scanned byte limit exceeded');
        const truncated = stat.size > bytesRead;
        let text: string;
        try { text = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, bytesRead), { stream: truncated }); }
        catch { return { lines: [] as string[], bytesRead, truncated, binary: true }; }
        if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text)) return { lines: [] as string[], bytesRead, truncated, binary: true };
        const lines = text.split('\n');
        if (truncated || lines.at(-1) === '') lines.pop(); // Never report an incomplete trailing line as complete evidence.
        return { lines, bytesRead, truncated, binary: false };
      } finally { await handle.close(); }
    }
    const lineResult = (line: string, index: number) => {
      const sanitized = safeText(line);
      return { line: index + 1, text: sanitized.slice(0, LIMITS.lineChars), ...(sanitized.length > LIMITS.lineChars ? { textTruncated: true } : {}) };
    };
    for (const op of request.operations) {
      check();
      if (op.kind === 'tree') {
        const result = { kind: op.kind, path: relative(scoped(op.path)), entries: [] as Record<string, unknown>[], truncated: false };
        output.inspection.results.push(result);
        for await (const item of walk(scoped(op.path), op.depth)) {
          if (result.entries.length >= op.maxEntries) { result.truncated = true; break; }
          result.entries.push({ path: relative(item.file), kind: item.kind }); boundOutput();
        }
      } else if (op.kind === 'read') {
        const file = scoped(op.path); const value = await textFile(file, op.maxBytes);
        const lines = value.lines.slice(op.startLine - 1, op.startLine - 1 + op.maxLines).map((line, index) => lineResult(line, op.startLine - 1 + index));
        output.inspection.results.push({ kind: op.kind, path: relative(file), startLine: op.startLine, lines, bytesRead: value.bytesRead, binary: value.binary, truncated: value.truncated || value.lines.length > op.startLine - 1 + op.maxLines });
      } else {
        const result = { kind: op.kind, scopeDepth: LIMITS.depth, matches: [] as Record<string, unknown>[], truncated: false, binaryFilesSkipped: 0, prefixFiles: 0 };
        output.inspection.results.push(result);
        const files = new Set<string>();
        outer: for (const requested of op.paths) {
          const source = scoped(requested); const stat = await fs.stat(source); check();
          const candidates = stat.isDirectory() ? walk(source, LIMITS.depth) : (async function* () { yield { file: source, kind: 'file' as const }; })();
          for await (const candidate of candidates) {
            if (candidate.kind !== 'file') continue;
            const file = scoped(candidate.file);
            if (files.has(file)) continue; files.add(file);
            const value = await textFile(file, op.maxBytes);
            if (value.binary) { result.binaryFilesSkipped += 1; continue; }
            if (value.truncated) result.prefixFiles += 1;
            for (let index = 0; index < value.lines.length; index += 1) {
              check(); const line = value.lines[index]!;
              for (const [patternIndex, pattern] of op.patterns.entries()) {
                if (!line.includes(pattern)) continue;
                if (result.matches.length >= op.maxMatches) { result.truncated = true; break outer; }
                result.matches.push({ path: relative(file), ...lineResult(line, index), patternIndex,
                  context: value.lines.slice(Math.max(0, index - op.contextLines), index + op.contextLines + 1).map((text, offset) => lineResult(text, Math.max(0, index - op.contextLines) + offset)) });
                boundOutput();
              }
            }
          }
        }
      }
      boundOutput();
    }
    check(); boundOutput(); return output;
  };
  try { return await Promise.race([execute(), timeout]); }
  finally { if (timer) clearTimeout(timer); }
}
