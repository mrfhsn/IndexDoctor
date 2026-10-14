# IndexDoctor — Project Plan (v2)

> Written 14 Oct 2026. Companion files: `architecture.md` (design and contract) and `agent.md` (how the AI builder works).
> **Precedence on conflict: `architecture.md` > `agent.md` > `plan.md`.** The builder must report any conflict to the user instead of picking silently.
>
> Legend: ✅ checked today against a live source · ⚠️ carried over from earlier notes, not re-run · ❓ unknown, resolved by a Gate 0 probe.

---

## 0. Verdict on the idea

**Go, with structural changes.** Paste a Postgres schema + a slow query → get a real planner's before/after plan, an ESR-style index recommendation, and copy-ready SQL / Drizzle / Prisma output. It demos in one click, fits Cloud Run (one stateless container, a secret, a probe, scale-out), and the "real planner in WASM" angle is a genuine differentiator.

- **Prior art** (from background knowledge, _not_ re-verified today): hypopg-based advisors such as Dexter and Supabase's `index_advisor`. IndexDoctor differs by needing zero install and zero database access, showing a plan diff, and emitting ORM output.
- **Biggest risks:** fidelity honesty (simulated stats), sandbox memory/DoS, model churn, and today's timeline.
- **Honesty rule that shapes everything:** the app never shows a cost number unless a real planner produced it. If the sandbox can't verify, it shows the recommendation _without numbers_. (The earlier design let the model invent "simulated" costs; that is removed.)

### 0.1 What I verified today

| #   | Item                    | Status | Finding                                                                                                                                                                                                                                                                                                                  | Impact                                                                |
| --- | ----------------------- | :----: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------- |
| 1   | Hackathon rules         |   ✅   | Deploy **directly to Cloud Run**; schedule/launch on **Oct 14**; answer **"Yes"** to the hackathon question; the $50 build credits require a scheduled launch with "Yes". A Cloud Run team member confirmed "deployed directly to Cloud Run".                                                                            | Deployment gate is mandatory                                          |
| 2   | Submissions still open? |   ❓   | Contest page shows `00h:00m:00s` next to a live **Submit now** button (may be a stale cached render). A forum comment ~3 h old says the submit form is reachable and **asks for the product URL first**; whether `*.run.app` URLs are accepted is unanswered.                                                            | Deploy a skeleton **before** creating the PH draft; ask in the thread |
| 3   | `gemini-3.5-flash-lite` |   ✅   | GA, exact ID, released 21 Jul 2026, no shutdown announced, default thinking `minimal`, $0.30 / $2.50 per 1M tokens. Labelled "previous-generation" (3.8 Flash and Gemini 4 Argon are newer) but "remains available for production use".                                                                                  | Valid default                                                         |
| 4   | `gemini-3.1-flash-lite` |   ✅   | GA, earliest shutdown **7 May 2027**, its recommended replacement is 3.5 Flash-Lite.                                                                                                                                                                                                                                     | Valid fallback #1                                                     |
| 5   | "gemma-4"               |   ✅   | **No bare `gemma-4` ID.** Gemini API IDs: `gemma-4-31b-it`, `gemma-4-26b-a4b-it`. Docs cover system instructions, thinking (`minimal` ↔ `high`), function calling. **Structured output is not documented.**                                                                                                              | Fallback #2 = `gemma-4-31b-it`; JSON-in-prompt + validation; probe    |
| 6   | API surface             |   ✅   | Docs now lead with the **Interactions API**; `generateContent` is still documented for these models and for Gemma. 3.5 Flash-Lite and newer **ignore `temperature`/`top_p`/`top_k` (future models return 400)**; requests ending in a `model` turn return **400**; thinking uses `thinkingLevel`, not `thinking_budget`. | One surface (`generateContent`), forbidden-parameter lint             |
| 7   | Node                    |   ✅   | Node 20 EOL (30 Apr 2026). Node 22 = Maintenance LTS (ends 30 Apr 2027). **Node 24 = Active LTS (to Apr 2028).** Node 26 enters LTS 28 Oct 2026 and reportedly removed APIs.                                                                                                                                             | Use **Node 24**                                                       |
| 8   | PGlite                  | ✅/⚠️  | 0.5.x line (Postgres 18); single connection by design. The earlier "measured" numbers (≈ 500 MB RSS, ≈ 2.9 s init, `statement_timeout` not enforced, 150–230 ms/job) were **not re-run by me** (my sandbox has no network).                                                                                              | **Spike 0** reproduces them before design is locked                   |
| 9   | Stats-scaling order     |   ⚠️   | By Postgres internals, `CREATE INDEX` rewrites the parent table's `pg_class` row stats. If you scale `reltuples` _before_ creating the index, the "after" plan may be costed on 20k rows while "before" used 500k.                                                                                                       | **Scale last, read back, assert** (Spike 0 confirms)                  |
| 10  | Cloud Run CPU           |   ✅   | By default CPU is allocated only during requests, startup and shutdown; background threads freeze between requests.                                                                                                                                                                                                      | `--no-cpu-throttling` + min-instances 1 so worker respawn can't stall |
| 11  | oxlint                  |   ✅   | Type-aware rules via `oxlint-tsgolint` and `--type-aware`, but **alpha**; `oxfmt` is the formatter.                                                                                                                                                                                                                      | `tsc` stays the type authority; oxlint is the second net              |
| 12  | SQL parser              | ✅/❓  | `libpg-query` is a WASM build of Postgres's own parser, with per-major dist-tags (pg17 confirmed; pg18 listed by one third-party source).                                                                                                                                                                                | Real-AST allow-list; `npm view` to confirm pg18                       |
| 13  | PH forum anecdote       |   ✅   | An agent-written Cloud Run deploy "reported every migration succeeded and marked the service healthy" while the container crash-looped on an unset variable.                                                                                                                                                             | Deploy verification must hit the live URL, revision status and logs   |

