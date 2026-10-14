import type { Catalog } from './catalog.js';
import { type GeneratedDdl, buildIndexDdl } from './ddl.js';
import { type CandidateIndexSpec, type IndexColumnSpec, validateIndexSpec } from './index-spec.js';
import type { ParsedStatement } from './parse.js';

type EsrRole = 'Equality' | 'Sort' | 'Range' | 'Include' | 'Other';

export type EsrClassification = {
  column: string;
  role: EsrRole;
  reason: string;
};

type EsrPlanSuccess = {
  spec: CandidateIndexSpec;
  ddl: GeneratedDdl;
  esr: EsrClassification[];
};

type EsrPlanFailure = {
  spec: null;
  reason: string;
};

export type EsrPlanResult = EsrPlanSuccess | EsrPlanFailure;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getRecord(obj: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const val = obj[key];
  return isRecord(val) ? val : undefined;
}

function getString(obj: Record<string, unknown>, key: string): string | undefined {
  const val = obj[key];
  return typeof val === 'string' ? val : undefined;
}

/**
 * Extracts a column name from a ColumnRef AST node.
 */
function extractColumnName(node: unknown, targetTable: string): string | null {
  if (!isRecord(node)) return null;
  const colRef = getRecord(node, 'ColumnRef');
  if (!colRef) return null;
  const fields = colRef['fields'];
  if (!Array.isArray(fields) || fields.length === 0) return null;

  const stringFields: string[] = [];
  for (const field of fields) {
    if (isRecord(field)) {
      const strObj = getRecord(field, 'String');
      if (strObj) {
        const sval = getString(strObj, 'sval');
        if (sval) stringFields.push(sval.toLowerCase());
      }
    }
  }

  if (stringFields.length === 1) {
    return stringFields[0] ?? null;
  }
  if (stringFields.length === 2 && stringFields[0] === targetTable.toLowerCase()) {
    return stringFields[1] ?? null;
  }
  return null;
}

/**
 * Checks if an expression contains an OR operator.
 */
function containsOrExpr(node: unknown): boolean {
  if (!isRecord(node)) return false;
  const boolExpr = getRecord(node, 'BoolExpr');
  if (boolExpr) {
    const boolop = getString(boolExpr, 'boolop');
    if (boolop === 'OR_EXPR') return true;
    const args = boolExpr['args'];
    if (Array.isArray(args)) {
      for (const arg of args) {
        if (containsOrExpr(arg)) return true;
      }
    }
  }
  return false;
}

type ExtractedQueryFeatures = {
  tableName: string;
  equalityColumns: Set<string>;
  rangeColumns: Map<string, { opclass?: 'text_pattern_ops' | 'varchar_pattern_ops' }>;
  sortColumns: Array<{
    name: string;
    direction: 'asc' | 'desc';
    nulls?: 'first' | 'last';
  }>;
  selectedColumns: string[];
  isSelectAll: boolean;
};

/**
 * Parses query AST and extracts candidate table, filter columns, sort columns, and selected columns.
 */
