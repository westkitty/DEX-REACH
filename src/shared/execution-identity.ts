import type { ExecutionFingerprint } from './protocol.js';
import { hashValue } from './hash.js';

export const EXECUTION_IDENTITY_FIELDS = [
  'nodeId',
  'hostname',
  'platform',
  'arch',
  'user',
  'home',
  'cwd',
  'repositoryRoot',
  'branch',
  'remote',
  'nodeVersion'
] as const;

type ExecutionIdentityField = typeof EXECUTION_IDENTITY_FIELDS[number];
export type ExecutionIdentityExpectation = Partial<Pick<ExecutionFingerprint, ExecutionIdentityField>>;

export type ExecutionIdentityMismatch = {
  field: ExecutionIdentityField;
  expected: string | null;
  actual: string | null;
};

function comparableFingerprint(fingerprint: ExecutionFingerprint): Record<ExecutionIdentityField, string | null> {
  return Object.fromEntries(EXECUTION_IDENTITY_FIELDS.map(field => [field, fingerprint[field]])) as Record<ExecutionIdentityField, string | null>;
}

export function executionIdentityHash(fingerprint: ExecutionFingerprint): string {
  return hashValue(comparableFingerprint(fingerprint));
}

export function parseExecutionIdentityExpectation(value: unknown): ExecutionIdentityExpectation | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('expected_identity must be an object');
  const input = value as Record<string, unknown>;
  const allowed = new Set<string>(EXECUTION_IDENTITY_FIELDS);
  for (const key of Object.keys(input)) if (!allowed.has(key)) throw new Error(`expected_identity contains unsupported field: ${key}`);
  const expectation: Record<string, string | null> = {};
  for (const field of EXECUTION_IDENTITY_FIELDS) {
    if (!(field in input)) continue;
    const candidate = input[field];
    if (candidate !== null && typeof candidate !== 'string') throw new Error(`expected_identity.${field} must be a string or null`);
    expectation[field] = candidate as string | null;
  }
  if (!Object.keys(expectation).length) throw new Error('expected_identity must contain at least one identity field');
  return expectation as ExecutionIdentityExpectation;
}

export function compareExecutionIdentity(expected: ExecutionIdentityExpectation, actual: ExecutionFingerprint): ExecutionIdentityMismatch[] {
  const mismatches: ExecutionIdentityMismatch[] = [];
  for (const field of EXECUTION_IDENTITY_FIELDS) {
    if (!(field in expected)) continue;
    const expectedValue = expected[field] ?? null;
    const actualValue = actual[field] ?? null;
    if (expectedValue !== actualValue) mismatches.push({ field, expected: expectedValue, actual: actualValue });
  }
  return mismatches;
}

export function assertExecutionIdentityExpectation(expected: ExecutionIdentityExpectation | undefined, actual: ExecutionFingerprint): void {
  if (!expected) return;
  const mismatches = compareExecutionIdentity(expected, actual);
  if (!mismatches.length) return;
  const summary = mismatches.map(item => `${item.field}: expected ${JSON.stringify(item.expected)}, got ${JSON.stringify(item.actual)}`).join('; ');
  throw new Error(`execution identity preflight failed: ${summary}`);
}

export function assertExecutionIdentityStable(planned: ExecutionFingerprint, current: ExecutionFingerprint): void {
  const plannedHash = executionIdentityHash(planned);
  const currentHash = executionIdentityHash(current);
  if (plannedHash === currentHash) return;
  const mismatches = EXECUTION_IDENTITY_FIELDS.filter(field => (planned[field] ?? null) !== (current[field] ?? null));
  const summary = mismatches.join(', ') || 'fingerprint hash';
  throw new Error(`execution identity changed after planning (${summary}); create a new plan`);
}
