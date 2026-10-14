# ADR 0002: In-Engine PGlite WASM with Simulated Statistics Scaling

## Context

IndexDoctor verifies candidate index efficacy using the real PostgreSQL query planner via PGlite (PostgreSQL compiled to WebAssembly). For the query planner to choose an index over a sequential scan, the table must contain a sufficient number of rows: on small tables (<1,000 rows), sequential scans are almost always cheaper than index lookups due to random I/O and tree-traversal overhead.

However, physically generating and inserting 500,000 rows into an in-memory WASM instance for every diagnosis request:

1. Takes 4,000–12,000 ms of CPU time per request.
2. Consumes >150 MiB of memory per evaluation, risking container OOM under Cloud Run concurrency.
3. Slows API response times well beyond the interactive threshold (<1,000 ms).

## Decision

Adopt the **simulated statistics scaling** technique:

1. Seed a small, representative dataset (e.g. 500–2,000 rows) using the user's schema types. This establishes valid catalog entries, column datatypes, distributions, and sample distinct values.
2. Run `VACUUM ANALYZE` to let PostgreSQL build standard distribution histograms and null fraction statistics in `pg_statistic`.
3. Directly update `pg_class` for target tables and indexes:
   ```sql
   UPDATE pg_class
   SET reltuples = 500000,
       relpages = CEIL((500000::float * avg_row_width) / 8192)
   WHERE relname = 'target_table';
   ```
4. Run `EXPLAIN (FORMAT JSON)` before and after candidate index creation.

## Consequences

### Positive

- **Execution Speed:** Baseline and candidate evaluations execute in 150–500 ms inside the worker thread instead of several seconds.
- **Planner Authenticity:** Uses the authentic PostgreSQL 17 planner costing equations ($c_{seq} = \text{pages} \cdot \text{seq\_page\_cost} + \text{tuples} \cdot \text{cpu\_tuple\_cost}$ vs $c_{idx} = \text{pages} \cdot \text{random\_page\_cost} + \dots$).
- **Deterministic Verification:** Eliminates false-negative recommendations caused by small-table sequential scan preference.
- **Resource Efficiency:** Sandbox RSS memory remains completely flat (<80% of 2 GiB across 100+ runs).

### Trade-offs & Limitations (Honesty Principle)

- Costs are planner estimations on simulated 500,000-row volume, not live hardware I/O benchmarks.
- Correlation and MCV (Most Common Values) distributions reflect the seeded sample rather than multi-gigabyte production data.
- The UI explicitly discloses: _"Planner-estimated cost on simulated 500,000 rows — not a benchmark."_