function extractQueryFeatures(
  queryAst: ParsedStatement,
  catalog: Catalog,
): { features: ExtractedQueryFeatures } | { error: string } {
  if (!isRecord(queryAst.stmt)) {
    return { error: 'Invalid statement AST.' };
  }

  const selectStmt = getRecord(queryAst.stmt, 'SelectStmt');
  if (!selectStmt) {
    return { error: 'Query is not a SELECT statement.' };
  }

  // 1. Table & Join check
  const fromClause = selectStmt['fromClause'];
  if (!Array.isArray(fromClause) || fromClause.length === 0) {
    return { error: 'Query has no FROM clause.' };
  }
  if (fromClause.length > 1) {
    return {
      error:
        'Query joins multiple tables; deterministic planner only optimizes single-table queries.',
    };
  }

  const firstFrom = fromClause[0];
  if (!isRecord(firstFrom) || !getRecord(firstFrom, 'RangeVar')) {
    return { error: 'Query contains joins or complex subqueries in FROM clause.' };
  }

  const rangeVar = getRecord(firstFrom, 'RangeVar');
  const tableName = rangeVar ? getString(rangeVar, 'relname')?.toLowerCase() : undefined;
  if (!tableName) {
    return { error: 'Could not determine target table name.' };
  }

  const table = catalog.tables[tableName];
  if (!table) {
    return { error: `Table "${tableName}" does not exist in catalog.` };
  }

  const tableColumnTypes = new Map(
    table.columns.map((c) => [c.name.toLowerCase(), c.type.toLowerCase()]),
  );

  // 2. WHERE Clause analysis
  const equalityColumns = new Set<string>();
  const rangeColumns = new Map<string, { opclass?: 'text_pattern_ops' | 'varchar_pattern_ops' }>();

  const whereClause = getRecord(selectStmt, 'whereClause');
  if (whereClause) {
    if (containsOrExpr(whereClause)) {
      return {
        error: 'Query contains OR expression; deterministic planner does not handle disjunctions.',
      };
    }

    let predicates: unknown[] = [];
    const boolExpr = getRecord(whereClause, 'BoolExpr');
    if (boolExpr && getString(boolExpr, 'boolop') === 'AND_EXPR') {
      predicates = Array.isArray(boolExpr['args']) ? boolExpr['args'] : [];
    } else {
      predicates = [whereClause];
    }

    for (const pred of predicates) {
      if (!isRecord(pred)) continue;

      // NullTest
      const nullTest = getRecord(pred, 'NullTest');
      if (nullTest) {
        const col = extractColumnName(nullTest['arg'], tableName);
        if (!col) return { error: 'Query contains expression in IS NULL check.' };
        const testType = getString(nullTest, 'nulltesttype');
        if (testType === 'IS_NULL') {
          equalityColumns.add(col);
        } else {
          rangeColumns.set(col, {});
        }
        continue;
      }

      // A_Expr
      const aExpr = getRecord(pred, 'A_Expr');
      if (aExpr) {
        const kind = getString(aExpr, 'kind');
        const lexpr = aExpr['lexpr'];
        const rexpr = aExpr['rexpr'];
        const colLeft = extractColumnName(lexpr, tableName);
        const colRight = extractColumnName(rexpr, tableName);

        if (kind === 'AEXPR_IN') {
          if (!colLeft) return { error: 'Query contains expression in IN list.' };
          equalityColumns.add(colLeft);
          continue;
        }

        if (kind === 'AEXPR_BETWEEN') {
          if (!colLeft) return { error: 'Query contains expression in BETWEEN predicate.' };
          rangeColumns.set(colLeft, {});
          continue;
        }

        if (kind === 'AEXPR_LIKE') {
          if (!colLeft) return { error: 'Query contains expression in LIKE predicate.' };
          const rConst = isRecord(rexpr) ? getRecord(rexpr, 'A_Const') : undefined;
          const svalObj = rConst ? getRecord(rConst, 'sval') : undefined;
          const likePattern = svalObj ? getString(svalObj, 'sval') : undefined;

          let opclass: 'text_pattern_ops' | 'varchar_pattern_ops' | undefined;
          if (likePattern && /^[^%_]+%$/.test(likePattern)) {
            const colType = tableColumnTypes.get(colLeft) ?? '';
            if (colType.includes('varchar') || colType.includes('character varying')) {
              opclass = 'varchar_pattern_ops';
            } else if (colType.includes('text')) {
              opclass = 'text_pattern_ops';
            }
          }
          rangeColumns.set(colLeft, { opclass });
          continue;
        }

        if (kind === 'AEXPR_OP') {
          const nameList = aExpr['name'];
          let opName: string | undefined;
          if (Array.isArray(nameList) && isRecord(nameList[0])) {
            const strObj = getRecord(nameList[0], 'String');
            if (strObj) {
              opName = getString(strObj, 'sval');
            }
          }

          if (opName === '=') {
            if (colLeft && !colRight) {
              equalityColumns.add(colLeft);
            } else if (colRight && !colLeft) {
              equalityColumns.add(colRight);
            } else {
              return { error: 'Query contains column-to-column comparison or complex expression.' };
            }
            continue;
          }

          if (
            opName === '>' ||
            opName === '>=' ||
            opName === '<' ||
            opName === '<=' ||
            opName === '<>' ||
            opName === '!='
          ) {
            const targetCol = colLeft ?? colRight;
            if (!targetCol) return { error: 'Query contains expression in comparison predicate.' };
            rangeColumns.set(targetCol, {});
            continue;
          }

          if (opName === '~~' || opName === 'LIKE') {
            if (!colLeft) return { error: 'Query contains expression in LIKE predicate.' };
            const rConst = isRecord(rexpr) ? getRecord(rexpr, 'A_Const') : undefined;
            const svalObj = rConst ? getRecord(rConst, 'sval') : undefined;
            const likePattern = svalObj ? getString(svalObj, 'sval') : undefined;

            let opclass: 'text_pattern_ops' | 'varchar_pattern_ops' | undefined;
            if (likePattern && /^[^%_]+%$/.test(likePattern)) {
              const colType = tableColumnTypes.get(colLeft) ?? '';
              if (colType.includes('varchar') || colType.includes('character varying')) {
                opclass = 'varchar_pattern_ops';
              } else if (colType.includes('text')) {
                opclass = 'text_pattern_ops';
              }
            }
            rangeColumns.set(colLeft, { opclass });
            continue;
          }
        }

        return { error: 'Query contains unsupported expression in WHERE clause.' };
      }

      return { error: 'Query contains unsupported expression in WHERE clause.' };
    }
  }

  // 3. ORDER BY Clause analysis
  const sortColumns: Array<{ name: string; direction: 'asc' | 'desc'; nulls?: 'first' | 'last' }> =
    [];
  const sortClause = selectStmt['sortClause'];
  if (Array.isArray(sortClause)) {
    for (const sortItem of sortClause) {
      if (!isRecord(sortItem)) continue;
      const sortBy = getRecord(sortItem, 'SortBy');
      if (!sortBy) continue;

      const col = extractColumnName(sortBy['node'], tableName);
      if (!col) {
        return { error: 'Query contains expression in ORDER BY clause.' };
      }

      const dirStr = getString(sortBy, 'sortby_dir');
      const direction: 'asc' | 'desc' = dirStr === 'SORTBY_DESC' ? 'desc' : 'asc';

      const nullsStr = getString(sortBy, 'sortby_nulls');
      let nulls: 'first' | 'last' | undefined;
      if (nullsStr === 'SORTBY_NULLS_FIRST') nulls = 'first';
      else if (nullsStr === 'SORTBY_NULLS_LAST') nulls = 'last';

      sortColumns.push({ name: col, direction, nulls });
    }
  }

  // 4. Target List (SELECT columns) analysis
  const selectedColumns: string[] = [];
  let isSelectAll = false;
  const targetList = selectStmt['targetList'];
  if (Array.isArray(targetList)) {
    for (const target of targetList) {
      if (!isRecord(target)) continue;
      const resTarget = getRecord(target, 'ResTarget');
      if (!resTarget) continue;

      const val = getRecord(resTarget, 'val');
      if (val) {
        const colRef = getRecord(val, 'ColumnRef');
        if (colRef) {
          const fields = colRef['fields'];
          if (Array.isArray(fields)) {
            const hasStar = fields.some((f) => isRecord(f) && Boolean(f['A_Star']));
            if (hasStar) {
              isSelectAll = true;
              break;
            }
            const col = extractColumnName(val, tableName);
            if (col && !selectedColumns.includes(col)) {
              selectedColumns.push(col);
            }
          }
        }
      }
    }
  }

  return {
    features: {
      tableName,
      equalityColumns,
      rangeColumns,
      sortColumns,
      selectedColumns,
      isSelectAll,
    },
  };
}

