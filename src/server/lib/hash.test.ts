import { describe, it, expect } from 'vitest';

import { hashInput } from './hash.js';

describe('hashInput', () => {
  it('returns deterministic 64-char hex string', () => {
    const hash1 = hashInput('CREATE TABLE t (id int);', 'SELECT * FROM t;');
    const hash2 = hashInput('CREATE TABLE t (id int);', 'SELECT * FROM t;');
    expect(hash1).toHaveLength(64);
    expect(hash1).toBe(hash2);
  });

  it('differentiates changes in schema or query', () => {
    const base = hashInput('CREATE TABLE t (id int);', 'SELECT * FROM t;');
    const diffSchema = hashInput('CREATE TABLE t (id int, x int);', 'SELECT * FROM t;');
    const diffQuery = hashInput('CREATE TABLE t (id int);', 'SELECT id FROM t;');
    expect(base).not.toBe(diffSchema);
    expect(base).not.toBe(diffQuery);
  });

  it('normalizes whitespace around inputs', () => {
    const trimmed = hashInput('CREATE TABLE t (id int);', 'SELECT * FROM t;');
    const untrimmed = hashInput('  CREATE TABLE t (id int); \n', '\tSELECT * FROM t;  ');
    expect(trimmed).toBe(untrimmed);
  });
});
