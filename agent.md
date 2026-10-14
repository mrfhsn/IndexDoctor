# agent.md — Build Instructions for the AI Coding Agent (IndexDoctor v2)

You are building **IndexDoctor**, an open-source tool, for the Google Cloud Run Hackathon on Product Hunt. Read `architecture.md` (what/design/contract) and `plan.md` (scope/gates/risks) first. **This file is how you work.**

**Precedence on conflict: `architecture.md` > `agent.md` > `plan.md`.** If two documents disagree, or a document disagrees with reality (a package, an API, a doc page), **stop, report the conflict, and propose a resolution.** Never resolve it silently.

Your three failure modes, in order of likelihood: (1) claiming something works that you did not run, (2) writing against an API from memory that has changed, (3) adding scope nobody asked for. Every rule below exists to prevent one of those.

---

## 1. Prime directives

1. **Evidence or it didn't happen.** Never report a result, number, plan change, test outcome or deployment state you did not produce _in this session_ by running a command. Paste the command and its real output into `.agent/evidence/`.
2. **Source-of-truth ladder** (highest wins): installed package types/README in `node_modules` → official docs fetched this session → your memory. If you rely on the bottom rung, say so.
3. **Smallest change that satisfies the acceptance criteria.** No features, abstractions or dependencies beyond `architecture.md`.
4. **Gates in order.** Do not start a gate until the previous gate's acceptance is met and evidenced.
5. **Green before commit.** Run `npm run verify:fast` before every commit and `npm run verify` before every gate report.
6. **Never weaken a check to pass it.** Do not edit a test, threshold, lint rule, tsconfig flag or forbidden-pattern to make something green. If a check is wrong, tell the user, explain, and get agreement. Adjust _preset data_, never _thresholds_.
7. **Never claim an improvement the planner didn't produce** (invariant I10), and never display a number without a measurement (I1).
8. **Never trust your own "healthy".** A deployment is healthy only when `npm run verify:deploy` exits 0 (see §10). (A real PH forum report: an agent marked a Cloud Run service healthy while the container crash-looped on an unset variable.)
9. **Persist your memory.** Keep `.agent/STATE.md` current (§5.1). After any context reset, read it first.
10. **Ask rather than guess** when a stop-and-ask trigger fires (§12).

---

## 2. Final decisions — do not re-litigate

| Topic       | Decision                                                                                                                                                                                   |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Runtime     | Node **24** LTS, ESM, TypeScript strict. If Spike 0 fails on 24, try 22 and tell the user.                                                                                                 |
| LLM models  | `LLM_MODELS=gemini-3.5-flash-lite,gemini-3.1-flash-lite,gemma-4-31b-it`, then the deterministic planner. Env-driven; the IDs live in `llm/models.ts` and `config.ts` only.                 |
| LLM surface | `@google/genai`, `ai.models.generateContent` only. Docs examples use the Interactions API; **do not copy them.** If Gate 0 shows `generateContent` rejected for a Gemini ID, stop and ask. |
| LLM params  | No `temperature`, `topP`, `topK`, `candidateCount`, `thinkingBudget`. Thinking via `thinkingLevel` only. Never end `contents` with a `model` turn.                                         |
| LLM output  | Structured **index spec**, never SQL text. Server builds the DDL.                                                                                                                          |
| Prompt      | Catalog summary + literal-masked, comment-stripped query. No user free text (I9).                                                                                                          |
| Sandbox     | One long-lived PGlite in one worker thread; one `evaluate` job per request; `SAVEPOINT` per candidate; scale stats **last** and read back.                                                 |
| Parser      | `libpg-query` (WASM) in `sql/parse.ts` only.                                                                                                                                               |
| Honesty     | `unverified` outcomes show no numbers.                                                                                                                                                     |
| Deploy      | `gcloud run deploy --source .`; 2 GiB; always-on CPU; min 1 / max 5; concurrency 8.                                                                                                        |
| Tooling     | oxlint (+ type-aware), oxfmt, `tsc`, knip, `check-forbidden`, Vitest.                                                                                                                      |

---

## 3. Dependency allow-list (exact pins; anything else → ask)

Before adding any package: run `npm view <pkg> version time --json`, read its README and types, prefer a release at least a week old, install with exact pin, and add a one-line reason to the PR/commit message.

