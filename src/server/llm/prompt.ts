import type { Catalog } from '../sql/catalog.js';
import { stripAndMaskQuery } from '../sql/strip-and-mask.js';

const SYSTEM_INSTRUCTION = `You are a Principal PostgreSQL Database Reliability Engineer.
Your objective is to recommend an optimal B-tree index for a slow query or determine that no new index is needed.

Rules:
1. Follow the Equality-Sort-Range (ESR) rule strictly:
   - Equality filter columns first (=, IN, IS NULL).
   - Sort columns second (matching ORDER BY direction and NULLS order).
   - Range filter columns last (<, <=, >, >=, BETWEEN, LIKE prefix).
   - If a column is in both Sort and Range, place it once in the Sort position.
2. INCLUDE clause:
   - Include 1 to 3 extra selected columns only when an Index Only Scan is plausible.
   - Never include columns already in the index key.
   - Never use INCLUDE for queries selecting all table columns (SELECT *).
3. Partial index:
   - Use a WHERE clause only for constant, highly selective predicates (e.g. status = 1, deleted_at IS NULL).
4. Pattern operations:
   - For LIKE 'prefix%' on varchar/text, specify opclass 'varchar_pattern_ops' or 'text_pattern_ops'.
5. Do not propose an index equivalent to an existing index in the catalog.
6. If existing indexes are optimal or no index can improve the query, return index: null.
7. Return strictly a JSON object matching the required schema.`;

export const MODEL_JSON_SCHEMA = {
  type: 'object',
  properties: {
    index: {
      type: 'object',
      nullable: true,
      properties: {
        table: { type: 'string' },
        columns: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              direction: { type: 'string', enum: ['asc', 'desc'] },
              nulls: { type: 'string', enum: ['first', 'last'] },
              opclass: { type: 'string', enum: ['text_pattern_ops', 'varchar_pattern_ops'] },
            },
            required: ['name'],
          },
        },
        include: {
          type: 'array',
          items: { type: 'string' },
        },
        where: { type: 'string', nullable: true },
      },
      required: ['table', 'columns'],
    },
    headline: { type: 'string' },
    explanation: { type: 'string' },
    antiPatterns: {
      type: 'array',
      items: { type: 'string' },
    },
    esr: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          column: { type: 'string' },
          reason: { type: 'string' },
        },
        required: ['column', 'reason'],
      },
    },
  },
  required: ['headline', 'explanation'],
} as const;

export type PromptBuildOptions = {
  catalog: Catalog;
  querySql: string;
  nonce: string;
  hints?: {
    equalityColumns?: string[];
    sortColumns?: string[];
    rangeColumns?: string[];
    selectedColumns?: string[];
  };
  includeJsonInPrompt?: boolean;
};

export type BuiltPrompt = {
  systemInstruction: string;
  userPrompt: string;
};

/**
 * Builds the structured LLM prompt enforcing Invariant I9:
 * - Only validated identifiers and column types
 * - Literal-masked query ($1..$N) with all SQL comments stripped
 * - Zero enum labels, defaults, or raw DDL
 * - Section delimiters with request nonce
 */
export function buildPrompt(options: PromptBuildOptions): BuiltPrompt {
  const { catalog, querySql, nonce, hints, includeJsonInPrompt } = options;

  // 1. Build sanitized catalog summary
  const tables = Object.values(catalog.tables).map((table) => ({
    table: table.name,
    columns: table.columns.map((col) => ({
      name: col.name,
      type: col.type,
      nullable: col.nullable,
    })),
    primaryKey: table.primaryKey,
    existingIndexes: table.indexes.map((idx) => ({
      name: idx.name,
      columns: idx.columns.map((c) => ({
        name: c.name,
        direction: c.direction,
      })),
    })),
  }));

  const catalogJson = JSON.stringify({ tables }, null, 2);

  // 2. Mask string literals and strip comments from query (Invariant I9)
  const { maskedSql } = stripAndMaskQuery(querySql);

  // 3. Format analyzer hints
  const hintsObj = {
    equalityColumns: hints?.equalityColumns ?? [],
    sortColumns: hints?.sortColumns ?? [],
    rangeColumns: hints?.rangeColumns ?? [],
    selectedColumns: hints?.selectedColumns ?? [],
    notice: 'Analyzer hints are heuristic indicators and may be incomplete.',
  };
  const hintsJson = JSON.stringify(hintsObj, null, 2);

  // 4. Assemble user prompt with nonce delimiters
  let userPrompt = `=== CATALOG_${nonce} ===
${catalogJson}

=== QUERY_${nonce} ===
${maskedSql.trim()}

=== HINTS_${nonce} ===
${hintsJson}`;

  if (includeJsonInPrompt) {
    userPrompt += `\n\n=== RESPONSE_FORMAT ===
Output strictly a JSON object with this shape:
{
  "index": null or {
    "table": "table_name",
    "columns": [{ "name": "column_name", "direction": "asc"|"desc", "nulls": "first"|"last", "opclass": "text_pattern_ops"|"varchar_pattern_ops" }],
    "include": ["column_name"],
    "where": "status = 1" or null
  },
  "headline": "concise recommendation summary (max 120 chars)",
  "explanation": "why this index improves execution plan (max 600 chars)",
  "antiPatterns": ["list of query anti-patterns if any"],
  "esr": [{ "column": "col_name", "reason": "role reason" }]
}`;
  }

  return {
    systemInstruction: SYSTEM_INSTRUCTION,
    userPrompt,
  };
}
