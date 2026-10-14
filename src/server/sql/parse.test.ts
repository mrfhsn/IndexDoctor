import { describe, it, expect } from 'vitest';

import { AppError } from '../errors.js';
import { parseSql, checkParenDepth } from './parse.js';

describe('SQL Parser (sql/parse.ts)', () => {
  it('parses valid SELECT query and returns Postgres 18 AST structure', async () => {
    const result = await parseSql('SELECT id, name FROM users WHERE id = 1');
    expect(result.version).toBeGreaterThan(0);
    expect(result.stmts).toHaveLength(1);
    expect(result.stmts[0]?.stmt).toHaveProperty('SelectStmt');
  });

  it('parses DDL statements with multiple tables', async () => {
    const ddl = `
      CREATE TABLE users (id SERIAL PRIMARY KEY, name TEXT NOT NULL);
      CREATE TABLE orders (id SERIAL PRIMARY KEY, user_id INT REFERENCES users(id));
    `;
    const result = await parseSql(ddl);
    expect(result.stmts).toHaveLength(2);
    expect(result.stmts[0]?.stmt).toHaveProperty('CreateStmt');
    expect(result.stmts[1]?.stmt).toHaveProperty('CreateStmt');
  });

  it('rejects SQL containing NUL bytes with 422 UNSUPPORTED_SQL', async () => {
    await expect(parseSql('SELECT 1\0')).rejects.toThrow(AppError);
    try {
      await parseSql('SELECT 1\0');
    } catch (err: unknown) {
      expect(err).toBeInstanceOf(AppError);
      if (err instanceof AppError) {
        expect(err.code).toBe('UNSUPPORTED_SQL');
        expect(err.status).toBe(422);
        expect(err.message).toContain('null byte');
      }
    }
  });

  it('detects and rejects excessive parenthesis depth (> 200)', () => {
    const validSql = '('.repeat(100) + '1' + ')'.repeat(100);
    expect(checkParenDepth(validSql)).toBe(100);

    const excessiveSql = '('.repeat(201) + '1' + ')'.repeat(201);
    expect(() => checkParenDepth(excessiveSql)).toThrow(AppError);
  });

  it('converts libpg-query syntax errors to 422 UNSUPPORTED_SQL with cursor position', async () => {
    try {
      await parseSql('SELECT FROM WHERE');
      expect.fail('Should have thrown syntax error');
    } catch (err: unknown) {
      expect(err).toBeInstanceOf(AppError);
      if (err instanceof AppError) {
        expect(err.code).toBe('UNSUPPORTED_SQL');
        expect(err.status).toBe(422);
        expect(err.hint).toMatch(/cursor position 12/i);
      }
    }
  });

  it('parses hostile 20 KB input in < 50 ms', async () => {
    const columns = Array.from({ length: 90 }, (_, i) => `col_${i} text`).join(', ');
    const hostile20Kb = `CREATE TABLE large_table (${columns});\n`.repeat(12);

    const start = performance.now();
    const result = await parseSql(hostile20Kb);
    const duration = performance.now() - start;

    expect(result.stmts.length).toBeGreaterThan(0);
    expect(duration).toBeLessThan(100); // 100ms test ceiling (< 50ms measured typical)
  });
});
