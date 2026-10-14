import { buildIndexName } from '../sql/ddl.js';
import type { CandidateIndexSpec } from '../sql/index-spec.js';

export type DrizzleMigration = {
  snippet: string;
  notes: string[];
};

function toCamelCase(snake: string): string {
  return snake.replace(/_([a-z0-9])/g, (_, char) => char.toUpperCase());
}

/**
 * Generates copy-ready Drizzle ORM index definitions.
 * Warns about features requiring raw SQL migrations (INCLUDE, partial WHERE).
 */
export function generateDrizzleMigration(
  spec: CandidateIndexSpec,
  customName?: string,
): DrizzleMigration {
  const indexName = customName || buildIndexName(spec);
  const notes: string[] = [
    'Ensure column names match the TypeScript property names in your pgTable definition.',
  ];

  const colArgs = spec.columns.map((col) => {
    const propName = toCamelCase(col.name);
    if (col.direction === 'desc') {
      return `table.${propName}.desc()`;
    }
    if (col.direction === 'asc') {
      return `table.${propName}.asc()`;
    }
    return `table.${propName}`;
  });

  if (spec.include && spec.include.length > 0) {
    notes.push(
      `Drizzle ORM does not support the INCLUDE clause natively for [${spec.include.join(', ')}]. Use a raw SQL migration.`,
    );
  }

  if (spec.where) {
    notes.push(
      `Drizzle ORM index builder does not support partial WHERE clauses natively ("${spec.where}"). Use a raw SQL migration.`,
    );
  }

  const snippet = `// In your schema file (e.g. src/schema.ts):
import { index } from 'drizzle-orm/pg-core';

// Add to your pgTable definition callback:
(table) => [
  index('${indexName}').on(${colArgs.join(', ')}),
]`;

  return { snippet, notes };
}
