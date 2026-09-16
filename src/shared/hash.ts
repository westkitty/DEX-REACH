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

export function hashValue(value: unknown): string {
  return crypto.createHash('sha256').update(canonicalJson(value)).digest('hex');
}
