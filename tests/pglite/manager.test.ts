import { describe, it, expect, afterAll } from 'vitest';

import { parseConfig } from '../../src/server/config.js';
import { SandboxManager } from '../../src/server/sandbox/manager.js';
import type { EvaluatePayload } from '../../src/server/sandbox/protocol.js';

describe('Sandbox Manager (sandbox/manager.ts)', () => {
  const config = parseConfig({
    SANDBOX_JOB_TIMEOUT_MS: '8000',
    SANDBOX_QUEUE_MAX: '5',
  });

  const manager = new SandboxManager({ config });

  afterAll(async () => {
    await manager.stop();
  });

  it('initializes worker, runs canary, and reports ready state', async () => {
    await manager.start();
    const status = manager.getStatus();
    expect(status.state).toBe('ready');
    expect(status.respawns).toBe(0);
    expect(status.queueLength).toBe(0);
  });

  it('evaluates candidate index end-to-end via worker thread', async () => {
    const payload: EvaluatePayload = {
      statements: [
        `CREATE TABLE manager_test_table (
          id SERIAL PRIMARY KEY,
          category TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL
        );`,
      ],
      querySql: `SELECT id FROM manager_test_table WHERE category = 'news' ORDER BY created_at DESC;`,
      candidateIndexes: [
        {
          name: 'idx_mgr_cat_created',
          ddl: 'CREATE INDEX idx_mgr_cat_created ON manager_test_table (category, created_at DESC);',
        },
      ],
      assumedRowCount: 500000,
      seededRows: 2000,
    };

    const result = await manager.evaluate(payload);
    expect(result.before.totalCost).toBeGreaterThan(0);
    expect(result.candidates).toHaveLength(1);

    const cand = result.candidates[0]!;
    expect(cand.indexUsed).toBe(true);
    expect(cand.costAfter).toBeLessThan(result.before.totalCost);

    const statusAfter = manager.getStatus();
    expect(statusAfter.state).toBe('ready');
    expect(statusAfter.jobsSinceSpawn).toBeGreaterThanOrEqual(1);
  });
});
