import { PGlite } from '@electric-sql/pglite';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

import { evaluateJob, extractPlanSummary } from '../../src/server/sandbox/engine.js';
import type { EvaluatePayload } from '../../src/server/sandbox/protocol.js';

describe('Sandbox Engine (sandbox/engine.ts)', () => {
  let pg: PGlite;

  beforeAll(async () => {
    pg = await PGlite.create();
    await pg.waitReady;
  });

  afterAll(async () => {
    if (pg) {
      await pg.close();
    }
  });

  it('extractPlanSummary extracts node tree, costs, and index names', () => {
    const sampleExplain = [
      {
        Plan: {
          'Node Type': 'Index Scan',
          'Relation Name': 'orders',
          'Index Name': 'idx_orders_customer',
          'Startup Cost': 0.42,
          'Total Cost': 18.5,
          'Plan Rows': 10,
        },
      },
    ];

    const summary = extractPlanSummary(sampleExplain);
    expect(summary.primaryScan).toBe('Index Scan');
    expect(summary.startupCost).toBe(0.42);
    expect(summary.totalCost).toBe(18.5);
    expect(summary.usesIndexes).toEqual(['idx_orders_customer']);
    expect(summary.nodePath).toBe('Index Scan');
  });

  it('runs evaluateJob end-to-end with seeding, stats scaling, before/after diffs, and clean rollback', async () => {
    const payload: EvaluatePayload = {
      statements: [
        `CREATE TABLE test_orders (
          id SERIAL PRIMARY KEY,
          customer_id INT NOT NULL,
          status TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL
        );`,
      ],
      querySql: `SELECT id, customer_id FROM test_orders WHERE customer_id = 42 AND created_at >= NOW() - INTERVAL '7 days' ORDER BY created_at DESC;`,
      candidateIndexes: [
        {
          name: 'idx_test_orders_cust_created',
          ddl: 'CREATE INDEX idx_test_orders_cust_created ON test_orders (customer_id, created_at DESC);',
        },
      ],
      assumedRowCount: 500000,
      seededRows: 2000,
    };

    const result = await evaluateJob(pg, payload);

    // 1. Baseline before-plan (Seq Scan)
    expect(result.before.primaryScan).toBe('Seq Scan');
    expect(result.before.totalCost).toBeGreaterThan(100);

    // 2. Candidate evaluation
    expect(result.candidates).toHaveLength(1);
    const candidate = result.candidates[0]!;
    expect(candidate.name).toBe('idx_test_orders_cust_created');
    expect(candidate.indexUsed).toBe(true);
    expect(candidate.costAfter).toBeLessThan(result.before.totalCost);
    expect(candidate.costReductionPercent).toBeGreaterThan(50);
    expect(candidate.costRatio).toBeGreaterThan(1.5);

    // 3. Poison check verification (zero user tables remain)
    const checkRes = await pg.query<{ count: string }>(`
      SELECT count(*) as count FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relkind IN ('r', 'v', 'm', 'i');
    `);
    expect(parseInt(checkRes.rows[0]?.count || '0', 10)).toBe(0);
  });
});
