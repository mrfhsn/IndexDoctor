import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import type { DiagnoseRequest, DiagnoseResponse } from '../shared/contract.js';
import { diagnose, fetchHealth } from './api.js';

describe('Client API (api.ts)', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('successfully executes diagnose and validates response against contract', async () => {
    const mockResponse: DiagnoseResponse = {
      requestId: 'req-success-1',
      cached: false,
      outcome: 'improved',
      verification: {
        status: 'verified',
        indexUsed: true,
        costBefore: 500,
        costAfter: 12,
        costReductionPercent: 97.6,
        costRatio: 41.6,
        severity: 'CRITICAL',
      },
      recommendation: {
        index: {
          table: 'users',
          name: 'idx_users_email',
          columns: [{ name: 'email', direction: 'ASC' }],
          include: [],
          where: null,
        },
        sql: {
          create: 'CREATE INDEX idx_users_email ON users (email ASC);',
          createConcurrently:
            'CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_users_email ON users (email ASC);',
        },
        headline: 'Index email column',
        explanation: 'Provides index scan for email filter',
        antiPatterns: [],
        esr: [{ column: 'email', role: 'Equality', reason: 'Equality filter' }],
        migrations: {
          postgres: 'CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_users_email ON users (email ASC);',
        },
        migrationNotes: [],
      },
      plans: {
        before: {
          nodePath: 'Seq Scan',
          primaryScan: 'Seq Scan',
          startupCost: 0,
          totalCost: 500,
          planRows: 1000,
          usesIndexes: [],
          tree: {
            type: 'Seq Scan',
            relation: 'users',
            startupCost: 0,
            totalCost: 500,
            planRows: 1000,
            children: [],
          },
        },
        after: {
          nodePath: 'Index Scan',
          primaryScan: 'Index Scan',
          startupCost: 0.28,
          totalCost: 12,
          planRows: 1,
          usesIndexes: ['idx_users_email'],
          tree: {
            type: 'Index Scan',
            relation: 'users',
            indexName: 'idx_users_email',
            startupCost: 0.28,
            totalCost: 12,
            planRows: 1,
            children: [],
          },
        },
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
      notices: [],
      timingsMs: {
        gate: 2,
        propose: 1,
        evaluate: 20,
        total: 23,
      },
    };

    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(mockResponse), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const req: DiagnoseRequest = {
      schema: 'CREATE TABLE users (id int, email text);',
      query: 'SELECT * FROM users WHERE email = $1;',
    };

    const res = await diagnose(req);
    expect(res.requestId).toBe('req-success-1');
    expect(res.outcome).toBe('improved');
    expect(res.verification.status).toBe('verified');
  });

  it('parses structured ErrorEnvelope on 422 UNSUPPORTED_SQL', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          error: {
            code: 'UNSUPPORTED_SQL',
            message: 'COPY statement is forbidden in schema',
            hint: 'Remove COPY and use CREATE TABLE',
          },
          requestId: 'req-err-422',
        }),
        {
          status: 422,
          headers: { 'Content-Type': 'application/json' },
        },
      ),
    );

    await expect(
      diagnose({ schema: 'COPY foo FROM stdin;', query: 'SELECT 1;' }),
    ).rejects.toMatchObject({
      name: 'ApiClientError',
      status: 422,
      code: 'UNSUPPORTED_SQL',
      message: 'COPY statement is forbidden in schema',
      hint: 'Remove COPY and use CREATE TABLE',
      requestId: 'req-err-422',
    });
  });

  it('extracts Retry-After header on 429 RATE_LIMITED', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          error: {
            code: 'RATE_LIMITED',
            message: 'Rate limit exceeded. Please wait before retrying.',
          },
          requestId: 'req-rate-limit-1',
        }),
        {
          status: 429,
          headers: {
            'Content-Type': 'application/json',
            'Retry-After': '45',
          },
        },
      ),
    );

    await expect(
      diagnose({ schema: 'CREATE TABLE t (id int);', query: 'SELECT 1;' }),
    ).rejects.toMatchObject({
      name: 'ApiClientError',
      status: 429,
      code: 'RATE_LIMITED',
      retryAfterSec: 45,
    });
  });

  it('throws CONTRACT_VIOLATION when server returns invalid payload', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          // missing required fields
          requestId: 'req-broken',
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      ),
    );

    await expect(
      diagnose({ schema: 'CREATE TABLE t (id int);', query: 'SELECT 1;' }),
    ).rejects.toMatchObject({
      name: 'ApiClientError',
      code: 'CONTRACT_VIOLATION',
    });
  });

  it('handles user cancellation via AbortSignal', async () => {
    const abortErr = new DOMException('The operation was aborted', 'AbortError');
    globalThis.fetch = vi.fn().mockRejectedValue(abortErr);

    const controller = new AbortController();
    controller.abort();

    await expect(
      diagnose({ schema: 'CREATE TABLE t (id int);', query: 'SELECT 1;' }, controller.signal),
    ).rejects.toMatchObject({
      name: 'ApiClientError',
      code: 'ABORTED',
    });
  });

  it('fetches and validates health status', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          ready: true,
          version: '0.1.0',
          uptimeSec: 120,
          sandbox: { state: 'ready', respawns: 0, jobsSinceSpawn: 5 },
          llm: {
            configured: true,
            models: [{ id: 'gemini-3.1-flash-lite', breaker: 'closed' }],
          },
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      ),
    );

    const health = await fetchHealth();
    expect(health.ready).toBe(true);
    expect(health.sandbox.state).toBe('ready');
    expect(health.llm.configured).toBe(true);
  });
});
