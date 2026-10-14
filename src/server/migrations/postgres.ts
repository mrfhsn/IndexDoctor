import { buildIndexDdl, buildIndexName } from '../sql/ddl.js';
import type { CandidateIndexSpec } from '../sql/index-spec.js';

export type PostgresMigration = {
  sql: string;
  notes: string[];
};

/**
 * Generates copy-ready PostgreSQL migration SQL.
 * Includes concurrency safety notes and transaction block warnings.
 */
export function generatePostgresMigration(
  spec: CandidateIndexSpec,
  customName?: string,
): PostgresMigration {
  const indexName = customName || buildIndexName(spec);
  const ddl = buildIndexDdl(spec, indexName);

  const sql = `-- IndexDoctor Recommended Migration
-- Target Table: "${spec.table}"
-- Warning: CREATE INDEX CONCURRENTLY cannot run inside a multi-statement transaction block.
-- Run this statement independently outside of any BEGIN ... COMMIT block.
${ddl.createConcurrently}`;

  const notes = ['CREATE INDEX CONCURRENTLY cannot execute inside a transaction block.'];

  if (spec.where) {
    notes.push('Partial index: verifies condition before writing index entries.');
  }

  if (spec.include && spec.include.length > 0) {
    notes.push(
      `Covering index: includes payload column(s) [${spec.include.join(', ')}] in leaf pages.`,
    );
  }

  return { sql, notes };
}
