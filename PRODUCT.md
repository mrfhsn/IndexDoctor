# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

- **Primary:** Backend and fullstack software engineers optimizing slow PostgreSQL queries in production or staging environments who need immediate, credible, zero-login advice without granting production database credentials or guessing index efficacy.
- **Secondary:** Database administrators, tech leads, and DevOps engineers evaluating schema migration strategies and reviewing execution plans during PR reviews.

## Product Purpose

IndexDoctor is an in-engine PostgreSQL index advisor running real PostgreSQL 17 in WebAssembly (PGlite) directly on Google Cloud Run. It accepts raw `CREATE TABLE` schema definitions and slow `SELECT` queries, establishes baseline execution plans on simulated 500,000-row statistics, tests candidate indexes directly inside PostgreSQL's optimizer, and delivers verified before/after plan diffs with copy-ready migrations.

Success means eliminating database indexing guesswork: developers never ship an index that PostgreSQL ignores at runtime, and never claim a performance improvement without planner verification.

## Positioning

Unlike generic AI query advisors that hallucinate index recommendations without knowing whether the PostgreSQL planner will actually select them (frequently failing on column order, missing covering columns, or unindexed expressions), IndexDoctor physically executes candidate indexes inside an authentic in-memory PostgreSQL engine. If PostgreSQL does not choose the new index or if planner cost does not drop, no improvement is claimed (`not_improved`).

## Operating Context

- **Environments:** Web browser on desktop and mobile (responsive down to 375 px), containerized serverless deployment on Google Cloud Run.
- **Workflows:** Copy-pasting schema DDL and query SQL from local codebases, psql terminals, or APM slow-query logs; exploring 1-click golden presets (Orders composite, Events multi-tenant, Analytics covering); reviewing vital sign cards and visual plan diff trees; copying generated migration code into ORMs (Drizzle, Prisma) or SQL migration scripts.

## Capabilities and Constraints

- **In-Engine Verification:** Real PostgreSQL 17 compiled to WebAssembly (PGlite) executing in an isolated Node.js worker thread with an in-memory virtual filesystem (MEMFS).
- **Simulated Statistics Scaling:** Seeds a representative sample, then updates PostgreSQL system catalogs directly (`UPDATE pg_class SET reltuples = 500000, relpages = ...`) to calculate authentic 500k-row planner costs in < 500 ms without physical data insertion overhead.
- **Zero Login & Zero Data Retention:** No accounts, no cookies, no tracking; schemas and queries are processed strictly in memory and are never written to disk, logs, or persistent databases (Invariant I4).
- **AST SQL Gate:** Strict allow-list via `libpg-query-node` permitting only standard `CREATE TABLE` and read `SELECT` statements; destructive DDL, `COPY`, `DO`, procedural execution, and multi-statements are rejected with helpful explanations.
- **Multi-Format Copy-Ready Output:** Instant copy-paste for PostgreSQL CONCURRENT DDL (`CREATE INDEX CONCURRENTLY`), Drizzle ORM index definitions, and Prisma ORM schema snippets.
- **Honest Planner Metrics:** Cost reductions are explicitly labeled as estimated cost units on simulated 500,000 rows—never masquerading as physical hardware I/O benchmarks.

## Brand Commitments

- **Name:** IndexDoctor
- **Voice:** Direct, technical, highly credible, honest, and zero-bullshit engineering tone.
- **Visual Commitments:** Sleek dark mode palette (`bg-slate-950`, `border-slate-800`), emerald-400 for verified improvements, rose-400 for scan bottlenecks, amber-400 for warnings/ESR roles.

## Evidence on Hand

- **Live Deployment:** Serving 100% traffic live on Google Cloud Run at `https://indexdoctor-536pir6nia-uc.a.run.app`.
- **Verified Measurements:** Recorded in `docs/measurements.md`: Orders (-99.9% cost reduction, 340 ms p50), Events (-99.9% cost reduction, 349 ms p50), Covering index (-85.7% cost reduction, 3983 ms p50), 20-burst resilience (651 ms, zero 500s), and 100-run soak stability (<80% memory, zero crashes).
- **Architectural Reference:** `docs/fidelity.md`, `docs/deployment.md`, `docs/adr/0001-model-chain.md`, `docs/adr/0002-stats-scaling.md`.

## Product Principles

1. **In-Engine Truth Over LLM Hallucinations:** Never recommend an index without authentic PostgreSQL query planner verification.
2. **Honest Metrics:** Never claim an improvement unless `costAfter < costBefore` and the index was actively chosen by PostgreSQL; explicitly declare simulated row counts.
3. **Zero Friction:** No login, no signup, and no credentials required; immediate interactive feedback via golden presets.
4. **Production-Safe Migrations:** Always emit non-blocking `CONCURRENTLY` DDL with copy buttons and rollback advice.

## Accessibility & Inclusion

- Keyboard-focusable controls with visible focus rings.
- Contrast ratios exceeding WCAG 2.1 AA standards on slate dark themes.
- Monospace typography for SQL editors, execution plans, and migration outputs.
- Live announcements for copy actions and asynchronous pipeline states.
