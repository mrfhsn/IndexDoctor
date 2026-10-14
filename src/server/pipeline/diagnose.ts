import type {
  Alternative,
  DiagnoseResponse,
  IndexObject,
  Outcome,
  PresetId,
  Recommendation,
  Verification,
} from '../../shared/contract.js';
import { deriveSeverity } from '../../shared/contract.js';
import type { Config } from '../config.js';
import { AppError } from '../errors.js';
import { createDeadline, type Deadline } from '../lib/deadline.js';
import { hashInput } from '../lib/hash.js';
import { LruCache } from '../lib/lru.js';
import { sanitizeText } from '../lib/sanitize-text.js';
import { SingleFlight } from '../lib/single-flight.js';
import { type Attempt, LlmChain } from '../llm/chain.js';
import type { ChainInput, ChainResult } from '../llm/chain.js';
import { type Logger, logger as defaultLogger } from '../logger.js';
import { generateDrizzleMigration } from '../migrations/drizzle.js';
import { generatePostgresMigration } from '../migrations/postgres.js';
import { generatePrismaMigration } from '../migrations/prisma.js';
import type { SandboxStatus } from '../sandbox/manager.js';
import type { EvaluatePayload, EvaluateResult } from '../sandbox/protocol.js';
import { PRESET_SNAPSHOTS } from '../snapshots/presets.js';
import type { GeneratedDdl } from '../sql/ddl.js';
import { classifyEsrRoles, type EsrClassification } from '../sql/esr-planner.js';
import { validateGate } from '../sql/gate.js';
import type { CandidateIndexSpec } from '../sql/index-spec.js';

export interface SandboxEvaluator {
  evaluate(payload: EvaluatePayload, deadlineMs?: number): Promise<EvaluateResult>;
  getStatus?(): SandboxStatus;
}

export interface ChainExecutor {
  execute(input: ChainInput): Promise<ChainResult>;
}

export interface PipelineRunner {
  run(input: DiagnoseInput): Promise<DiagnoseResponse>;
}

export interface PipelineDependencies {
  config: Config;
  logger?: Logger;
  sandboxManager?: SandboxEvaluator;
  llmChain?: ChainExecutor;
  cache?: LruCache<DiagnoseResponse>;
  singleFlight?: SingleFlight<DiagnoseResponse>;
}

export interface DiagnoseInput {
  schema: string;
  query: string;
  presetId?: PresetId;
  requestId: string;
  deadline?: Deadline;
}

interface CandidatePackage {
  spec: CandidateIndexSpec;
  ddl: GeneratedDdl;
  source: 'llm' | 'deterministic';
  headline: string;
  explanation: string;
  antiPatterns: string[];
  esr: EsrClassification[];
}

function buildIndexObject(spec: CandidateIndexSpec, name: string): IndexObject {
  return {
    table: spec.table,
    name,
    columns: spec.columns.map((c) => ({
      name: c.name,
      direction: c.direction === 'desc' ? 'DESC' : 'ASC',
      nulls: c.nulls === 'first' ? 'FIRST' : c.nulls === 'last' ? 'LAST' : undefined,
      opclass: c.opclass,
    })),
    include: spec.include ?? [],
    where: spec.where ?? null,
  };
}

function buildRecommendation(candidate: CandidatePackage): Recommendation {
  const pgMigration = generatePostgresMigration(candidate.spec, candidate.ddl.name);
  const drizzleMigration = generateDrizzleMigration(candidate.spec, candidate.ddl.name);
  const prismaMigration = generatePrismaMigration(candidate.spec, candidate.ddl.name);

  const notes = Array.from(
    new Set([...pgMigration.notes, ...drizzleMigration.notes, ...prismaMigration.notes]),
  );

  return {
    index: buildIndexObject(candidate.spec, candidate.ddl.name),
    sql: {
      create: candidate.ddl.create,
      createConcurrently: candidate.ddl.createConcurrently,
    },
    headline: sanitizeText(candidate.headline, 120),
    explanation: sanitizeText(candidate.explanation, 600),
    antiPatterns: candidate.antiPatterns.map((p) => sanitizeText(p, 160)),
    esr: candidate.esr.map((e) => ({
      column: e.column,
      role: e.role,
      reason: sanitizeText(e.reason, 160),
    })),
    migrations: {
      postgres: pgMigration.sql,
      drizzle: drizzleMigration.snippet,
      prisma: prismaMigration.snippet,
    },
    migrationNotes: notes,
  };
}

