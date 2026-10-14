import crypto from 'node:crypto';

/**
 * Deterministically generates a SHA-256 hexadecimal hash from input schema and query SQL.
 * Used for cache keys, single-flight coalescing keys, and sanitized log correlation.
 */
export function hashInput(schema: string, query: string): string {
  return crypto
    .createHash('sha256')
    .update(schema.trim())
    .update('\0')
    .update(query.trim())
    .digest('hex');
}
