import * as z from 'zod/v4';

/** Public ceilings shared by the MCP schema, node executor and budget accounting. */
export const INSPECTION_LIMITS = {
  operations: 8, paths: 16, pathsPerSearch: 4, depth: 4, entries: 200,
  patterns: 4, patternChars: 128, matches: 100, contextLines: 2,
  fileBytes: 32768, readLines: 200, startLine: 10000,
  resultBytes: 16384, timeoutMs: 5000,
  visitedEntries: 1024, scannedFiles: 64, scannedBytes: 262144, lineChars: 1024
} as const;
const absolutePath = z.string().min(1).max(4096).refine(value => /^(\/|[A-Za-z]:[\\/])/.test(value), 'path must be absolute').describe('Absolute path inside the selected repository and node allowed roots.');
const fileBytes = z.number().int().min(1).max(INSPECTION_LIMITS.fileBytes).default(8192);
const operation = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('tree'), path: absolutePath, depth: z.number().int().min(1).max(4).default(2), maxEntries: z.number().int().min(1).max(200).default(100) }).strict(),
  z.object({ kind: z.literal('search'), paths: z.array(absolutePath).min(1).max(4), patterns: z.array(z.string().min(1).max(128).refine(value => !/[\r\n\0]/.test(value), 'pattern must be a single literal line')).min(1).max(4), maxMatches: z.number().int().min(1).max(100).default(50), contextLines: z.number().int().min(0).max(2).default(0), maxBytes: fileBytes }).strict(),
  z.object({ kind: z.literal('read'), path: absolutePath, startLine: z.number().int().min(1).max(10000).default(1), maxLines: z.number().int().min(1).max(200).default(100), maxBytes: fileBytes }).strict()
]);
export const REPO_INSPECTION_SCHEMA = z.object({
  operations: z.array(operation).min(1).max(8),
  maxResultBytes: z.number().int().min(256).max(16384).default(16384),
  timeoutMs: z.number().int().min(100).max(5000).default(5000)
}).strict().superRefine((value, context) => {
  const paths = value.operations.reduce((total, op) => total + (op.kind === 'search' ? op.paths.length : 1), 0);
  if (paths > INSPECTION_LIMITS.paths) context.addIssue({ code: 'custom', message: 'inspection exceeds 16 requested paths' });
});
export type RepoInspection = z.infer<typeof REPO_INSPECTION_SCHEMA>;
export function parseRepoInspection(value: unknown): RepoInspection {
  const parsed = REPO_INSPECTION_SCHEMA.safeParse(value);
  if (!parsed.success) throw new Error(`invalid inspection: ${parsed.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ').slice(0, 500)}`);
  return parsed.data;
}
/** Metadata plus each read/tree, and two search steps per path/pattern (start + retrieval). */
export function inspectionOperationCost(value: unknown): number {
  const request = parseRepoInspection(value);
  return 1 + request.operations.reduce((total, op) => total + (op.kind === 'search' ? 2 * op.paths.length * op.patterns.length : 1), 0);
}
