import type { PGlite } from '@electric-sql/pglite';

import type { PlanNode, PlanSummary } from '../../shared/contract.js';
import { AppError } from '../errors.js';
import type { CandidateEvaluationResult, EvaluatePayload, EvaluateResult } from './protocol.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Extracts a normalized PlanSummary tree from raw PostgreSQL EXPLAIN JSON.
 * Traverses the node tree, collects used indexes (including Bitmap Index Scans),
 * and calculates primary scan type and total costs.
 */
export function extractPlanSummary(rawExplain: unknown): PlanSummary {
  let parsed: unknown = rawExplain;

  if (typeof rawExplain === 'string') {
    try {
      parsed = JSON.parse(rawExplain) as unknown;
    } catch {
      parsed = {};
    }
  }

  let explainItem: unknown = parsed;
  if (Array.isArray(parsed) && parsed.length > 0) {
    explainItem = parsed[0];
  }

  const rootNode =
    isRecord(explainItem) && isRecord(explainItem['Plan']) ? explainItem['Plan'] : undefined;

  if (!rootNode) {
    throw new AppError('INTERNAL', 'Failed to extract Plan from EXPLAIN JSON output', {
      status: 500,
      hint: 'Invalid EXPLAIN response from Postgres planner.',
    });
  }

  const usesIndexes = new Set<string>();
  const nodePathParts: string[] = [];
  let primaryScan = 'Unknown Scan';

  function walk(node: Record<string, unknown>): PlanNode {
    const nodeType = typeof node['Node Type'] === 'string' ? node['Node Type'] : 'Unknown';
    nodePathParts.push(nodeType);

    const idxName = typeof node['Index Name'] === 'string' ? node['Index Name'] : undefined;
    if (idxName) {
      usesIndexes.add(idxName);
    }

    if (nodeType.includes('Scan') && primaryScan === 'Unknown Scan') {
      primaryScan = nodeType;
    }

    const children: PlanNode[] = [];
    const childPlans = node['Plans'];
    if (Array.isArray(childPlans)) {
      for (const child of childPlans) {
        if (isRecord(child)) {
          children.push(walk(child));
        }
      }
    }

    const startupCost = typeof node['Startup Cost'] === 'number' ? node['Startup Cost'] : 0;
    const totalCost = typeof node['Total Cost'] === 'number' ? node['Total Cost'] : 0;
    const planRows = typeof node['Plan Rows'] === 'number' ? node['Plan Rows'] : 0;

    const planNode: PlanNode = {
      type: nodeType,
      startupCost,
      totalCost,
      planRows,
      children,
    };

    if (typeof node['Relation Name'] === 'string') planNode.relation = node['Relation Name'];
    if (idxName) planNode.indexName = idxName;
    if (typeof node['Alias'] === 'string') planNode.alias = node['Alias'];
    if (typeof node['Filter'] === 'string') planNode.filter = node['Filter'];
    if (typeof node['Index Cond'] === 'string') planNode.indexCond = node['Index Cond'];
    if (typeof node['Recheck Cond'] === 'string') planNode.recheckCond = node['Recheck Cond'];
    if (Array.isArray(node['Sort Key'])) {
      planNode.sortKey = node['Sort Key'].map((k) => String(k));
    }
    if (typeof node['Join Type'] === 'string') planNode.joinType = node['Join Type'];

    return planNode;
  }

  const tree = walk(rootNode);

  return {
    nodePath: nodePathParts.join(' -> '),
    primaryScan,
    startupCost: tree.startupCost,
    totalCost: tree.totalCost,
    planRows: tree.planRows,
    usesIndexes: Array.from(usesIndexes),
    tree,
  };
}

/**
 * Generates an SQL expression for synthetic data generation based on column heuristics.
 */
function getColumnSeedExpression(colName: string, udtType: string, isEnum: boolean): string | null {
  const name = colName.toLowerCase();
  const type = udtType.toLowerCase();

  // If column is an enum, pick from its valid values
  if (isEnum) {
    return `(enum_range(NULL::${udtType}))[(g % array_length(enum_range(NULL::${udtType}), 1)) + 1]`;
  }

  // Name-based heuristics
  if (name === 'id' || name.endsWith('_id')) {
    if (name === 'id') return 'g';
    return '((g % 500) + 1)';
  }

  if (
    name.endsWith('_at') ||
    name.endsWith('_date') ||
    type.includes('timestamp') ||
    type.includes('date')
  ) {
    return `NOW() - ((20000 - g) * INTERVAL '1 minute')`;
  }

  if (
    name === 'status' ||
    name === 'state' ||
    name === 'type' ||
    name === 'kind' ||
    name === 'role' ||
    name === 'category'
  ) {
    return `(CASE (g % 5) WHEN 0 THEN 'pending' WHEN 1 THEN 'completed' WHEN 2 THEN 'failed' WHEN 3 THEN 'active' ELSE 'inactive' END)`;
  }

  if (
    name.startsWith('is_') ||
    name.startsWith('has_') ||
    name.startsWith('deleted') ||
    type === 'bool'
  ) {
    return `((g % 10) = 0)`;
  }

  if (name.includes('email')) {
    return `'user_' || g || '@example.com'`;
  }

  if (name.includes('name') || name.includes('title') || name.includes('slug')) {
    return `'item_' || g`;
  }

  // Type-based fallbacks
  if (
    type === 'int2' ||
    type === 'int4' ||
    type === 'int8' ||
    type === 'serial' ||
    type === 'bigserial'
  ) {
    return '((g * 31) % 1000)';
  }

  if (type === 'numeric' || type === 'float4' || type === 'float8') {
    return '(((g * 17) % 10000)::numeric / 100.0)';
  }

  if (type === 'text' || type === 'varchar' || type === 'bpchar') {
    return `'val_' || ((g * 13) % 200)`;
  }

  if (type === 'uuid') {
    return 'gen_random_uuid()';
  }

  if (type === 'json' || type === 'jsonb') {
    return `'{"id": ' || g || '}'::jsonb`;
  }

  if (type.startsWith('_')) {
    // Array types
    return `ARRAY[]::${type}`;
  }

  return null;
}

