import { z } from 'zod';

import { planSummarySchema } from '../../shared/contract.js';

// Candidate index specification for evaluation
const candidateIndexPayloadSchema = z.object({
  name: z.string(),
  ddl: z.string(),
});

// Payload sent to sandbox worker for evaluate job
const evaluatePayloadSchema = z.object({
  statements: z.array(z.string()),
  querySql: z.string(),
  candidateIndexes: z.array(candidateIndexPayloadSchema).max(2),
  assumedRowCount: z.number().int().positive().default(500000),
  seededRows: z.number().int().positive().default(20000),
});
export type EvaluatePayload = z.infer<typeof evaluatePayloadSchema>;

// Measured plan evaluation for a candidate index
const candidateEvaluationResultSchema = z.object({
  name: z.string(),
  ddl: z.string(),
  after: planSummarySchema,
  indexUsed: z.boolean(),
  costBefore: z.number(),
  costAfter: z.number(),
  costReductionPercent: z.number(),
  costRatio: z.number(),
});
export type CandidateEvaluationResult = z.infer<typeof candidateEvaluationResultSchema>;

// Evaluation result returned by the sandbox engine/worker
const evaluateResultSchema = z.object({
  before: planSummarySchema,
  candidates: z.array(candidateEvaluationResultSchema),
  unseededTables: z.array(z.string()).default([]),
});
export type EvaluateResult = z.infer<typeof evaluateResultSchema>;

// Worker Protocol Messages (Main -> Worker)
export const mainToWorkerMessageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('job'),
    id: z.string(),
    kind: z.literal('evaluate'),
    payload: evaluatePayloadSchema,
  }),
  z.object({
    type: z.literal('canary'),
    id: z.string(),
  }),
]);
export type MainToWorkerMessage = z.infer<typeof mainToWorkerMessageSchema>;

// Worker Protocol Messages (Worker -> Main)
const workerResultSuccessSchema = z.object({
  type: z.literal('result'),
  id: z.string(),
  ok: z.literal(true),
  data: evaluateResultSchema,
});

const workerResultErrorSchema = z.object({
  type: z.literal('result'),
  id: z.string(),
  ok: z.literal(false),
  error: z.object({
    code: z.string(),
    message: z.string(),
  }),
});

export const workerToMainMessageSchema = z.union([
  z.object({
    type: z.literal('ready'),
  }),
  workerResultSuccessSchema,
  workerResultErrorSchema,
  z.object({
    type: z.literal('canary_ok'),
    id: z.string(),
  }),
  z.object({
    type: z.literal('fatal'),
    message: z.string(),
  }),
]);
export type WorkerToMainMessage = z.infer<typeof workerToMainMessageSchema>;
