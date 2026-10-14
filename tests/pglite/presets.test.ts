import { PGlite } from '@electric-sql/pglite';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

import { evaluateJob } from '../../src/server/sandbox/engine.js';
import { validateGate } from '../../src/server/sql/gate.js';
import { PRESETS } from '../../src/shared/presets/presets.js';

describe('Golden Presets Verification on PGlite', () => {
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

  it('runs all 3 golden presets and validates measurable cost improvements', async () => {
    const measurements: Array<{
      id: string;
      scanBefore: string;
      scanAfter: string;
      costBefore: number;
      costAfter: number;
      reduction: number;
      indexUsed: boolean;
      usesIndexes: string[];
    }> = [];

    for (const preset of PRESETS) {
      // oxlint-disable-next-line no-await-in-loop -- sequential execution required to run presets on single PGlite instance
      const gateResult = await validateGate(preset.schema, preset.query);

      // oxlint-disable-next-line no-await-in-loop -- sequential execution required to run presets on single PGlite instance
      const result = await evaluateJob(pg, {
        statements: gateResult.statements,
        querySql: gateResult.querySql,
        candidateIndexes: [
          {
            name: preset.candidateIndex.name,
            ddl: preset.candidateIndex.ddl,
          },
        ],
        assumedRowCount: 500000,
        seededRows: 20000,
      });

      expect(result.candidates).toHaveLength(1);
      const cand = result.candidates[0]!;

      // Invariant I10: index must be used and costAfter must be less than costBefore
      expect(cand.indexUsed).toBe(true);
      expect(cand.costAfter).toBeLessThan(cand.costBefore);
      expect(cand.costReductionPercent).toBeGreaterThan(0);

      measurements.push({
        id: preset.id,
        scanBefore: result.before.primaryScan,
        scanAfter: cand.after.primaryScan,
        costBefore: Math.round(cand.costBefore * 100) / 100,
        costAfter: Math.round(cand.costAfter * 100) / 100,
        reduction: Math.round(cand.costReductionPercent * 10) / 10,
        indexUsed: cand.indexUsed,
        usesIndexes: cand.after.usesIndexes,
      });

      // Special validation for Preset 3: must flip to Index Only Scan!
      if (preset.id === 'analytics-covering') {
        expect(cand.after.primaryScan).toBe('Index Only Scan');
      }
    }

    // Print measured before/after table
    console.log('\n=== GOLDEN PRESET MEASUREMENTS TABLE ===');
    console.table(measurements);

    expect(measurements).toHaveLength(3);
  });

  it('recovers cleanly after a hostile statement fails', async () => {
    // 1. Hostile payload that fails execution
    const hostilePayload = {
      statements: ['CREATE TABLE hostile (id int);', 'SELECT * FROM nonexistent_table_xyz;'],
      querySql: 'SELECT * FROM hostile;',
      candidateIndexes: [],
      assumedRowCount: 1000,
      seededRows: 100,
    };

    await expect(evaluateJob(pg, hostilePayload)).rejects.toThrow();

    // 2. Immediate next valid preset succeeds
    const preset = PRESETS[0]!;
    const gateResult = await validateGate(preset.schema, preset.query);
    const result = await evaluateJob(pg, {
      statements: gateResult.statements,
      querySql: gateResult.querySql,
      candidateIndexes: [
        {
          name: preset.candidateIndex.name,
          ddl: preset.candidateIndex.ddl,
        },
      ],
      assumedRowCount: 10000,
      seededRows: 1000,
    });

    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]!.indexUsed).toBe(true);
  });
});
