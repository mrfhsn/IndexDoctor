export interface MaskedQueryResult {
  maskedSql: string;
  literalCount: number;
}

/**
 * Strips comments and masks string literals from a query.
 * Guarantees that no raw user string literal text is forwarded to LLM prompts (Invariant I9).
 */
export function stripAndMaskQuery(sql: string): MaskedQueryResult {
  let masked = '';
  let literalCount = 0;
  let i = 0;

  while (i < sql.length) {
    const char = sql[i];
    const next = sql[i + 1];

    // 1. Single-line comment (-- ...)
    if (char === '-' && next === '-') {
      i += 2;
      while (i < sql.length && sql[i] !== '\n') {
        i++;
      }
      if (i < sql.length && sql[i] === '\n') {
        masked += '\n';
        i++;
      }
      continue;
    }

    // 2. Multi-line comment (/* ... */)
    if (char === '/' && next === '*') {
      i += 2;
      while (i < sql.length && !(sql[i] === '*' && sql[i + 1] === '/')) {
        if (sql[i] === '\n') masked += '\n'; // preserve line numbers
        i++;
      }
      if (i < sql.length) {
        i += 2; // skip */
      }
      continue;
    }

    // 3. Quoted identifier ("...") - preserve verbatim
    if (char === '"') {
      masked += '"';
      i++;
      while (i < sql.length) {
        if (sql[i] === '"') {
          if (sql[i + 1] === '"') {
            masked += '""';
            i += 2;
          } else {
            masked += '"';
            i++;
            break;
          }
        } else {
          masked += sql[i];
          i++;
        }
      }
      continue;
    }

    // 4. String literal ('...') - replace with $N placeholder
    if (char === "'") {
      i++;
      // Consume the string literal
      while (i < sql.length) {
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") {
            i += 2; // escaped quote
          } else {
            i++; // end of literal
            break;
          }
        } else {
          i++;
        }
      }
      literalCount++;
      masked += `$${literalCount}`;
      continue;
    }

    // 5. Standard character
    masked += char;
    i++;
  }

  // Clean up excess whitespace while preserving line structure
  const normalized = masked
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line, index, arr) => line.length > 0 || (index > 0 && arr[index - 1]!.length > 0))
    .join('\n')
    .trim();

  return {
    maskedSql: normalized,
    literalCount,
  };
}