/**
 * Scales table planner stats (reltuples, relallvisible) and asserts verification.
 */
async function scaleStats(
  pg: PGlite,
  tableNames: string[],
  assumedRowCount: number,
): Promise<void> {
  if (tableNames.length === 0) return;

  const namesList = tableNames.map((n) => `'${n}'`).join(', ');

  await pg.exec(`
    UPDATE pg_class
    SET reltuples = ${assumedRowCount}, relallvisible = relpages
    WHERE relname IN (${namesList}) AND relnamespace = 'public'::regnamespace;
  `);

  // Read back and assert
  const readBack = await pg.query<{ relname: string; reltuples: number }>(`
    SELECT relname, reltuples
    FROM pg_class
    WHERE relname IN (${namesList}) AND relnamespace = 'public'::regnamespace;
  `);

  for (const row of readBack.rows) {
    if (Math.abs(row.reltuples - assumedRowCount) > 1) {
      throw new AppError(
        'INTERNAL',
        `Failed to scale stats for table ${row.relname}: expected ${assumedRowCount}, got ${row.reltuples}`,
        { status: 500 },
      );
    }
  }
}

/**
 * Runs an evaluate job inside a single transaction with savepoint isolation per candidate.
 * Guarantees zero leak of user objects upon completion (poison check).
 */
