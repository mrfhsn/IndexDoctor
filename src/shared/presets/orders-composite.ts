import type { Preset } from './presets.js';

export const ordersCompositePreset: Preset = {
  id: 'orders-composite',
  name: 'E-Commerce Orders',
  description: 'Status equality + created_at range and sort order',
  schema: `CREATE TABLE orders (
  id serial PRIMARY KEY,
  user_id integer NOT NULL,
  status text NOT NULL,
  total_amount numeric(10, 2) NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);`,
  query: `SELECT id, user_id, total_amount, created_at
FROM orders
WHERE status = 'shipped'
  AND created_at >= '2024-01-01 00:00:00+00'
ORDER BY created_at DESC
LIMIT 50;`,
  candidateIndex: {
    name: 'idx_orders_status_created_at',
    ddl: 'CREATE INDEX idx_orders_status_created_at ON orders (status, created_at DESC);',
  },
};
