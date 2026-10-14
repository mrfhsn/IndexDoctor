import crypto from 'node:crypto';

import type { CandidateIndexSpec } from './index-spec.js';

export type GeneratedDdl = {
  name: string;
  create: string;
  createConcurrently: string;
};

/**
 * Builds a deterministic, PostgreSQL-compliant index identifier.
 * Postgres identifiers are limited to 63 bytes.
 * If idx_<table>_<cols> exceeds 63 chars, truncates and appends a 6-char hash.
 */
export function buildIndexName(spec: CandidateIndexSpec): string {
  const colNames = spec.columns.map((c) => c.name.toLowerCase()).join('_');
  const baseName = `idx_${spec.table.toLowerCase()}_${colNames}`;

  if (baseName.length <= 63) {
    return baseName;
  }

  const hash = crypto
    .createHash('sha256')
    .update(`${spec.table}:${colNames}:${spec.where || ''}`)
    .digest('hex')
    .slice(0, 6);

  // Leave room for _ and 6-char hash
  const truncated = baseName.slice(0, 63 - 7);
  return `${truncated}_${hash}`;
}

/**
 * The ONLY builder of CREATE INDEX DDL in the application.
 * Identifiers are quoted with double quotes.
 * Model input strings are never interpolated directly.
 * (architecture.md §11.6)
 */
export function buildIndexDdl(spec: CandidateIndexSpec, customName?: string): GeneratedDdl {
  const indexName = customName || buildIndexName(spec);
  const tableName = spec.table.toLowerCase().trim();

  // 1. Build column expressions
  const colExprs = spec.columns.map((col) => {
    let expr = `"${col.name.toLowerCase().trim()}"`;
    if (col.opclass) {
      expr += ` ${col.opclass}`;
    }
    if (col.direction === 'desc') {
      expr += ' DESC';
    } else if (col.direction === 'asc') {
      expr += ' ASC';
    }

    if (col.nulls === 'first') {
      expr += ' NULLS FIRST';
    } else if (col.nulls === 'last') {
      expr += ' NULLS LAST';
    }

    return expr;
  });

  const columnsClause = `(${colExprs.join(', ')})`;

  // 2. Build INCLUDE clause
  let includeClause = '';
  if (Array.isArray(spec.include) && spec.include.length > 0) {
    const includeCols = spec.include.map((c) => `"${c.toLowerCase().trim()}"`).join(', ');
    includeClause = ` INCLUDE (${includeCols})`;
  }

  // 3. Build WHERE clause
  let whereClause = '';
  if (spec.where?.trim()) {
    whereClause = ` WHERE (${spec.where.trim()})`;
  }

  const create = `CREATE INDEX "${indexName}" ON "${tableName}" ${columnsClause}${includeClause}${whereClause};`;
  const createConcurrently = `CREATE INDEX CONCURRENTLY IF NOT EXISTS "${indexName}" ON "${tableName}" ${columnsClause}${includeClause}${whereClause};`;

  return {
    name: indexName,
    create,
    createConcurrently,
  };
}
