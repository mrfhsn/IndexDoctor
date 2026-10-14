import { describe, it, expect, vi } from 'vitest';

import { createApp } from '../../src/server/app.js';
import type { Config } from '../../src/server/config.js';
import { TokenBucketRateLimiter } from '../../src/server/lib/token-bucket.js';
import type { PipelineRunner, SandboxEvaluator } from '../../src/server/pipeline/diagnose.js';
import {
  diagnoseResponseSchema,
  errorEnvelopeSchema,
  type DiagnoseResponse,
} from '../../src/shared/contract.js';

const testConfig: Config = {
  PORT: 8080,
  NODE_ENV: 'test',
  LOG_LEVEL: 'error',
  GEMINI_API_KEY: '',
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

const mockBeforePlan = {
  nodePath: 'Seq Scan',
  primaryScan: 'Seq Scan',
  startupCost: 0,
  totalCost: 1000,
  planRows: 1000,
  usesIndexes: [],
  tree: {
    type: 'Seq Scan',
    relation: 'users',
    startupCost: 0,
    totalCost: 1000,
    planRows: 1000,
    children: [],
  },
};

const mockAfterPlan = {
  nodePath: 'Index Scan',
  primaryScan: 'Index Scan',
  startupCost: 0.28,
  totalCost: 10,
  planRows: 1,
  usesIndexes: ['idx_users_email'],
  tree: {
    type: 'Index Scan',
    relation: 'users',
    indexName: 'idx_users_email',
    startupCost: 0.28,
    totalCost: 10,
    planRows: 1,
    children: [],
  },
};

describe('POST /api/diagnose Contract Tests', () => {
  it('returns 200 and schema-valid response for verified improvement', async () => {
    const mockSandbox: SandboxEvaluator = {
      getStatus: () => ({ state: 'ready', respawns: 0, jobsSinceSpawn: 1, queueLength: 0 }),
      evaluate: vi.fn(async () => ({
        before: mockBeforePlan,
        candidates: [
          {
            name: 'idx_users_email',
            ddl: 'CREATE INDEX "idx_users_email" ON "users" ("email" ASC);',
            after: mockAfterPlan,
            indexUsed: true,
            costBefore: 1000,
            costAfter: 10,
            costReductionPercent: 99,
            costRatio: 100,
          },
        ],
        unseededTables: [],
      })),
    };

    const app = createApp({
      config: testConfig,
      sandboxManager: mockSandbox,
    });

    const res = await app.request('/api/diagnose', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        schema: 'CREATE TABLE users (id int, email text);',
        query: "SELECT id FROM users WHERE email = 'test@example.com';",
      }),
    });

    expect(res.status).toBe(200);
    const validated = diagnoseResponseSchema.parse(await res.json());

    expect(validated.outcome).toBe('improved');
    expect(validated.verification.status).toBe('verified');
    if (validated.verification.status === 'verified') {
      expect(validated.verification.costReductionPercent).toBe(99);
      expect(validated.verification.costRatio).toBe(100);
      expect(validated.verification.severity).toBe('CRITICAL');
    }
    expect(validated.recommendation).not.toBeNull();
    expect(validated.plans.before).not.toBeNull();
    expect(validated.plans.after).not.toBeNull();
  });

  it('returns 415 UNSUPPORTED_MEDIA_TYPE when Content-Type is not application/json', async () => {
    const app = createApp({ config: testConfig });

    const res = await app.request('/api/diagnose', {
      method: 'POST',
      headers: {
        'content-type': 'text/plain',
      },
      body: 'CREATE TABLE users (id int);',
    });

    expect(res.status).toBe(415);
    const body = await res.json();
    const env = errorEnvelopeSchema.parse(body);
    expect(env.error.code).toBe('UNSUPPORTED_MEDIA_TYPE');
  });

  it('returns 413 PAYLOAD_TOO_LARGE when body exceeds MAX_BODY_BYTES', async () => {
    const app = createApp({ config: testConfig });

    // 35 KB payload (> 32 KB limit)
    const largePayload = JSON.stringify({
      schema: 'CREATE TABLE users (id int);' + ' '.repeat(35000),
      query: 'SELECT * FROM users;',
    });

    const res = await app.request('/api/diagnose', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: largePayload,
    });

    expect(res.status).toBe(413);
    const body = await res.json();
    const env = errorEnvelopeSchema.parse(body);
    expect(env.error.code).toBe('PAYLOAD_TOO_LARGE');
  });

  it('returns 400 INVALID_REQUEST when JSON is malformed or schema fails', async () => {
    const app = createApp({ config: testConfig });

    // 1. Malformed JSON
    const resMalformed = await app.request('/api/diagnose', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: '{ not valid json',
    });
    expect(resMalformed.status).toBe(400);
    const bodyMalformed = await resMalformed.json();
    expect(errorEnvelopeSchema.parse(bodyMalformed).error.code).toBe('INVALID_REQUEST');

    // 2. Extra unpermitted keys (strict schema)
    const resExtra = await app.request('/api/diagnose', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        schema: 'CREATE TABLE t (id int);',
        query: 'SELECT * FROM t;',
        unknownField: 'illegal',
      }),
    });
    expect(resExtra.status).toBe(400);
    const bodyExtra = await resExtra.json();
    expect(errorEnvelopeSchema.parse(bodyExtra).error.code).toBe('INVALID_REQUEST');
  });

  it('returns 422 UNSUPPORTED_SQL when SQL gate rejects input', async () => {
    const app = createApp({ config: testConfig });

    // COPY statement is prohibited by the SQL gate
    const res = await app.request('/api/diagnose', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        schema: "COPY users FROM '/etc/passwd';",
        query: 'SELECT * FROM users;',
      }),
    });

    expect(res.status).toBe(422);
    const body = await res.json();
    const env = errorEnvelopeSchema.parse(body);
    expect(env.error.code).toBe('UNSUPPORTED_SQL');
    expect(env.error.hint).toBeDefined();
  });

  it('returns 429 RATE_LIMITED with Retry-After header when token bucket is exhausted', async () => {
    // Limiter with burst = 1
    const limiter = new TokenBucketRateLimiter({ ratePerMin: 12, burst: 1 });
    const app = createApp({ config: testConfig, rateLimiter: limiter });

    const payload = JSON.stringify({
      schema: 'CREATE TABLE t (id int);',
      query: 'SELECT * FROM t;',
    });

    // Request 1 consumes the single burst token
    const res1 = await app.request('/api/diagnose', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': '198.51.100.1' },
      body: payload,
    });
    expect(res1.status).not.toBe(429);

    // Request 2 from the same IP must be rejected with 429
    const res2 = await app.request('/api/diagnose', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': '198.51.100.1' },
      body: payload,
    });
    expect(res2.status).toBe(429);
    expect(res2.headers.get('retry-after')).toBeDefined();

    const body = await res2.json();
    const env = errorEnvelopeSchema.parse(body);
    expect(env.error.code).toBe('RATE_LIMITED');
  });

  it('returns 503 BUSY when in-flight request cap is reached', async () => {
    // App with MAX_IN_FLIGHT = 1
    const constrainedConfig: Config = { ...testConfig, MAX_IN_FLIGHT: 1 };

    let resolveActive: (() => void) | null = null;
    const blockingPipeline: PipelineRunner = {
      run: vi.fn(async () => {
        return new Promise<DiagnoseResponse>((resolve) => {
          resolveActive = () =>
            resolve({
              requestId: 'req-block',
              cached: false,
              outcome: 'improved',
              verification: {
                status: 'verified',
                indexUsed: true,
                costBefore: 100,
                costAfter: 10,
                costReductionPercent: 90,
                costRatio: 10,
                severity: 'CRITICAL',
              },
              recommendation: null,
              plans: { before: null, after: null },
              source: { proposedBy: 'deterministic', model: null, attempts: [] },
              alternative: null,
              assumptions: {
                assumedRowCount: 500000,
                seededRows: 20000,
                plannerSettings: 'postgres-defaults',
                tablesScaledEqually: true,
              },
              notices: [],
              timingsMs: { gate: 1, propose: 1, evaluate: 1, total: 3 },
            });
        });
      }),
    };

    const app = createApp({
      config: constrainedConfig,
      pipeline: blockingPipeline,
    });

    const payload = JSON.stringify({
      schema: 'CREATE TABLE t (id int);',
      query: 'SELECT * FROM t;',
    });

    // Start in-flight request 1 (will pause inside blocking pipeline)
    const req1Promise = app.request('/api/diagnose', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: payload,
    });

    // Wait a tick to ensure req1 is in-flight
    await new Promise((r) => setTimeout(r, 10));

    // Request 2 should immediately receive 503 BUSY with Retry-After
    const res2 = await app.request('/api/diagnose', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: payload,
    });

    expect(res2.status).toBe(503);
    expect(res2.headers.get('retry-after')).toBe('2');
    const body2 = await res2.json();
    const env2 = errorEnvelopeSchema.parse(body2);
    expect(env2.error.code).toBe('BUSY');

    // Unblock req1
    if (resolveActive !== null) {
      const unblock: () => void = resolveActive;
      unblock();
    }
    const res1 = await req1Promise;
    expect(res1.status).toBe(200);
  });
});