/**
 * Plans a candidate index deterministically using the Equality-Sort-Range (ESR) rule.
 */
export async function planEsrIndex(
  queryAst: ParsedStatement,
  catalog: Catalog,
): Promise<EsrPlanResult> {
  const extracted = extractQueryFeatures(queryAst, catalog);
  if ('error' in extracted) {
    return { spec: null, reason: extracted.error };
  }

  const { tableName, equalityColumns, rangeColumns, sortColumns, selectedColumns, isSelectAll } =
    extracted.features;

  const keyColumns: IndexColumnSpec[] = [];
  const seenKeyCols = new Set<string>();

  // 1. Equality columns
  for (const eqCol of equalityColumns) {
    if (!seenKeyCols.has(eqCol)) {
      seenKeyCols.add(eqCol);
      keyColumns.push({ name: eqCol });
    }
  }

  // 2. Sort columns (if column is already in equality, sorting on it is redundant)
  for (const sortCol of sortColumns) {
    if (!seenKeyCols.has(sortCol.name)) {
      seenKeyCols.add(sortCol.name);
      keyColumns.push({
        name: sortCol.name,
        direction: sortCol.direction,
        nulls: sortCol.nulls,
      });
    }
  }

  // 3. Range columns (a column that is both sort and range appears once, in sort position)
  for (const [rangeCol, options] of rangeColumns.entries()) {
    if (!seenKeyCols.has(rangeCol)) {
      seenKeyCols.add(rangeCol);
      keyColumns.push({
        name: rangeCol,
        opclass: options.opclass,
      });
    }
  }

  if (keyColumns.length === 0) {
    return { spec: null, reason: 'Query has no filter or sort columns suitable for an index.' };
  }

  // 4. INCLUDE columns (selected columns not in key, 1-3 columns, not SELECT *)
  let includeCols: string[] | undefined;
  if (!isSelectAll) {
    const candidateInclude = selectedColumns.filter((col) => !seenKeyCols.has(col));
    if (candidateInclude.length >= 1 && candidateInclude.length <= 3) {
      includeCols = candidateInclude;
    }
  }

  const candidateSpec: CandidateIndexSpec = {
    table: tableName,
    columns: keyColumns,
    include: includeCols,
  };

  // 5. Validate against catalog and check existing index equivalence
  const validation = await validateIndexSpec(candidateSpec, catalog, new Set([tableName]));
  if (!validation.valid) {
    return { spec: null, reason: validation.reason };
  }

  const ddl = buildIndexDdl(validation.spec);
  const esr = classifyEsrRoles(validation.spec, queryAst, catalog);

  return {
    spec: validation.spec,
    ddl,
    esr,
  };
}