export class DiagnosePipeline implements PipelineRunner {
  private readonly config: Config;
  private readonly log: Logger;
  private readonly sandboxManager?: SandboxEvaluator;
  private readonly llmChain: ChainExecutor;
  private readonly cache: LruCache<DiagnoseResponse>;
  private readonly singleFlight: SingleFlight<DiagnoseResponse>;

  public constructor(deps: PipelineDependencies) {
    this.config = deps.config;
    this.log = deps.logger ?? defaultLogger;
    this.sandboxManager = deps.sandboxManager;
    this.llmChain = deps.llmChain ?? new LlmChain({ config: this.config });
    this.cache =
      deps.cache ??
      new LruCache<DiagnoseResponse>({
        maxEntries: this.config.CACHE_MAX_ENTRIES,
        ttlMs: this.config.CACHE_TTL_MS,
      });
    this.singleFlight = deps.singleFlight ?? new SingleFlight<DiagnoseResponse>();
  }

  public async run(input: DiagnoseInput): Promise<DiagnoseResponse> {
    const startTotal = Date.now();
    const deadline = input.deadline ?? createDeadline(this.config.REQUEST_DEADLINE_MS);
    const inputHash = hashInput(input.schema, input.query);

    // 1. Stage 2: Cache Check (Hit -> Return immediately)
    const cached = this.cache.get(inputHash);
    if (cached) {
      this.log.info('Diagnose cache hit', {
        requestId: input.requestId,
        inputHash,
        outcome: cached.outcome,
        cached: true,
      });
      return {
        ...cached,
        requestId: input.requestId,
        cached: true,
        timingsMs: {
          ...cached.timingsMs,
          total: Date.now() - startTotal,
        },
      };
    }

    // 2. Stage 2: Single-flight Coalescing
    const { result, shared } = await this.singleFlight.do(inputHash, async () => {
      return this.executePipeline(input, deadline, inputHash, startTotal);
    });

    const finalResponse = shared
      ? {
          ...result,
          requestId: input.requestId,
          cached: false,
          timingsMs: {
            ...result.timingsMs,
            total: Date.now() - startTotal,
          },
        }
      : result;

    this.log.info('Diagnose completed', {
      requestId: input.requestId,
      inputHash,
      outcome: finalResponse.outcome,
      proposedBy: finalResponse.source.proposedBy,
      model: finalResponse.source.model,
      cached: finalResponse.cached,
      timingsMs: finalResponse.timingsMs,
    });

    return finalResponse;
  }