### 0.2 What changed versus the previous plan

1. Node 24; Gemini 3.5 → 3.1 → Gemma 4 chain (exact IDs); `generateContent` only; no sampling parameters.
2. **One sandbox job type (`evaluate`)**: build state once, `EXPLAIN` the baseline, then try up to two candidate indexes using `SAVEPOINT`s. Halves sandbox work and removes the transaction-across-LLM-call problem.
3. The LLM returns a **structured index spec** (table, columns, directions, include, optional partial predicate), never SQL text. The server builds the DDL from validated identifiers.
4. **Prompt contains no user free text**: built from a catalog summary and a literal-masked, comment-stripped query with strictly validated identifiers. Prompt injection has no channel.
5. ESR roles, severity, and Drizzle/Prisma/Postgres snippets are produced **deterministically** by the server, not by the model.
6. **Verify-then-repair:** if the model's index is invalid or not used by the planner, the deterministic ESR candidate is evaluated in the same job.
7. Real SQL parser (AST) for the allow-list instead of regex.
8. Single-flight coalescing of identical requests (launch-day preset spikes), circuit breakers per model, worker recycling, canary self-test, poison check.
9. Cloud Run always-on CPU, liveness vs startup probes, SIGTERM handling.
10. **Open-source standards** from day one: OSS file set, CI, conventional commits, ADRs, strict lint/format/type gates, boundary rules.

---

## 1. Hackathon facts and timeline

- **Rules (✅):** deploy on Cloud Run directly; launch on Product Hunt on 14 Oct; tick "Yes" for the hackathon. Prizes: $500 Google Cloud credits, a 1-on-1 with Cloud Run engineers, shout-outs. Credits ($50) "while supplies last" require a scheduled launch with "Yes".
- **Not published:** judging rubric; whether Gemini use is rewarded. Assumption: clear Cloud Run usage plus launch-day engagement matter. Optimise for both.
- **Time pressure:** the launch date is today. PH's day rolls over at 12:01 AM Pacific, as far as I know. Convert to your local time and decide now whether you can finish Tier A before the window closes. If the window has closed, ask in the forum thread before spending effort on eligibility.
- **Order consequence:** the PH form asks for a product URL first → **skeleton on Cloud Run before the PH draft** (Gate 1).

---

## 2. Goal, users, success criteria

**Goal:** a zero-login web tool that proves, with a real Postgres planner, that a recommended index changes the plan, and gives copy-ready output.

**Users:** (1) PH visitors who want a payoff in under 30 seconds with no typing (presets); (2) backend developers who need a trustworthy, copyable result; (3) hackathon judges who need to see Cloud Run used properly; (4) open-source contributors who need a repo they can read and extend.

**Measurable success criteria** (all numbers must come from the deployed app, recorded in `docs/measurements.md`):

- Public Cloud Run URL; `/api/health` green; no login.
- 3 presets run end-to-end live; for each, the after-plan uses the new index and cost drops.
- Warm preset run: publish the measured p50/p95 (target < 5 s with LLM, < 1.5 s deterministic-only).
- Hostile input returns a clean error in ≤ 5 s and the next request succeeds with no restart.
- 20 parallel requests → only 200/429/503, never an unhandled 5xx; memory stable across 100 sequential runs.
- `npm run verify` green locally and in CI; public repo with MIT license and the full OSS file set.
- PH post scheduled for 14 Oct with hackathon = **Yes**.

---

## 3. Scope

### Tier A — must ship

