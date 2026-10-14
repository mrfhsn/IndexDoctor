# IndexDoctor — Architecture (v2)

> Binding design and contract. Written 14 Oct 2026. Numbers marked ⚠️ come from earlier notes and **must be re-measured in Spike 0** (see `agent.md`) before anything depends on them. Names of internal modules are suggestions; **contract types, error codes, env var names, invariants and import boundaries are binding.**

---

## 1. Overview

One stateless container on Google Cloud Run. One Node 24 process contains:

- a **Hono** HTTP server (API + static React SPA) on the main thread,
- an **SQL gate** (real Postgres parser, WASM) that admits only a safe subset,
- one **sandbox worker thread** that owns a single long-lived in-memory Postgres (PGlite),
- a **doctor** that proposes an index (LLM chain + deterministic ESR planner) and builds output deterministically.

```
Browser (React SPA)
   │ POST /api/diagnose  (one JSON response)
   ▼
┌──────────────────────── Cloud Run instance (2 GiB, 1 vCPU, CPU always allocated) ────────────────────────┐
│ Hono (main thread)                                                                                        │
│  1 edge:      request-id → security headers → body limit → content-type → rate limit → in-flight cap      │
│  2 cache:     LRU hit? return.  Identical request in flight? await the same promise (single-flight)       │
│  3 gate:      parse (libpg-query) → allow-list → catalog model → identifier/size rules   [ms, main thread]│
│  4 propose:   LLM chain ─┐  (prompt = catalog + masked query; no user free text)                          │
│               ESR planner┴─► candidates (≤ 2): LLM spec, deterministic spec                               │
│  5 evaluate:  ONE sandbox job ──► worker ──► PGlite                                                       │
│               BEGIN → schema → seed → ANALYZE → scale stats → EXPLAIN (before)                            │
│               per candidate: SAVEPOINT → CREATE INDEX → scale stats → EXPLAIN (after) → ROLLBACK TO       │
│               ROLLBACK (always, in finally) → poison check                                                │
│  6 assemble:  choose candidate, derive ESR roles/severity/migrations, sanitise text, cache                │
│                                                                                                           │
│ Secret Manager ─► GEMINI_API_KEY (env)        Cloud Logging ◄─ JSON logs (metadata only)                  │
└───────────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

**Why this shape:** PGlite is single-connection and heavy (⚠️ ≈ 450–550 MB RSS, ≈ 3 s init), and a heavy statement blocks its thread. So: one instance, off the main thread, serialised access, killable, recyclable. Everything user-controlled is validated _before_ it reaches the worker.

---

## 2. Principles and invariants

Invariants are **tests**, not aspirations. Each must have at least one automated test (see §16).

| ID  | Invariant                                                                                                                                                                                                                                                          |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| I1  | A response contains cost numbers **only** if `verification.status === "verified"`. Model-invented numbers never appear.                                                                                                                                            |
| I2  | The only SQL the worker executes is: validated schema statements, the engine's own seeding/catalog statements, the validated query inside `EXPLAIN`, and `CREATE INDEX` text **built by the server** from validated parts. Model output is never executed as text. |
| I3  | After every job (success, error, timeout) the sandbox holds zero user objects. A failed invariant check recycles the worker.                                                                                                                                       |
| I4  | Logs never contain schema or query text, API keys, or raw model output.                                                                                                                                                                                            |
| I5  | Every non-2xx response uses the error envelope; no stack traces, no internals.                                                                                                                                                                                     |
| I6  | `/api/health/live` never depends on the worker or the LLM.                                                                                                                                                                                                         |
| I7  | No single request can kill the process or leave the service permanently unready.                                                                                                                                                                                   |
| I8  | Gemini and sandbox failures degrade the response (never 5xx). Only invalid or unsafe _input_ is rejected.                                                                                                                                                          |
| I9  | The prompt contains no user-authored free text: only validated identifiers, type names from a fixed set, and a literal-masked, comment-stripped query.                                                                                                             |
| I10 | An improvement is claimed only if the new index appears in the after-plan **and** `costAfter < costBefore`.                                                                                                                                                        |
| I11 | Every external call (LLM, worker) has a deadline and an abort path.                                                                                                                                                                                                |
| I12 | Same input + same code version → same plans (deterministic seeding; no `Math.random`).                                                                                                                                                                             |

---

## 3. Key decisions

| #   | Decision                                                                                                                                                  | Why                                                                                                                         | Rejected                                             |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| D1  | One long-lived PGlite in a worker thread                                                                                                                  | Single connection; memory; killable                                                                                         | `new PGlite()` per request                           |
| D2  | **One `evaluate` job** per request with `SAVEPOINT` per candidate                                                                                         | One state rebuild (⚠️ ≈ 150–230 ms), baseline and candidates compared on identical data, no transaction across the LLM call | Separate baseline and verify jobs                    |
| D3  | Seed ~20k real rows → `ANALYZE` → scale `reltuples`, set `relallvisible = relpages` — **scale last, after any `CREATE INDEX`, then read back and assert** | Planner takes page count from the physical file and only density from `pg_class`; index builds rewrite parent stats         | Scale before index; `pg_class` edits on empty tables |
| D4  | Hard job timeout → terminate worker → respawn; recycle every N jobs when idle; poison check                                                               | `statement_timeout` not enforced (⚠️); WASM memory never shrinks                                                            | Trusting `SET statement_timeout`                     |
| D5  | `generateContent` via `@google/genai` for all models                                                                                                      | Documented for Gemini 3.5/3.1 and Gemma; one code path; Interactions API stays behind the adapter                           | Mixed surfaces                                       |
| D6  | Model chain from env: `gemini-3.5-flash-lite` → `gemini-3.1-flash-lite` → `gemma-4-31b-it` → deterministic                                                | User requirement; exact IDs verified                                                                                        | Single model                                         |
| D7  | LLM returns a **structured index spec**; server builds DDL                                                                                                | Removes "model returns DROP TABLE" class entirely                                                                           | Model returns SQL text                               |
| D8  | Prompt built from catalog + masked query; identifiers strictly validated                                                                                  | Structural prompt-injection immunity (I9)                                                                                   | Pasting raw schema into the prompt                   |
| D9  | Real Postgres parser (libpg-query WASM) for the allow-list                                                                                                | Regex allow-lists are bypassable                                                                                            | Hand-rolled tokenizer                                |
| D10 | ESR roles, severity, migrations are deterministic                                                                                                         | No hallucinated ORM syntax or inconsistent badges                                                                           | Model-generated migrations                           |
| D11 | Deterministic planner doubles as fallback _and_ repair candidate                                                                                          | Demo works with no key; model mistakes are caught by measurement                                                            | Fail the request                                     |
| D12 | No database; in-memory LRU + single-flight; optional browser localStorage history                                                                         | Stateless fits Cloud Run                                                                                                    | Redis / Cloud SQL                                    |
| D13 | Instance-based CPU billing (`--no-cpu-throttling`) + min-instances 1                                                                                      | Worker respawn/recycle is background work that freezes otherwise                                                            | Request-based CPU                                    |
| D14 | Node 24 LTS, ESM, TypeScript strict; compile server with `tsc`; no `tsx` at runtime                                                                       | Active LTS; fast cold start                                                                                                 | Node 22 (Maintenance), tsx in prod                   |
| D15 | oxlint (+ type-aware) + oxfmt + `tsc` + knip + forbidden-pattern script + Vitest                                                                          | Fast, strict, and `tsc` remains the type authority while type-aware linting is alpha                                        | ESLint+Prettier; relying on oxlint alone for types   |
| D16 | No UI kit, no router, no external fonts/CDNs                                                                                                              | Strict CSP; fewer moving parts                                                                                              | Component libraries                                  |

---

## 4. Repository layout and boundaries

```text
indexdoctor/
├── .github/
│   ├── workflows/ci.yml
│   ├── ISSUE_TEMPLATE/{bug_report.yml,feature_request.yml,config.yml}
│   ├── PULL_REQUEST_TEMPLATE.md
│   └── dependabot.yml
├── .agent/                    # gitignored: STATE.md, evidence/ (builder's working memory)
├── docs/
│   ├── adr/0001-….md          # one ADR per decision D1…D16 that surprised someone
│   ├── architecture.md        # copy of this file
│   ├── deployment.md          # exact Cloud Run steps and flags
│   ├── fidelity.md            # how the simulation works and where it is wrong
│   └── measurements.md        # generated by scripts; the only source for published numbers
├── scripts/                   # plain .mjs, no build step
│   ├── check-forbidden.mjs  probe-models.mjs  spike-pglite.mjs
│   ├── smoke.mjs  verify-deploy.mjs  snapshot-presets.mjs  measure.mjs
├── src/
│   ├── shared/                # imported by client AND server; no runtime deps except zod
│   │   ├── contract.ts        # Zod schemas + inferred types (API contract §8)
│   │   ├── error-codes.ts     # error code → HTTP status table
│   │   └── presets/           # 3 preset files + presets.ts list (data only)
│   ├── server/
│   │   ├── main.ts            # bootstrap, signals, process-level handlers
│   │   ├── app.ts             # createApp(deps): testable Hono app
│   │   ├── config.ts          # Zod env parsing, defaults (§15)
│   │   ├── logger.ts  errors.ts
│   │   ├── http/{middleware/*.ts, routes/{health,diagnose,static}.ts}
│   │   ├── pipeline/diagnose.ts      # orchestration; dependencies injected
│   │   ├── sql/{parse,gate,catalog,sanitize-mysql,strip-and-mask,esr-planner,index-spec,ddl}.ts
│   │   ├── sandbox/{manager,worker,engine,seed,stats,plan,protocol}.ts
│   │   ├── llm/{client,models,prompt,parse-output,chain,breaker}.ts
│   │   ├── migrations/{postgres,drizzle,prisma}.ts
│   │   ├── lib/{lru,single-flight,token-bucket,semaphore,hash,deadline,sanitize-text}.ts
│   │   └── snapshots/presets.json    # Tier B, recorded from the deployed app
│   └── client/
│       ├── main.tsx  App.tsx  index.css  api.ts
│       ├── state/{reducer,history}.ts
│       └── components/*.tsx
├── tests/{integration,hostile,fixtures}/   # unit tests are co-located as *.test.ts
├── Dockerfile  .dockerignore  .env.example
├── package.json  .npmrc  .nvmrc  .editorconfig  .gitignore  .gitattributes
├── tsconfig.json  tsconfig.base.json  tsconfig.{shared,server,client,tests}.json
├── vite.config.ts  vitest.config.ts  .oxlintrc.json  .oxfmtrc.json  knip.json
└── README.md  LICENSE  CONTRIBUTING.md  CODE_OF_CONDUCT.md  SECURITY.md  CHANGELOG.md
```

### 4.1 Import boundaries (enforced by lint)

| From                   | May import                                       | Must not import                      |
| ---------------------- | ------------------------------------------------ | ------------------------------------ |
| `src/shared`           | `zod`, itself                                    | `server`, `client`, any Node/DOM API |
| `src/server`           | `shared`, Node, server deps                      | `client`                             |
| `src/client`           | `shared`, browser deps                           | `server`, Node built-ins             |
| `sandbox/worker.ts`    | `engine`, `protocol`, `@electric-sql/pglite`     | everything HTTP/LLM                  |
| `@electric-sql/pglite` | only `sandbox/worker.ts` and `sandbox/engine.ts` | all other files                      |
| `@google/genai`        | only `llm/client.ts`                             | all other files                      |
| `libpg-query`          | only `sql/parse.ts`                              | all other files                      |

Other rules: relative imports only (no path aliases); no barrel files (`index.ts` re-exports); no circular imports; named exports only (default exports allowed in config files).

### 4.2 Module responsibilities (what each owns and never does)

| Module                      | Owns                                                                             | Never                     |
| --------------------------- | -------------------------------------------------------------------------------- | ------------------------- |
| `http/*`                    | limits, headers, error envelope, routing                                         | business logic            |
| `pipeline/diagnose`         | stage order, deadlines, degradation, response assembly                           | HTTP details, SQL parsing |
| `sql/gate`                  | allow-list over the AST, size/count limits, MySQL sanitiser hand-off             | executing SQL             |
| `sql/catalog`               | tables, columns, types, PK/unique/existing indexes from the AST                  | touching the sandbox      |
| `sql/esr-planner`           | deterministic candidate + ESR classification                                     | LLM calls                 |
| `sql/index-spec`, `sql/ddl` | validate a spec against the catalog; build `CREATE INDEX` text with safe quoting | trusting model strings    |
| `sandbox/manager`           | queue, timeouts, respawn, recycle, readiness, circuit                            | SQL knowledge             |
| `sandbox/engine`            | job lifecycle on a PGlite handle (testable in-process)                           | worker plumbing           |
| `llm/client`                | the only SDK calls; capability downgrade ladder                                  | validation of semantics   |
| `llm/chain`                 | model order, breakers, budgets, repair, daily cap                                | prompt wording            |
| `migrations/*`              | deterministic snippets from a validated spec                                     | model text                |

---

## 5. Runtime topology and Cloud Run

| Setting             | Value                                                                                                            | Reason                                        |
| ------------------- | ---------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| Base image          | `node:24-slim`, multi-stage, non-root                                                                            | Active LTS                                    |
| Memory / CPU        | **2 GiB / 1 vCPU**, startup CPU boost on                                                                         | one PGlite ≈ 0.5 GB (⚠️) + headroom           |
| CPU allocation      | **always allocated** (`--no-cpu-throttling`)                                                                     | worker respawn/recycle is background work     |
| Min / max instances | **1 / 5**                                                                                                        | no cold start in launch week; cost cap        |
| Concurrency         | **8**                                                                                                            | sandbox work is serialised; LLM waits are I/O |
| Request timeout     | 60 s (app deadline 30 s)                                                                                         | app answers first                             |
| Startup probe       | `GET /api/health` (200 only after canary passes); generous window (≥ 60 s)                                       | traffic only to ready instances               |
| Liveness probe      | `GET /api/health/live`                                                                                           | restart a wedged event loop                   |
| Secrets             | `--set-secrets GEMINI_API_KEY=gemini-api-key:latest`; runtime service account has `secretmanager.secretAccessor` | not `--set-env-vars`                          |
| Auth                | allow unauthenticated                                                                                            | zero-login requirement                        |
| Deploy              | `gcloud run deploy --source .` (Dockerfile build)                                                                | "deployed directly to Cloud Run"              |

Notes:

- Cloud Run documents **startup and liveness probes only**; there is no readiness probe. The app therefore handles "sandbox not ready" internally (queue briefly → `503 NOT_READY` + `Retry-After`).
- **Boot order:** parse config (fail fast with a readable message; never print secret values) → start listening immediately → spawn worker → run canary → flip ready. The process listens before it is ready so liveness passes during init.
- **SIGTERM:** stop accepting, let in-flight finish (≤ 8 s; Cloud Run allows ~10 s), terminate the worker, exit 0.
- **Process-level:** `unhandledRejection` / `uncaughtException` → log (metadata only) and exit(1); Cloud Run restarts. If the sandbox stays `dead` > 60 s → exit(1) so the instance is replaced.
- **Client IP:** use the **rightmost** `X-Forwarded-For` entry appended by Google's front end (`TRUSTED_PROXY_HOPS=1`), never the leftmost (client-controlled). Verify with a spoofed-header request on the deployed service.

---

## 6. Request lifecycle and budgets

Total request deadline `REQUEST_DEADLINE_MS` (default 30 000). Every stage receives a `Deadline` object; stages abort when it expires.

| #   | Stage                 |                           Budget | Failure behaviour                                             |
| --- | --------------------- | -------------------------------: | ------------------------------------------------------------- |
| 1   | Edge checks           |                            ~1 ms | 413 / 415 / 400 / 429 / 503                                   |
| 2   | Cache / single-flight |                            ~1 ms | hit → return; in-flight twin → await it                       |
| 3   | Gate                  |            ≤ 50 ms (main thread) | 422 `UNSUPPORTED_SQL` with parser position and hint           |
| 4   | Propose               |         ≤ 15 s (`LLM_BUDGET_MS`) | chain → deterministic; both fail → `no_recommendation`        |
| 5   | Evaluate              | ≤ 6 s (`SANDBOX_JOB_TIMEOUT_MS`) | timeout → recycle; response becomes `unverified` (no numbers) |
| 6   | Assemble              |                          ≤ 50 ms | n/a                                                           |

- Stage 4 runs the LLM chain and the (synchronous) deterministic planner. Candidates: `[llmSpec?, deterministicSpec?]`, de-duplicated; max 2.
- Stage 5 is skipped when there are no candidates.
- **Selection:** prefer the LLM candidate if _improved_ (I10); else the deterministic candidate if improved; else report `not_improved` with the better of the two. The unselected candidate (if measured) becomes `alternative`.
- Queue: `SANDBOX_QUEUE_MAX` waiting jobs, wait ≤ `SANDBOX_QUEUE_WAIT_MS`; beyond that → `503 BUSY` + `Retry-After`.
- In-flight cap `MAX_IN_FLIGHT`; beyond → `503 BUSY`.

---

## 7. HTTP layer

**Middleware order:** request-id → security headers → in-flight cap → rate limit → body limit (stream-counted, not trusting `Content-Length`) → content-type check → route. A global error handler maps `AppError` to the envelope; unknown errors become `INTERNAL` with a request id only.

| Concern       | Rule                                                                                                                                                                                                                                                                               |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Body          | `MAX_BODY_BYTES` (32 KB); `Content-Type` must be exactly `application/json`; `Zod.strict()` rejects unknown keys                                                                                                                                                                   |
| CORS          | none (same-origin only); no `Access-Control-*` headers                                                                                                                                                                                                                             |
| CSP           | `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'` (add `style-src-attr 'unsafe-inline'` only if React inline styles require it) |
| Other headers | `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `Strict-Transport-Security`, `Cross-Origin-Opener-Policy: same-origin`, minimal `Permissions-Policy`                                                                                                            |
| Rate limit    | per-IP token bucket (`RATE_LIMIT_PER_MIN`, `RATE_LIMIT_BURST`); `429` + `Retry-After`                                                                                                                                                                                              |
| Static        | serve `dist/client`; hashed assets `immutable`; `index.html` `no-cache`; SPA fallback only for GET requests not starting with `/api`                                                                                                                                               |
| Assets        | no remote fonts, scripts or images anywhere                                                                                                                                                                                                                                        |

---

## 8. API contract

All shapes are Zod schemas in `src/shared/contract.ts`; the client parses responses with the same schemas. **TypeScript types are inferred from the schemas, never hand-written twice.**

### `POST /api/diagnose`

**Request** (strict object)

| Field      | Type   | Rule                                                                                              |
| ---------- | ------ | ------------------------------------------------------------------------------------------------- |
| `schema`   | string | 1–`MAX_SCHEMA_BYTES` (20 000)                                                                     |
| `query`    | string | 1–`MAX_QUERY_BYTES` (8 000); exactly one `SELECT` / `WITH … SELECT`                               |
| `presetId` | enum?  | one of the 3 preset IDs; lets the server use a snapshot when the pipeline is unavailable (Tier B) |

**Response 200**

| Field                        | Type                                                                                                                                  | Notes                                                                                                                                               |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `requestId`                  | string                                                                                                                                | also in logs                                                                                                                                        |
| `cached`                     | boolean                                                                                                                               |                                                                                                                                                     |
| `outcome`                    | `"improved"` \| `"not_improved"` \| `"unverified"` \| `"no_recommendation"`                                                           | drives UI state                                                                                                                                     |
| `verification`               | `{status:"verified", indexUsed, costBefore, costAfter, costReductionPercent, costRatio, severity}` \| `{status:"unverified", reason}` | numbers only when verified (I1). `costReductionPercent` clamped 0–99.9; `costRatio = before/after` labelled "planner-estimated", never "speedup"    |
| `severity` (inside verified) | `"CRITICAL"` \| `"HIGH"` \| `"MODERATE"` \| `"OPTIMAL"`                                                                               | derived from measured ratio: ≥ 10× CRITICAL, ≥ 3× HIGH, otherwise MODERATE when improved; OPTIMAL when no index is needed. Thresholds are constants |
| `recommendation`             | object \| null                                                                                                                        | below                                                                                                                                               |
| `plans`                      | `{before: PlanSummary\|null, after: PlanSummary\|null}`                                                                               | null when unverified                                                                                                                                |
| `source`                     | `{proposedBy:"llm"\|"deterministic", model: string\|null, attempts: Attempt[]}`                                                       | `Attempt = {model, outcome, ms}`; outcome ∈ `ok`, `timeout`, `http_error`, `invalid_output`, `skipped_breaker`, `skipped_cap`, `no_key`             |
| `alternative`                | `{proposedBy, index, indexUsed, costAfter}` \| null                                                                                   | Tier B                                                                                                                                              |
| `assumptions`                | `{assumedRowCount, seededRows, plannerSettings:"postgres-defaults", tablesScaledEqually:true}`                                        | always present                                                                                                                                      |
| `notices`                    | string[]                                                                                                                              | e.g. MySQL rewrites applied, statements ignored, unseeded columns                                                                                   |
| `timingsMs`                  | `{gate, propose, evaluate, total}`                                                                                                    |                                                                                                                                                     |

**`recommendation`:** `{ index: {table, name, columns:[{name, direction, nulls?, opclass?}], include:[], where:string|null}, sql:{create, createConcurrently}, headline, explanation, antiPatterns[], esr:[{column, role:"Equality"|"Sort"|"Range"|"Include"|"Other", reason}], migrations:{postgres, drizzle?, prisma?}, migrationNotes[] }`. Free-text fields are sanitised and length-capped (§11.6).

**`PlanSummary`:** `{ nodePath, primaryScan, startupCost, totalCost, planRows, usesIndexes[], tree: PlanNode, rawPlan?: unknown }` with `PlanNode = {type, relation?, indexName?, alias?, startupCost, totalCost, planRows, filter?, indexCond?, recheckCond?, sortKey?[], joinType?, children[]}`. `rawPlan` is omitted when larger than 64 KB. Unknown node types pass through generically; the extractor never throws.

**Errors** — envelope `{ error: { code, message, hint? }, requestId }`

| Code                     | HTTP | When                                                               |
| ------------------------ | :--: | ------------------------------------------------------------------ |
| `INVALID_REQUEST`        | 400  | body fails the schema                                              |
| `PAYLOAD_TOO_LARGE`      | 413  | body or field over limit                                           |
| `UNSUPPORTED_MEDIA_TYPE` | 415  | content-type not JSON                                              |
| `UNSUPPORTED_SQL`        | 422  | gate rejection (hint says why and where)                           |
| `RATE_LIMITED`           | 429  | + `Retry-After`                                                    |
| `BUSY`                   | 503  | in-flight cap or queue full, + `Retry-After`                       |
| `NOT_READY`              | 503  | sandbox starting/recovering and nothing to return, + `Retry-After` |
| `INTERNAL`               | 500  | unexpected; request id only                                        |

LLM or sandbox failures are **not** errors (I8).

### Health

- `GET /api/health` → `200 {ready:true, version, uptimeSec, sandbox:{state, respawns, jobsSinceSpawn}, llm:{configured, models:[{id, breaker}]}}` or `503` with the same shape and `ready:false`. Never includes secrets.
- `GET /api/health/live` → `200 {status:"ok"}` always (I6).

---

## 9. SQL gate (main thread, before anything else)

**Parse:** `libpg-query` (Postgres 18 dist-tag if it exists, else 17; confirm with `npm view libpg-query dist-tags`). Pre-checks before parsing: byte limits, no NUL bytes, paren-depth ≤ 200. Parse failure → 422 with message and position. Hostile fixtures must parse-or-reject in < 50 ms; if any takes longer than 200 ms, move the gate into the worker (decision by measurement).

**MySQL sanitiser (best effort, before parse):** `AUTO_INCREMENT` → `GENERATED … AS IDENTITY`/`SERIAL`, `DATETIME` → `TIMESTAMP`, backticks → double quotes, `ENGINE=…`/`CHARSET=…` removed. Each rewrite adds a `notice`. Still unparseable → 422.

**Schema allow-list (by AST node type):**

| Allowed               | Notes                                                                                                             |
| --------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `CreateStmt`          | `CREATE TABLE`; reject `CREATE TABLE AS`, partitions, inheritance in v1                                           |
| `CreateEnumStmt`      | enum labels never go into the prompt                                                                              |
| `IndexStmt`           | existing indexes (used for duplicate detection)                                                                   |
| `AlterTableStmt`      | only `ADD CONSTRAINT` (PK/UNIQUE/FK/CHECK) and `ADD COLUMN`                                                       |
| Ignored with a notice | `VariableSetStmt`, `CommentStmt`, `CreateExtensionStmt`, `ALTER … OWNER TO`, the pg_dump `set_config` preamble    |
| Everything else       | rejected (`COPY`, `DO`, functions/procedures/triggers, `INSERT/UPDATE/DELETE`, `DROP`, views, `CREATE SCHEMA`, …) |

Function calls in DDL (defaults, checks, generated columns) must be on an allow-list (`now`, `current_timestamp`, `gen_random_uuid`, `nextval`, `lower`, `upper`, `coalesce`, …); anything else is rejected.

**Query rules:** exactly one `SelectStmt` (incl. `WITH … SELECT`); no `INTO`, no locking clause, no data-modifying CTEs, no `FuncCall` on the deny-list (`pg_sleep*`, `pg_read_*`, `pg_ls_*`, `lo_*`, `dblink*`, `set_config`, `pg_terminate_backend`, …), no schema-qualified system catalogs. All referenced relations (excluding CTE names) must exist in the schema; otherwise 422 listing the unknown tables.

**Identifier rule (I9):** every identifier in the schema and query must match `^[A-Za-z_][A-Za-z0-9_]{0,62}$` (case-insensitive; quoted identifiers allowed if they match). Otherwise 422 with hint "use simple identifiers".

**Limits:** ≤ 30 tables, ≤ 100 columns/table, ≤ 100 statements, ≤ 20 000 AST nodes.

**Output of the gate:** `GateResult { statements: string[] (validated source slices), querySql: string, catalog: Catalog, notices: string[] }`. Only these slices reach the worker.

**Catalog:** tables, columns (name, type, nullable, has default, generated), PK, unique constraints, FKs, existing indexes (ordered key columns + directions), enum type names. Built from the AST, never from text.

---

## 10. Sandbox

### 10.1 Job lifecycle (`evaluate`)

```
BEGIN
  SET LOCAL session_replication_role = replica      -- FK triggers off; no FK-ordering problems
  SET LOCAL max_parallel_workers_per_gather = 0     -- determinism; planner settings otherwise = Postgres defaults
  run validated schema statements, one by one
  drop CHECK constraints                            -- seeding must not fail on them (note it)
  introspect catalog → seed plan
  seed each table: INSERT … SELECT … FROM generate_series(1, SEEDED_ROWS)
  ANALYZE
  scaleStats()  → read back reltuples/relallvisible, assert == target     ← before-plan
  EXPLAIN (FORMAT JSON) <query>                                            → before
  for each candidate (≤ 2):
      SAVEPOINT c
      CREATE INDEX <built by server>
      (if partial/expression index: ANALYZE that table)
      scaleStats() + read-back assert                                     ← CREATE INDEX rewrote parent stats
      EXPLAIN (FORMAT JSON) <query>                                        → after
      ROLLBACK TO SAVEPOINT c; RELEASE c
ROLLBACK                                                                   -- always, in finally
poison check: zero user objects remain; else mark worker poisoned
```

`scaleStats()`: for each user table set `reltuples = ASSUMED_ROW_COUNT`, keep physical `relpages`, set `relallvisible = relpages` (so Index Only Scan is considered; `VACUUM` cannot run in a transaction block). Planner settings stay at **Postgres defaults** and the response says so (no "tuning" to flatter results).

### 10.2 Seeding (deterministic, in-engine SQL)

- Read column metadata from the catalog **after** the DDL runs. Seed with `INSERT … SELECT` over `generate_series`, expressions derived from the column type and a name hint; **no JS row loops, no `random()`** (I12). Use a hash/modulo of the series index and a per-column constant.
- Name hints (heuristics, documented in `docs/fidelity.md`): `*_at`/`*_date` → increasing time series (correlated with the series index); `*_id` → medium cardinality; `status|type|state|role|kind` → 3–8 distinct values; `is_*|has_*|deleted*` → skewed boolean; `email|name|title|slug` → near-unique text.
- Types supported: smallint/int/bigint, numeric/float, text/varchar/char, boolean, date/timestamp(tz), uuid, json/jsonb, enums, arrays (empty). Serial/identity/defaulted/generated columns: let the default produce the value. PK/unique: derive from the series index. Unsupported type and NOT NULL → that table is **unseeded** → the whole evaluation returns `unverified` with the reason (no crash).
- Cardinality design: columns whose `n_distinct` should scale with table size must be high-cardinality (so `ANALYZE` stores them as a fraction); enum-like columns stay low and absolute.
- Row count (`SANDBOX_SEED_ROWS`, default 20 000 ⚠️) is a tunable verified by Spike 0.

### 10.3 Plan extraction

Walk the `EXPLAIN (FORMAT JSON)` tree into `PlanSummary`. "Index used" = any node whose `Index Name` equals the candidate's index name (Index Scan, Index Only Scan, **Bitmap Index Scan**). `improved = usedNewIndex && costAfter < costBefore` (I10). Handles Seq/Index/Index-Only/Bitmap scans, Sort, Limit, Aggregate, joins, CTE/Subquery scans, Append, Result; unknown nodes pass through.

### 10.4 Manager

States: `starting → ready ⇄ busy`, `recovering`, `dead`.

- FIFO queue with cap and wait limit; one job at a time.
- Per-job timeout `min(SANDBOX_JOB_TIMEOUT_MS, remaining deadline)`. On timeout: `worker.terminate()`, reject the job, respawn. The failing request does **not** wait for respawn; it returns `unverified`.
- Respawn backoff 0 / 1 / 2 / 5 s; after 5 consecutive spawn failures within 60 s → `dead`; if `dead` persists 60 s → `process.exit(1)`.
- **Canary:** after init the worker runs a tiny create/insert/explain/rollback; only then is the manager `ready`.
- **Recycle:** after `SANDBOX_RECYCLE_JOBS` jobs (default 300), when idle ≥ 1 s, terminate and respawn (WASM memory never shrinks). Never recycle mid-queue.
- **Poison:** a failed invariant check, a `ROLLBACK` error, or a worker `error`/`exit` event triggers recycle.
- Worker `error` and `exit` events are always handled; unexpected exit mid-job rejects that job.

### 10.5 Worker protocol (`protocol.ts`, Zod-validated both ways)

`→ {type:"job", id, kind:"evaluate", payload}` · `← {type:"ready"}` · `← {type:"result", id, ok:true, data}` · `← {type:"result", id, ok:false, error:{code,message}}` · `← {type:"fatal", message}`.

### 10.6 Fidelity caveats (shown in UI and `docs/fidelity.md`)

Planner-estimated cost on simulated stats, not a benchmark; ~20k seeded rows keep page counts small (baseline cost is CPU-dominated); seeded data is synthetic (no skew/correlation beyond the hints); all tables are scaled equally; PGlite is single-process, so no parallel plans; the planner may prefer Bitmap scans (counted as used).

---

## 11. Doctor (diagnosis)

### 11.1 LLM client (`llm/client.ts`)

- Only file importing `@google/genai`; `ai.models.generateContent` for all models. Read the installed types for exact config field names (e.g. `systemInstruction`, `responseMimeType`, `responseJsonSchema` vs `responseSchema`, `thinkingConfig.thinkingLevel`). Never end `contents` with a `model` turn. **Never send `temperature`, `topP`, `topK`, `candidateCount`, `thinkingBudget`.**
- `AbortSignal` per attempt (`LLM_ATTEMPT_TIMEOUT_MS`).
- **Capability downgrade ladder** (per model, learned once and remembered in memory): full config (schema + thinking) → on `400` drop `thinkingConfig` → on `400` drop the response schema and use JSON-in-prompt mode. The learned profile is logged once.

### 11.2 Model profiles (`llm/models.ts`)

| Model (default order)   | Family | Structured output                                               | Thinking                                                   |
| ----------------------- | ------ | --------------------------------------------------------------- | ---------------------------------------------------------- |
| `gemini-3.5-flash-lite` | gemini | schema                                                          | `minimal` (default; configurable via `LLM_THINKING_LEVEL`) |
| `gemini-3.1-flash-lite` | gemini | schema (probe)                                                  | probe, else omit                                           |
| `gemma-4-31b-it`        | gemma  | **none assumed** (probe) → JSON-in-prompt + tolerant extraction | `minimal`                                                  |

`gemma-4-26b-a4b-it` (MoE, faster) is a documented swap via `LLM_MODELS`. Profiles are updated from Gate 0 probe results and recorded in an ADR.

### 11.3 Chain (`llm/chain.ts`)

For each model in `LLM_MODELS`: skip if its breaker is open or `LLM_DAILY_CAP` is reached → attempt within `min(LLM_ATTEMPT_TIMEOUT_MS, remaining LLM budget)` → on invalid output, **one** repair attempt only if ≥ 3 s of budget remain (repair = new _user_ turn containing the Zod issues; never a model-turn prefill) → on failure, next model. No key → skip the chain (`no_key`). All fail → deterministic only.

| Error                   | Breaker                                                   |
| ----------------------- | --------------------------------------------------------- |
| 401/403                 | open 10 min (log at error level)                          |
| 404                     | open 30 min                                               |
| 429                     | open for server hint or 60 s                              |
| 5xx / network / timeout | count; open `LLM_BREAKER_COOLDOWN_MS` after 3 consecutive |
| 400                     | handled by the downgrade ladder                           |

Outbound concurrency is limited by a semaphore (`LLM_MAX_CONCURRENCY`).

### 11.4 Prompt contract (`llm/prompt.ts`)

- **System instruction (static):** Principal PostgreSQL Database Reliability Engineer. Rules: ESR for B-tree (equality → sort → range; a column that is both sort and range appears once, in the sort position); `INCLUDE` only for 1–3 extra selected columns when Index Only Scan is plausible; partial index only for a constant, highly selective predicate; `text_pattern_ops`/`varchar_pattern_ops` for `LIKE 'prefix%'`; B-tree only; never propose an index equivalent to an existing one; if the plan is already good, return `index: null`; return only the JSON object.
- **User content (I9):** catalog summary as JSON (table, column, type name, nullability, PK, existing indexes); the comment-stripped, **string-literal-masked** query (`$1…`); the analyzer's hints (equality/sort/range/select columns) marked as "may be wrong". No raw DDL, no comments, no enum labels, no defaults, no literals. Section delimiters use a per-request random nonce.
- **Output schema (flat, Gemini-subset-safe):** `{ index: null | { table, columns:[{name, direction, nulls?, opclass?}], include:[], where?: string|null }, headline, explanation, antiPatterns:[], esr:[{column, reason}] }`. Derive it from Zod and strip unsupported keywords (`$schema`, `maxLength`, `pattern`, `$ref`, …); Zod re-validates length limits after the call.

### 11.5 Deterministic ESR planner (`sql/esr-planner.ts`)

Handles one table, `AND`-connected predicates only.

- Equality: `col = const`, `col IN (…)`, `col IS NULL`. Range: `>`, `>=`, `<`, `<=`, `BETWEEN`, `LIKE 'prefix%'`. Sort: `ORDER BY col [ASC|DESC] [NULLS …]`.
- Key = equality columns, then sort columns (with directions), then range columns not already present. A column that is both sort and range appears once, in sort position.
- `INCLUDE` = selected columns not in the key, only if 1–3 and not `SELECT *`.
- Name `idx_<table>_<cols>` truncated to 63 bytes with a short hash.
- Returns `null` with a reason for joins, top-level `OR`, expressions, or an index equivalent to an existing one.
- Doubles as the **ESR role classifier** for display (roles come from here whenever the column is classified; otherwise `Other` with the model's reason).

### 11.6 Validation and sanitising

- **Spec validation (`sql/index-spec.ts`):** table exists and is in the query; columns exist in that table, no duplicates; ≤ 6 key columns, ≤ 3 include, include ∩ key = ∅; `opclass` from a fixed allow-list and only on text types; `where` must parse (`SELECT 1 FROM t WHERE <pred>`) to a predicate of column/constant comparisons only; not equivalent to an existing index. Invalid → treated as no LLM candidate (falls to deterministic).
- **DDL builder (`sql/ddl.ts`):** the only producer of `CREATE INDEX` text; quotes identifiers by rule; never interpolates model strings other than validated identifiers/enums.
- **Free-text sanitiser:** strip control characters, collapse whitespace, remove URLs/HTML/markdown links (replace with `[link removed]`), cap lengths (headline 120, explanation 600, each antiPattern 160, each reason 160). Render as text only.

### 11.7 Migrations (deterministic, unit-tested snapshots)

- **PostgreSQL:** `CREATE INDEX CONCURRENTLY IF NOT EXISTS …` plus a comment that it cannot run inside a transaction block.
- **Drizzle / Prisma (Tier B):** key columns (with directions) in each ORM's syntax; **verify exact syntax against the current official docs before coding**. `INCLUDE` and partial indexes are not expressible in Prisma (open issue prisma/prisma #8584, not re-checked today) and unverified for Drizzle → put the ORM-expressible part in the tab and a `migrationNotes` entry pointing to the raw SQL. Add a note that property names must match the user's schema definition.

---

## 12. Degradation ladder and failure matrix

| Level | Condition                                 | Result                                            |
| ----: | ----------------------------------------- | ------------------------------------------------- |
|    L0 | LLM ok, sandbox ok                        | verified result, `proposedBy:"llm"`               |
|    L1 | model N fails                             | next model (attempts listed in `source`)          |
|    L2 | LLM unavailable or invalid                | deterministic candidate, verified                 |
|    L3 | sandbox timeout/unseeded/unready          | recommendation **without numbers** (`unverified`) |
|    L4 | pipeline unavailable and `presetId` given | recorded snapshot, labelled with date (Tier B)    |
|    L5 | overloaded                                | `429` / `503` with `Retry-After`                  |

| Failure                              | Behaviour                                                              |
| ------------------------------------ | ---------------------------------------------------------------------- |
| No/invalid key, model 404, quota     | breaker + chain → deterministic; UI says "generated by built-in rules" |
| Unsupported config for a model (400) | downgrade ladder                                                       |
| Malformed model JSON                 | tolerant extraction → one repair → next model                          |
| Model proposes unsafe/invalid spec   | rejected by validation; deterministic candidate                        |
| Planner ignores new index            | `not_improved`; no improvement claimed                                 |
| Sandbox timeout                      | terminate/respawn, `unverified`                                        |
| Worker crash mid-job                 | job rejected, respawn, `unverified`                                    |
| Container restart                    | boot → canary → ready (⚠️ ≈ 3 s init)                                  |
| Queue/in-flight full                 | `503 BUSY` + `Retry-After`                                             |

---

## 13. Security model

| Threat                                                          | Control                                                                                                                                       |
| --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Malicious SQL (DoS, file/network access)                        | AST allow-list; function allow/deny lists; identifier rule; PGlite is in-process WASM with a virtual FS; worker thread; hard timeout; recycle |
| Event-loop starvation                                           | sandbox off the main thread; parse pre-checks and < 50 ms rule                                                                                |
| Prompt injection (comments, literals, identifiers, enum labels) | I9: no user free text reaches the prompt                                                                                                      |
| Hostile model output                                            | structured spec only; catalog-validated; DDL built by the server; text sanitised; sandbox verification before any claim                       |
| XSS                                                             | React text rendering only; no `dangerouslySetInnerHTML`; strict CSP; no remote assets                                                         |
| CSRF                                                            | JSON-only content type, no CORS, no cookies                                                                                                   |
| Cost abuse                                                      | body/size limits, per-IP bucket, daily LLM cap, cache, single-flight, max-instances, billing alert                                            |
| Secret leakage                                                  | Secret Manager → env; never logged, never in the client bundle; secret regex in `check-forbidden` and CI secret scan                          |
| Supply chain                                                    | exact pins, lockfile, `npm ci`, minimal allow-listed dependencies, Dependabot, `npm audit` in CI, prefer releases at least a week old         |
| Data retention                                                  | none; log metadata only (sizes, hashes, timings)                                                                                              |

**Privacy line in the UI:** "Schemas and queries are processed in memory and sent to Google's Gemini API when a model is used; don't paste secrets." Wording must match the data-use terms of the key's tier (check at Gate 0). In deterministic mode nothing leaves the instance.

---

## 14. Observability

- **Structured JSON logs to stdout** (`severity`, `message`, `requestId`, `outcome`, `proposedBy`, `model`, `cached`, per-stage timings, queue depth, worker state, respawn count, breaker transitions, rate-limit hits). Hash of the input for correlation; **never** schema/query text (I4, tested by capturing logs).
- Cloud Run metrics to watch on launch day: instance count, memory utilisation (alert > 80 %), latency, 4xx/5xx, container restarts. Logs at `error` level for respawns > 3/hour.
- Gemini: per-model status counters (404/429/400 visible at a glance).

---

## 15. Configuration (env; parsed and validated in `config.ts`)

Invalid values fail fast at boot with a readable message (names only). Missing optional values use defaults. **`.env.example` lists exactly these names** (a test enforces sync).

| Var                                                       | Default                                                      | Notes                                                |
| --------------------------------------------------------- | ------------------------------------------------------------ | ---------------------------------------------------- |
| `PORT`                                                    | 8080                                                         |                                                      |
| `NODE_ENV`                                                | production                                                   |                                                      |
| `LOG_LEVEL`                                               | info                                                         |                                                      |
| `GEMINI_API_KEY`                                          | —                                                            | secret; absent → deterministic only                  |
| `LLM_MODELS`                                              | `gemini-3.5-flash-lite,gemini-3.1-flash-lite,gemma-4-31b-it` | ordered chain                                        |
| `LLM_THINKING_LEVEL`                                      | minimal                                                      | applied only where accepted                          |
| `LLM_ATTEMPT_TIMEOUT_MS`                                  | 8000                                                         |                                                      |
| `LLM_BUDGET_MS`                                           | 15000                                                        | total across the chain                               |
| `LLM_MAX_CONCURRENCY`                                     | 6                                                            |                                                      |
| `LLM_DAILY_CAP`                                           | 1500                                                         | per instance; worst case × max-instances             |
| `LLM_BREAKER_COOLDOWN_MS`                                 | 60000                                                        |                                                      |
| `REQUEST_DEADLINE_MS`                                     | 30000                                                        |                                                      |
| `MAX_BODY_BYTES` / `MAX_SCHEMA_BYTES` / `MAX_QUERY_BYTES` | 32768 / 20000 / 8000                                         |                                                      |
| `MAX_IN_FLIGHT`                                           | 24                                                           |                                                      |
| `SANDBOX_QUEUE_MAX` / `SANDBOX_QUEUE_WAIT_MS`             | 12 / 5000                                                    |                                                      |
| `SANDBOX_JOB_TIMEOUT_MS`                                  | 6000                                                         |                                                      |
| `SANDBOX_SEED_ROWS`                                       | 20000                                                        | ⚠️ confirm in Spike 0                                |
| `ASSUMED_ROW_COUNT`                                       | 500000                                                       | shown in the UI                                      |
| `SANDBOX_RECYCLE_JOBS`                                    | 300                                                          |                                                      |
| `RATE_LIMIT_PER_MIN` / `RATE_LIMIT_BURST`                 | 12 / 6                                                       | per IP                                               |
| `TRUSTED_PROXY_HOPS`                                      | 1                                                            |                                                      |
| `CACHE_MAX_ENTRIES` / `CACHE_TTL_MS`                      | 200 / 3600000                                                | verified outcomes only; `unverified` is never cached |

Cost note (estimate, measure in Gate 0): ≈ 2k input + 0.5k output tokens per call at list price ≈ $0.002 per call; worst case `LLM_DAILY_CAP × max-instances` ≈ 7 500 calls/day ≈ $15/day.

---

## 16. Testing strategy

Pyramid: unit (fast, parallel) → engine tests on real PGlite (**serial**; one instance per file) → integration against the **built** output with the real worker → hostile corpus → soak/parallel scripts on the deployed URL.

**Vitest projects:** `unit` (parallel; no PGlite), `pglite` (`fileParallelism: false`; engine tests call `engine.ts` in-process), `integration` (run after `npm run build`; spawns the compiled worker). Manager logic (timeouts, respawn, queue, recycle) is tested against `tests/fixtures/fake-worker.mjs`, not PGlite. The LLM adapter is faked at the `llm/client.ts` boundary; **no network in tests**.

| Area                  | Tests                                                                                                                                                                                                            |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Golden presets        | per preset: baseline bottleneck; new index used; cost drops by ≥ a threshold **taken from measurements**; read-back stats assertion                                                                              |
| Gate                  | allow/reject matrix per node type; pg_dump preamble; MySQL rewrites; identifier rule; limits                                                                                                                     |
| Hostile               | huge `generate_series`, `pg_sleep`, 1 MB body, `COPY`, `DO`, multi-statement, unterminated quote/comment, dollar-quote tricks, deep nesting, giant identifier, NUL bytes, 10 MB single line, unicode confusables |
| Prompt-injection      | injection text in comments, literals, identifiers, enum labels, defaults → prompt snapshot contains none of it (I9)                                                                                              |
| LLM chain             | no key; bogus model (404); 400 unsupported config → downgrade; 429/5xx → breaker; malformed JSON → repair; model returns `DROP TABLE`/non-existent column → rejected; all fail → deterministic                   |
| Deterministic planner | table-driven fixtures for ESR ordering, sort+range same column, INCLUDE, IN lists, OR bail-out, existing-index detection                                                                                         |
| Migrations            | snapshot per shape (plain, DESC, INCLUDE, partial)                                                                                                                                                               |
| Invariants            | I1–I12 each map to ≥ 1 test (log-capture test for I4; stats read-back for D3; leak check after N jobs for I3)                                                                                                    |
| Contract              | every response (success and each error code) parses with the shared Zod schema                                                                                                                                   |
| Resilience            | worker killed mid-job; job timeout → next request succeeds; queue overflow → 503; SIGTERM drains                                                                                                                 |
| Soak (script)         | 100 sequential runs: no leftover objects, RSS slope bounded                                                                                                                                                      |
| Parallel (script)     | 20 concurrent on the deployed URL: only 200/429/503                                                                                                                                                              |
| UI                    | pure-function and reducer tests; manual state checklist at 375 px (Tier A); optional Playwright later                                                                                                            |

---

## 17. Tooling and quality gates

**TypeScript:** `strict`, `noUncheckedIndexedAccess`, `noImplicitOverride`, `noImplicitReturns`, `noFallthroughCasesInSwitch`, `noPropertyAccessFromIndexSignature`, `verbatimModuleSyntax`, `isolatedModules`, `forceConsistentCasingInFileNames`, `noUnusedLocals`, `noUnusedParameters`. Server/shared/tests: `module`/`moduleResolution` `NodeNext` (relative imports carry `.js`); client: bundler resolution. Project references via `tsc -b`.

**oxlint** (`.oxlintrc.json`; validate against `node_modules/oxlint/configuration_schema.json` and `npx oxlint --rules`; **rule names below are intent, confirm each exists in the installed version**):

- Categories: `correctness` and `suspicious` = error; `perf` = warn→CI error; `pedantic`/`style` off (oxfmt owns formatting).
- Plugins: typescript, unicorn, import, promise, node, oxc, react, react-perf(optional), jsx-a11y (client), vitest (tests).
- Type-aware rules: `no-floating-promises`, `no-misused-promises`, `await-thenable`, `no-unsafe-assignment/argument/call/member-access/return`, `no-unnecessary-type-assertion`, `switch-exhaustiveness-check`, `only-throw-error`, `restrict-template-expressions`.
- Hygiene: `no-console` (server uses the logger; scripts exempt), `eqeqeq`, `no-eval`, `no-new-func`, `no-implied-eval`, `no-explicit-any`, `no-non-null-assertion`, `ban-ts-comment` (requires description), `consistent-type-imports`, `no-cycle`, `no-default-export` (exempt config files), `filename-case` (kebab-case; PascalCase allowed for `.tsx` under `components/`), `prefer-node-protocol`, `react/no-danger` (error), `react-hooks/rules-of-hooks` and `exhaustive-deps`, `jsx-a11y/*`, `max-lines` (warn 300), `complexity` (warn 15), `no-await-in-loop` (warn), `no-restricted-imports` (the boundary table in §4.1).
- Options: `reportUnusedDisableDirectives`, `denyWarnings` in CI. Type-aware is **alpha**: keep `tsc` authoritative; if tsgolint fails to parse a tsconfig, fix `module`/`moduleResolution` first; never silently disable the check (ADR required).

**oxfmt** (`.oxfmtrc.json`; options validated against its schema): single quotes, semicolons, trailing commas, print width 100, sorted imports. `.editorconfig`: LF, UTF-8, 2 spaces, final newline.

**knip:** flags unused files, exports and dependencies (CI error).

**`scripts/check-forbidden.mjs`** (fast grep-style guard; fails CI) — patterns: `@google/generative-ai`; `new PGlite(` outside the worker/engine; `eval(`, `new Function`; `dangerouslySetInnerHTML`; `localStorage` outside `client/state/history.ts`; `temperature|topP|top_p|topK|top_k|candidateCount|thinkingBudget|thinking_budget`; literal `gemini-` / `gemma-` model strings outside `llm/models.ts`, `config.ts` and tests; `console.` in `src/server`; secret shapes (`AIza[0-9A-Za-z_-]{35}`); `// @ts-ignore` and `@ts-nocheck`; `oxlint-disable` / `eslint-disable` without a reason comment; TODOs without an issue reference.

**CI (`.github/workflows/ci.yml`):** Node from `.nvmrc`; `npm ci`; `npm run verify`; `npm audit --omit=dev --audit-level=high`; secret scan action; Docker build job that runs the container with `--memory 2g --cpus 1` and curls `/api/health`. Deployment is manual (`workflow_dispatch` or local `gcloud`); no auto-deploy.

**Scripts** (`package.json`): `dev`, `build`, `typecheck`, `lint` (type-aware), `lint:fast`, `fmt`, `fmt:check`, `knip`, `check:forbidden`, `test`, `test:unit`, `test:pglite`, `test:integration`, `verify:fast` (fmt:check + lint:fast + typecheck + test:unit + check:forbidden), `verify` (everything + build), `smoke`, `verify:deploy`. `engines.node` = `>=24 <25`; `.npmrc`: `engine-strict=true`, `save-exact=true`.

---

## 18. Open-source standards

| Area                 | Standard                                                                                                                                                                                                                                                                      |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| License              | MIT (`LICENSE`); README credits PGlite (Apache-2.0 / PostgreSQL License) and libpg-query (MIT)                                                                                                                                                                                |
| Root files           | README, CONTRIBUTING, CODE_OF_CONDUCT (Contributor Covenant 2.1 from the official source), SECURITY (private reporting via GitHub advisories; scope: sandbox escape, SQL gate bypass, cost abuse), CHANGELOG (Keep a Changelog), `.editorconfig`, `.nvmrc`                    |
| README               | what it is, a GIF/screenshot, how it works (3 sentences + diagram), **limits ("simulated stats")**, run locally (`npm ci && npm run dev`), env table, deploy to Cloud Run, project layout, contributing link                                                                  |
| Commits and versions | Conventional Commits (`feat(sandbox): …`); SemVer; tag `v0.1.0` at launch                                                                                                                                                                                                     |
| GitHub               | issue forms, PR template (checklist: `verify` green, tests, docs, no new dependency without reason), Dependabot (npm, docker, actions; weekly)                                                                                                                                |
| Docs                 | ADRs in `docs/adr/` (template: context, decision, consequences); `docs/fidelity.md`; `docs/deployment.md`                                                                                                                                                                     |
| Code style           | named exports; `type` over `interface`; Zod-inferred types; TSDoc on exported symbols; comments explain _why_; files ≤ 300 lines, functions ≤ 40 lines (soft); no commented-out code; typed `AppError` with codes; no swallowed exceptions; options object for > 3 parameters |
| Tests                | co-located `*.test.ts`; behaviour names ("rejects COPY statements"); table-driven fixtures; thresholds carry a `measured on <date>` comment                                                                                                                                   |

---

## 19. Frontend

React 19 + Vite + Tailwind v4 (`@tailwindcss/vite`, `@import "tailwindcss"`; no config file unless needed) + `lucide-react`. Single page, no router, no UI kit, system fonts.

- **Theme:** `bg-slate-950`, `border-slate-800`; emerald-400 = improved, rose-400 = bottleneck, amber-400 = ESR roles and warnings.
- **Layout:** header ("IndexDoctor", pulsing icon, badge "Deployed on Google Cloud Run"); hero; preset pills (one click fills both editors and runs); two monospace textareas; run button.
- **Result:** three vital-sign cards (cost before → after with −XX.X% badge; scan-node change red → emerald; verification line with ms and the `source` model or "built-in rules"); side-by-side plan comparison (+ raw-JSON toggle, Tier B); ESR chain pills; migration tabs with copy and `migrationNotes`; honesty line "Planner-estimated cost on simulated {assumedRowCount} rows — not a benchmark"; privacy line.
- **State machine** (reducer): `idle → running → success(outcome)` or `error(code)`. Outcome rendering: `improved` (emerald), `not_improved` (amber "index not used / no gain", no improvement claimed), `unverified` (amber, recommendation without numbers), `no_recommendation` (neutral), `RATE_LIMITED` (shows retry timer), `BUSY`/`NOT_READY` (retry hint), other errors (message + request id).
- **No fake progress:** a spinner with elapsed seconds only. Do not claim stages that aren't streamed.
- **A11y and responsiveness:** keyboard-focusable controls, visible focus, labelled textareas, `aria-live` for status, contrast checked, usable at 375 px, copy buttons announce success.
- **Rendering rule:** all server strings render as text.

---

## 20. Future (out of scope now)

Real Postgres connection (read-only `EXPLAIN` only), workload-level analysis, `pg_stat_statements` ingestion, non-B-tree methods (GIN/GiST/BRIN), multiple candidates with write-amplification trade-offs, MySQL parity, server-side permalinks, streaming progress.
