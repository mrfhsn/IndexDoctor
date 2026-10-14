import crypto from 'node:crypto';

import type { Config } from '../config.js';
import { Semaphore } from '../lib/semaphore.js';
import { logger } from '../logger.js';
import type { Catalog } from '../sql/catalog.js';
import { type GeneratedDdl, buildIndexDdl } from '../sql/ddl.js';
import { type EsrClassification, classifyEsrRoles, planEsrIndex } from '../sql/esr-planner.js';
import { type CandidateIndexSpec, validateIndexSpec } from '../sql/index-spec.js';
import type { ParsedStatement } from '../sql/parse.js';
import { circuitBreaker, type ModelCircuitBreaker } from './breaker.js';
import { LlmClient } from './client.js';
import { parseModelOutput } from './parse-output.js';
import { buildPrompt } from './prompt.js';

type AttemptOutcome =
  | 'ok'
  | 'timeout'
  | 'http_error'
  | 'invalid_output'
  | 'skipped_breaker'
  | 'skipped_cap'
  | 'no_key';

export type Attempt = {
  model: string;
  outcome: AttemptOutcome;
  ms: number;
};

export type ChainInput = {
  catalog: Catalog;
  queryAst: ParsedStatement;
  querySql: string;
  queryReferencedTables: Set<string>;
  deadlineMs?: number;
  signal?: AbortSignal;
};

