import { z } from 'zod';

import { errorCodeSchema } from './error-codes.js';

export const errorEnvelopeSchema = z.object({
  error: z.object({
    code: errorCodeSchema,
    message: z.string(),
    hint: z.string().optional(),
  }),
  requestId: z.string(),
});

export type ErrorEnvelope = z.infer<typeof errorEnvelopeSchema>;

export const healthLiveResponseSchema = z.object({
  status: z.literal('ok'),
});

export type HealthLiveResponse = z.infer<typeof healthLiveResponseSchema>;

export const healthResponseSchema = z.object({
  ready: z.boolean(),
  version: z.string(),
  uptimeSec: z.number(),
  sandbox: z.object({
    state: z.string(),
    respawns: z.number(),
    jobsSinceSpawn: z.number(),
  }),
  llm: z.object({
    configured: z.boolean(),
    models: z.array(
      z.object({
        id: z.string(),
        breaker: z.string(),
      }),
    ),
  }),
});

export type HealthResponse = z.infer<typeof healthResponseSchema>;

const presetIdSchema = z.enum(['orders-composite', 'events-multitenant', 'analytics-covering']);
export type PresetId = z.infer<typeof presetIdSchema>;

export const diagnoseRequestSchema = z
  .object({
    schema: z.string().min(1).max(20000),
    query: z.string().min(1).max(8000),
    presetId: presetIdSchema.optional(),
  })
  .strict();

export type DiagnoseRequest = z.infer<typeof diagnoseRequestSchema>;

export type PlanNode = {
  type: string;
  relation?: string;
  indexName?: string;
  alias?: string;
  startupCost: number;
  totalCost: number;
  planRows: number;
  filter?: string;
  indexCond?: string;
  recheckCond?: string;
  sortKey?: string[];
  joinType?: string;
  children: PlanNode[];
};

const planNodeSchema: z.ZodType<PlanNode> = z.lazy(() =>
  z.object({
    type: z.string(),
    relation: z.string().optional(),
    indexName: z.string().optional(),
    alias: z.string().optional(),
    startupCost: z.number(),
    totalCost: z.number(),
    planRows: z.number(),
    filter: z.string().optional(),
    indexCond: z.string().optional(),
    recheckCond: z.string().optional(),
    sortKey: z.array(z.string()).optional(),
    joinType: z.string().optional(),
    children: z.array(planNodeSchema),
  }),
);

export const planSummarySchema = z.object({
  nodePath: z.string(),
  primaryScan: z.string(),
  startupCost: z.number(),
  totalCost: z.number(),
  planRows: z.number(),
  usesIndexes: z.array(z.string()),
  tree: planNodeSchema,
  rawPlan: z.unknown().optional(),
});

export type PlanSummary = z.infer<typeof planSummarySchema>;

const outcomeSchema = z.enum(['improved', 'not_improved', 'unverified', 'no_recommendation']);
export type Outcome = z.infer<typeof outcomeSchema>;

const severitySchema = z.enum(['CRITICAL', 'HIGH', 'MODERATE', 'OPTIMAL']);
export type Severity = z.infer<typeof severitySchema>;

const SEVERITY_RATIO_CRITICAL = 10;
const SEVERITY_RATIO_HIGH = 3;

export function deriveSeverity(outcome: Outcome, costRatio: number): Severity {
  if (outcome !== 'improved') {
    return 'OPTIMAL';
  }
  if (costRatio >= SEVERITY_RATIO_CRITICAL) {
    return 'CRITICAL';
  }
  if (costRatio >= SEVERITY_RATIO_HIGH) {
    return 'HIGH';
  }
  return 'MODERATE';
}

const verifiedStatusSchema = z.object({
  status: z.literal('verified'),
  indexUsed: z.boolean(),
  costBefore: z.number(),
  costAfter: z.number(),
  costReductionPercent: z.number(),
  costRatio: z.number(),
  severity: severitySchema,
});

const unverifiedStatusSchema = z.object({
  status: z.literal('unverified'),
  reason: z.string(),
});

const verificationSchema = z.discriminatedUnion('status', [
  verifiedStatusSchema,
  unverifiedStatusSchema,
]);

export type Verification = z.infer<typeof verificationSchema>;

const indexColumnSchema = z.object({
  name: z.string(),
  direction: z.enum(['ASC', 'DESC']),
  nulls: z.enum(['FIRST', 'LAST']).optional(),
  opclass: z.string().optional(),
});

const indexObjectSchema = z.object({
  table: z.string(),
  name: z.string(),
  columns: z.array(indexColumnSchema),
  include: z.array(z.string()),
  where: z.string().nullable(),
});

export type IndexObject = z.infer<typeof indexObjectSchema>;

const esrRoleSchema = z.enum(['Equality', 'Sort', 'Range', 'Include', 'Other']);

const esrEntrySchema = z.object({
  column: z.string(),
  role: esrRoleSchema,
  reason: z.string(),
});

const recommendationSchema = z.object({
  index: indexObjectSchema,
  sql: z.object({
    create: z.string(),
    createConcurrently: z.string(),
  }),
  headline: z.string(),
  explanation: z.string(),
  antiPatterns: z.array(z.string()),
  esr: z.array(esrEntrySchema),
  migrations: z.object({
    postgres: z.string(),
    drizzle: z.string().optional(),
    prisma: z.string().optional(),
  }),
  migrationNotes: z.array(z.string()),
});

export type Recommendation = z.infer<typeof recommendationSchema>;

const attemptOutcomeSchema = z.enum([
  'ok',
  'timeout',
  'http_error',
  'invalid_output',
  'skipped_breaker',
  'skipped_cap',
  'no_key',
]);

const attemptSchema = z.object({
  model: z.string(),
  outcome: attemptOutcomeSchema,
  ms: z.number(),
});

const sourceSchema = z.object({
  proposedBy: z.enum(['llm', 'deterministic']),
  model: z.string().nullable(),
  attempts: z.array(attemptSchema),
});

const alternativeSchema = z
  .object({
    proposedBy: z.enum(['llm', 'deterministic']),
    index: indexObjectSchema,
    indexUsed: z.boolean(),
    costAfter: z.number(),
  })
  .nullable();

export type Alternative = z.infer<typeof alternativeSchema>;

const assumptionsSchema = z.object({
  assumedRowCount: z.number(),
  seededRows: z.number(),
  plannerSettings: z.literal('postgres-defaults'),
  tablesScaledEqually: z.literal(true),
});

const timingsMsSchema = z.object({
  gate: z.number(),
  propose: z.number(),
  evaluate: z.number(),
  total: z.number(),
});

export const diagnoseResponseSchema = z.object({
  requestId: z.string(),
  cached: z.boolean(),
  outcome: outcomeSchema,
  verification: verificationSchema,
  recommendation: recommendationSchema.nullable(),
  plans: z.object({
    before: planSummarySchema.nullable(),
    after: planSummarySchema.nullable(),
  }),
  source: sourceSchema,
  alternative: alternativeSchema,
  assumptions: assumptionsSchema,
  notices: z.array(z.string()),
  timingsMs: timingsMsSchema,
});

export type DiagnoseResponse = z.infer<typeof diagnoseResponseSchema>;
