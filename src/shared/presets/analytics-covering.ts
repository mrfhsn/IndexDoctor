import type { Preset } from './presets.js';

export const analyticsCoveringPreset: Preset = {
  id: 'analytics-covering',
  name: 'Analytics Covering Index',
  description:
    'Flips existing narrow Index Scan to Index Only Scan using INCLUDE for payload columns',
  schema: `CREATE TABLE pageviews (
  id serial PRIMARY KEY,
  page_id integer NOT NULL,
  visitor_id integer NOT NULL,
  view_duration integer NOT NULL,
  viewed_at timestamp with time zone NOT NULL DEFAULT now()
);
CREATE INDEX idx_pageviews_page_id ON pageviews (page_id);`,
  query: `SELECT page_id, viewed_at, view_duration
FROM pageviews
WHERE page_id = 101;`,
  candidateIndex: {
    name: 'idx_pageviews_page_covering',
    ddl: 'CREATE INDEX idx_pageviews_page_covering ON pageviews (page_id) INCLUDE (viewed_at, view_duration);',
  },
};