export type ChainResult = {
  proposedBy: 'llm' | 'deterministic';
  model: string | null;
  spec: CandidateIndexSpec | null;
  ddl: GeneratedDdl | null;
  esr: EsrClassification[];
  headline: string;
  explanation: string;
  antiPatterns: string[];
  attempts: Attempt[];
  deterministicCandidate?: {
    spec: CandidateIndexSpec;
    ddl: GeneratedDdl;
  };
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Orchestrates LLM model chain with circuit breakers, capability downgrades,
 * tolerant repair turn, and deterministic ESR fallback.
 * Enforces architecture.md §11.3 and §12.
 */
export class LlmChain {
  private readonly config: Config;
  private readonly client: LlmClient;
  private readonly breaker: ModelCircuitBreaker;
  private readonly semaphore: Semaphore;

  public constructor(options: {
    config: Config;
    client?: LlmClient;
    breaker?: ModelCircuitBreaker;
  }) {
    this.config = options.config;
    this.breaker = options.breaker ?? circuitBreaker;
    this.client =
      options.client ??
      new LlmClient({
        apiKey: this.config.GEMINI_API_KEY,
      });
    this.semaphore = new Semaphore(this.config.LLM_MAX_CONCURRENCY);
  }

  public async execute(input: ChainInput): Promise<ChainResult> {
    const { catalog, queryAst, querySql, queryReferencedTables } = input;
    const attempts: Attempt[] = [];

    // Pre-calculate deterministic candidate (always available for repair / dual-evaluation)
    const deterministicPlan = await planEsrIndex(queryAst, catalog);
    const deterministicCandidate =
      deterministicPlan.spec !== null
        ? { spec: deterministicPlan.spec, ddl: deterministicPlan.ddl }
        : undefined;

    // 1. If no API key configured, skip chain immediately (no_key)
    if (!this.config.GEMINI_API_KEY) {
      attempts.push({ model: 'none', outcome: 'no_key', ms: 0 });
      return this.buildDeterministicResult(deterministicPlan, attempts, deterministicCandidate);
    }

    const models = this.config.LLM_MODELS.split(',')
      .map((m) => m.trim())
      .filter(Boolean);
    const deadline = Date.now() + (input.deadlineMs ?? this.config.LLM_BUDGET_MS);
    const nonce = crypto.randomBytes(6).toString('hex');

    // 2. Iterate through configured models in priority order
    for (const model of models) {
      // Check circuit breaker
      if (this.breaker.isOpen(model)) {
        attempts.push({ model, outcome: 'skipped_breaker', ms: 0 });
        continue;
      }

      const remainingBudget = Math.max(0, deadline - Date.now());
      const attemptTimeout = Math.min(this.config.LLM_ATTEMPT_TIMEOUT_MS, remainingBudget);

      // If less than 1 second remains, skip to deterministic fallback
      if (attemptTimeout < 1000) {
        attempts.push({ model, outcome: 'timeout', ms: 0 });
        break;
      }

      const prompt = buildPrompt({
        catalog,
        querySql,
        nonce,
        includeJsonInPrompt: this.client.getDowngradeLevel(model) === 2,
      });

      // oxlint-disable-next-line eslint/no-await-in-loop -- sequential fallback chain requires acquiring semaphore per model
      const release = await this.semaphore.acquire();
      const t0 = performance.now();

      try {
        // oxlint-disable-next-line eslint/no-await-in-loop -- sequential fallback chain requires awaiting each candidate model
        let res = await this.client.generate(model, prompt, {
          timeoutMs: attemptTimeout,
          signal: input.signal,
        });

        let parsed = parseModelOutput(res.text);

        // One tolerant repair turn if output was malformed and budget >= 3s remains
        if (!parsed.ok) {
          const budgetAfterCall = deadline - Date.now();
          if (budgetAfterCall >= 3000) {
            logger.info('Attempting single LLM repair turn', {
              model,
              error: parsed.error,
              remainingBudgetMs: budgetAfterCall,
            });

            // oxlint-disable-next-line eslint/no-await-in-loop -- sequential fallback chain requires awaiting repair turn
            res = await this.client.generate(model, prompt, {
              timeoutMs: budgetAfterCall,
              signal: input.signal,
              repairTurn: {
                previousOutput: res.text,
                error: parsed.error,
              },
            });

            parsed = parseModelOutput(res.text);
          }
        }

        const elapsedMs = Math.round(performance.now() - t0);

        if (!parsed.ok) {
          // Output was unparseable even after repair attempt
          attempts.push({ model, outcome: 'invalid_output', ms: elapsedMs });
          continue;
        }

        const data = parsed.data;

        // Model determined no index is needed
        if (!data.index) {
          this.breaker.recordSuccess(model);
          attempts.push({ model, outcome: 'ok', ms: elapsedMs });
          return {
            proposedBy: 'llm',
            model,
            spec: null,
            ddl: null,
            esr: [],
            headline: data.headline,
            explanation: data.explanation,
            antiPatterns: data.antiPatterns,
            attempts,
            deterministicCandidate,
          };
        }

        // Validate model's index specification against schema and query
        // oxlint-disable-next-line eslint/no-await-in-loop -- sequential fallback chain requires validating model candidate
        const validation = await validateIndexSpec(data.index, catalog, queryReferencedTables);

        if (!validation.valid) {
          // Model proposed hallucinated/invalid columns or tables
          logger.warn('Model proposed invalid index specification', {
            model,
            reason: validation.reason,
          });
          attempts.push({ model, outcome: 'invalid_output', ms: elapsedMs });
          continue;
        }

        // Valid candidate index produced by LLM
        this.breaker.recordSuccess(model);
        attempts.push({ model, outcome: 'ok', ms: elapsedMs });

        const ddl = buildIndexDdl(validation.spec);
        const esr = classifyEsrRoles(validation.spec, queryAst, catalog);

        return {
          proposedBy: 'llm',
          model,
          spec: validation.spec,
          ddl,
          esr,
          headline: data.headline,
          explanation: data.explanation,
          antiPatterns: data.antiPatterns,
          attempts,
          deterministicCandidate,
        };
      } catch (err) {
        const elapsedMs = Math.round(performance.now() - t0);
        const status = this.extractStatusCode(err);
        const isTimeout =
          (err instanceof Error && err.name === 'TimeoutError') ||
          (err instanceof Error && err.message.toLowerCase().includes('timeout'));

        const outcome: AttemptOutcome = isTimeout ? 'timeout' : 'http_error';
        this.breaker.recordFailure(model, {
          status,
          message: err instanceof Error ? err.message : String(err),
        });

        logger.warn('LLM attempt failed', {
          model,
          outcome,
          status,
          ms: elapsedMs,
        });

        attempts.push({ model, outcome, ms: elapsedMs });
      } finally {
        release();
      }
    }

    // 3. Total LLM failure -> Fallback to deterministic ESR planner
    return this.buildDeterministicResult(deterministicPlan, attempts, deterministicCandidate);
  }

  private buildDeterministicResult(
    esrResult: Awaited<ReturnType<typeof planEsrIndex>>,
    attempts: Attempt[],
    deterministicCandidate?: { spec: CandidateIndexSpec; ddl: GeneratedDdl },
  ): ChainResult {
    if (esrResult.spec !== null) {
      return {
        proposedBy: 'deterministic',
        model: null,
        spec: esrResult.spec,
        ddl: esrResult.ddl,
        esr: esrResult.esr,
        headline: 'Deterministic ESR Index Recommendation',
        explanation:
          'Generated using PostgreSQL Equality-Sort-Range heuristics based on query predicates and sort orders.',
        antiPatterns: [],
        attempts,
        deterministicCandidate,
      };
    }

    return {
      proposedBy: 'deterministic',
      model: null,
      spec: null,
      ddl: null,
      esr: [],
      headline: 'No Index Recommendation',
      explanation: esrResult.reason,
      antiPatterns: [],
      attempts,
      deterministicCandidate,
    };
  }

  private extractStatusCode(err: unknown): number | undefined {
    if (isRecord(err)) {
      if (typeof err['status'] === 'number') return err['status'];
      if (typeof err['statusCode'] === 'number') return err['statusCode'];
      if (typeof err['code'] === 'number') return err['code'];
      if (typeof err['message'] === 'string') {
        const match = /\b(400|401|403|404|429|500|503)\b/.exec(err['message']);
        if (match?.[1]) return Number(match[1]);
      }
    }
    return undefined;
  }
}
