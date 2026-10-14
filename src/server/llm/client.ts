import { GoogleGenAI } from '@google/genai';

import { logger } from '../logger.js';
import { getModelProfile } from './models.js';
import { MODEL_JSON_SCHEMA, type BuiltPrompt } from './prompt.js';

export type GenerateOptions = {
  timeoutMs?: number;
  signal?: AbortSignal;
  repairTurn?: {
    previousOutput: string;
    error: string;
  };
};

export type LlmClientResult = {
  text: string;
  ms: number;
};

export type GenerateContentFn = (
  modelId: string,
  contents: unknown,
  config: Record<string, unknown>,
) => Promise<{ text?: string | null }>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Client for Google Gemini and Gemma models using @google/genai.
 * Enforces architecture.md §11.1:
 * - The ONLY file importing @google/genai
 * - Calls ai.models.generateContent
 * - Never sends forbidden sampling parameters
 * - Thinking configured via thinkingLevel only
 * - Never ends contents with a model turn
 * - Capability downgrade ladder (Level 0 -> Level 1 -> Level 2)
 */
export class LlmClient {
  private readonly ai: GoogleGenAI | null;
  private readonly customGenerator: GenerateContentFn | null;
  // Capability downgrade ladder state remembered in-memory per model (0 = full, 1 = drop thinking, 2 = drop schema)
  private readonly downgradeLevels = new Map<string, number>();

  public constructor(options?: { apiKey?: string; generator?: GenerateContentFn }) {
    if (options?.generator) {
      this.customGenerator = options.generator;
      this.ai = null;
    } else if (options?.apiKey) {
      this.ai = new GoogleGenAI({ apiKey: options.apiKey });
      this.customGenerator = null;
    } else {
      this.ai = null;
      this.customGenerator = null;
    }
  }

  /**
   * Returns current capability downgrade level for a model.
   * 0: full config (structured schema + thinkingLevel)
   * 1: drop thinkingLevel
   * 2: drop responseSchema (JSON-in-prompt)
   */
  public getDowngradeLevel(modelId: string): number {
    return this.downgradeLevels.get(modelId) ?? 0;
  }

  /**
   * Generates content from an LLM model, handling the capability downgrade ladder on HTTP 400.
   */
  public async generate(
    modelId: string,
    prompt: BuiltPrompt,
    options: GenerateOptions = {},
  ): Promise<LlmClientResult> {
    const profile = getModelProfile(modelId);
    let level = this.getDowngradeLevel(modelId);

    // Initial check for models that default without structured schema (like standard Gemma)
    if (!profile.structuredOutput && level < 2) {
      level = 2;
      this.downgradeLevels.set(modelId, 2);
    }

    const t0 = performance.now();

    // Prepare abort signal with timeout
    const timeoutMs = options.timeoutMs ?? 15000;
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const combinedSignal = options.signal
      ? AbortSignal.any([options.signal, timeoutSignal])
      : timeoutSignal;

    let contents: string | Array<{ role: string; parts: Array<{ text: string }> }>;
    if (options.repairTurn) {
      contents = [
        { role: 'user', parts: [{ text: prompt.userPrompt }] },
        { role: 'model', parts: [{ text: options.repairTurn.previousOutput }] },
        {
          role: 'user',
          parts: [
            {
              text: `Your previous output failed schema validation with error: ${options.repairTurn.error}.\nFix the issues and output strictly valid JSON matching the required schema.`,
            },
          ],
        },
      ];
    } else {
      contents = prompt.userPrompt;
    }

    // Attempt generation with automatic capability downgrade ladder on 400
    while (level <= 2) {
      const config: Record<string, unknown> = {
        systemInstruction: prompt.systemInstruction,
        responseMimeType: 'application/json',
        abortSignal: combinedSignal,
      };

      if (level === 0) {
        config['responseSchema'] = MODEL_JSON_SCHEMA;
        if (profile.thinkingLevel) {
          config['thinkingConfig'] = { thinkingLevel: profile.thinkingLevel };
        }
      } else if (level === 1) {
        config['responseSchema'] = MODEL_JSON_SCHEMA;
        // thinkingConfig dropped
      } else {
        // level 2: responseSchema dropped, relying on JSON-in-prompt
      }

      try {
        let rawText: string | undefined | null;

        if (this.customGenerator) {
          // oxlint-disable-next-line eslint/no-await-in-loop -- sequential capability downgrade ladder on HTTP 400
          const res = await this.customGenerator(modelId, contents, config);
          rawText = res.text;
        } else if (this.ai) {
          // oxlint-disable-next-line eslint/no-await-in-loop -- sequential capability downgrade ladder on HTTP 400
          const res = await this.ai.models.generateContent({
            model: modelId,
            contents,
            config,
          });
          rawText = res.text;
        } else {
          throw new Error('No LLM client configured (missing API key or generator)');
        }

        const ms = performance.now() - t0;
        return {
          text: rawText ?? '',
          ms,
        };
      } catch (err) {
        const status = this.extractStatusCode(err);

        // On HTTP 400: downgrade capability and retry
        if (status === 400 && level < 2) {
          level += 1;
          this.downgradeLevels.set(modelId, level);
          logger.warn('LLM capability downgrade ladder triggered', {
            modelId,
            newLevel: level,
            reason: 'HTTP 400 rejected configuration',
          });
          continue;
        }

        // Rethrow with parsed metadata for the chain and breaker
        throw err;
      }
    }

    throw new Error(`Exhausted downgrade ladder for model ${modelId}`);
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
