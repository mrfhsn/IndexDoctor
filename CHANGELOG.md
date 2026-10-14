# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-10-14

### Added

#### Core Engine & Sandbox

- In-engine PostgreSQL 17 query analysis powered by PGlite (WASM) in an isolated Node.js worker thread.
- Simulated statistics scaling (`UPDATE pg_class`) enabling realistic 500k-row cost modeling in < 500 ms without physical data insertion.
- Four-layer sandbox defense: AST allow-list, worker thread isolation, Emscripten virtual MEMFS, and hard 6 s execution timeouts.
- Automatic worker thread recycling after 300 evaluations to ensure zero memory leaks.

#### Diagnosis & Intelligence

- Deterministic Equality-Sort-Range (ESR) indexing engine with covering index (`INCLUDE`) support and partial filter analysis.
- Multi-model LLM recommendation chain via `@google/genai` (Gemini 3.1 Flash Lite, Gemma 4 26B MoE, Gemini 3.5 Flash Lite) with circuit breaker and automatic fallback to deterministic rules.
- Strict anti-hallucination guarantee: candidate indexes are tested in the real PostgreSQL planner before being returned to the user; unverified or ineffective recommendations are flagged as `not_improved`.

#### SQL AST Gate & Security

- Native PostgreSQL AST parsing via `libpg-query-node` enforcing strict allow-lists for schema and query inputs.
- Hostile payload rejection (blocks `COPY`, `DO`, `DROP`, multiple statements, procedural code, and suspicious identifiers).
- Zero-logging architecture (Invariant I4): schemas, queries, and Gemini API keys are never written to logs, disk, or client bundles.
- Security headers (strict CSP, HSTS, X-Content-Type-Options, Referrer-Policy) and token-bucket IP rate limiting with spoof-resistant proxy hop resolution.

#### Web Interface

- Responsive single-page dashboard built with React 19, Tailwind CSS v4, and Lucide icons.
- One-click presets (E-Commerce Orders, Multi-Tenant Events, Analytics Covering Index) with immediate before/after plan comparison.
- Visual plan diff tree highlighting scan bottleneck transitions (e.g. `Seq Scan` $\to$ `Index Only Scan`).
- Copy-ready migration outputs for PostgreSQL (`CREATE INDEX CONCURRENTLY`), Drizzle ORM, and Prisma ORM.

#### Cloud Run Infrastructure & Tooling

- Production deployment on Google Cloud Run (`us-central1`) with Secret Manager integration and always-on CPU allocation.
- Container smoke testing script (`scripts/smoke.mjs`) for local Docker verification.
- Automated 12-point live deployment verification suite (`scripts/verify-deploy.mjs`).
- Automated performance and soak benchmarking tool (`scripts/measure.mjs`) generating verified metrics in `docs/measurements.md`.
