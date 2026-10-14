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
