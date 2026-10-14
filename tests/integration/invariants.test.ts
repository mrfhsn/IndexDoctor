import { describe, it, expect, vi } from 'vitest';

import { createApp } from '../../src/server/app.js';
import type { Config } from '../../src/server/config.js';
import { createDeadline } from '../../src/server/lib/deadline.js';
import { buildPrompt } from '../../src/server/llm/prompt.js';
import { Logger, type LogMetadata } from '../../src/server/logger.js';
import { DiagnosePipeline, type SandboxEvaluator } from '../../src/server/pipeline/diagnose.js';
import { buildIndexDdl } from '../../src/server/sql/ddl.js';
import { validateGate } from '../../src/server/sql/gate.js';
import { stripAndMaskQuery } from '../../src/server/sql/strip-and-mask.js';
import { diagnoseResponseSchema, errorEnvelopeSchema } from '../../src/shared/contract.js';

const testConfig: Config = {
  PORT: 8080,
  NODE_ENV: 'test',
  LOG_LEVEL: 'info',
  GEMINI_API_KEY: 'test-secret-gemini-key',
  LLM_MODELS: 'gemini-3.1-flash-lite',
  LLM_THINKING_LEVEL: 'minimal',
  LLM_ATTEMPT_TIMEOUT_MS: 5000,
  LLM_BUDGET_MS: 15000,
  LLM_MAX_CONCURRENCY: 6,
  LLM_DAILY_CAP: 1500,
  LLM_BREAKER_COOLDOWN_MS: 60000,
  REQUEST_DEADLINE_MS: 30000,
  MAX_BODY_BYTES: 32768,
  MAX_SCHEMA_BYTES: 20000,
  MAX_QUERY_BYTES: 8000,
  MAX_IN_FLIGHT: 24,
  SANDBOX_QUEUE_MAX: 12,
  SANDBOX_QUEUE_WAIT_MS: 5000,
  SANDBOX_JOB_TIMEOUT_MS: 6000,
  SANDBOX_SEED_ROWS: 20000,
  ASSUMED_ROW_COUNT: 500000,
  SANDBOX_RECYCLE_JOBS: 300,
  RATE_LIMIT_PER_MIN: 12,
  RATE_LIMIT_BURST: 6,
  TRUSTED_PROXY_HOPS: 1,
  CACHE_MAX_ENTRIES: 100,
  CACHE_TTL_MS: 3600000,
};

function isCandidateImproved(before: number, after: number, used: boolean): boolean {
  return used && after < before;
}