| Group                                                 | Packages                                                                                                                                                                          |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Server runtime (`dependencies`)                       | `hono`, `@hono/node-server`, `@electric-sql/pglite`, `libpg-query`, `@google/genai`, `zod`                                                                                        |
| Client (`devDependencies`; built at image-build time) | `react`, `react-dom`, `lucide-react`, `vite`, `@vitejs/plugin-react`, `tailwindcss`, `@tailwindcss/vite`                                                                          |
| Tooling (`devDependencies`)                           | `typescript`, `tsx`, `@types/node`, `@types/react`, `@types/react-dom`, `vitest`, `oxlint`, `oxlint-tsgolint`, `oxfmt`, `knip`, `concurrently` (+ `@vitest/coverage-v8` optional) |

Rules: the production image installs `--omit=dev`, so **server code may import only `dependencies`** (knip + the Docker smoke test catch violations). `@google/generative-ai` is deprecated and forbidden. No ORMs, no auth libraries, no logging library (use `logger.ts`), no UI kit, no state library, no CSS-in-JS, no analytics.

---

## 4. Verify-before-use checklist (read the installed types or docs; do not guess)

| Thing                     | What to confirm                                                                                                                                                                                                    | Where                                              |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------- |
| `@google/genai`           | exact `GenerateContentConfig` field names: `systemInstruction`, `responseMimeType`, `responseJsonSchema` vs `responseSchema`, `thinkingConfig.thinkingLevel` enum values, `abortSignal`, error shape (status code) | `node_modules/@google/genai/**/*.d.ts`             |
| PGlite                    | construction (`PGlite.create` / `waitReady`), `exec`, `query`, `close`, result shapes                                                                                                                              | `node_modules/@electric-sql/pglite` types + README |
| libpg-query               | `npm view libpg-query dist-tags` (pg18?), `parse` vs `parseSync`, AST shape (`stmts[].stmt.<Node>`, `stmt_location`, `stmt_len`, `location` fields)                                                                | print real ASTs for sample SQL in Spike 0          |
| Hono                      | `hono/body-limit`, `serveStatic` root path semantics, how to read the raw stream                                                                                                                                   | installed types                                    |
| Zod                       | installed major (expect 4); `toJSONSchema` output; strip unsupported keywords for Gemini                                                                                                                           | installed types + a probe call                     |
| oxlint                    | every rule name in `.oxlintrc.json` exists: `npx oxlint --rules`; config keys validate against `node_modules/oxlint/configuration_schema.json`; CLI flags via `npx oxlint --help`                                  | installed package                                  |
| oxfmt                     | option names against `node_modules/oxfmt/configuration_schema.json`                                                                                                                                                | installed package                                  |
| Vitest                    | `projects` config, `fileParallelism`                                                                                                                                                                               | installed docs                                     |
| Tailwind v4               | `@import "tailwindcss";` in CSS, `@tailwindcss/vite` plugin, no `tailwind.config.js`                                                                                                                               | docs                                               |
| Drizzle / Prisma (Tier B) | current index syntax: key columns, `desc`, `INCLUDE`, partial `WHERE`, index naming                                                                                                                                | official docs, fetched this session                |
| `gcloud`                  | probe flags and secret flags: `gcloud run deploy --help`                                                                                                                                                           | local CLI                                          |

If something isn't in this table and you're unsure, **look it up**. If you cannot, say "unverified" in your report.

---

## 5. Working method

### 5.1 `.agent/STATE.md` (gitignored; update after every task)

```
# STATE
Current gate: G?   Last green `verify`: <time> @ <commit>
Decisions made (with evidence file): …
Gate checklist: [x] / [ ] items copied from §9
Open issues / questions for the user: …
Next action: <one concrete step>
```

### 5.2 Task loop

