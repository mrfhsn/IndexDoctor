import { describe, expect, it } from 'vitest';

import type { CandidateIndexSpec } from '../sql/index-spec.js';
import { generateDrizzleMigration } from './drizzle.js';
import { generatePostgresMigration } from './postgres.js';
import { generatePrismaMigration } from './prisma.js';

describe('migrations/{postgres, drizzle, prisma}', () => {
  it('generates standard composite index across all targets', () => {
    const spec: CandidateIndexSpec = {
      table: 'orders',
      columns: [{ name: 'customer_id' }, { name: 'created_at', direction: 'desc' }],
    };

    // 1. PostgreSQL
    const pg = generatePostgresMigration(spec);
    expect(pg.sql).toContain('CREATE INDEX CONCURRENTLY IF NOT EXISTS');
    expect(pg.sql).toContain('"idx_orders_customer_id_created_at"');
    expect(pg.sql).toContain('("customer_id", "created_at" DESC)');
    expect(pg.notes[0]).toContain(
      'CREATE INDEX CONCURRENTLY cannot execute inside a transaction block',
    );

    // 2. Drizzle
    const drizzle = generateDrizzleMigration(spec);
    expect(drizzle.snippet).toContain("index('idx_orders_customer_id_created_at')");
    expect(drizzle.snippet).toContain('table.customerId, table.createdAt.desc()');

    // 3. Prisma
    const prisma = generatePrismaMigration(spec);
    expect(prisma.snippet).toContain(
      '@@index([customerId, createdAt(sort: Desc)], name: "idx_orders_customer_id_created_at")',
    );
  });

  it('adds migration notes for INCLUDE covering index', () => {
    const spec: CandidateIndexSpec = {
      table: 'events',
      columns: [{ name: 'tenant_id' }],
      include: ['payload', 'metadata'],
    };

    const pg = generatePostgresMigration(spec);
    expect(pg.sql).toContain('INCLUDE ("payload", "metadata")');
    expect(pg.notes.some((n) => n.includes('Covering index'))).toBe(true);

    const drizzle = generateDrizzleMigration(spec);
    expect(drizzle.notes.some((n) => n.includes('does not support the INCLUDE clause'))).toBe(true);

    const prisma = generatePrismaMigration(spec);
    expect(prisma.notes.some((n) => n.includes('does not support covering INCLUDE indexes'))).toBe(
      true,
    );
  });

  it('adds migration notes for partial WHERE clause and opclasses', () => {
    const spec: CandidateIndexSpec = {
      table: 'users',
      columns: [{ name: 'username', opclass: 'varchar_pattern_ops' }],
      where: 'status = 1',
    };

    const pg = generatePostgresMigration(spec);
    expect(pg.sql).toContain('WHERE (status = 1)');
    expect(pg.notes.some((n) => n.includes('Partial index'))).toBe(true);

    const drizzle = generateDrizzleMigration(spec);
    expect(drizzle.notes.some((n) => n.includes('does not support partial WHERE'))).toBe(true);

    const prisma = generatePrismaMigration(spec);
    expect(prisma.notes.some((n) => n.includes('does not support partial indexes'))).toBe(true);
    expect(prisma.notes.some((n) => n.includes('specialized operator classes'))).toBe(true);
  });
});
