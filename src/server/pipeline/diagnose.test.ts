import { describe, it, expect, vi } from 'vitest';

import { diagnoseResponseSchema, type DiagnoseResponse } from '../../shared/contract.js';
import type { Config } from '../config.js';
import { LruCache } from '../lib/lru.js';
import { PRESET_SNAPSHOTS } from '../snapshots/presets.js';
import { type ChainExecutor, DiagnosePipeline, type SandboxEvaluator } from './diagnose.js';

const mockConfig: Config = {
  PORT: 8080,
  NODE_ENV: 'test',
  LOG_LEVEL: 'error',
  GEMINI_API_KEY: 'test-key',
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

describe('DiagnosePipeline', () => {
  it('runs complete diagnosis and caches verified outcome', async () => {
    const evaluateFn = vi.fn(async () => ({
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
    }));

    const mockSandbox: SandboxEvaluator = {
      evaluate: evaluateFn,
    };

    const mockLlmChain: ChainExecutor = {
      execute: vi.fn(async () => ({
        proposedBy: 'deterministic' as const,
        model: null,
        spec: {
          table: 'users',
          columns: [{ name: 'email', direction: 'asc' as const }],
        },
        ddl: {
          name: 'idx_users_email',
          create: 'CREATE INDEX "idx_users_email" ON "users" ("email" ASC);',
          createConcurrently:
            'CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_users_email" ON "users" ("email" ASC);',
        },
        esr: [{ column: 'email', role: 'Equality' as const, reason: 'Equality filter' }],
        headline: 'Index users by email',
        explanation: 'Covers lookup on email column.',
        antiPatterns: [],
        attempts: [],
      })),
    };

    const cache = new LruCache<DiagnoseResponse>({ maxEntries: 10, ttlMs: 10000 });
    const pipeline = new DiagnosePipeline({
      config: mockConfig,
      sandboxManager: mockSandbox,
      llmChain: mockLlmChain,
      cache,
    });

    const input = {
      schema: 'CREATE TABLE users (id int, email text);',
      query: "SELECT id FROM users WHERE email = 'test@example.com';",
      requestId: 'req-test-1',
    };

    const res = await pipeline.run(input);

    expect(res.outcome).toBe('improved');
    expect(res.verification.status).toBe('verified');
    if (res.verification.status === 'verified') {
      expect(res.verification.costReductionPercent).toBe(99);
      expect(res.verification.severity).toBe('CRITICAL');
    }
    expect(res.cached).toBe(false);
    expect(diagnoseResponseSchema.safeParse(res).success).toBe(true);

    // Second call should hit cache
    const secondRes = await pipeline.run({ ...input, requestId: 'req-test-2' });
    expect(secondRes.cached).toBe(true);
    expect(secondRes.requestId).toBe('req-test-2');
    expect(secondRes.outcome).toBe('improved');
    expect(evaluateFn).toHaveBeenCalledTimes(1);
  });

  it('degrades cleanly to unverified when sandbox fails (Invariant I1 & I8)', async () => {
    const mockSandbox: SandboxEvaluator = {
      evaluate: vi.fn(async () => {
        throw new Error('Sandbox worker terminated');
      }),
    };

    const mockLlmChain: ChainExecutor = {
      execute: vi.fn(async () => ({
        proposedBy: 'deterministic' as const,
        model: null,
        spec: {
          table: 'users',
          columns: [{ name: 'email', direction: 'asc' as const }],
        },
        ddl: {
          name: 'idx_users_email',
          create: 'CREATE INDEX "idx_users_email" ON "users" ("email" ASC);',
          createConcurrently:
            'CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_users_email" ON "users" ("email" ASC);',
        },
        esr: [],
        headline: 'Index email',
        explanation: 'Explanation',
        antiPatterns: [],
        attempts: [],
      })),
    };

    const pipeline = new DiagnosePipeline({
      config: mockConfig,
      sandboxManager: mockSandbox,
      llmChain: mockLlmChain,
    });

    const res = await pipeline.run({
      schema: 'CREATE TABLE users (id int, email text);',
      query: "SELECT id FROM users WHERE email = 'test@example.com';",
      requestId: 'req-unverified',
    });

    expect(res.outcome).toBe('unverified');
    expect(res.verification.status).toBe('unverified');
    if (res.verification.status === 'unverified') {
      expect(res.verification.reason).toContain('Sandbox worker terminated');
    }
    expect(res.plans.before).toBeNull();
    expect(res.plans.after).toBeNull();
    // Invariant I1: no cost numbers
    expect('costBefore' in res.verification).toBe(false);
    expect(diagnoseResponseSchema.safeParse(res).success).toBe(true);
  });

  it('serves Tier B preset snapshot when sandbox is unavailable and presetId is provided', async () => {
    const pipeline = new DiagnosePipeline({
      config: mockConfig,
      // sandboxManager intentionally undefined
    });

    const preset = PRESET_SNAPSHOTS['orders-composite'];
    const res = await pipeline.run({
      schema:
        'CREATE TABLE orders (id int, customer_id int, status text, created_at timestamptz, total numeric);',
      query:
        "SELECT id, total FROM orders WHERE status = 'pending' ORDER BY created_at DESC LIMIT 50;",
      presetId: 'orders-composite',
      requestId: 'req-preset-tier-b',
    });

    expect(res.outcome).toBe('improved');
    expect(res.verification.status).toBe('verified');
    if (res.verification.status === 'verified') {
      expect(res.verification.costBefore).toBe(
        preset.verification.status === 'verified' ? preset.verification.costBefore : 0,
      );
    }
    expect(res.notices).toContain('Tier B snapshot served from verified PGlite recordings.');
    expect(diagnoseResponseSchema.safeParse(res).success).toBe(true);
  });
});