  private async executePipeline(
    input: DiagnoseInput,
    deadline: Deadline,
    inputHash: string,
    startTotal: number,
  ): Promise<DiagnoseResponse> {
    // Stage 1: Edge & Gate Checks (AST parser, allow-list, MySQL normalizer)
    deadline.throwIfExpired('gate');
    const startGate = Date.now();
    const gateResult = await validateGate(input.schema, input.query);
    const gateMs = Date.now() - startGate;

    // Stage 2: Propose (LLM Chain + Deterministic ESR Planner)
    deadline.throwIfExpired('propose');
    const startPropose = Date.now();
    const proposeDeadline = deadline.child(this.config.LLM_BUDGET_MS);

    let chainResult;
    try {
      chainResult = await this.llmChain.execute({
        catalog: gateResult.catalog,
        queryAst: gateResult.queryAst,
        querySql: gateResult.querySql,
        queryReferencedTables: gateResult.referencedTables,
        deadlineMs: proposeDeadline.remainingMs,
        signal: proposeDeadline.signal,
      });
    } finally {
      proposeDeadline.dispose();
    }
    const proposeMs = Date.now() - startPropose;

    // Build list of unique candidate packages (up to 2 candidates: Primary + Alternative)
    const candidates: CandidatePackage[] = [];

    if (chainResult.spec && chainResult.ddl) {
      candidates.push({
        spec: chainResult.spec,
        ddl: chainResult.ddl,
        source: chainResult.proposedBy,
        headline: chainResult.headline,
        explanation: chainResult.explanation,
        antiPatterns: chainResult.antiPatterns,
        esr: chainResult.esr,
      });
    }

    if (
      chainResult.proposedBy === 'llm' &&
      chainResult.deterministicCandidate &&
      chainResult.deterministicCandidate.ddl.create !== chainResult.ddl?.create
    ) {
      const detEsr = classifyEsrRoles(
        chainResult.deterministicCandidate.spec,
        gateResult.queryAst,
        gateResult.catalog,
      );
      candidates.push({
        spec: chainResult.deterministicCandidate.spec,
        ddl: chainResult.deterministicCandidate.ddl,
        source: 'deterministic',
        headline: 'Deterministic ESR Index Recommendation',
        explanation:
          'Index structured using PostgreSQL Equality-Sort-Range B-tree heuristics from query AST.',
        antiPatterns: [],
        esr: detEsr,
      });
    }

    // Stage 3: Evaluate (PGlite in WASM Sandbox)
    deadline.throwIfExpired('evaluate');
    const startEval = Date.now();
    const evalBudgetMs = Math.min(this.config.SANDBOX_JOB_TIMEOUT_MS, deadline.remainingMs);

    let evalResult = null;
    let evalError: string | null = null;

    if (this.sandboxManager) {
      try {
        evalResult = await this.sandboxManager.evaluate(
          {
            statements: gateResult.statements,
            querySql: gateResult.querySql,
            candidateIndexes: candidates.map((c) => ({
              name: c.ddl.name,
              ddl: c.ddl.create,
            })),
            assumedRowCount: this.config.ASSUMED_ROW_COUNT,
            seededRows: this.config.SANDBOX_SEED_ROWS,
          },
          evalBudgetMs,
        );
      } catch (err) {
        evalError = err instanceof Error ? err.message : String(err);
      }
    } else {
      evalError = 'Sandbox manager is not configured.';
    }

    const evalMs = Date.now() - startEval;

    // Check Tier B fallback if sandbox is unavailable / failed and presetId is provided
    if (evalResult === null && input.presetId && PRESET_SNAPSHOTS[input.presetId]) {
      const snapshot = PRESET_SNAPSHOTS[input.presetId];
      const snapshotResponse: DiagnoseResponse = {
        ...snapshot,
        requestId: input.requestId,
        cached: false,
        timingsMs: {
          gate: gateMs,
          propose: proposeMs,
          evaluate: evalMs,
          total: Date.now() - startTotal,
        },
      };
      return snapshotResponse;
    }

    // Stage 4: Assemble & Response Selection
    const assumptions = {
      assumedRowCount: this.config.ASSUMED_ROW_COUNT,
      seededRows: this.config.SANDBOX_SEED_ROWS,
      plannerSettings: 'postgres-defaults' as const,
      tablesScaledEqually: true as const,
    };

    const source = {
      proposedBy: chainResult.proposedBy,
      model: chainResult.model,
      attempts: chainResult.attempts.map((a: Attempt) => ({
        model: a.model,
        outcome: a.outcome,
        ms: a.ms,
      })),
    };

    const notices = [...gateResult.notices];

    // Case 1: Sandbox failed or unseeded tables -> Degrade to unverified (Invariant I8 & I1)
    if (evalResult === null || evalResult.unseededTables.length > 0) {
      const reason =
        evalResult && evalResult.unseededTables.length > 0
          ? `Schema contains unseeded table(s): ${evalResult.unseededTables.join(', ')}`
          : (evalError ?? 'Sandbox evaluation timed out or failed');

      if (evalResult && evalResult.unseededTables.length > 0) {
        notices.push(
          `Evaluation unverified due to unseeded tables: ${evalResult.unseededTables.join(', ')}`,
        );
      }

      const primary = candidates[0];
      const unverifiedResponse: DiagnoseResponse = {
        requestId: input.requestId,
        cached: false,
        outcome: 'unverified',
        verification: {
          status: 'unverified',
          reason,
        },
        recommendation: primary ? buildRecommendation(primary) : null,
        plans: {
          before: null,
          after: null,
        },
        source,
        alternative: null,
        assumptions,
        notices,
        timingsMs: {
          gate: gateMs,
          propose: proposeMs,
          evaluate: evalMs,
          total: Date.now() - startTotal,
        },
      };

      // Unverified responses are never cached
      return unverifiedResponse;
    }

    // Case 2: Zero candidates proposed -> no_recommendation
    if (candidates.length === 0) {
      const baseCost = evalResult.before.totalCost;
      const noRecResponse: DiagnoseResponse = {
        requestId: input.requestId,
        cached: false,
        outcome: 'no_recommendation',
        verification: {
          status: 'verified',
          indexUsed: false,
          costBefore: baseCost,
          costAfter: baseCost,
          costReductionPercent: 0,
          costRatio: 1,
          severity: 'OPTIMAL',
        },
        recommendation: null,
        plans: {
          before: evalResult.before,
          after: null,
        },
        source,
        alternative: null,
        assumptions,
        notices,
        timingsMs: {
          gate: gateMs,
          propose: proposeMs,
          evaluate: evalMs,
          total: Date.now() - startTotal,
        },
      };

      this.cache.set(inputHash, noRecResponse);
      return noRecResponse;
    }

    // Case 3: We have evaluated candidates -> Apply selection rules
    const cand0 = candidates[0];
    const cand0Eval = evalResult.candidates[0];

    const cand1 = candidates[1];
    const cand1Eval = evalResult.candidates[1];

    if (!cand0 || !cand0Eval) {
      throw new AppError('INTERNAL', 'Candidate evaluation result missing.');
    }

    const cand0Improved = cand0Eval.indexUsed && cand0Eval.costAfter < cand0Eval.costBefore;
    const cand1Improved = Boolean(
      cand1 && cand1Eval && cand1Eval.indexUsed && cand1Eval.costAfter < cand1Eval.costBefore,
    );

    let selectedPackage: CandidatePackage;
    let selectedEval = cand0Eval;
    let outcome: Outcome;
    let alternative: Alternative = null;

    if (cand0Improved) {
      // LLM or Primary improved
      selectedPackage = cand0;
      selectedEval = cand0Eval;
      outcome = 'improved';
      if (cand1 && cand1Eval) {
        alternative = {
          proposedBy: cand1.source,
          index: buildIndexObject(cand1.spec, cand1.ddl.name),
          indexUsed: cand1Eval.indexUsed,
          costAfter: cand1Eval.costAfter,
        };
      }
    } else if (cand1 && cand1Eval && cand1Improved) {
      // Deterministic fallback candidate improved
      selectedPackage = cand1;
      selectedEval = cand1Eval;
      outcome = 'improved';
      alternative = {
        proposedBy: cand0.source,
        index: buildIndexObject(cand0.spec, cand0.ddl.name),
        indexUsed: cand0Eval.indexUsed,
        costAfter: cand0Eval.costAfter,
      };
    } else {
      // Neither improved
      outcome = 'not_improved';
      if (cand1 && cand1Eval) {
        if (cand0Eval.costAfter <= cand1Eval.costAfter) {
          selectedPackage = cand0;
          selectedEval = cand0Eval;
          alternative = {
            proposedBy: cand1.source,
            index: buildIndexObject(cand1.spec, cand1.ddl.name),
            indexUsed: cand1Eval.indexUsed,
            costAfter: cand1Eval.costAfter,
          };
        } else {
          selectedPackage = cand1;
          selectedEval = cand1Eval;
          alternative = {
            proposedBy: cand0.source,
            index: buildIndexObject(cand0.spec, cand0.ddl.name),
            indexUsed: cand0Eval.indexUsed,
            costAfter: cand0Eval.costAfter,
          };
        }
      } else {
        selectedPackage = cand0;
        selectedEval = cand0Eval;
        alternative = null;
      }
    }

    const costBefore = selectedEval.costBefore;
    const costAfter = selectedEval.costAfter;
    const costRatio = costBefore / Math.max(0.01, costAfter);
    const costReductionPercent = Math.max(
      0,
      Math.min(99.9, ((costBefore - costAfter) / costBefore) * 100),
    );
    const severity = deriveSeverity(outcome, costRatio);

    const verification: Verification = {
      status: 'verified',
      indexUsed: selectedEval.indexUsed,
      costBefore,
      costAfter,
      costReductionPercent: Math.round(costReductionPercent * 10) / 10,
      costRatio: Math.round(costRatio * 100) / 100,
      severity,
    };

    const finalResponse: DiagnoseResponse = {
      requestId: input.requestId,
      cached: false,
      outcome,
      verification,
      recommendation: buildRecommendation(selectedPackage),
      plans: {
        before: evalResult.before,
        after: selectedEval.after,
      },
      source: {
        ...source,
        proposedBy: selectedPackage.source,
      },
      alternative,
      assumptions,
      notices,
      timingsMs: {
        gate: gateMs,
        propose: proposeMs,
        evaluate: evalMs,
        total: Date.now() - startTotal,
      },
    };

    // Cache ONLY verified outcomes (architecture §15)
    this.cache.set(inputHash, finalResponse);
    return finalResponse;
  }
}
