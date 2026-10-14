import { describe, expect, it } from 'vitest';

import { buildCatalog } from './catalog.js';
import { classifyEsrRoles, planEsrIndex } from './esr-planner.js';
import { parseSql } from './parse.js';

describe('sql/esr-planner', () => {
  const sampleSchema = `
    CREATE TABLE orders (
      id serial primary key,
      customer_id int not null,
      status varchar(20) not null,
      total numeric(10, 2) not null,
      created_at timestamp not null,
      deleted_at timestamp,
      notes text
    );
    CREATE TABLE users (
      id serial primary key,
      username varchar(50) not null,
      email text not null
    );
  `;

  async function getCatalogAndQueryAst(query: string, schemaSql = sampleSchema) {
    const schemaParsed = await parseSql(schemaSql);
    const catalog = buildCatalog(schemaParsed.stmts);
    const queryParsed = await parseSql(query);
    const queryAst = queryParsed.stmts[0];
    if (!queryAst) throw new Error('Query parsed to empty statements');
    return { catalog, queryAst };
  }

  it('plans index for pure equality filters', async () => {
    const query = "SELECT * FROM orders WHERE customer_id = 42 AND status = 'active';";
    const { catalog, queryAst } = await getCatalogAndQueryAst(query);

    const result = await planEsrIndex(queryAst, catalog);
    expect(result.spec).not.toBeNull();
    if (!result.spec) return;

    expect(result.spec.table).toBe('orders');
    const colNames = result.spec.columns.map((c) => c.name);
    expect(colNames).toContain('customer_id');
    expect(colNames).toContain('status');
    expect(result.spec.columns.length).toBe(2);
    expect(result.spec.include).toBeUndefined();
  });

  it('plans index for Equality + Sort', async () => {
    const query = 'SELECT * FROM orders WHERE customer_id = 42 ORDER BY created_at DESC;';
    const { catalog, queryAst } = await getCatalogAndQueryAst(query);

    const result = await planEsrIndex(queryAst, catalog);
    expect(result.spec).not.toBeNull();
    if (!result.spec) return;

    expect(result.spec.columns[0]?.name).toBe('customer_id');
    expect(result.spec.columns[1]?.name).toBe('created_at');
    expect(result.spec.columns[1]?.direction).toBe('desc');
  });

  it('plans index for Equality + Sort + Range', async () => {
    const query =
      'SELECT * FROM orders WHERE customer_id = 42 AND total > 100 ORDER BY created_at DESC;';
    const { catalog, queryAst } = await getCatalogAndQueryAst(query);

    const result = await planEsrIndex(queryAst, catalog);
    expect(result.spec).not.toBeNull();
    if (!result.spec) return;

    expect(result.spec.columns.map((c) => c.name)).toEqual(['customer_id', 'created_at', 'total']);
    expect(result.spec.columns[1]?.direction).toBe('desc');
  });

  it('places a column that is both Sort and Range once in the Sort position', async () => {
    const query = "SELECT * FROM orders WHERE created_at >= '2026-01-01' ORDER BY created_at DESC;";
    const { catalog, queryAst } = await getCatalogAndQueryAst(query);

    const result = await planEsrIndex(queryAst, catalog);
    expect(result.spec).not.toBeNull();
    if (!result.spec) return;

    expect(result.spec.columns.length).toBe(1);
    expect(result.spec.columns[0]?.name).toBe('created_at');
    expect(result.spec.columns[0]?.direction).toBe('desc');
  });

  it('adds 1 to 3 selected non-key columns to INCLUDE', async () => {
    const query = 'SELECT status, total FROM orders WHERE customer_id = 42;';
    const { catalog, queryAst } = await getCatalogAndQueryAst(query);

    const result = await planEsrIndex(queryAst, catalog);
    expect(result.spec).not.toBeNull();
    if (!result.spec) return;

    expect(result.spec.columns.map((c) => c.name)).toEqual(['customer_id']);
    expect(result.spec.include).toEqual(['status', 'total']);
    expect(result.ddl.create).toContain('INCLUDE ("status", "total")');
  });

  it('does not add INCLUDE for SELECT *', async () => {
    const query = 'SELECT * FROM orders WHERE customer_id = 42;';
    const { catalog, queryAst } = await getCatalogAndQueryAst(query);

    const result = await planEsrIndex(queryAst, catalog);
    expect(result.spec).not.toBeNull();
    if (!result.spec) return;

    expect(result.spec.include).toBeUndefined();
  });

  it('does not add INCLUDE when more than 3 non-key columns are selected', async () => {
    const query = 'SELECT id, status, total, notes FROM orders WHERE customer_id = 42;';
    const { catalog, queryAst } = await getCatalogAndQueryAst(query);

    const result = await planEsrIndex(queryAst, catalog);
    expect(result.spec).not.toBeNull();
    if (!result.spec) return;

    expect(result.spec.include).toBeUndefined();
  });

  it('bails out on queries with joins', async () => {
    const query = `
      SELECT o.id FROM orders o
      JOIN users u ON o.customer_id = u.id
      WHERE o.status = 'active';
    `;
    const { catalog, queryAst } = await getCatalogAndQueryAst(query);

    const result = await planEsrIndex(queryAst, catalog);
    expect(result.spec).toBeNull();
    if (result.spec === null) {
      expect(result.reason).toContain('join');
    }
  });

  it('bails out on top-level OR expressions', async () => {
    const query = "SELECT * FROM orders WHERE customer_id = 42 OR status = 'active';";
    const { catalog, queryAst } = await getCatalogAndQueryAst(query);

    const result = await planEsrIndex(queryAst, catalog);
    expect(result.spec).toBeNull();
    if (result.spec === null) {
      expect(result.reason).toContain('OR');
    }
  });

  it('bails out on expressions in WHERE clause', async () => {
    const query = "SELECT * FROM orders WHERE LOWER(status) = 'active';";
    const { catalog, queryAst } = await getCatalogAndQueryAst(query);

    const result = await planEsrIndex(queryAst, catalog);
    expect(result.spec).toBeNull();
    if (result.spec === null) {
      expect(result.reason).toContain('expression');
    }
  });

  it('detects equivalent existing index and returns null with reason', async () => {
    const schemaWithIndex = `
      CREATE TABLE orders (
        id serial primary key,
        customer_id int not null,
        created_at timestamp not null
      );
      CREATE INDEX idx_orders_customer_id ON orders (customer_id);
    `;
    const query = 'SELECT * FROM orders WHERE customer_id = 42;';
    const { catalog, queryAst } = await getCatalogAndQueryAst(query, schemaWithIndex);

    const result = await planEsrIndex(queryAst, catalog);
    expect(result.spec).toBeNull();
    if (result.spec === null) {
      expect(result.reason).toContain('equivalent');
    }
  });

  it('handles IN list and IS NULL as equality conditions', async () => {
    const query = "SELECT * FROM orders WHERE status IN ('a', 'b') AND deleted_at IS NULL;";
    const { catalog, queryAst } = await getCatalogAndQueryAst(query);

    const result = await planEsrIndex(queryAst, catalog);
    expect(result.spec).not.toBeNull();
    if (!result.spec) return;

    const names = result.spec.columns.map((c) => c.name);
    expect(names).toContain('status');
    expect(names).toContain('deleted_at');
  });

  it('applies varchar_pattern_ops on prefix LIKE queries on text types', async () => {
    const query = "SELECT * FROM users WHERE username LIKE 'john%';";
    const { catalog, queryAst } = await getCatalogAndQueryAst(query);

    const result = await planEsrIndex(queryAst, catalog);
    expect(result.spec).not.toBeNull();
    if (!result.spec) return;

    expect(result.spec.columns[0]?.name).toBe('username');
    expect(result.spec.columns[0]?.opclass).toBe('varchar_pattern_ops');
  });

  it('classifies ESR roles correctly for UI badges', async () => {
    const query = `
      SELECT status, total FROM orders
      WHERE customer_id = 42 AND total > 100
      ORDER BY created_at DESC;
    `;
    const { catalog, queryAst } = await getCatalogAndQueryAst(query);

    const result = await planEsrIndex(queryAst, catalog);
    expect(result.spec).not.toBeNull();
    if (!result.spec) return;

    const roles = classifyEsrRoles(result.spec, queryAst, catalog);
    const roleMap = new Map(roles.map((r) => [r.column, r.role]));

    expect(roleMap.get('customer_id')).toBe('Equality');
    expect(roleMap.get('created_at')).toBe('Sort');
    expect(roleMap.get('total')).toBe('Range');
    expect(roleMap.get('status')).toBe('Include');
  });
});
