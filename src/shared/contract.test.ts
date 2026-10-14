import { describe, it, expect } from 'vitest';

import {
  diagnoseRequestSchema,
  diagnoseResponseSchema,
  errorEnvelopeSchema,
  healthResponseSchema,
  deriveSeverity,
  type DiagnoseRequest,
  type DiagnoseResponse,
} from './contract.js';

describe('Shared Contract Schemas', () => {
  it('validates a valid DiagnoseRequest', () => {
    const valid: DiagnoseRequest = {
      schema: 'CREATE TABLE users (id int);',
      query: 'SELECT * FROM users;',
      presetId: 'orders-composite',
    };

    const parsed = diagnoseRequestSchema.parse(valid);
    expect(parsed.schema).toBe(valid.schema);
    expect(parsed.query).toBe(valid.query);
    expect(parsed.presetId).toBe(valid.presetId);
  });

  it('rejects unknown properties in DiagnoseRequest (strict)', () => {
    const invalid = {
      schema: 'CREATE TABLE users (id int);',
      query: 'SELECT * FROM users;',
      extraField: 'not allowed',
    };

    expect(() => diagnoseRequestSchema.parse(invalid)).toThrow();
  });

  it('validates standard ErrorEnvelope', () => {
    const envelope = {
      error: {
        code: 'UNSUPPORTED_SQL',
        message: 'Invalid AST node',
        hint: 'Use simple SELECT statement',
      },
      requestId: 'req-123',
    };

    const parsed = errorEnvelopeSchema.parse(envelope);
    expect(parsed.error.code).toBe('UNSUPPORTED_SQL');
    expect(parsed.requestId).toBe('req-123');
  });

  it('validates standard HealthResponse', () => {
    const health = {
      ready: true,
      version: '0.1.0',
      uptimeSec: 42,
      sandbox: {
        state: 'ready',
        respawns: 0,
        jobsSinceSpawn: 10,
      },
      llm: {
        configured: true,
        models: [{ id: 'gemini-3.1-flash-lite', breaker: 'closed' }],
      },
    };

    const parsed = healthResponseSchema.parse(health);
    expect(parsed.ready).toBe(true);
    expect(parsed.version).toBe('0.1.0');
  });

  it('validates complete verified DiagnoseResponse', () => {
    const res: DiagnoseResponse = {
      requestId: 'req-abc-123',
      cached: false,
      outcome: 'improved',
      verification: {
        status: 'verified',
        indexUsed: true,
        costBefore: 1000,
        costAfter: 10,
        costReductionPercent: 99,
        costRatio: 100,
        severity: 'CRITICAL',
      },
      recommendation: {
        index: {
          table: 'orders',
          name: 'idx_orders_customer_created',
          columns: [
            { name: 'customer_id', direction: 'ASC' },
            { name: 'created_at', direction: 'DESC' },
          ],
          include: ['total'],
          where: null,
        },
        sql: {
          create:
            'CREATE INDEX "idx_orders_customer_created" ON "orders" ("customer_id" ASC, "created_at" DESC) INCLUDE ("total");',
          createConcurrently:
            'CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_orders_customer_created" ON "orders" ("customer_id" ASC, "created_at" DESC) INCLUDE ("total");',
        },
        headline: 'Optimize order lookups by customer',
        explanation: 'Index directly satisfies equality on customer_id and sort order.',
        antiPatterns: [],
        esr: [
          { column: 'customer_id', role: 'Equality', reason: 'Equality filter' },
          { column: 'created_at', role: 'Sort', reason: 'Order by clause' },
        ],
        migrations: {
          postgres: 'CREATE INDEX CONCURRENTLY IF NOT EXISTS ...;',
          drizzle: 'index(...);',
        },
        migrationNotes: [],
      },
      plans: {
        before: {
          nodePath: 'Seq Scan',
          primaryScan: 'Seq Scan',
          startupCost: 0,
          totalCost: 1000,
          planRows: 1000,
          usesIndexes: [],
          tree: {
            type: 'Seq Scan',
            relation: 'orders',
            startupCost: 0,
            totalCost: 1000,
            planRows: 1000,
            children: [],
          },
        },
        after: {
          nodePath: 'Index Scan',
          primaryScan: 'Index Scan',
          startupCost: 0.28,
          totalCost: 10,
          planRows: 1,
          usesIndexes: ['idx_orders_customer_created'],
          tree: {
            type: 'Index Scan',
            relation: 'orders',
            indexName: 'idx_orders_customer_created',
            startupCost: 0.28,
            totalCost: 10,
            planRows: 1,
            children: [],
          },
        },
      },
      source: {
        proposedBy: 'llm',
        model: 'gemini-3.1-flash-lite',
        attempts: [{ model: 'gemini-3.1-flash-lite', outcome: 'ok', ms: 1200 }],
      },
      alternative: null,
      assumptions: {
        assumedRowCount: 500000,
        seededRows: 20000,
        plannerSettings: 'postgres-defaults',
        tablesScaledEqually: true,
      },
      notices: [],
      timingsMs: {
        gate: 2,
        propose: 1200,
        evaluate: 150,
        total: 1352,
      },
    };

    const parsed = diagnoseResponseSchema.parse(res);
    expect(parsed.requestId).toBe('req-abc-123');
    expect(parsed.outcome).toBe('improved');
    expect(parsed.verification.status).toBe('verified');
  });

  it('validates unverified DiagnoseResponse without cost numbers (Invariant I1)', () => {
    const unverified: DiagnoseResponse = {
      requestId: 'req-unverified-1',
      cached: false,
      outcome: 'unverified',
      verification: {
        status: 'unverified',
        reason: 'Sandbox timeout during execution',
      },
      recommendation: null,
      plans: {
        before: null,
        after: null,
      },
      source: {
        proposedBy: 'deterministic',
        model: null,
        attempts: [],
      },
      alternative: null,
      assumptions: {
        assumedRowCount: 500000,
        seededRows: 20000,
        plannerSettings: 'postgres-defaults',
        tablesScaledEqually: true,
      },
      notices: ['Sandbox worker respawned due to timeout'],
      timingsMs: {
        gate: 2,
        propose: 10,
        evaluate: 6000,
        total: 6012,
      },
    };

    const parsed = diagnoseResponseSchema.parse(unverified);
    expect(parsed.outcome).toBe('unverified');
    expect(parsed.verification.status).toBe('unverified');
    // Enforces I1: no cost numbers in verification
    expect('costBefore' in parsed.verification).toBe(false);
  });

  it('derives severity correctly according to thresholds', () => {
    expect(deriveSeverity('not_improved', 1)).toBe('OPTIMAL');
    expect(deriveSeverity('no_recommendation', 1)).toBe('OPTIMAL');
    expect(deriveSeverity('improved', 12.5)).toBe('CRITICAL');
    expect(deriveSeverity('improved', 10)).toBe('CRITICAL');
    expect(deriveSeverity('improved', 5)).toBe('HIGH');
    expect(deriveSeverity('improved', 3)).toBe('HIGH');
    expect(deriveSeverity('improved', 2.9)).toBe('MODERATE');
    expect(deriveSeverity('improved', 1.05)).toBe('MODERATE');
  });
});
