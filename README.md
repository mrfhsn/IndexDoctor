# IndexDoctor

[![Google Cloud Run](https://img.shields.io/badge/Google_Cloud_Run-Deployed-4285F4?logo=googlecloud&logoColor=white)](https://indexdoctor-536pir6nia-uc.a.run.app)
[![Node.js](https://img.shields.io/badge/Node.js-24_LTS-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-Strict_5.7-blue?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)

**In-engine Postgres index advisor running real PostgreSQL in WebAssembly on Google Cloud Run.**  
Paste your `CREATE TABLE` and a slow `SELECT` query — get verified index recommendations, before/after query planner diffs, cost reduction calculations, and copy-ready migration code for PostgreSQL, Drizzle ORM, and Prisma.

🔗 **Live Public Demo (No Login Required):** [https://indexdoctor-536pir6nia-uc.a.run.app](https://indexdoctor-536pir6nia-uc.a.run.app)

---

## Why IndexDoctor?

Most AI query tools hallucinate index recommendations without verifying whether PostgreSQL will actually use them. Real database engineers know that adding an index doesn't mean the planner will pick it: column order matters (Equality $\to$ Sort $\to$ Range), covering columns (`INCLUDE`) prevent heap fetches, and low selectivity can cause the planner to stick with sequential scans.

IndexDoctor embeds an authentic PostgreSQL 17 engine ([PGlite](https://github.com/electric-sql/pglite)) directly inside the application container:

1. **Parses & Validates:** Checks query and schema syntax using PostgreSQL's native parser (`libpg-query-node`).
2. **Establishes Baseline:** Runs `EXPLAIN (FORMAT JSON)` inside WASM PostgreSQL with 500k-row simulated statistics.
3. **Recommends Index Candidates:** Generates optimal candidate index specs using Gemini 3.1 Flash Lite + Gemma MoE or deterministic ESR heuristics.
4. **Verifies In-Engine:** Builds the candidate index inside PGlite and re-runs `EXPLAIN`. If the planner doesn't select the index or if the cost doesn't drop, no improvement is claimed.
5. **Generates Migrations:** Emits safe concurrent DDL (`CREATE INDEX CONCURRENTLY`), Drizzle schema indexes, and Prisma schema definitions.

---

## Measured Performance & Accuracy

All performance figures below are copied directly from live Cloud Run benchmark tests recorded in [`docs/measurements.md`](./docs/measurements.md).

### 1. Golden Presets Latency & Improvement Profile

| Preset                                              | Scan Before        | Scan After        | Cost Before | Cost After | Reduction  | Uses Index                                   | p50 Latency | p95 Latency |
| :-------------------------------------------------- | :----------------- | :---------------- | :---------- | :--------- | :--------- | :------------------------------------------- | :---------- | :---------- |
| **E-Commerce Orders** (`orders-composite`)          | `Seq Scan`         | `Index Only Scan` | `7652.02`   | `4.32`     | **-99.9%** | `idx_orders_status_created_at`               | **340 ms**  | **505 ms**  |
| **Multi-Tenant Events** (`events-multitenant`)      | `Seq Scan`         | `Index Only Scan` | `8917.07`   | `4.41`     | **-99.9%** | `idx_events_tenant_id_event_type_created_at` | **349 ms**  | **482 ms**  |
| **Analytics Covering Index** (`analytics-covering`) | `Bitmap Heap Scan` | `Index Only Scan` | `152.55`    | `21.8`     | **-85.7%** | `idx_pageviews_page_covering`                | **3983 ms** | **9686 ms** |

> **Invariant I1 & I10 Compliance:** Every cost number was generated inside an authentic PostgreSQL 17 planner in WebAssembly. The recommended index was actively chosen by PostgreSQL.

### 2. Live Soak & Concurrency Resilience

- **20-Request Parallel Burst:** 20 simultaneous requests fired across unique IPs completed in **651 ms** with **0 500 errors** (2 served, 18 throttled via 429 token-bucket rate limiter).
- **100-Run Sequential Soak:** 100 sequential runs across alternating presets completed with **0 worker crashes/respawns**, **0 memory leaks**, and RSS memory staying strictly below **80% of 2 GiB**.

---

## Architecture & Request Flow

```
[ Browser Client ]
       │
       ▼ (HTTPS / JSON)
[ Google Cloud Run (Node.js 24) ]
       │
       ├─► [ Security Middleware ] (Strict CSP, In-flight cap, IP Token-Bucket Rate Limiter)
       ├─► [ Layer 1: AST Gate ]   (libpg-query-node allow-list; rejects COPY, DO, injections)
       ├─► [ Layer 2: LLM Chain ]  (Gemini 3.1 Flash Lite ──► Gemma 4 MoE ──► Deterministic ESR)
       └─► [ Layer 3: WASM Engine] (PGlite worker thread; MEMFS; simulated 500k stats scaling)
               │
               ▼
       [ Verified Before / After Plan Diff ]
```

---

## Limitations & Honesty

We believe developer tools must be honest about their boundaries:

1. **Simulated Statistics (Not a Live Benchmark):** IndexDoctor measures cost reductions in **PostgreSQL planner cost units** on a simulated 500,000-row table (`UPDATE pg_class`), not hardware wall-clock I/O benchmarks. It does not measure disk seek latency, SSD NVMe caching, or hardware buffer pool contention.
2. **Query Scope:** Designed for read queries (`SELECT`, CTEs, subqueries, filters, sorts). Does not diagnose cross-database sharding or multi-tenant partition routing.
3. **Allowed DDL:** The SQL gate allow-lists standard `CREATE TABLE` and `SELECT` statements. Exotic custom extensions, `COPY`, `DO`, procedural functions, and unquoted exotic identifiers are rejected by design.
4. **Data Privacy:** Schemas and queries are analyzed in-memory. When Gemini is active, schema metadata and queries are transmitted to Google's Gemini API over TLS without logging (Invariant I4). Never paste production credentials or proprietary secrets.

For an in-depth explanation of the WASM sandbox and costing equations, see [`docs/fidelity.md`](./docs/fidelity.md).

---

## Quickstart: Local Development

### Prerequisites

- Node.js 24 LTS (see `.nvmrc`)
- npm 11+

### Installation & Run

```bash
# 1. Clone repository
git clone https://github.com/mrfhsn/IndexDoctor.git
cd IndexDoctor

# 2. Install dependencies with exact lockfile pins
npm ci

# 3. Configure environment variables (optional; defaults to deterministic ESR rules if no key)
cp .env.example .env
# Edit .env to add your GEMINI_API_KEY if desired

# 4. Start concurrent development server (Client on :5173, Server on :8080)
npm run dev
```

Visit `http://localhost:5173` to test the application locally.

---

## Docker Container

Build and run the production container locally with Cloud Run resource constraints:

```bash
# Build multi-stage container
docker build -t indexdoctor:local .

# Run with 2 GiB memory and 1 vCPU
docker run --rm \
  --memory 2g \
  --cpus 1 \
  -p 8080:8080 \
  -e PORT=8080 \
  indexdoctor:local

# Execute local container smoke test
npm run smoke http://localhost:8080
```

---

## Google Cloud Run Deployment

Deploy directly from source using the Google Cloud CLI:

```bash
# 1. Enable required services
gcloud services enable run.googleapis.com cloudbuild.googleapis.com secretmanager.googleapis.com

# 2. Store your Gemini API key in Secret Manager
printf '%s' "YOUR_API_KEY" | gcloud secrets create gemini-api-key --data-file=-

# 3. Deploy to Cloud Run
gcloud run deploy indexdoctor \
  --source . \
  --region us-central1 \
  --allow-unauthenticated \
  --memory 2Gi \
  --cpu 1 \
  --cpu-boost \
  --no-cpu-throttling \
  --min-instances 1 \
  --max-instances 5 \
  --concurrency 8 \
  --timeout 60 \
  --set-secrets GEMINI_API_KEY=gemini-api-key:latest

# 4. Verify live deployment
npm run verify:deploy
```

For detailed deployment parameters and health probe configurations, see [`docs/deployment.md`](./docs/deployment.md).

---

## Configuration

All configuration is validated at startup via `src/server/config.ts`:

| Environment Variable     | Default                                                          | Purpose                                                           |
| :----------------------- | :--------------------------------------------------------------- | :---------------------------------------------------------------- |
| `PORT`                   | `8080`                                                           | HTTP server port                                                  |
| `NODE_ENV`               | `production`                                                     | Node environment (`development` / `production`)                   |
| `GEMINI_API_KEY`         | _(optional)_                                                     | Google Gemini API key; falls back to deterministic ESR if omitted |
| `LLM_MODELS`             | `gemini-3.1-flash-lite,gemma-4-26b-a4b-it,gemini-3.5-flash-lite` | Ordered fallback chain for model recommendations                  |
| `LLM_THINKING_LEVEL`     | `minimal`                                                        | Thinking configuration applied where supported                    |
| `LLM_ATTEMPT_TIMEOUT_MS` | `8000`                                                           | Per-model attempt timeout                                         |
| `LLM_BUDGET_MS`          | `15000`                                                          | Overall LLM chain budget                                          |
| `REQUEST_DEADLINE_MS`    | `30000`                                                          | End-to-end request timeout deadline                               |
| `MAX_BODY_BYTES`         | `32768`                                                          | Maximum HTTP POST body size (32 KB)                               |
| `MAX_SCHEMA_BYTES`       | `20000`                                                          | Maximum schema text size (20 KB)                                  |
| `MAX_QUERY_BYTES`        | `8000`                                                           | Maximum query text size (8 KB)                                    |
| `MAX_IN_FLIGHT`          | `24`                                                             | Maximum concurrent requests per instance                          |
| `SANDBOX_QUEUE_MAX`      | `12`                                                             | Worker queue capacity                                             |
| `SANDBOX_JOB_TIMEOUT_MS` | `6000`                                                           | Hard job timeout for PGlite evaluations                           |
| `ASSUMED_ROW_COUNT`      | `500000`                                                         | Simulated row count for statistics scaling                        |
| `RATE_LIMIT_PER_MIN`     | `12`                                                             | Token bucket per-minute refill rate per IP                        |
| `RATE_LIMIT_BURST`       | `6`                                                              | Token bucket burst capacity per IP                                |

---

## Quality & Verification Commands

IndexDoctor uses strict type-checking, type-aware linting (`oxlint`), and automated testing:

```bash
# Format check
npm run fmt:check

# Type-aware linting
npm run lint

# TypeScript project references check
npm run typecheck

# Architecture invariant check
npm run check:forbidden

# Fast verification (all above + unit tests)
npm run verify:fast

# Full production verification (fast + build + integration)
npm run verify

# Live Cloud Run verification
npm run verify:deploy

# Live Cloud Run benchmark profiling
npm run measure
```

---

## Project Structure

```
IndexDoctor/
├── .github/workflows/ci.yml       # GitHub Actions CI workflow
├── docs/
│   ├── adr/                       # Architecture Decision Records
│   ├── deployment.md              # Cloud Run deployment documentation
│   ├── fidelity.md                # PGlite WASM engine fidelity & costing guide
│   └── measurements.md            # Live measured benchmarks & soak data
├── scripts/
│   ├── check-forbidden.mjs        # Static AST & forbidden pattern guard
│   ├── measure.mjs                # Live benchmark and soak test runner
│   ├── smoke.mjs                  # Docker container smoke test
│   └── verify-deploy.mjs          # 12-point Cloud Run deployment verification
├── src/
│   ├── client/                    # React 19 + Tailwind v4 Single Page App
│   │   ├── components/            # UI Cards, Editors, Plan Trees, Migration Tabs
│   │   └── state/                 # State machine reducer & action dispatchers
│   ├── server/                    # Hono server running on Node 24
│   │   ├── llm/                   # Gemini / Gemma model chain & circuit breaker
│   │   ├── pipeline/              # Request orchestrator & single-flight cache
│   │   ├── sandbox/               # PGlite worker thread & WASM executor
│   │   └── sql/                   # AST gate, DDL generator, ESR heuristic
│   └── shared/                    # Shared Zod schemas and API contracts
└── tests/                         # Unit, PGlite engine, and integration test suites
```

---

## Open Source Credits

IndexDoctor is built on open-source technologies:

- **[PGlite](https://github.com/electric-sql/pglite)** by ElectricSQL (Apache-2.0 / PostgreSQL License)
- **[libpg-query-node](https://github.com/constructive-io/libpg-query-node)** by Constructive (MIT License)
- **[Google Cloud Run](https://cloud.google.com/run)** for serverless container execution

## License

This project is licensed under the [MIT License](./LICENSE).