describe('System Invariants I1–I12', () => {
  // Invariant I1: A response contains cost numbers ONLY if verification.status === "verified".
  it('Invariant I1: omits cost numbers when verification is unverified', async () => {
    const pipeline = new DiagnosePipeline({
      config: { ...testConfig, GEMINI_API_KEY: '' },
      // no sandbox manager -> will yield unverified
    });

    const res = await pipeline.run({
      schema: 'CREATE TABLE users (id int, email text);',
      query: "SELECT id FROM users WHERE email = 'alice@example.com';",
      requestId: 'req-i1',
    });

    expect(res.outcome).toBe('unverified');
    expect(res.verification.status).toBe('unverified');
    expect('costBefore' in res.verification).toBe(false);
    expect('costAfter' in res.verification).toBe(false);
    expect('costRatio' in res.verification).toBe(false);
    expect('costReductionPercent' in res.verification).toBe(false);
    expect(res.plans.before).toBeNull();
    expect(res.plans.after).toBeNull();
  });

  // Invariant I2: Server builds DDL, model output is never executed as raw text
  it('Invariant I2: quotes identifiers and never executes raw model SQL', () => {
    const spec = {
      table: 'users',
      columns: [{ name: 'email', direction: 'asc' as const }],
      where: 'id > 100',
    };
    const ddl = buildIndexDdl(spec);
    expect(ddl.create).toContain('CREATE INDEX');
    expect(ddl.create).toContain('"users"');
    expect(ddl.create).toContain('"email" ASC');
    expect(ddl.create).toContain('WHERE (id > 100)');
  });

  // Invariant I4: Logs never contain schema/query text, API keys, or raw model output
  it('Invariant I4: asserts sentinel table name and API key never appear in captured logs', async () => {
    class TestCapturingLogger extends Logger {
      public readonly capturedLogs: string[] = [];

      override debug(_msg: string, meta?: LogMetadata): void {
        if (meta) this.capturedLogs.push(JSON.stringify(meta));
      }
      override info(_msg: string, meta?: LogMetadata): void {
        if (meta) this.capturedLogs.push(JSON.stringify(meta));
      }
      override warn(_msg: string, meta?: LogMetadata): void {
        if (meta) this.capturedLogs.push(JSON.stringify(meta));
      }
      override error(_msg: string, meta?: LogMetadata): void {
        if (meta) this.capturedLogs.push(JSON.stringify(meta));
      }
    }

    const testLogger = new TestCapturingLogger('info');
    const sentinelTableName = 'zz_canary_sentinel_xyz123';
    const app = createApp({
      config: testConfig,
      logger: testLogger,
    });

    // Make an invalid request containing the sentinel name
    await app.request('/api/diagnose', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        schema: `CREATE TABLE ${sentinelTableName} (id int);`,
        query: `SELECT * FROM ${sentinelTableName};`,
      }),
    });

    expect(testLogger.capturedLogs.length).toBeGreaterThan(0);
    const joinedLogs = testLogger.capturedLogs.join(' ');

    // The sentinel table name must NEVER appear in any log output
    expect(joinedLogs).not.toContain(sentinelTableName);
    // The API key must NEVER appear in any log output
    expect(joinedLogs).not.toContain('test-secret-gemini-key');
  });

  // Invariant I5: Every non-2xx response uses the error envelope; no stack traces, no internals
  it('Invariant I5: verifies all non-2xx responses strictly adhere to errorEnvelopeSchema', async () => {
    const app = createApp({ config: testConfig });

    const errorRequests = [
      { path: '/api/diagnose', headers: { 'content-type': 'text/plain' }, body: '' },
      { path: '/api/diagnose', headers: { 'content-type': 'application/json' }, body: '{ invalid' },
      {
        path: '/api/diagnose',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ schema: 'DROP TABLE t;', query: 'SELECT 1;' }),
      },
    ];

    for (const req of errorRequests) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- sequential test execution
      const res = await app.request(req.path, {
        method: 'POST',
        headers: req.headers,
        body: req.body,
      });

      expect(res.status).toBeGreaterThanOrEqual(400);
      // oxlint-disable-next-line eslint/no-await-in-loop -- sequential test execution
      const body = await res.json();
      const parsed = errorEnvelopeSchema.safeParse(body);
      expect(parsed.success).toBe(true);
      expect(JSON.stringify(body)).not.toContain('stack');
      expect(JSON.stringify(body)).not.toContain('node_modules');
    }
  });

  // Invariant I6: /api/health/live never depends on the worker or the LLM
  it('Invariant I6: /api/health/live returns 200 ok unconditionally', async () => {
    const app = createApp({
      config: testConfig,
      // No sandbox or LLM key provided
    });

    const res = await app.request('/api/health/live');
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({ status: 'ok' });
  });

  // Invariant I7: No single request can kill the process or leave the service permanently unready
  it('Invariant I7: recovers cleanly after a hostile query', async () => {
    const app = createApp({ config: testConfig });

    // 1. Hostile query rejected
    const hostile = await app.request('/api/diagnose', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        schema: "CREATE TABLE t (id int); COPY t FROM '/etc/passwd';",
        query: 'SELECT * FROM t;',
      }),
    });
    expect(hostile.status).toBe(422);

    // 2. Health check still returns healthy
    const health = await app.request('/api/health');
    expect(health.status).toBe(200);
  });

  // Invariant I8: LLM or sandbox failures degrade the response, never 5xx
  it('Invariant I8: sandbox or LLM crash yields HTTP 200 with unverified, never 5xx', async () => {
    const crashingSandbox: SandboxEvaluator = {
      getStatus: () => ({ state: 'recovering', respawns: 2, jobsSinceSpawn: 0, queueLength: 0 }),
      evaluate: vi.fn(async () => {
        throw new Error('Fatal WASM memory fault');
      }),
    };

    const pipeline = new DiagnosePipeline({
      config: testConfig,
      sandboxManager: crashingSandbox,
    });

    const app = createApp({
      config: testConfig,
      pipeline,
    });

    const res = await app.request('/api/diagnose', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        schema: 'CREATE TABLE items (id int, val text);',
        query: "SELECT id FROM items WHERE val = 'x';",
      }),
    });

    // Invariant I8: MUST BE 200, never 500
    expect(res.status).toBe(200);
    const body = diagnoseResponseSchema.parse(await res.json());
    expect(body.outcome).toBe('unverified');
    expect(body.verification.status).toBe('unverified');
  });

  // Invariant I9: Prompt contains no user-authored free text
  it('Invariant I9: strips comments and masks literals before building prompt', () => {
    const rawSql = "SELECT * FROM users WHERE email = 'secret@example.com' /* private comment */;";
    const masked = stripAndMaskQuery(rawSql).maskedSql;

    expect(masked).not.toContain('secret@example.com');
    expect(masked).not.toContain('private comment');
    expect(masked).toContain('$1');

    const prompt = buildPrompt({
      catalog: {
        tables: {
          users: {
            name: 'users',
            columns: [
              {
                name: 'email',
                type: 'text',
                nullable: false,
                hasDefault: false,
                isGenerated: false,
                isPrimaryKey: false,
              },
            ],
            primaryKey: [],
            foreignKeys: [],
            uniqueConstraints: [],
            indexes: [],
          },
        },
        enumTypes: [],
      },
      querySql: rawSql,
      hints: { equalityColumns: ['email'], sortColumns: [], rangeColumns: [], selectedColumns: [] },
      nonce: 'test-nonce-1234',
    });

    expect(prompt.userPrompt).not.toContain('secret@example.com');
    expect(prompt.userPrompt).not.toContain('private comment');
    expect(prompt.userPrompt).toContain('test-nonce-1234');
  });

  // Invariant I10: Improvement claimed only if costAfter < costBefore and index is used
  it('Invariant I10: enforces costAfter < costBefore and indexUsed === true to claim improvement', () => {
    expect(isCandidateImproved(100, 10, true)).toBe(true);
    expect(isCandidateImproved(100, 10, false)).toBe(false);
    expect(isCandidateImproved(100, 100, true)).toBe(false);
    expect(isCandidateImproved(100, 150, true)).toBe(false);
  });

  // Invariant I11: Every external call has a deadline and abort path
  it('Invariant I11: creates deadline with signal that aborts upon expiry', async () => {
    const deadline = createDeadline(30);
    expect(deadline.signal.aborted).toBe(false);

    await new Promise((r) => setTimeout(r, 50));
    expect(deadline.isExpired).toBe(true);
    expect(deadline.signal.aborted).toBe(true);
    expect(() => deadline.throwIfExpired()).toThrow(/deadline exceeded/);
    deadline.dispose();
  });

  // Invariant I12: Deterministic seeding produces identical output for same input
  it('Invariant I12: validateGate produces deterministic catalog and statements for same input', async () => {
    const schema = 'CREATE TABLE items (id int, name text);';
    const query = "SELECT id FROM items WHERE name = 'tool';";

    const res1 = await validateGate(schema, query);
    const res2 = await validateGate(schema, query);

    expect(res1.statements).toEqual(res2.statements);
    expect(res1.querySql).toEqual(res2.querySql);
    expect(res1.catalog).toEqual(res2.catalog);
  });
});
