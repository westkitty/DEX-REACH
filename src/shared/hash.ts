import crypto from 'node:crypto';

export function canonicalJson(value: unknown): string {
  const normalize = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(normalize);
    if (input && typeof input === 'object') {
      return Object.fromEntries(
        Object.entries(input as Record<string, unknown>)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, child]) => [key, normalize(child)])
      );
    }
    return input;
  };
  return JSON.stringify(normalize(value));
}

/**
 * SHA-256 digest of the canonical JSON form. This is a content/integrity digest of structured records
 * (policy snapshots, manifests, receipts, inventories). It is never used to store or verify a password.
 */
export function hashValue(value: unknown): string {
  return crypto.hash('sha256', canonicalJson(value), 'hex');
}
