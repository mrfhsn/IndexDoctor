import { describe, it, expect } from 'vitest';

import { buildCatalog } from './catalog.js';
import { validateIndexSpec, type CandidateIndexSpec } from './index-spec.js';
import { parseSql } from './parse.js';

describe('Index Spec Validator (sql/index-spec.ts)', () => {
  const ddl = `
    CREATE TABLE users (
      id INT PRIMARY KEY,
      email TEXT NOT NULL,
      status VARCHAR(20) NOT NULL,
      age INT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL
    );
    CREATE INDEX idx_users_email ON users (email);
  `;

  async function getCatalogAndTables() {
    const { stmts } = await parseSql(ddl);
    const catalog = buildCatalog(stmts);
    const queryTables = new Set(['users']);
    return { catalog, queryTables };
  }

  it('approves a valid composite index spec', async () => {
    const { catalog, queryTables } = await getCatalogAndTables();
    const spec: CandidateIndexSpec = {
      table: 'users',
      columns: [{ name: 'status' }, { name: 'created_at', direction: 'desc' }],
      include: ['email'],
    };

    const res = await validateIndexSpec(spec, catalog, queryTables);
    expect(res.valid).toBe(true);
    if (res.valid) {
      expect(res.spec.table).toBe('users');
      expect(res.spec.columns).toHaveLength(2);
      expect(res.spec.include).toEqual(['email']);
    }
  });

  it('rejects specs for tables not in schema or not in query', async () => {
    const { catalog, queryTables } = await getCatalogAndTables();

    const notInSchema: CandidateIndexSpec = {
      table: 'orders',
      columns: [{ name: 'id' }],
    };
    const res1 = await validateIndexSpec(notInSchema, catalog, queryTables);
    expect(res1.valid).toBe(false);
    if (!res1.valid) {
      expect(res1.reason).toContain('does not exist in schema');
    }

    const notInQuery: CandidateIndexSpec = {
      table: 'users',
      columns: [{ name: 'id' }],
    };
    const res2 = await validateIndexSpec(notInQuery, catalog, new Set(['orders']));
    expect(res2.valid).toBe(false);
    if (!res2.valid) {
      expect(res2.reason).toContain('not referenced by the query');
    }
  });

  it('rejects duplicate key columns and non-existent columns', async () => {
    const { catalog, queryTables } = await getCatalogAndTables();

    const nonExistent: CandidateIndexSpec = {
      table: 'users',
      columns: [{ name: 'fake_col' }],
    };
    const res1 = await validateIndexSpec(nonExistent, catalog, queryTables);
    expect(res1.valid).toBe(false);
    if (!res1.valid) {
      expect(res1.reason).toContain('does not exist in table');
    }

    const duplicate: CandidateIndexSpec = {
      table: 'users',
      columns: [{ name: 'email' }, { name: 'email' }],
    };
    const res2 = await validateIndexSpec(duplicate, catalog, queryTables);
    expect(res2.valid).toBe(false);
    if (!res2.valid) {
      expect(res2.reason).toContain('Duplicate key column');
    }
  });

  it('enforces column limits (max 6 key, max 3 include)', async () => {
    const { catalog, queryTables } = await getCatalogAndTables();

    const tooManyKeys: CandidateIndexSpec = {
      table: 'users',
      columns: [
        { name: 'id' },
        { name: 'email' },
        { name: 'status' },
        { name: 'age' },
        { name: 'created_at' },
        { name: 'email' },
        { name: 'status' },
      ],
    };
    const res1 = await validateIndexSpec(tooManyKeys, catalog, queryTables);
    expect(res1.valid).toBe(false);
    if (!res1.valid) {
      expect(res1.reason).toContain('exceeds maximum key columns');
    }

    const tooManyInclude: CandidateIndexSpec = {
      table: 'users',
      columns: [{ name: 'id' }],
      include: ['email', 'status', 'age', 'created_at'],
    };
    const res2 = await validateIndexSpec(tooManyInclude, catalog, queryTables);
    expect(res2.valid).toBe(false);
    if (!res2.valid) {
      expect(res2.reason).toContain('exceeds maximum INCLUDE columns');
    }
  });

  it('rejects overlap between key columns and INCLUDE', async () => {
    const { catalog, queryTables } = await getCatalogAndTables();

    const overlap: CandidateIndexSpec = {
      table: 'users',
      columns: [{ name: 'email' }],
      include: ['email'],
    };
    const res = await validateIndexSpec(overlap, catalog, queryTables);
    expect(res.valid).toBe(false);
    if (!res.valid) {
      expect(res.reason).toContain('cannot be present in both key columns and INCLUDE');
    }
  });

  it('validates opclass restriction to text types', async () => {
    const { catalog, queryTables } = await getCatalogAndTables();

    const validTextOpclass: CandidateIndexSpec = {
      table: 'users',
      columns: [{ name: 'email', opclass: 'text_pattern_ops' }],
    };
    const res1 = await validateIndexSpec(validTextOpclass, catalog, queryTables);
    expect(res1.valid).toBe(true);

    const invalidIntOpclass: CandidateIndexSpec = {
      table: 'users',
      columns: [{ name: 'age', opclass: 'text_pattern_ops' }],
    };
    const res2 = await validateIndexSpec(invalidIntOpclass, catalog, queryTables);
    expect(res2.valid).toBe(false);
    if (!res2.valid) {
      expect(res2.reason).toContain('can only be applied to text columns');
    }
  });

  it('detects equivalence to existing index', async () => {
    const { catalog, queryTables } = await getCatalogAndTables();

    const equivalent: CandidateIndexSpec = {
      table: 'users',
      columns: [{ name: 'email', direction: 'asc' }],
    };
    const res = await validateIndexSpec(equivalent, catalog, queryTables);
    expect(res.valid).toBe(false);
    if (!res.valid) {
      expect(res.reason).toContain('equivalent to existing index "idx_users_email"');
    }
  });
});