1. Read the relevant `architecture.md` section and this file's gate steps.
2. Write a 3-line plan (what, which files, how you'll test).
3. Write the test first when the behaviour is specified (gate, planner, validators, migrations, config).
4. Implement the smallest thing; keep to the module's "owns / never" table.
5. `npm run verify:fast`. Fix root causes; do not silence.
6. Record evidence (command + real output) in `.agent/evidence/<gate>-<topic>.md`.
7. Commit (Conventional Commits). Update `STATE.md`.

**Done per task** = code + tests + `verify:fast` green + evidence + commit.

### 5.3 Gate report (send to the user after each gate)

`Built:` · `Commands run:` · `Measured results:` (table, real numbers) · `Deviations from the docs:` · `Open issues:` · `Next:`. If anything failed, say so first.

---

## 6. Code style and OSS standards

Authoritative detail in `architecture.md` §17–§18. Rules you must follow while writing code:

| Area              | Rule                                                                                                                                                                                     |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Files             | kebab-case (`strip-and-mask.ts`); React components PascalCase (`PlanTree.tsx`); tests co-located as `name.test.ts`; fixtures under `tests/fixtures/`                                     |
| Exports           | named exports only (default only in config files); no barrel files; no path aliases; relative imports with `.js` extensions on server/shared                                             |
| Types             | `type` over `interface`; infer from Zod; no `any` (validate unknown JSON at the boundary instead); no non-null `!`; no `@ts-ignore`/`@ts-nocheck`; `@ts-expect-error` only with a reason |
| Naming            | `camelCase` values/functions; `PascalCase` types/components; `UPPER_SNAKE` true constants and error codes; Zod schemas `fooSchema`; hooks `useFoo`; booleans `isX/hasX/canX`             |
| Functions         | small; ≤ 40 lines soft, ≤ 80 hard; early returns; options object above 3 parameters; no mutation of inputs                                                                               |
| Errors            | throw `AppError(code, message, {cause, hint, status})`; never throw strings; no empty `catch`; every catch either logs metadata and degrades, or rethrows                                |
| Async             | no floating promises; every external call has a deadline + abort path (I11); no `await` in loops unless sequential by design (comment why)                                               |
| Logging           | `logger.ts` only; metadata only (I4); no `console.*` in `src/server`                                                                                                                     |
| Comments          | explain **why**, not what; TSDoc on every exported symbol; no commented-out code; `TODO(#issue)` only                                                                                    |
| Constants         | named constants in `config.ts` or the module; no magic numbers in logic                                                                                                                  |
| Tests             | behaviour names ("rejects COPY statements"); table-driven fixtures; one behaviour per test; no network; thresholds carry `// measured on <date>`                                         |
| Security          | never log or commit secrets; never `eval`/`new Function`; never `dangerouslySetInnerHTML`; render server text as text                                                                    |
| Git               | Conventional Commits (`feat(sandbox): …`, `fix(llm): …`, `test(gate): …`, `docs: …`, `chore: …`); one logical change per commit; never `--no-verify`; never force-push `main`            |
| Lint suppressions | allowed only as `// oxlint-disable-next-line <rule> -- <reason>`; a suppression without a reason fails `check-forbidden`                                                                 |

### OSS file set (create in Gate 1, polish in Gate 7)

README, LICENSE (MIT), CONTRIBUTING, CODE_OF_CONDUCT (Contributor Covenant 2.1 — **copy from the official source**; ask the user for the contact email), SECURITY, CHANGELOG, `.editorconfig`, `.nvmrc`, `.github/` (CI, issue forms, PR template, Dependabot), `docs/adr/`.

---

## 7. Quality gates you must create in Gate 1 (before any feature code)

| Tool                          | Requirement                                                                                                                                                                                                                                                                |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tsc -b`                      | project references; flags from `architecture.md` §17; zero errors                                                                                                                                                                                                          |
| oxlint                        | `.oxlintrc.json` per §17; `npm run lint` = type-aware with warnings denied; `lint:fast` = without type-aware. Overrides for tests (allow non-null assertions, long files), scripts (allow `console`), config files (allow default exports), client (jsx-a11y, react rules) |
| oxfmt                         | `.oxfmtrc.json`; `fmt:check` in `verify`                                                                                                                                                                                                                                   |
| knip                          | `knip.json` with entry points (`src/server/main.ts`, `src/server/sandbox/worker.ts`, `src/client/main.tsx`, scripts, tests); zero findings                                                                                                                                 |
| `scripts/check-forbidden.mjs` | patterns from `architecture.md` §17; each pattern has a self-test fixture proving it triggers                                                                                                                                                                              |
| Vitest                        | projects `unit`, `pglite` (serial), `integration` (post-build)                                                                                                                                                                                                             |
| CI                            | `.github/workflows/ci.yml` as in `architecture.md` §17                                                                                                                                                                                                                     |

**Starter `.oxlintrc.json` shape** (validate every key and rule name before trusting it; adjust to the installed schema, and record deviations in an ADR):

```json
{
  "$schema": "./node_modules/oxlint/configuration_schema.json",
  "plugins": ["typescript", "unicorn", "import", "promise", "node", "oxc", "react", "jsx-a11y"],
  "categories": { "correctness": "error", "suspicious": "error", "perf": "warn" },
  "options": { "typeAware": true, "reportUnusedDisableDirectives": "error", "denyWarnings": true },
  "rules": {},
  "overrides": []
}
```

Add the hygiene, type-aware and boundary rules from §17 (`no-restricted-imports` implements the boundary table). **If tsgolint (type-aware) crashes or can't parse a tsconfig, fix `module`/`moduleResolution` first; never disable it silently.**

`npm run verify` = `fmt:check` → `lint` → `typecheck` → `knip` → `check:forbidden` → `test` (all projects; integration after build) → `build`.

---

## 8. Known traps (stale or surprising facts — do not "fix" these)

| Trap                    | Fact                                                                                                                                                                                                                                 |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Gemma model ID          | There is **no** `gemma-4`. Use `gemma-4-31b-it` (or `gemma-4-26b-a4b-it`).                                                                                                                                                           |
| Gemma structured output | Not documented for the Gemini API. Assume none: JSON-in-prompt + tolerant extraction (strip code fences, take the outermost braces) + Zod + one repair turn. Probe it.                                                               |
| Sampling params         | Ignored by 3.5 Flash-Lite and newer, and will return 400 in future models. Never send.                                                                                                                                               |
| Prefill                 | A request whose last turn is `model` returns 400. The repair turn is a **user** turn.                                                                                                                                                |
| Interactions API        | Docs lead with it; we deliberately use `generateContent`.                                                                                                                                                                            |
| Docs examples           | They often use `gemini-3.8-flash`. Our default is `gemini-3.5-flash-lite`. Do not copy model IDs from examples.                                                                                                                      |
| PGlite                  | Single connection. One instance, one worker. Never `new PGlite()` per request. ⚠️ ≈ 500 MB RSS and ≈ 3 s init (re-measure).                                                                                                          |
| `statement_timeout`     | ⚠️ reportedly not enforced; do not rely on it. The hard timeout + terminate is the control.                                                                                                                                          |
| `VACUUM`                | Cannot run in a transaction. Set `relallvisible` directly.                                                                                                                                                                           |
| Stats order             | `CREATE INDEX` rewrites the parent table's `pg_class` stats. **Scale after it, then read back and assert.**                                                                                                                          |
| Empty tables            | Planner takes the page count from the physical file; an empty table yields ≈ 0 cost before and after. That is why we seed.                                                                                                           |
| Determinism             | No `Math.random`, no `random()` in seeding (I12).                                                                                                                                                                                    |
| Cloud Run CPU           | Default is request-only; background threads freeze → `--no-cpu-throttling`.                                                                                                                                                          |
| Cloud Run probes        | Startup and liveness only; no readiness probe.                                                                                                                                                                                       |
| Client IP               | Rightmost `X-Forwarded-For` entry (Google-appended). Verify with spoofed headers.                                                                                                                                                    |
| Secrets                 | `--set-secrets`; runtime service account needs `roles/secretmanager.secretAccessor` or the revision fails to start.                                                                                                                  |
| NodeNext                | Relative imports on server/shared need `.js` extensions; TS error 2835 tells you.                                                                                                                                                    |
| Worker path             | `new Worker(new URL('./worker.js', import.meta.url))` must work in **both** `npm run dev` (tsx) and compiled `node dist/…`. Test both in Gate 1/2; if tsx can't resolve it, choose the extension from the runtime and record an ADR. |
| Vitest + PGlite         | Parallel files each spawn a PGlite (~0.5 GB) → OOM. Use the serial `pglite` project.                                                                                                                                                 |
| Tailwind v4             | No `tailwind.config.js`; `@import "tailwindcss";` + `@tailwindcss/vite`.                                                                                                                                                             |
| `npm ci --omit=dev`     | Client libs are `devDependencies`; server must not import them.                                                                                                                                                                      |

---

## 9. Gates

Create `.agent/STATE.md` now. After each gate: all checklist items evidenced → gate report → continue.

### Gate 0 — Feasibility and eligibility (≈ 30 min)

1. Confirm the answers to the plan §8 questions. Check `node -v` (24.x), `npm -v`, `gcloud auth list`, `gcloud config get-value project`, `docker --version` (optional but expected).
2. Ask the user to confirm the PH flow: draft reachable, hackathon toggle = Yes, and whether a `*.run.app` URL is accepted. You cannot check this yourself.
3. **`scripts/probe-models.mjs`** (reads the key from env; never prints it). For each model in `LLM_MODELS`: (a) minimal call; (b) structured output with the real response schema; (c) `thinkingLevel: minimal`; (d) system instruction; (e) latency over 3 runs; (f) token usage. Print a table. Also confirm `generateContent` works for all three IDs. Check the key's **tier and data-use terms** and the rate-limit page for the model; tell the user the wording the privacy line needs.
4. **`scripts/spike-pglite.mjs` — Spike 0** on Node 24, one PGlite instance:

| Spike | Measure                                                                                                                                                | Pass criterion                                                                                                         | If it fails                                                  |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| S1    | init time, RSS idle                                                                                                                                    | RSS < 700 MB; init < 6 s                                                                                               | raise memory (4 GiB) or lower seed rows; tell user           |
| S2    | empty-table plan cost                                                                                                                                  | ≈ 0 (confirms why we seed)                                                                                             | note and continue                                            |
| S3    | orders-like table: 20k seed → `ANALYZE` → scale → `EXPLAIN` before; create index; **read `reltuples` after `CREATE INDEX`**; re-scale; `EXPLAIN` after | before shows Seq Scan (+ Sort); stats reset after `CREATE INDEX` is _observed or ruled out_; after-plan uses the index | if scaling can't work: seed more rows and drop scaling (ADR) |
| S4    | `SET statement_timeout` + `pg_sleep`; heavy `generate_series`; `worker.terminate()` latency                                                            | record whether enforced; terminate returns within 1 s                                                                  | rely on hard timeout only                                    |
| S5    | 20 jobs: user-object count after each; RSS slope                                                                                                       | 0 objects; slope bounded                                                                                               | tune recycle count                                           |
| S6    | terminate → respawn → ready time; RSS afterwards                                                                                                       | ready < 6 s; RSS returns                                                                                               | adjust backoff/recycle                                       |
| S7    | `libpg-query`: dist-tags; AST for sample schema/query; parse time on hostile 20 KB inputs                                                              | all < 50 ms; AST node names match `architecture.md` §9                                                                 | move the gate into the worker (> 200 ms) or adapt names      |
| S8    | `UPDATE pg_class` allowed; `session_replication_role = replica` allowed; planner picks a Bitmap scan sometimes                                         | allowed                                                                                                                | adjust approach, ask                                         |

5. Write `.agent/evidence/gate0-models.md` and `gate0-spike.md` with raw output. Update model profiles, seed rows, memory and Node decisions; draft ADRs for any deviation.

**Acceptance:** evidence files contain real output; a decision is recorded for every spike that did not pass; the user has the probe table and spike table. **Stop and ask** if S1 or S3 fails, or a model in the chain is unavailable to the key.

### Gate 1 — Foundation and walking skeleton, live on Cloud Run (≈ 50 min)

1. `git init`; `.nvmrc` (24), `.npmrc` (`engine-strict`, `save-exact`), `package.json` (`type: module`, `engines`, all scripts from `architecture.md` §17), install the §3 allow-list with exact pins and a committed lockfile.
2. tsconfigs, oxlint, oxfmt, knip, `check-forbidden` (+ self-tests), Vitest projects, `.editorconfig`, `.gitignore` (includes `.agent/`, `.env*`, `dist/`), `.gitattributes`.
3. Minimal code: `config.ts` (Zod env, defaults, fail-fast readable errors), `logger.ts`, `errors.ts`, `app.ts` (`createApp(deps)` with request-id, security headers, `/api/health`, `/api/health/live`, static placeholder), `main.ts` (listen first; SIGTERM; process-level handlers). The worker doesn't exist yet: `/api/health` reports `ready:true` with `sandbox.state:"not_started"` for this gate only.
4. Tests: config (valid, invalid, defaults; `.env.example` ↔ config sync), health, headers, error envelope.
5. OSS files (§6) and `.github/` (CI, issue forms, PR template, Dependabot).
6. `Dockerfile` (multi-stage, `node:24-slim`, non-root, `npm ci --omit=dev`, compiled server) + `.dockerignore`. **Run it locally**: `docker run --memory 2g --cpus 1 -p 8080:8080 …`, curl health and a static asset.
7. Deploy per §10 and run `npm run verify:deploy` (the skeleton subset: describe + health + headers).
8. Give the user the URL and the ready-to-paste PH draft fields (name, tagline, description, URL, GitHub link, hackathon = Yes).

**Acceptance:** `npm run verify` green; CI green on push; public `/api/health` 200; `verify:deploy` exits 0; revision settings match `architecture.md` §5; the PH draft has the real URL.

### Gate 2 — SQL gate and sandbox (≈ 100–120 min)

Build order (test each before the next): `sql/parse` → `sql/gate` → `sql/catalog` → `sql/sanitize-mysql` → `sql/strip-and-mask` → `sandbox/protocol` → `sandbox/engine` (+ `seed`, `stats`, `plan`) → `sandbox/worker` → `sandbox/manager` → canary.

Required behaviours (`architecture.md` §9–§10):

- Gate: allow/reject matrix per AST node type, pg_dump preamble handling, MySQL rewrites with notices, identifier rule, limits, unknown-table detection. Hostile fixtures reject or parse in < 50 ms.
- Engine: job lifecycle exactly as §10.1 — including `SAVEPOINT` per candidate, **scale-last with read-back assertion**, drop CHECK constraints, deterministic seeding, unseeded fallback (never a crash), poison check.
- Plan extractor: pure function; unknown node types pass through; Bitmap Index Scan counts as used.
- Manager: queue cap and wait limit; per-job timeout → terminate → respawn; backoff; recycle when idle; `dead` handling; canary before ready. Tested with `fake-worker.mjs`.
- `/api/health` now reflects the real sandbox state.

**Golden preset tests** (data lives in `src/shared/presets/`; thresholds come from your measurements): for each of the 3 presets print before/after node path, scan type, cost and index used. Preset 3 (existing narrow index → `INCLUDE`) **must be validated**; if the planner doesn't flip to Index Only Scan, change the preset data (not the thresholds) and tell the user.

**Acceptance:** preset table printed with real numbers; hostile suite returns an error ≤ 5 s and the _next_ request succeeds; 100 sequential `evaluate` jobs leave zero user objects and bounded RSS; killing the worker mid-job recovers; `verify` green. Record the numbers in `docs/measurements.md` via `scripts/measure.mjs` (not by hand).

### Gate 3 — Diagnosis (≈ 75 min)

Build order: `lib/sanitize-text` → `sql/index-spec` → `sql/ddl` → `sql/esr-planner` → `llm/models` → `llm/client` → `llm/prompt` → `llm/parse-output` → `llm/breaker` → `llm/chain` → `migrations/postgres` (→ Drizzle/Prisma in Tier B).

Required behaviours (`architecture.md` §11):

- LLM client is the only importer of `@google/genai`; AbortSignal per attempt; capability downgrade ladder; no forbidden parameters.
- Prompt snapshot test: contains no comments, literals, enum labels, defaults, raw DDL; delimiters use a nonce (I9).
- Spec validation and DDL builder; the **only** `CREATE INDEX` text comes from `sql/ddl`.
- Deterministic planner: table-driven ESR fixtures (equality→sort→range, sort+range same column once, INCLUDE rules, IN lists, OR bail-out, joins → null, existing-index detection).
- Chain: no key; bogus model (404 → breaker); 400 → downgrade; 429/5xx → breaker; malformed JSON → one repair as a _user_ turn; model returns `DROP TABLE`/missing column/huge arrays → rejected; all fail → deterministic.
- Migrations: snapshot tests.

**Acceptance:** all chain tests pass using a fake `llm/client`; one **live** call per model in the chain succeeds (or its failure is documented); with no key, a preset still yields a valid result; injection test (hostile text in comments, literals, identifiers, enum labels) → output validates and the prompt snapshot is clean.

### Gate 4 — Pipeline, API and guards (≈ 60 min)

Build order: `lib/*` (deadline, lru, single-flight, token-bucket, semaphore, hash) → middleware (request-id, security headers, in-flight cap, rate limit, body limit, error handler) → `pipeline/diagnose` → `routes/diagnose` → `routes/static`.

Required behaviours: stage order and budgets per `architecture.md` §6; selection rule (LLM improved → deterministic improved → not_improved); outcomes and `verification` per §8; single-flight (identical concurrent requests share one run); cache only verified outcomes; rate limit uses the rightmost XFF; every response validates against the shared Zod schema.

**Acceptance:** contract tests for success and every error code; invariants I1–I12 each have a passing test (I4 by capturing logs and asserting a sentinel table name never appears); killing the worker or breaking the LLM yields 200 with `unverified`/deterministic, never 5xx; 20 concurrent identical requests run the pipeline once.

### Gate 5 — UI (≈ 75 min)

Implement `architecture.md` §19. Order: `api.ts` (Zod-parsed) → `state/reducer` → components (cards, plan tree, ESR chain, migration tabs, editors, preset bar) → states → responsive/a11y pass.

**Acceptance:** from a fresh load, **one click** on a preset reaches a full result; every outcome and error state is reachable (use a dev-only way to trigger them via the fake pipeline, not by editing production code) and readable at **375 px**; no console errors; keyboard-only run works; all strings render as text; reducer and formatters have unit tests; screenshots saved for Gate 7.

### Gate 6 — Harden, deploy, measure (≈ 45 min)

1. `npm run verify` clean from a fresh clone (`git clone` to a temp dir, `npm ci`, `npm run verify`).
2. Run the container locally with `--memory 2g --cpus 1`: `scripts/smoke.mjs` (health, 3 presets, hostile, 20 parallel).
3. Deploy (§10) and run `npm run verify:deploy`.
4. `scripts/measure.mjs` against the public URL: p50/p95 for presets (LLM and deterministic-only), 100-run soak (RSS via health/metrics), 20 parallel. Write `docs/measurements.md`.

**Acceptance:** 20 parallel → only 200/429/503; `verify:deploy` exits 0; memory < 80 % of 2 GiB during the soak; measurements file generated by the script.

### Gate 7 — OSS polish and launch assets (≈ 45 min)

README per `architecture.md` §18 (limits section prominent; numbers copied only from `docs/measurements.md`); ADRs for decisions that deviated or surprised; `docs/fidelity.md` and `docs/deployment.md`; CHANGELOG `0.1.0`; tag `v0.1.0`. Provide the user: 3 screenshots, optional recording, PH tagline/description/maker comment drafts, and captions with measured numbers only. Run the §11 self-audit.

**Acceptance:** fresh clone → `npm ci && npm run verify` passes; every number in README/PH copy is traceable to `docs/measurements.md`; the repo is ready to flip public.

---

## 10. Cloud Run procedure and `verify:deploy`

Replace placeholders; **never echo, log or commit the API key.** Ask the user to run the secret-creation command themselves (or pipe it from their own shell), and do not paste the key into the chat or a file.

```bash
gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com secretmanager.googleapis.com
# user runs this themselves, with the key on stdin:
#   printf '%s' "$GEMINI_API_KEY" | gcloud secrets create gemini-api-key --data-file=-
gcloud secrets add-iam-policy-binding gemini-api-key \
  --member="serviceAccount:<RUNTIME_SERVICE_ACCOUNT>" --role="roles/secretmanager.secretAccessor"
gcloud run deploy indexdoctor --source . --region <REGION> --allow-unauthenticated \
  --memory 2Gi --cpu 1 --cpu-boost --no-cpu-throttling \
  --min-instances 1 --max-instances 5 --concurrency 8 --timeout 60 \
  --set-secrets GEMINI_API_KEY=gemini-api-key:latest
```

Add the startup probe (`/api/health`, generous window ≥ 60 s) and liveness probe (`/api/health/live`). **Look up the exact flag or YAML syntax with `gcloud run deploy --help`; do not guess.** The runtime service account is the default compute service account unless the service sets another; confirm via `gcloud run services describe`. Record the final commands in `docs/deployment.md`. Also set a **billing budget alert** (ask the user).

### `scripts/verify-deploy.mjs` (exits non-zero on any failure; prints a results table)

1. `gcloud run services describe`: latest created revision == latest ready revision; 100 % traffic to it; memory 2Gi; cpu 1; min 1 / max 5; concurrency 8; CPU throttling off; startup CPU boost on; `GEMINI_API_KEY` bound from Secret Manager (never print the value).
2. `GET /api/health` → 200, `ready:true`, `sandbox.state:"ready"`, `llm.configured:true`.
3. `GET /api/health/live` → 200.
4. `POST /api/diagnose` for each preset → 200, `verification.status:"verified"`, `outcome:"improved"`, the new index in `plans.after.usesIndexes`; print timings.
5. Hostile: a `COPY` schema → 422 within 5 s; then a preset → 200 (the service recovered).
6. Rate limit: 20 rapid requests with rotating spoofed leftmost `X-Forwarded-For` values still reach 429 (spoofing doesn't bypass).
7. Logs (`gcloud logging read`, last 5 min): no unexpected `ERROR`; a unique sentinel table name sent in a canary request (`zz_canary_<random>`) **does not appear** in any log line (I4).
8. Security headers present (CSP, nosniff, referrer policy, HSTS).

**You may report "deployed and healthy" only when this script exits 0 and you have pasted its table.**

---

## 11. Self-audit before every gate report

- [ ] `npm run verify` green (paste the tail of the output).
- [ ] `git grep -nE "AIza|GEMINI_API_KEY=" -- . ':!.env.example'` finds no secret.
- [ ] `git grep -n "console\." src/server` finds nothing; no `any`, `@ts-ignore`, or unexplained suppressions.
- [ ] No new dependency outside §3 (or the user approved it).
- [ ] Every number you quote exists in a file produced by a script.
- [ ] Each invariant touched by this gate has a test.
- [ ] `STATE.md` and `.env.example` are current.
- [ ] No TODO without an issue reference; no commented-out code.

---

## 12. Stop-and-ask triggers and failure protocol

**Stop and ask the user when:** the PH flow looks closed or rejects the URL; the Gemini key or any model in the chain doesn't work; Spike S1 or S3 fails; a Tier A item can't be met; a cut line must be used; a document conflicts with reality or another document; a new dependency seems necessary; a check seems wrong; a deploy fails after two fixes; you are about to spend more than 20 minutes on one problem.

**Failure protocol:** if the same error survives three _different_ attempts, stop. Write what you tried and the evidence, give two options with trade-offs, and ask. Do not loop, do not paper over, do not delete the failing test.

---

## 13. Things you must never do

- Run `new PGlite()` outside the worker/engine, per request, or keep a transaction open across an LLM call.
- Execute model text as SQL, or send a user-authored string to the model.
- Present unverified numbers, or claim an improvement when the new index wasn't used.
- Hard-code a model ID outside `llm/models.ts`/`config.ts`, or in UI copy.
- Send `temperature`/`topP`/`topK`/`candidateCount`/`thinkingBudget`, or end a request with a `model` turn.
- Import `@google/generative-ai`, add a database, login, or a second service.
- Log schema or query text, or any secret.
- Edit a test, threshold, lint rule or tsconfig flag to make a check pass without telling the user.
- Use `--no-verify`, `--force` on shared branches, or `// @ts-ignore`.
- Skip the Cloud Run deployment gate because "it works locally", or report healthy without `verify:deploy` passing.
- Publish a number that is not in `docs/measurements.md`.
- Add features not in `architecture.md` (Tier C items only after Tier A and B are done and the user agrees).

---

## 14. Definition of done

Everything in `plan.md` §9, plus: the final report to the user contains the public URL, the measured timings table, the preset before/after table, the list of known limitations, the ADR list, and the exact commands for local run and deploy.
