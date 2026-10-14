import { describe, it, expect } from 'vitest';

import { stripAndMaskQuery } from './strip-and-mask.js';

describe('Query Comment Stripping and Literal Masking (sql/strip-and-mask.ts)', () => {
  it('strips single-line and multi-line comments', () => {
    const query = `
      -- Top level comment
      SELECT id, name
      /* Multi
         line
         comment */
      FROM users
      WHERE active = true; -- trailing comment
    `;
    const result = stripAndMaskQuery(query);
    expect(result.maskedSql).not.toContain('Top level comment');
    expect(result.maskedSql).not.toContain('Multi');
    expect(result.maskedSql).not.toContain('trailing comment');
    expect(result.maskedSql).toContain('SELECT id, name');
    expect(result.maskedSql).toContain('FROM users');
  });

  it('masks string literals with positional placeholders ($1, $2, ...)', () => {
    const query =
      "SELECT * FROM orders WHERE status = 'pending' AND customer_email = 'alice@example.com'";
    const result = stripAndMaskQuery(query);
    expect(result.maskedSql).not.toContain('pending');
    expect(result.maskedSql).not.toContain('alice@example.com');
    expect(result.maskedSql).toContain('status = $1');
    expect(result.maskedSql).toContain('customer_email = $2');
    expect(result.literalCount).toBe(2);
  });

  it('handles escaped quotes inside string literals', () => {
    const query = "SELECT * FROM items WHERE description = 'O''Reilly Media';";
    const result = stripAndMaskQuery(query);
    expect(result.maskedSql).not.toContain("O''Reilly Media");
    expect(result.maskedSql).toContain('description = $1');
  });

  it('preserves query structure without leaking user string inputs (I9)', () => {
    const query =
      "SELECT u.id FROM users u WHERE u.bio LIKE '%developer%' ORDER BY u.created_at DESC;";
    const result = stripAndMaskQuery(query);
    expect(result.maskedSql).not.toContain('%developer%');
    expect(result.maskedSql).toContain('u.bio LIKE $1');
    expect(result.maskedSql).toContain('ORDER BY u.created_at DESC');
  });
});
