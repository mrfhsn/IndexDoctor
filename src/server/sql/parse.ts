import { hasSqlDetails, parse } from 'libpg-query';

import { AppError } from '../errors.js';

export interface ParsedStatement {
  stmt: Record<string, unknown>;
  stmt_location?: number;
  stmt_len?: number;
}

export interface ParseResult {
  version?: number;
  stmts: ParsedStatement[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const MAX_PAREN_DEPTH = 200;
const MAX_AST_NODES = 20000;

/**
 * Validates parenthesis nesting depth to protect against stack-overflow attacks.
 * Skips parenthesis inside string literals and SQL comments.
 */
export function checkParenDepth(sql: string, maxDepth = MAX_PAREN_DEPTH): number {
  let depth = 0;
  let maxObserved = 0;
  let inString = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (let i = 0; i < sql.length; i++) {
    const char = sql[i];
    const next = sql[i + 1];

    if (inLineComment) {
      if (char === '\n') inLineComment = false;
      continue;
    }

    if (inBlockComment) {
      if (char === '*' && next === '/') {
        inBlockComment = false;
        i++;
      }
      continue;
    }

    if (inString) {
      if (char === "'") {
        if (next === "'") {
          i++; // Escaped single quote
        } else {
          inString = false;
        }
      }
      continue;
    }

    // Check for comment starts
    if (char === '-' && next === '-') {
      inLineComment = true;
      i++;
      continue;
    }
    if (char === '/' && next === '*') {
      inBlockComment = true;
      i++;
      continue;
    }

    if (char === "'") {
      inString = true;
      continue;
    }

    if (char === '(') {
      depth++;
      if (depth > maxObserved) maxObserved = depth;
      if (depth > maxDepth) {
        throw new AppError(
          'UNSUPPORTED_SQL',
          `Excessive parenthesis nesting depth (> ${maxDepth})`,
          {
            status: 422,
            hint: 'Simplify deeply nested subqueries or expressions.',
          },
        );
      }
    } else if (char === ')') {
      if (depth > 0) depth--;
    }
  }

  return maxObserved;
}

/**
 * Counts total nodes in the parsed AST object to protect memory.
 */
function countAstNodes(node: unknown): number {
  if (!node || typeof node !== 'object') return 0;
  let count = 1;

  if (Array.isArray(node)) {
    for (const item of node) {
      count += countAstNodes(item);
    }
  } else if (isRecord(node)) {
    for (const val of Object.values(node)) {
      count += countAstNodes(val);
    }
  }

  return count;
}

/**
 * Parses SQL using libpg-query (Postgres parser WASM).
 * Strictly enforces byte limits, NUL-byte guards, paren depth, and node limits.
 */
export async function parseSql(sql: string): Promise<ParseResult> {
  if (sql.includes('\0')) {
    throw new AppError('UNSUPPORTED_SQL', 'SQL text contains null bytes', {
      status: 422,
      hint: 'Remove null bytes from SQL input.',
    });
  }

  checkParenDepth(sql);

  let raw: { version?: number; stmts?: unknown[] };
  try {
    raw = await parse(sql);
  } catch (err: unknown) {
    let message = 'SQL syntax error';
    let cursor: number | undefined;

    if (hasSqlDetails(err)) {
      message = err.sqlDetails?.message || err.message || message;
      cursor = err.sqlDetails?.cursorPosition;
    } else if (err instanceof Error) {
      message = err.message;
    }

    const hint =
      cursor !== undefined ? `Syntax error at cursor position ${cursor}.` : 'Check SQL syntax.';

    throw new AppError('UNSUPPORTED_SQL', message, {
      status: 422,
      hint,
    });
  }

  const stmts: ParsedStatement[] = [];
  if (Array.isArray(raw.stmts)) {
    for (const s of raw.stmts) {
      if (isRecord(s) && isRecord(s['stmt'])) {
        const stmtLocation =
          typeof s['stmt_location'] === 'number' ? s['stmt_location'] : undefined;
        const stmtLen = typeof s['stmt_len'] === 'number' ? s['stmt_len'] : undefined;
        stmts.push({
          stmt: s['stmt'],
          stmt_location: stmtLocation,
          stmt_len: stmtLen,
        });
      }
    }
  }

  const result: ParseResult = {
    version: raw.version,
    stmts,
  };

  const nodeCount = countAstNodes(result.stmts);
  if (nodeCount > MAX_AST_NODES) {
    throw new AppError(
      'PAYLOAD_TOO_LARGE',
      `SQL AST exceeds maximum allowed complexity (${nodeCount} nodes > ${MAX_AST_NODES})`,
      {
        status: 413,
        hint: 'Reduce schema or query size and complexity.',
      },
    );
  }

  return result;
}
