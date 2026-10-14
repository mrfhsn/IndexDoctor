import { z } from 'zod';

import { sanitizeText, TEXT_LIMITS } from '../lib/sanitize-text.js';

const modelColumnSpecSchema = z.object({
  name: z.string().min(1).max(63),
  direction: z.enum(['asc', 'desc']).optional(),
  nulls: z.enum(['first', 'last']).optional(),
  opclass: z.enum(['text_pattern_ops', 'varchar_pattern_ops']).optional(),
});

const modelCandidateIndexSchema = z.object({
  table: z.string().min(1).max(63),
  columns: z.array(modelColumnSpecSchema).min(1).max(6),
  include: z.array(z.string().min(1).max(63)).max(3).optional(),
  where: z.string().nullable().optional(),
});

const modelEsrItemSchema = z.object({
  column: z.string().min(1).max(63),
  reason: z.string().max(300),
});

const modelRecommendationSchema = z.object({
  index: modelCandidateIndexSchema.nullable().optional(),
  headline: z.string(),
  explanation: z.string(),
  antiPatterns: z.array(z.string()).default([]),
  esr: z.array(modelEsrItemSchema).default([]),
});

type ModelRecommendation = z.infer<typeof modelRecommendationSchema>;

export type ParsedModelOutput =
  | {
      ok: true;
      data: ModelRecommendation;
    }
  | {
      ok: false;
      error: string;
      rawSnippet?: string;
    };

/**
 * Tolerant JSON extractor and parser for model output.
 * Strips code fences, finds the outermost braces, validates with Zod,
 * and sanitizes free text.
 */
export function parseModelOutput(rawOutput: string): ParsedModelOutput {
  if (!rawOutput || !rawOutput.trim()) {
    return { ok: false, error: 'Model output is empty.' };
  }

  let text = rawOutput.trim();

  // 1. Strip markdown code fences if present (```json ... ```)
  if (text.startsWith('```')) {
    text = text
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/```\s*$/, '')
      .trim();
  }

  // 2. Extract outermost JSON object { ... }
  const firstBrace = text.indexOf('{');
  const lastBrace = text.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    text = text.slice(firstBrace, lastBrace + 1);
  }

  // 3. Parse JSON
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(text);
  } catch (err) {
    const snippet = text.slice(0, 100);
    return {
      ok: false,
      error: `Failed to parse model JSON: ${err instanceof Error ? err.message : String(err)}`,
      rawSnippet: snippet,
    };
  }

  // 4. Validate against Zod schema
  const result = modelRecommendationSchema.safeParse(parsedJson);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(', ');
    return {
      ok: false,
      error: `Model output did not match recommendation schema: ${issues}`,
    };
  }

  const data = result.data;

  // 5. Sanitize text fields per architecture §11.6
  const sanitizedHeadline = sanitizeText(data.headline, TEXT_LIMITS.HEADLINE);
  const sanitizedExplanation = sanitizeText(data.explanation, TEXT_LIMITS.EXPLANATION);
  const sanitizedAntiPatterns = data.antiPatterns.map((ap) =>
    sanitizeText(ap, TEXT_LIMITS.ANTI_PATTERN),
  );
  const sanitizedEsr = data.esr.map((item) => ({
    column: sanitizeText(item.column, 63),
    reason: sanitizeText(item.reason, TEXT_LIMITS.REASON),
  }));

  return {
    ok: true,
    data: {
      index: data.index ?? null,
      headline: sanitizedHeadline,
      explanation: sanitizedExplanation,
      antiPatterns: sanitizedAntiPatterns,
      esr: sanitizedEsr,
    },
  };
}
