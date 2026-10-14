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

export const diagnoseRequestSchema = z
  .object({
    schema: z.string().min(1).max(20000),
    query: z.string().min(1).max(8000),
    presetId: z.enum(['orders-composite', 'products-range', 'analytics-covering']).optional(),
  })
  .strict();

export type DiagnoseRequest = z.infer<typeof diagnoseRequestSchema>;
