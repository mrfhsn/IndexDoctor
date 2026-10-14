import { describe, it, expect, vi } from 'vitest';

import { createApp } from '../../src/server/app.js';
import type { Config } from '../../src/server/config.js';
import { TokenBucketRateLimiter } from '../../src/server/lib/token-bucket.js';
import { DiagnosePipeline, type SandboxEvaluator } from '../../src/server/pipeline/diagnose.js';

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
  MAX_IN_FLIGHT: 50,
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
    relation: 'orders',
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
  usesIndexes: ['idx_orders_customer_id'],
  tree: {
    type: 'Index Scan',
    relation: 'orders',
    indexName: 'idx_orders_customer_id',
    startupCost: 0.28,
    totalCost: 10,
    planRows: 1,
    children: [],
  },
};

describe('Concurrency and Rate Limiting Security', () => {
  it('20 concurrent identical requests run the pipeline once via SingleFlight', async () => {
    const evaluateSpy = vi.fn(async () => {
      // Simulate real engine evaluation time
      await new Promise((r) => setTimeout(r, 60));
      return {
        before: mockBeforePlan,
        candidates: [
          {
            name: 'idx_orders_customer_id',
            ddl: 'CREATE INDEX "idx_orders_customer_id" ON "orders" ("customer_id" ASC);',
            after: mockAfterPlan,
            indexUsed: true,
            costBefore: 1000,
            costAfter: 10,
            costReductionPercent: 99,
            costRatio: 100,
          },
        ],
        unseededTables: [],
      };
    });

    const mockSandbox: SandboxEvaluator = {
      getStatus: () => ({ state: 'ready', respawns: 0, jobsSinceSpawn: 1, queueLength: 0 }),
      evaluate: evaluateSpy,
    };

    const pipeline = new DiagnosePipeline({
      config: testConfig,
      sandboxManager: mockSandbox,
    });

    // Disable rate limiting for this test to focus on SingleFlight coalescing
    const unlimitedLimiter = new TokenBucketRateLimiter({ ratePerMin: 10000, burst: 100 });

    const app = createApp({
      config: testConfig,
      pipeline,
      rateLimiter: unlimitedLimiter,
    });

    const payload = JSON.stringify({
      schema: 'CREATE TABLE orders (id int, customer_id int);',
      query: 'SELECT id FROM orders WHERE customer_id = 42;',
    });

    // Launch 20 concurrent requests with different request IDs
    const requests = Array.from({ length: 20 }, async (_, i) =>
      app.request('/api/diagnose', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-request-id': `req-conc-${i}`,
        },
        body: payload,
      }),
    );

    const responses = await Promise.all(requests);

    // All 20 requests must succeed with 200
    for (const res of responses) {
      expect(res.status).toBe(200);
    }

    // Crucial check: the underlying sandbox evaluate was invoked EXACTLY ONCE
    expect(evaluateSpy).toHaveBeenCalledTimes(1);
  });

  it('20 rapid requests with rotating spoofed leftmost X-Forwarded-For values still reach 429', async () => {
    // Config: burst = 6, rate = 12/min
    const limiter = new TokenBucketRateLimiter({ ratePerMin: 12, burst: 6 });
    const app = createApp({
      config: testConfig,
      rateLimiter: limiter,
    });

    const payload = JSON.stringify({
      schema: 'CREATE TABLE t (id int);',
      query: 'SELECT * FROM t;',
    });

    const realClientIp = '203.0.113.195';
    const statusCodes: number[] = [];

    // Send 20 rapid requests where the client attempts to spoof by rotating the leftmost IP:
    // e.g. "1.1.1.1, 203.0.113.195", "1.1.1.2, 203.0.113.195", etc.
    for (let i = 0; i < 20; i++) {
      const spoofedHeader = `192.168.1.${i}, 10.0.0.${i}, ${realClientIp}`;
      // oxlint-disable-next-line eslint/no-await-in-loop -- sequential rapid burst
      const res = await app.request('/api/diagnose', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-forwarded-for': spoofedHeader,
        },
        body: payload,
      });
      statusCodes.push(res.status);
    }

    // First 6 requests (burst limit) should succeed (status 200 or 422 gate)
    const initialAllowed = statusCodes.slice(0, 6);
    expect(initialAllowed.every((s) => s !== 429)).toBe(true);

    // Remaining requests beyond burst must be throttled with 429 RATE_LIMITED
    const throttled = statusCodes.slice(6);
    expect(throttled).toContain(429);
    expect(throttled.filter((s) => s === 429).length).toBeGreaterThanOrEqual(10);
  });
});
