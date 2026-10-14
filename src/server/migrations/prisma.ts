import { buildIndexName } from '../sql/ddl.js';
import type { CandidateIndexSpec } from '../sql/index-spec.js';

export type PrismaMigration = {
  snippet: string;
  notes: string[];
};

function toCamelCase(snake: string): string {
  return snake.replace(/_([a-z0-9])/g, (_, char) => char.toUpperCase());
}

/**
 * Generates copy-ready Prisma schema @@index attributes.
 * Warns about unsupported Prisma features (INCLUDE, partial WHERE, opclasses).
 */
export function generatePrismaMigration(
  spec: CandidateIndexSpec,
  customName?: string,
): PrismaMigration {
  const indexName = customName || buildIndexName(spec);
  const notes: string[] = [
    'Ensure field names match the Prisma model field definitions in schema.prisma.',
  ];

  const colArgs = spec.columns.map((col) => {
    const fieldName = toCamelCase(col.name);
    if (col.direction === 'desc') {
      return `${fieldName}(sort: Desc)`;
    }
    if (col.direction === 'asc') {
      return `${fieldName}(sort: Asc)`;
    }
    return fieldName;
  });

  if (spec.include && spec.include.length > 0) {
    notes.push(
      `Prisma does not support covering INCLUDE indexes (prisma/prisma #8584). Run raw SQL migration with "prisma db execute".`,
    );
  }

  if (spec.where) {
    notes.push(
      `Prisma does not support partial indexes (WHERE "${spec.where}"). Run raw SQL migration.`,
    );
  }

  const hasOpclass = spec.columns.some((c) => Boolean(c.opclass));
  if (hasOpclass) {
    notes.push(
      'Prisma does not support specialized operator classes (e.g. varchar_pattern_ops). Run raw SQL migration.',
    );
  }

  const snippet = `// In schema.prisma inside your model definition:
@@index([${colArgs.join(', ')}], name: "${indexName}")`;

  return { snippet, notes };
}
