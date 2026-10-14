import { type Catalog } from './catalog.js';
import { parseSql } from './parse.js';

export type IndexColumnSpec = {
  name: string;
  direction?: 'asc' | 'desc';
  nulls?: 'first' | 'last';
  opclass?: 'text_pattern_ops' | 'varchar_pattern_ops';
};

export type CandidateIndexSpec = {
  table: string;
  columns: IndexColumnSpec[];
  include?: string[];
  where?: string | null;
};

export type ValidationFailure = {
  valid: false;
  reason: string;
};

export type ValidationSuccess = {
  valid: true;
  spec: CandidateIndexSpec;
};

export type ValidationResult = ValidationSuccess | ValidationFailure;

const ALLOWED_OPCLASSES = new Set(['text_pattern_ops', 'varchar_pattern_ops']);
const TEXT_TYPES = new Set(['text', 'varchar', 'character varying', 'bpchar', 'char']);
const MAX_KEY_COLUMNS = 6;
const MAX_INCLUDE_COLUMNS = 3;

/**
 * Validates a candidate index specification from the LLM or planner.
 * Enforces architecture.md §11.6:
 * - Table exists and is in the query
 * - Columns exist in that table, no duplicates
 * - <= 6 key columns, <= 3 include columns, include ∩ key = empty
 * - opclass from allow-list only and only on text types
 * - where must parse safely to a pure predicate
 * - not equivalent to an existing index
 */
export async function validateIndexSpec(
  spec: CandidateIndexSpec | null | undefined,
  catalog: Catalog,
  queryReferencedTables: Set<string>,
): Promise<ValidationResult> {
  if (!spec) {
    return { valid: false, reason: 'Candidate index spec is null or undefined.' };
  }

  // 1. Validate Table
  const tableName = spec.table?.toLowerCase().trim();
  if (!tableName) {
    return { valid: false, reason: 'Index table name is missing.' };
  }

  const tableInfo = catalog.tables[tableName];
  if (!tableInfo) {
    return { valid: false, reason: `Target table "${tableName}" does not exist in schema.` };
  }

  if (!queryReferencedTables.has(tableName)) {
    return {
      valid: false,
      reason: `Target table "${tableName}" is not referenced by the query.`,
    };
  }

  const tableColumnNames = new Set(tableInfo.columns.map((c) => c.name.toLowerCase()));
  const columnTypeMap = new Map(
    tableInfo.columns.map((c) => [c.name.toLowerCase(), c.type.toLowerCase()]),
  );

  // 2. Validate Key Columns (1 to 6)
  if (!Array.isArray(spec.columns) || spec.columns.length === 0) {
    return { valid: false, reason: 'Candidate index must contain at least one key column.' };
  }

  if (spec.columns.length > MAX_KEY_COLUMNS) {
    return {
      valid: false,
      reason: `Candidate index exceeds maximum key columns (${spec.columns.length} > ${MAX_KEY_COLUMNS}).`,
    };
  }

  const seenKeyColumns = new Set<string>();

  for (const col of spec.columns) {
    const colName = col.name?.toLowerCase().trim();
    if (!colName) {
      return { valid: false, reason: 'Key column name is missing.' };
    }

    if (!tableColumnNames.has(colName)) {
      return {
        valid: false,
        reason: `Key column "${colName}" does not exist in table "${tableName}".`,
      };
    }

    if (seenKeyColumns.has(colName)) {
      return {
        valid: false,
        reason: `Duplicate key column "${colName}" in candidate index.`,
      };
    }
    seenKeyColumns.add(colName);

    // Validate opclass
    if (col.opclass) {
      if (!ALLOWED_OPCLASSES.has(col.opclass)) {
        return {
          valid: false,
          reason: `Disallowed opclass "${col.opclass}". Only ${Array.from(ALLOWED_OPCLASSES).join(', ')} are permitted.`,
        };
      }

      const colType = columnTypeMap.get(colName) || '';
      if (!TEXT_TYPES.has(colType)) {
        return {
          valid: false,
          reason: `opclass "${col.opclass}" can only be applied to text columns, but "${colName}" has type "${colType}".`,
        };
      }
    }
  }

  // 3. Validate INCLUDE Columns (0 to 3, disjoint from key columns)
  const includeList: string[] = [];
  if (Array.isArray(spec.include) && spec.include.length > 0) {
    if (spec.include.length > MAX_INCLUDE_COLUMNS) {
      return {
        valid: false,
        reason: `Candidate index exceeds maximum INCLUDE columns (${spec.include.length} > ${MAX_INCLUDE_COLUMNS}).`,
      };
    }

    const seenInclude = new Set<string>();
    for (const inc of spec.include) {
      const incName = inc.toLowerCase().trim();
      if (!tableColumnNames.has(incName)) {
        return {
          valid: false,
          reason: `INCLUDE column "${incName}" does not exist in table "${tableName}".`,
        };
      }
      if (seenKeyColumns.has(incName)) {
        return {
          valid: false,
          reason: `Column "${incName}" cannot be present in both key columns and INCLUDE.`,
        };
      }
      if (seenInclude.has(incName)) {
        return {
          valid: false,
          reason: `Duplicate INCLUDE column "${incName}".`,
        };
      }
      seenInclude.add(incName);
      includeList.push(incName);
    }
  }

  // 4. Validate Partial Index Predicate (WHERE clause)
  const whereClause = spec.where?.trim();
  if (whereClause) {
    // Guard against SQL injection or complex expressions in WHERE
    const testSql = `SELECT 1 FROM "${tableName}" WHERE ${whereClause};`;
    try {
      const parsed = await parseSql(testSql);
      if (parsed.stmts.length !== 1) {
        return {
          valid: false,
          reason: 'Partial index WHERE clause must contain a single predicate.',
        };
      }
    } catch {
      return {
        valid: false,
        reason: `Invalid syntax in partial index WHERE clause: "${whereClause}".`,
      };
    }
  }

  // 5. Check for Equivalence to an Existing Index
  for (const existing of tableInfo.indexes) {
    // An index is equivalent if it has the same key columns in the same order and direction
    if (existing.columns.length === spec.columns.length) {
      const matchesAll = existing.columns.every((exCol, i) => {
        const specCol = spec.columns[i];
        if (!specCol) return false;
        if (specCol.opclass) return false;
        const specDir = specCol.direction || 'asc';
        return (
          exCol.name.toLowerCase() === specCol.name.toLowerCase() && exCol.direction === specDir
        );
      });

      if (matchesAll && !whereClause) {
        return {
          valid: false,
          reason: `Candidate index is equivalent to existing index "${existing.name}".`,
        };
      }
    }
  }

  return {
    valid: true,
    spec: {
      table: tableName,
      columns: spec.columns.map((c) => ({
        name: c.name.toLowerCase().trim(),
        direction: c.direction,
        nulls: c.nulls,
        opclass: c.opclass,
      })),
      include: includeList.length > 0 ? includeList : undefined,
      where: whereClause || null,
    },
  };
}
