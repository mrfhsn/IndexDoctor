import { describe, it, expect } from 'vitest';

import { buildCatalog } from './catalog.js';
import { parseSql } from './parse.js';

describe('SQL Catalog Extractor (sql/catalog.ts)', () => {
  it('extracts tables, columns, types, and column constraints', async () => {
    const ddl = `
      CREATE TABLE users (
        id SERIAL PRIMARY KEY,
        email VARCHAR(255) NOT NULL,
        age INT DEFAULT 18,
        active BOOLEAN
      );
    `;
    const { stmts } = await parseSql(ddl);
    const catalog = buildCatalog(stmts);

    expect(catalog.tables['users']).toBeDefined();
    const users = catalog.tables['users']!;
    expect(users.name).toBe('users');
    expect(users.columns).toHaveLength(4);

    const idCol = users.columns.find((c) => c.name === 'id')!;
    expect(idCol.type).toBe('serial');
    expect(idCol.isPrimaryKey).toBe(true);

    const emailCol = users.columns.find((c) => c.name === 'email')!;
    expect(emailCol.type).toBe('varchar');
    expect(emailCol.nullable).toBe(false);

    const ageCol = users.columns.find((c) => c.name === 'age')!;
    expect(ageCol.hasDefault).toBe(true);
    expect(ageCol.nullable).toBe(true);
  });

  it('extracts table-level primary key constraints', async () => {
    const ddl = `
      CREATE TABLE order_items (
        order_id INT NOT NULL,
        item_id INT NOT NULL,
        quantity INT NOT NULL,
        PRIMARY KEY (order_id, item_id)
      );
    `;
    const { stmts } = await parseSql(ddl);
    const catalog = buildCatalog(stmts);

    const table = catalog.tables['order_items']!;
    expect(table.primaryKey).toEqual(['order_id', 'item_id']);
  });

  it('extracts standalone CREATE INDEX definitions with ordering and include', async () => {
    const ddl = `
      CREATE TABLE orders (
        id SERIAL PRIMARY KEY,
        customer_id INT NOT NULL,
        status TEXT NOT NULL,
        total NUMERIC(10, 2) NOT NULL,
        created_at TIMESTAMPTZ NOT NULL
      );
      CREATE INDEX idx_orders_customer_created ON orders (customer_id ASC, created_at DESC) INCLUDE (total);
    `;
    const { stmts } = await parseSql(ddl);
    const catalog = buildCatalog(stmts);

    const orders = catalog.tables['orders']!;
    expect(orders.indexes).toHaveLength(1);
    const idx = orders.indexes[0]!;
    expect(idx.name).toBe('idx_orders_customer_created');
    expect(idx.columns).toEqual([
      { name: 'customer_id', direction: 'asc' },
      { name: 'created_at', direction: 'desc' },
    ]);
    expect(idx.include).toEqual(['total']);
  });

  it('extracts enum type names without storing enum labels (I9)', async () => {
    const ddl = `
      CREATE TYPE order_status AS ENUM ('placed', 'shipped', 'delivered');
      CREATE TABLE shipments (id SERIAL PRIMARY KEY, status order_status);
    `;
    const { stmts } = await parseSql(ddl);
    const catalog = buildCatalog(stmts);

    expect(catalog.enumTypes).toContain('order_status');
    const jsonStr = JSON.stringify(catalog);
    expect(jsonStr).not.toContain('placed');
    expect(jsonStr).not.toContain('shipped');
    expect(jsonStr).not.toContain('delivered');
  });

  it('extracts ALTER TABLE ADD CONSTRAINT for foreign keys and unique constraints', async () => {
    const ddl = `
      CREATE TABLE customers (id SERIAL PRIMARY KEY);
      CREATE TABLE accounts (id SERIAL PRIMARY KEY, customer_id INT, account_number TEXT);
      ALTER TABLE accounts ADD CONSTRAINT fk_accounts_customer FOREIGN KEY (customer_id) REFERENCES customers(id);
      ALTER TABLE accounts ADD CONSTRAINT uq_account_num UNIQUE (account_number);
    `;
    const { stmts } = await parseSql(ddl);
    const catalog = buildCatalog(stmts);

    const accounts = catalog.tables['accounts']!;
    expect(accounts.foreignKeys).toHaveLength(1);
    expect(accounts.foreignKeys[0]).toEqual({
      column: 'customer_id',
      foreignTable: 'customers',
      foreignColumn: 'id',
    });
    expect(accounts.uniqueConstraints).toEqual([['account_number']]);
  });
});