export async function evaluateJob(pg: PGlite, payload: EvaluatePayload): Promise<EvaluateResult> {
  const unseededTables: string[] = [];
  let evaluateError: unknown = null;
  let evaluateResult: EvaluateResult | null = null;

  await pg.exec('BEGIN;');

  try {
    // 1. Transaction isolation configuration
    await pg.exec(`
      SET LOCAL session_replication_role = replica;
      SET LOCAL max_parallel_workers_per_gather = 0;
    `);

    // 2. Execute schema statements one by one (order matters for table/index dependencies)
    for (const stmt of payload.statements) {
      if (stmt.trim()) {
        // oxlint-disable-next-line no-await-in-loop -- sequential execution required for DDL statements
        await pg.exec(stmt);
      }
    }

    // 3. Drop CHECK constraints so synthetic data seeding does not fail
    const checkConstraints = await pg.query<{ conname: string; relname: string }>(`
      SELECT c.conname, r.relname
      FROM pg_constraint c
      JOIN pg_class r ON c.conrelid = r.oid
      WHERE c.contype = 'c' AND r.relnamespace = 'public'::regnamespace;
    `);

    for (const row of checkConstraints.rows) {
      // oxlint-disable-next-line no-await-in-loop -- sequential constraint drops in Postgres
      await pg.exec(`ALTER TABLE "${row.relname}" DROP CONSTRAINT "${row.conname}";`);
    }

    // 4. Introspect user tables
    const userTablesRes = await pg.query<{ tablename: string }>(`
      SELECT tablename FROM pg_tables WHERE schemaname = 'public';
    `);
    const tableNames = userTablesRes.rows.map((r) => r.tablename);

    // Introspect enums
    const enumsRes = await pg.query<{ typname: string }>(`
      SELECT t.typname
      FROM pg_type t
      JOIN pg_namespace n ON n.oid = t.typnamespace
      WHERE t.typtype = 'e' AND n.nspname = 'public';
    `);
    const enumSet = new Set(enumsRes.rows.map((r) => r.typname));

    // 5. Seed each user table sequentially
    for (const tbl of tableNames) {
      // oxlint-disable-next-line no-await-in-loop -- sequential column introspection per table
      const colRes = await pg.query<{
        column_name: string;
        udt_name: string;
        is_nullable: string;
        column_default: string | null;
        is_identity: string;
        generation_expression: string | null;
      }>(`
        SELECT column_name, udt_name, is_nullable, column_default, is_identity, generation_expression
        FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = '${tbl}';
      `);

      const insertCols: string[] = [];
      const exprs: string[] = [];
      let canSeed = true;

      for (const col of colRes.rows) {
        if (
          col.is_identity === 'YES' ||
          col.generation_expression !== null ||
          col.column_default?.includes('nextval(')
        ) {
          // Let identity/generated/serial default produce value
          continue;
        }

        const isEnum = enumSet.has(col.udt_name);
        const expr = getColumnSeedExpression(col.column_name, col.udt_name, isEnum);

        if (expr) {
          insertCols.push(`"${col.column_name}"`);
          exprs.push(expr);
        } else if (col.is_nullable === 'NO' && !col.column_default) {
          canSeed = false;
          break;
        }
      }

      if (canSeed && insertCols.length > 0) {
        // oxlint-disable-next-line no-await-in-loop -- sequential seeding per table
        await pg.exec(`
          INSERT INTO "${tbl}" (${insertCols.join(', ')})
          SELECT ${exprs.join(', ')}
          FROM generate_series(1, ${payload.seededRows}) g;
        `);
        // oxlint-disable-next-line no-await-in-loop -- sequential analyze per table
        await pg.exec(`ANALYZE "${tbl}";`);
      } else if (!canSeed) {
        unseededTables.push(tbl);
      }
    }

    // 6. Scale stats and assert read-back
    await scaleStats(pg, tableNames, payload.assumedRowCount);

    // 7. Measure Baseline (Before Plan)
    const beforeExplainRes = await pg.query<{ 'QUERY PLAN': unknown }>(
      `EXPLAIN (FORMAT JSON) ${payload.querySql}`,
    );
    const beforePlan = extractPlanSummary(beforeExplainRes.rows[0]?.['QUERY PLAN']);

    // 8. Measure Candidate Indexes (up to 2) using SAVEPOINTs
    const candidateResults: CandidateEvaluationResult[] = [];

    for (let i = 0; i < payload.candidateIndexes.length; i++) {
      const candidate = payload.candidateIndexes[i]!;
      const savepointName = `sp_candidate_${i}`;

      // oxlint-disable-next-line no-await-in-loop -- sequential savepoint isolation per candidate
      await pg.exec(`SAVEPOINT ${savepointName};`);
      try {
        // oxlint-disable-next-line no-await-in-loop -- sequential candidate DDL execution
        await pg.exec(candidate.ddl);

        // CREATE INDEX resets reltuples; re-scale and assert
        // oxlint-disable-next-line no-await-in-loop -- sequential stats re-scaling
        await scaleStats(pg, tableNames, payload.assumedRowCount);

        // oxlint-disable-next-line no-await-in-loop -- sequential query explain
        const afterExplainRes = await pg.query<{ 'QUERY PLAN': unknown }>(
          `EXPLAIN (FORMAT JSON) ${payload.querySql}`,
        );
        const afterPlan = extractPlanSummary(afterExplainRes.rows[0]?.['QUERY PLAN']);

        const indexUsed = afterPlan.usesIndexes.includes(candidate.name);
        const costBefore = beforePlan.totalCost;
        const costAfter = afterPlan.totalCost;

        const costReductionPercent =
          costBefore > 0
            ? Math.max(0, Math.min(99.9, ((costBefore - costAfter) / costBefore) * 100))
            : 0;
        const costRatio = costAfter > 0 ? costBefore / costAfter : 1;

        candidateResults.push({
          name: candidate.name,
          ddl: candidate.ddl,
          after: afterPlan,
          indexUsed,
          costBefore,
          costAfter,
          costReductionPercent,
          costRatio,
        });
      } finally {
        // oxlint-disable-next-line no-await-in-loop -- sequential rollback savepoint
        await pg.exec(`ROLLBACK TO SAVEPOINT ${savepointName};`);
        // oxlint-disable-next-line no-await-in-loop -- sequential release savepoint
        await pg.exec(`RELEASE SAVEPOINT ${savepointName};`);
      }
    }

    evaluateResult = {
      before: beforePlan,
      candidates: candidateResults,
      unseededTables,
    };
  } catch (err: unknown) {
    evaluateError = err;
  } finally {
    // Guarantee rollback of all user objects
    await pg.exec('ROLLBACK;');
  }

  // 10. Poison Check outside finally block: assert zero user relations remain
  const poisonCheck = await pg.query<{ count: string }>(`
    SELECT count(*) as count
    FROM pg_class
    WHERE relnamespace = 'public'::regnamespace AND relkind IN ('r', 'v', 'm', 'i');
  `);
  const count = parseInt(poisonCheck.rows[0]?.count || '0', 10);
  if (count > 0) {
    throw new AppError(
      'INTERNAL',
      `Worker poison check failed: ${count} relations remain in public schema after ROLLBACK.`,
      { status: 500 },
    );
  }

  if (evaluateError) {
    throw evaluateError;
  }

  if (!evaluateResult) {
    throw new AppError('INTERNAL', 'Evaluation produced no result.', { status: 500 });
  }

  return evaluateResult;
}
