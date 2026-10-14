import type { Preset } from './presets.js';

export const eventsMultitenantPreset: Preset = {
  id: 'events-multitenant',
  name: 'Multi-Tenant Events',
  description: 'Tenant isolation + event type equality with timestamp range and sort',
  schema: `CREATE TABLE events (
  id serial PRIMARY KEY,
  tenant_id integer NOT NULL,
  event_type text NOT NULL,
  severity text NOT NULL,
  payload text NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);`,
  query: `SELECT id, tenant_id, event_type, severity, created_at
FROM events
WHERE tenant_id = 42
  AND event_type = 'user.login'
  AND created_at >= '2024-01-01 00:00:00+00'
ORDER BY created_at DESC
LIMIT 25;`,
  candidateIndex: {
    name: 'idx_events_tenant_type_created',
    ddl: 'CREATE INDEX idx_events_tenant_type_created ON events (tenant_id, event_type, created_at DESC);',
  },
};