/**
 * Classifies the role of each column in an index spec (ESR role badges for UI).
 */
export function classifyEsrRoles(
  spec: CandidateIndexSpec,
  queryAst: ParsedStatement,
  catalog: Catalog,
): EsrClassification[] {
  const extracted = extractQueryFeatures(queryAst, catalog);
  const features = 'features' in extracted ? extracted.features : null;

  const result: EsrClassification[] = [];

  for (const col of spec.columns) {
    const colName = col.name.toLowerCase();

    if (features?.equalityColumns.has(colName)) {
      result.push({
        column: colName,
        role: 'Equality',
        reason: `Filters rows on "${colName}" using equality (=, IN, or IS NULL).`,
      });
    } else if (features?.sortColumns.some((s) => s.name === colName)) {
      const sort = features.sortColumns.find((s) => s.name === colName);
      result.push({
        column: colName,
        role: 'Sort',
        reason: `Orders rows on "${colName}" (${sort?.direction ?? 'asc'}) without an in-memory sort pass.`,
      });
    } else if (features?.rangeColumns.has(colName)) {
      result.push({
        column: colName,
        role: 'Range',
        reason: `Filters rows on "${colName}" using range comparison or prefix pattern.`,
      });
    } else {
      result.push({
        column: colName,
        role: 'Other',
        reason: `Additional index key column "${colName}".`,
      });
    }
  }

  if (Array.isArray(spec.include)) {
    for (const inc of spec.include) {
      const incName = inc.toLowerCase();
      result.push({
        column: incName,
        role: 'Include',
        reason: `Payload column included in index leaf pages to enable Index Only Scan.`,
      });
    }
  }

  return result;
}
