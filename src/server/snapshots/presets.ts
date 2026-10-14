import type { PresetId, DiagnoseResponse } from '../../shared/contract.js';

/**
 * Pre-recorded Tier B snapshots from PGlite in WASM.
 * Returned when the live sandbox pipeline is recovering/unavailable and presetId is provided.
 * (architecture.md §12 Level L4)
 */
export const PRESET_SNAPSHOTS: Record<
  PresetId,
  Omit<DiagnoseResponse, 'requestId' | 'cached' | 'timingsMs'>
> = {
  'orders-composite': {
    outcome: 'improved',
    verification: {
      status: 'verified',
      indexUsed: true,
      costBefore: 7652.02,
      costAfter: 8.23,
      costReductionPercent: 99.9,
      costRatio: 929.77,
      severity: 'CRITICAL',
    },
    recommendation: {
      index: {
        table: 'orders',
        name: 'idx_orders_status_created_at',
        columns: [
          { name: 'status', direction: 'ASC' },
          { name: 'created_at', direction: 'DESC' },
        ],
        include: [],
        where: null,
      },
      sql: {
        create:
          'CREATE INDEX "idx_orders_status_created_at" ON "orders" ("status" ASC, "created_at" DESC);',
        createConcurrently:
          'CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_orders_status_created_at" ON "orders" ("status" ASC, "created_at" DESC);',
      },
      headline: 'Optimize order status filtering and sorting',
      explanation:
        'Composite index directly matches the equality predicate on status and satisfies the reverse sort order on created_at.',
      antiPatterns: [],
      esr: [
        { column: 'status', role: 'Equality', reason: 'Equality predicate in WHERE clause' },
        { column: 'created_at', role: 'Sort', reason: 'ORDER BY created_at DESC' },
      ],
      migrations: {
        postgres:
          'CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_orders_status_created_at" ON "orders" ("status" ASC, "created_at" DESC);',
        drizzle:
          'index("idx_orders_status_created_at").on(table.status.asc(), table.createdAt.desc())',
        prisma:
          '@@index([status(sort: Asc), createdAt(sort: Desc)], map: "idx_orders_status_created_at")',
      },
      migrationNotes: [
        'CREATE INDEX CONCURRENTLY cannot execute inside a transaction block.',
        'Ensure column names match the TypeScript property names in your pgTable definition.',
        'Ensure field names match the Prisma model field definitions in schema.prisma.',
      ],
    },
    plans: {
      before: {
        nodePath: 'Seq Scan',
        primaryScan: 'Seq Scan',
        startupCost: 0,
        totalCost: 7652.02,
        planRows: 50000,
        usesIndexes: [],
        tree: {
          type: 'Seq Scan',
          relation: 'orders',
          startupCost: 0,
          totalCost: 7652.02,
          planRows: 50000,
          children: [],
        },
      },
      after: {
        nodePath: 'Index Scan',
        primaryScan: 'Index Scan',
        startupCost: 0.28,
        totalCost: 8.23,
        planRows: 1,
        usesIndexes: ['idx_orders_status_created_at'],
        tree: {
          type: 'Index Scan',
          relation: 'orders',
          indexName: 'idx_orders_status_created_at',
          startupCost: 0.28,
          totalCost: 8.23,
          planRows: 1,
          children: [],
        },
      },
    },
    source: {
      proposedBy: 'deterministic',
      model: null,
      attempts: [],
    },
    alternative: null,
    assumptions: {
      assumedRowCount: 500000,
      seededRows: 20000,
      plannerSettings: 'postgres-defaults',
      tablesScaledEqually: true,
    },
    notices: ['Tier B snapshot served from verified PGlite recordings.'],
  },
  'events-multitenant': {
    outcome: 'improved',
    verification: {
      status: 'verified',
      indexUsed: true,
      costBefore: 8917.07,
      costAfter: 21.92,
      costReductionPercent: 99.8,
      costRatio: 406.8,
      severity: 'CRITICAL',
    },
    recommendation: {
      index: {
        table: 'events',
        name: 'idx_events_tenant_type_created',
        columns: [
          { name: 'tenant_id', direction: 'ASC' },
          { name: 'event_type', direction: 'ASC' },
          { name: 'created_at', direction: 'DESC' },
        ],
        include: [],
        where: null,
      },
      sql: {
        create:
          'CREATE INDEX "idx_events_tenant_type_created" ON "events" ("tenant_id" ASC, "event_type" ASC, "created_at" DESC);',
        createConcurrently:
          'CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_events_tenant_type_created" ON "events" ("tenant_id" ASC, "event_type" ASC, "created_at" DESC);',
      },
      headline: 'Multi-tenant event partition index',
      explanation:
        'Composite B-tree index indexing tenant_id, event_type, and descending timestamp eliminates full table scan.',
      antiPatterns: [],
      esr: [
        { column: 'tenant_id', role: 'Equality', reason: 'Equality filter on tenant ID' },
        { column: 'event_type', role: 'Equality', reason: 'Equality filter on event type' },
        { column: 'created_at', role: 'Sort', reason: 'ORDER BY created_at DESC' },
      ],
      migrations: {
        postgres:
          'CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_events_tenant_type_created" ON "events" ("tenant_id" ASC, "event_type" ASC, "created_at" DESC);',
        drizzle:
          'index("idx_events_tenant_type_created").on(table.tenantId.asc(), table.eventType.asc(), table.createdAt.desc())',
        prisma:
          '@@index([tenantId(sort: Asc), eventType(sort: Asc), createdAt(sort: Desc)], map: "idx_events_tenant_type_created")',
      },
      migrationNotes: [
        'CREATE INDEX CONCURRENTLY cannot execute inside a transaction block.',
        'Ensure column names match the TypeScript property names in your pgTable definition.',
        'Ensure field names match the Prisma model field definitions in schema.prisma.',
      ],
    },
    plans: {
      before: {
        nodePath: 'Seq Scan',
        primaryScan: 'Seq Scan',
        startupCost: 0,
        totalCost: 8917.07,
        planRows: 50000,
        usesIndexes: [],
        tree: {
          type: 'Seq Scan',
          relation: 'events',
          startupCost: 0,
          totalCost: 8917.07,
          planRows: 50000,
          children: [],
        },
      },
      after: {
        nodePath: 'Bitmap Heap Scan',
        primaryScan: 'Bitmap Heap Scan',
        startupCost: 4.45,
        totalCost: 21.92,
        planRows: 5,
        usesIndexes: ['idx_events_tenant_type_created'],
        tree: {
          type: 'Bitmap Heap Scan',
          relation: 'events',
          startupCost: 4.45,
          totalCost: 21.92,
          planRows: 5,
          children: [],
        },
      },
    },
    source: {
      proposedBy: 'deterministic',
      model: null,
      attempts: [],
    },
    alternative: null,
    assumptions: {
      assumedRowCount: 500000,
      seededRows: 20000,
      plannerSettings: 'postgres-defaults',
      tablesScaledEqually: true,
    },
    notices: ['Tier B snapshot served from verified PGlite recordings.'],
  },
  'analytics-covering': {
    outcome: 'improved',
    verification: {
      status: 'verified',
      indexUsed: true,
      costBefore: 152.55,
      costAfter: 21.8,
      costReductionPercent: 85.7,
      costRatio: 7.0,
      severity: 'HIGH',
    },
    recommendation: {
      index: {
        table: 'pageviews',
        name: 'idx_pageviews_page_covering',
        columns: [{ name: 'page_id', direction: 'ASC' }],
        include: ['viewed_at', 'view_duration'],
        where: null,
      },
      sql: {
        create:
          'CREATE INDEX "idx_pageviews_page_covering" ON "pageviews" ("page_id" ASC) INCLUDE ("viewed_at", "view_duration");',
        createConcurrently:
          'CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_pageviews_page_covering" ON "pageviews" ("page_id" ASC) INCLUDE ("viewed_at", "view_duration");',
      },
      headline: 'Covering index enabling Index-Only Scan',
      explanation:
        'Adding INCLUDE columns allows PostgreSQL to satisfy the entire query directly from index leaf pages without table heap fetches.',
      antiPatterns: [],
      esr: [
        { column: 'page_id', role: 'Equality', reason: 'Equality filter on page_id' },
        { column: 'viewed_at', role: 'Include', reason: 'Included column for Index Only Scan' },
        { column: 'view_duration', role: 'Include', reason: 'Included column for Index Only Scan' },
      ],
      migrations: {
        postgres:
          'CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_pageviews_page_covering" ON "pageviews" ("page_id" ASC) INCLUDE ("viewed_at", "view_duration");',
        drizzle: 'index("idx_pageviews_page_covering").on(table.pageId.asc())',
        prisma: '@@index([pageId(sort: Asc)], map: "idx_pageviews_page_covering")',
      },
      migrationNotes: [
        'CREATE INDEX CONCURRENTLY cannot execute inside a transaction block.',
        'Covering index: includes payload column(s) [viewed_at, view_duration] in leaf pages.',
        'Drizzle ORM does not support the INCLUDE clause natively for [viewed_at, view_duration]. Use a raw SQL migration.',
        'Prisma does not support covering INCLUDE indexes (prisma/prisma #8584). Run raw SQL migration with "prisma db execute".',
      ],
    },
    plans: {
      before: {
        nodePath: 'Bitmap Heap Scan',
        primaryScan: 'Bitmap Heap Scan',
        startupCost: 4.45,
        totalCost: 152.55,
        planRows: 100,
        usesIndexes: ['idx_pageviews_page_id'],
        tree: {
          type: 'Bitmap Heap Scan',
          relation: 'pageviews',
          startupCost: 4.45,
          totalCost: 152.55,
          planRows: 100,
          children: [],
        },
      },
      after: {
        nodePath: 'Index Only Scan',
        primaryScan: 'Index Only Scan',
        startupCost: 0.28,
        totalCost: 21.8,
        planRows: 100,
        usesIndexes: ['idx_pageviews_page_covering'],
        tree: {
          type: 'Index Only Scan',
          relation: 'pageviews',
          indexName: 'idx_pageviews_page_covering',
          startupCost: 0.28,
          totalCost: 21.8,
          planRows: 100,
          children: [],
        },
      },
    },
    source: {
      proposedBy: 'deterministic',
      model: null,
      attempts: [],
    },
    alternative: null,
    assumptions: {
      assumedRowCount: 500000,
      seededRows: 20000,
      plannerSettings: 'postgres-defaults',
      tablesScaledEqually: true,
    },
    notices: ['Tier B snapshot served from verified PGlite recordings.'],
  },
};
