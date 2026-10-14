import { describe, expect, it } from 'vitest';

import { buildIndexDdl, buildIndexName } from './ddl.js';
import type { CandidateIndexSpec } from './index-spec.js';

describe('sql/ddl', () => {
  it('builds standard single-column index DDL', () => {
    const spec: CandidateIndexSpec = {
      table: 'users',
      columns: [{ name: 'email' }],
    };

    const ddl = buildIndexDdl(spec);
    expect(ddl.name).toBe('idx_users_email');
    expect(ddl.create).toBe('CREATE INDEX "idx_users_email" ON "users" ("email");');
    expect(ddl.createConcurrently).toBe(
      'CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_users_email" ON "users" ("email");',
    );
  });

  it('builds composite index with direction, nulls ordering, and opclass', () => {
    const spec: CandidateIndexSpec = {
      table: 'orders',
      columns: [
        { name: 'customer_id', direction: 'asc', nulls: 'first' },
        { name: 'created_at', direction: 'desc', nulls: 'last' },
        { name: 'code', opclass: 'varchar_pattern_ops' },
      ],
    };

    const ddl = buildIndexDdl(spec);
    expect(ddl.name).toBe('idx_orders_customer_id_created_at_code');
    expect(ddl.create).toBe(
      'CREATE INDEX "idx_orders_customer_id_created_at_code" ON "orders" ("customer_id" ASC NULLS FIRST, "created_at" DESC NULLS LAST, "code" varchar_pattern_ops);',
    );
  });

  it('builds covering index with INCLUDE clause', () => {
    const spec: CandidateIndexSpec = {
      table: 'events',
      columns: [{ name: 'tenant_id' }, { name: 'event_type' }],
      include: ['payload', 'created_at'],
    };

    const ddl = buildIndexDdl(spec);
    expect(ddl.name).toBe('idx_events_tenant_id_event_type');
    expect(ddl.create).toBe(
      'CREATE INDEX "idx_events_tenant_id_event_type" ON "events" ("tenant_id", "event_type") INCLUDE ("payload", "created_at");',
    );
  });

  it('builds partial index with WHERE clause', () => {
    const spec: CandidateIndexSpec = {
      table: 'tasks',
      columns: [{ name: 'assigned_to' }, { name: 'priority' }],
      where: 'status = 1',
    };

    const ddl = buildIndexDdl(spec);
    expect(ddl.name).toBe('idx_tasks_assigned_to_priority');
    expect(ddl.create).toBe(
      'CREATE INDEX "idx_tasks_assigned_to_priority" ON "tasks" ("assigned_to", "priority") WHERE (status = 1);',
    );
  });

  it('truncates index names over 63 chars and appends deterministic hash', () => {
    const spec: CandidateIndexSpec = {
      table: 'organization_subscription_membership_records',
      columns: [
        { name: 'first_associated_account_identifier' },
        { name: 'second_associated_account_identifier' },
      ],
    };

    const name = buildIndexName(spec);
    expect(name.length).toBeLessThanOrEqual(63);
    expect(name).toMatch(
      /^idx_organization_subscription_membership_records_[a-z0-9_]+_[a-f0-9]{6}$/,
    );

    const ddl = buildIndexDdl(spec);
    expect(ddl.name).toBe(name);
    expect(ddl.name.length).toBeLessThanOrEqual(63);
  });

  it('supports custom index name override', () => {
    const spec: CandidateIndexSpec = {
      table: 'users',
      columns: [{ name: 'email' }],
    };

    const ddl = buildIndexDdl(spec, 'my_custom_index');
    expect(ddl.name).toBe('my_custom_index');
    expect(ddl.create).toBe('CREATE INDEX "my_custom_index" ON "users" ("email");');
  });
});
