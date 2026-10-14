import { z } from 'zod';

const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(8080),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('production'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),

  GEMINI_API_KEY: z.string().optional(),
  LLM_MODELS: z.string().default('gemini-3.1-flash-lite,gemma-4-26b-a4b-it,gemini-3.5-flash-lite'),
  LLM_THINKING_LEVEL: z.enum(['minimal', 'low', 'medium', 'high']).default('minimal'),
  LLM_ATTEMPT_TIMEOUT_MS: z.coerce.number().int().positive().default(8000),
  LLM_BUDGET_MS: z.coerce.number().int().positive().default(15000),
  LLM_MAX_CONCURRENCY: z.coerce.number().int().positive().default(6),
  LLM_DAILY_CAP: z.coerce.number().int().positive().default(1500),
  LLM_BREAKER_COOLDOWN_MS: z.coerce.number().int().positive().default(60000),

  REQUEST_DEADLINE_MS: z.coerce.number().int().positive().default(30000),
  MAX_BODY_BYTES: z.coerce.number().int().positive().default(32768),
  MAX_SCHEMA_BYTES: z.coerce.number().int().positive().default(20000),
  MAX_QUERY_BYTES: z.coerce.number().int().positive().default(8000),
  MAX_IN_FLIGHT: z.coerce.number().int().nonnegative().default(24),

  SANDBOX_QUEUE_MAX: z.coerce.number().int().positive().default(12),
  SANDBOX_QUEUE_WAIT_MS: z.coerce.number().int().positive().default(5000),
  SANDBOX_JOB_TIMEOUT_MS: z.coerce.number().int().positive().default(6000),
  SANDBOX_SEED_ROWS: z.coerce.number().int().positive().default(20000),
  ASSUMED_ROW_COUNT: z.coerce.number().int().positive().default(500000),
  SANDBOX_RECYCLE_JOBS: z.coerce.number().int().positive().default(300),

  RATE_LIMIT_PER_MIN: z.coerce.number().int().positive().default(12),
  RATE_LIMIT_BURST: z.coerce.number().int().positive().default(6),
  TRUSTED_PROXY_HOPS: z.coerce.number().int().nonnegative().default(1),

  CACHE_MAX_ENTRIES: z.coerce.number().int().positive().default(200),
  CACHE_TTL_MS: z.coerce.number().int().positive().default(3600000),
});

export type Config = z.infer<typeof envSchema>;

export const CONFIG_KEYS: readonly string[] = Object.keys(envSchema.shape);

export function parseConfig(env: Record<string, string | undefined> = process.env): Config {
  const result = envSchema.safeParse(env);
  if (!result.success) {
    const errorDetails = result.error.issues
      .map((issue) => `  ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(`Configuration initialization error:\n${errorDetails}`);
  }
  return result.data;
}