- Hono server: `/api/health`, `/api/health/live`, `POST /api/diagnose`, static SPA, security headers, limits.
- SQL gate (AST allow-list) and sandbox (`evaluate` job, seeding, stats scaling, plan extraction, rollback).
- Diagnosis: model chain (3.5 Flash-Lite → 3.1 Flash-Lite → Gemma 4) with deterministic ESR fallback; verify-then-repair.
- 3 presets, two editors, vital-sign cards, plan comparison, ESR chain, PostgreSQL migration tab with copy.
- Honest states: improved, index-not-used, unverified, no-recommendation, rate-limited, error.
- Guards: size limits, per-IP rate limit, daily LLM cap, single-flight cache, circuit breakers.
- Cloud Run deployment with secret, probes, always-on CPU; `verify-deploy` script.
- OSS baseline: README, LICENSE, CONTRIBUTING, SECURITY, CODE_OF_CONDUCT, CI.

### Tier B — should

- Drizzle and Prisma tabs with `migrationNotes` (INCLUDE and partial indexes need raw SQL).
- "Alternative considered" card (the second candidate's measured cost).
- Recorded preset snapshots (labelled with date) for LLM/sandbox outages.
- localStorage history; raw-JSON plan toggle; ADRs and `docs/fidelity.md`.

### Tier C — could

- Row-count selector (10k / 500k / 5M); shareable URL-hash links; NDJSON progress streaming.

### Won't (this hackathon)

Login, any database/Redis, real database connections, MySQL as a first-class target (small sanitiser only), joins as a first-class analysis target (the LLM may handle them, the deterministic path will not), non-B-tree index methods, query rewriting, multi-statement workloads.

---

## 4. Gates (build order)

Estimates are agent wall-clock, assuming no major blocker: **≈ 8 h at full scope, ≈ 5 h for Tier A only.** Detailed procedures, commands and evidence live in `agent.md`.

| Gate                                   | Goal                                                                        |        Est. | Acceptance (headline)                                                                                                                 |
| -------------------------------------- | --------------------------------------------------------------------------- | ----------: | ------------------------------------------------------------------------------------------------------------------------------------- |
| **G0** Feasibility and eligibility     | Prove the three risky dependencies work before committing                   |      30 min | PH draft path confirmed; Gemini probe table for all 3 models; Spike 0 results on Node 24; libpg-query AST samples; decisions recorded |
| **G1** Foundation and walking skeleton | Tooling, OSS files, CI, Hono health, Dockerfile, **live on Cloud Run**      |      50 min | `npm run verify` green; CI green; public `/api/health` 200; revision config matches spec; PH draft created with the URL               |
| **G2** SQL gate and sandbox            | Parse/allow-list; worker + manager; seeding; stats scaling; plan extraction | 100–120 min | 3 presets: baseline bottleneck, after-plan uses index, cost drops; hostile inputs recover ≤ 5 s; 100 runs leave nothing behind        |
| **G3** Diagnosis                       | ESR planner; LLM chain; validators; migrations; severity                    |      75 min | Works with no key, bogus model, malformed JSON, hostile output, injection text; all end in a valid safe response                      |
| **G4** Pipeline, API, guards           | Orchestration, error envelope, rate limit, cache, single-flight             |      60 min | Contract tests pass; no 5xx for sandbox/LLM failures; invariants I1–I10 tested                                                        |
| **G5** UI                              | Dashboard, presets, all states, a11y, 375 px                                |      75 min | One click to a full result; every state reachable; no console errors                                                                  |
| **G6** Harden and deploy               | Soak, parallel, 2 GiB container test, deploy, measure                       |      45 min | 20 parallel → only 200/429/503; `verify-deploy` green; timings recorded                                                               |
| **G7** OSS polish and launch assets    | README, docs, ADRs, screenshots, PH copy                                    |      45 min | Fresh clone → `npm ci && npm run verify` passes; every published number traceable to `docs/measurements.md`                           |

**Time-box rule:** at T+3 h, if G3 isn't complete, apply the cut lines and ship deterministic-only plus presets.

---

## 5. Cut lines (drop in this order)

1. Tier C, then localStorage history and the raw-JSON toggle.
2. Alternative-candidate card; recorded preset snapshots.
3. Drizzle/Prisma tabs (keep the Postgres tab).
4. Recording/GIF (keep screenshots).

**Never cut:** Cloud Run deployment, PH draft with the toggle, verified before/after on all presets, honesty labels, input limits, rate limit, `verify-deploy`, the SQL gate, LICENSE.

---

## 6. Risk register

| Risk                                              | Likelihood |  Impact  | Early signal                         | Pre-decided response                                                                                                         |
| ------------------------------------------------- | :--------: | :------: | ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| Submission already closed                         |     ?      | Critical | Form refuses or countdown stuck      | Ask in thread; still launch later without eligibility                                                                        |
| `*.run.app` URL not accepted by PH                |  Low–Med   |   Med    | Form validation error                | Ask in thread; map a custom domain only if needed                                                                            |
| PGlite misbehaves on Node 24 / Cloud Run          |    Med     | Critical | Spike 0 failure                      | Try Node 22; else Plan B: unverified-only product, or a Postgres sidecar container on the same Cloud Run service (ADR first) |
| Memory growth / OOM                               |    Med     |   High   | RSS slope in soak test               | Recycle worker every N jobs when idle; raise to 4 GiB                                                                        |
| `UPDATE pg_class` stats trick behaves differently |    Med     |   High   | Spike 0 read-back mismatch           | Seed more rows (100k) and drop scaling; document                                                                             |
| Planner doesn't pick the new index                |    Med     |   Med    | Golden test fails                    | Tune preset data (never thresholds); UI "index not used" state is already honest                                             |
| Model retired / quota / unsupported config        |    High    |   Med    | 404/429/400 in probe or logs         | Chain, breakers, downgrade ladder, deterministic fallback                                                                    |
| Gemma returns non-JSON                            |    High    |   Low    | Probe                                | Tolerant extraction + one repair + Zod                                                                                       |
| Cost abuse of public endpoint                     |    Med     |   Med    | Billing alert                        | Rate limit, cap, cache, max-instances 5, budget alert                                                                        |
| Agent claims success it didn't achieve            |    Med     |   High   | Mismatch between report and evidence | Evidence files, `verify-deploy`, "no number without a measurement" rule                                                      |
| Launch-day traffic spike on presets               |    High    |   Med    | Latency/429                          | Single-flight, cache, snapshots, min-instances 1                                                                             |
| Over-scoped for the time left                     |    High    |   High   | T+3 h check                          | Cut lines                                                                                                                    |

---

## 7. Assumptions (correct any that are wrong)

- Solo maker with an AI coding agent; one repo; one container; MIT license; public GitHub.
- Postgres only; targets read queries on a handful of tables; input ≤ 20 KB schema, ≤ 8 KB query.
- Identifiers are simple (`[A-Za-z_][A-Za-z0-9_]{0,62}`); exotic quoted identifiers are rejected with a hint.
- Gemini key is a standard AI Studio key. Free-tier limits and **data-use terms depend on key tier**; Gate 0 checks both and the UI privacy line must match the tier.
- Cloud Run region `us-central1` (any region is eligible).
- Instance-based billing (always-on CPU) with min-instances 1 for launch week; revert to scale-to-zero or delete the service afterwards.

## 8. Questions to answer before Gate 0

1. GitHub owner/repo name and a maintainer contact email (needed for SECURITY.md and CODE_OF_CONDUCT).
2. GCP project ID, billing confirmed, and your preferred region.
3. Is the PH account ready, and is the draft started?
4. Which tier is the Gemini key (free or paid)?

---

## 9. Definition of done

- [ ] Public Cloud Run URL, health green, no login
- [ ] 3 presets verified live; index used; costs from the planner
- [ ] Fallback tests pass (no key, bogus model, malformed output, injection text)
- [ ] Hostile-input suite passes; memory stable over 100 runs
- [ ] Secrets in Secret Manager; rate limit on; budget alert set
- [ ] `npm run verify` and CI green on a fresh clone
- [ ] OSS file set present; README documents limits ("simulated stats")
- [ ] `docs/measurements.md` generated by scripts; every published number traceable to it
- [ ] PH post scheduled for 14 Oct, hackathon = **Yes**

## 10. Launch-day operations

- Be online at launch; watch Cloud Run logs (errors, respawns, memory), the Gemini quota, and the billing alert.
- Reply to every comment; answer Cloud Run engineers in the forum thread.
- Don't redeploy under traffic unless it is a hotfix; fallback and snapshots keep the demo alive.
- After the hackathon: set min-instances to 0 (or delete the service) and revert CPU throttling to stop billing.

## 11. Sources checked today

- PH forum thread: `producthunt.com/p/google-cloud-platform/google-cloud-run-takeover-hackathon`; contest page: `producthunt.com/contests/google-cloud-run`
- Gemini: `ai.google.dev/gemini-api/docs/whats-new-gemini-3.6`, `.../deprecations`, `.../latest-model`, `.../structured-output`, `.../thinking`
- Gemma on the Gemini API: `ai.google.dev/gemma/docs/core/gemma_on_gemini_api`
- Cloud Run: `docs.cloud.google.com/run/docs/tips`, Google Cloud blog on CPU allocation
- Tooling: `oxc.rs` type-aware linting docs; PGlite (GitHub/npm); `constructive-io/libpg-query-node`; Node.js release schedule (third-party summaries; confirm at nodejs.org)
