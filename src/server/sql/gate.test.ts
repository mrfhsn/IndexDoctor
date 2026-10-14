import { describe, it, expect } from 'vitest';

import { AppError } from '../errors.js';
import { validateGate } from './gate.js';

describe('SQL Gate (sql/gate.ts)', () => {
  const sampleSchema = `
    CREATE TABLE users (
      id SERIAL PRIMARY KEY,
      email TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT now()
    );
    CREATE TABLE orders (
      id SERIAL PRIMARY KEY,
      user_id INT REFERENCES users(id),
      status TEXT NOT NULL,
      amount NUMERIC(10, 2)
    );
  `;
  const sampleQuery = 'SELECT id, email FROM users WHERE email = $1';

  it('accepts valid schema and query, returning GateResult', async () => {
    const result = await validateGate(sampleSchema, sampleQuery);
    expect(result.statements.length).toBeGreaterThanOrEqual(2);
    expect(result.catalog.tables['users']).toBeDefined();
    expect(result.catalog.tables['orders']).toBeDefined();
    expect(result.querySql).toBe(sampleQuery);
  });

  it('rejects COPY statements with 422 UNSUPPORTED_SQL', async () => {
    const hostileSchema = `
      CREATE TABLE test (id INT);
      COPY test FROM stdin;
    `;
    await expect(validateGate(hostileSchema, sampleQuery)).rejects.toThrow(AppError);
    try {
      await validateGate(hostileSchema, sampleQuery);
    } catch (err: unknown) {
      expect(err).toBeInstanceOf(AppError);
      if (err instanceof AppError) {
        expect(err.code).toBe('UNSUPPORTED_SQL');
        expect(err.status).toBe(422);
        expect(err.message).toMatch(/statement type CopyStmt is not permitted/i);
      }
    }
  });

  it('rejects DROP and data-modification statements in schema', async () => {
    const hostileDrop = 'CREATE TABLE test (id INT); DROP TABLE test;';
    await expect(validateGate(hostileDrop, sampleQuery)).rejects.toThrow(AppError);

    const hostileInsert = 'CREATE TABLE test (id INT); INSERT INTO test VALUES (1);';
    await expect(validateGate(hostileInsert, sampleQuery)).rejects.toThrow(AppError);
  });

  it('rejects non-SELECT query statements (UPDATE, DELETE, etc.)', async () => {
    await expect(validateGate(sampleSchema, 'DELETE FROM users WHERE id = 1')).rejects.toThrow(
      AppError,
    );
    await expect(
      validateGate(sampleSchema, 'INSERT INTO users (email) VALUES ($1)'),
    ).rejects.toThrow(AppError);
  });

  it('rejects locking clauses (FOR UPDATE, FOR SHARE)', async () => {
    const lockingQuery = 'SELECT * FROM users WHERE id = 1 FOR UPDATE';
    await expect(validateGate(sampleSchema, lockingQuery)).rejects.toThrow(AppError);
  });

  it('rejects deny-listed system functions (e.g. pg_sleep, dblink)', async () => {
    const sleepingQuery = 'SELECT pg_sleep(5), id FROM users';
    await expect(validateGate(sampleSchema, sleepingQuery)).rejects.toThrow(AppError);
  });

  it('rejects access to system catalogs (pg_class, information_schema)', async () => {
    const catalogQuery = 'SELECT relname FROM pg_class';
    await expect(validateGate(sampleSchema, catalogQuery)).rejects.toThrow(AppError);
  });

  it('rejects queries referencing unknown tables with list of unknown tables', async () => {
    const unknownQuery = 'SELECT * FROM nonexistent_table WHERE id = 1';
    try {
      await validateGate(sampleSchema, unknownQuery);
      expect.fail('Should have failed on unknown table');
    } catch (err: unknown) {
      expect(err).toBeInstanceOf(AppError);
      if (err instanceof AppError) {
        expect(err.code).toBe('UNSUPPORTED_SQL');
        expect(err.message).toContain('nonexistent_table');
      }
    }
  });

  it('ignores comments and pg_dump preamble with notices', async () => {
    const pgDumpSchema = `
      SET statement_timeout = 0;
      SET client_encoding = 'UTF8';
      CREATE TABLE articles (id SERIAL PRIMARY KEY, title TEXT);
      COMMENT ON TABLE articles IS 'User published articles';
    `;
    const query = 'SELECT * FROM articles WHERE id = 1';
    const result = await validateGate(pgDumpSchema, query);
    expect(result.catalog.tables['articles']).toBeDefined();
    expect(result.notices.length).toBeGreaterThan(0);
  });

  it('enforces identifier naming rule (I9)', async () => {
    const invalidIdSchema = 'CREATE TABLE "bad name with spaces" (id INT PRIMARY KEY);';
    await expect(
      validateGate(invalidIdSchema, 'SELECT * FROM "bad name with spaces"'),
    ).rejects.toThrow(AppError);
  });

  it('rejects multiple queries in query parameter', async () => {
    const multiQuery = 'SELECT 1; SELECT 2;';
    await expect(validateGate(sampleSchema, multiQuery)).rejects.toThrow(AppError);
  });
});
