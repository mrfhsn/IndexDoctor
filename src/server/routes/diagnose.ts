import { Hono } from 'hono';

import { diagnoseRequestSchema } from '../../shared/contract.js';
import type { AppEnv } from '../app.js';
import type { Config } from '../config.js';
import { AppError } from '../errors.js';
import { extractClientIp, type TokenBucketRateLimiter } from '../lib/token-bucket.js';
import type { PipelineRunner } from '../pipeline/diagnose.js';

export interface DiagnoseRouteDependencies {
  config: Config;
  pipeline: PipelineRunner;
  rateLimiter: TokenBucketRateLimiter;
}

/**
 * Creates the POST /api/diagnose route handler with:
 * - Per-IP token-bucket rate limiting (extracting rightmost XFF hop)
 * - Strict Content-Type enforcement (415)
 * - Stream-counted body size protection (413)
 * - Strict schema validation (400)
 */
export function createDiagnoseRoute(deps: DiagnoseRouteDependencies): Hono<AppEnv> {
  const router = new Hono<AppEnv>();

  router.post('/diagnose', async (c) => {
    const requestId = c.get('requestId');

    // 1. Rate Limiting Check (per-IP Token Bucket)
    const clientIp = extractClientIp(c.req.raw.headers, deps.config.TRUSTED_PROXY_HOPS);
    const rateCheck = deps.rateLimiter.consume(clientIp);
    if (!rateCheck.allowed) {
      c.header('Retry-After', String(rateCheck.retryAfterSec ?? 5));
      throw new AppError('RATE_LIMITED', 'Rate limit exceeded. Please retry shortly.', {
        status: 429,
        hint: `IP rate limit reached (${deps.config.RATE_LIMIT_PER_MIN} req/min). Retry in ${rateCheck.retryAfterSec ?? 5} seconds.`,
      });
    }

    // 2. Content-Type Check (architecture.md §7)
    const contentType = c.req.header('content-type') ?? '';
    if (!contentType.toLowerCase().includes('application/json')) {
      throw new AppError('UNSUPPORTED_MEDIA_TYPE', 'Content-Type must be application/json.', {
        status: 415,
        hint: 'Set Content-Type header to application/json',
      });
    }

    // 3. Body Size Limit (stream-counted, rejecting before full processing)
    const buffer = await c.req.raw.arrayBuffer();
    if (buffer.byteLength > deps.config.MAX_BODY_BYTES) {
      throw new AppError(
        'PAYLOAD_TOO_LARGE',
        `Request body exceeds maximum size of ${deps.config.MAX_BODY_BYTES} bytes (${buffer.byteLength} bytes received).`,
        {
          status: 413,
          hint: `Limit total request payload to ${deps.config.MAX_BODY_BYTES} bytes.`,
        },
      );
    }

    // 4. JSON parse check
    let rawJson: unknown;
    try {
      const text = new TextDecoder().decode(buffer);
      rawJson = JSON.parse(text);
    } catch {
      throw new AppError('INVALID_REQUEST', 'Malformed JSON in request body.', {
        status: 400,
        hint: 'Ensure request body is valid JSON.',
      });
    }

    // 5. Strict Zod Schema Validation
    const parsed = diagnoseRequestSchema.safeParse(rawJson);
    if (!parsed.success) {
      const firstIssue = parsed.error.issues[0];
      const issueMsg = firstIssue
        ? `${firstIssue.path.join('.') || 'body'}: ${firstIssue.message}`
        : 'Validation failed';
      throw new AppError('INVALID_REQUEST', `Invalid request parameters: ${issueMsg}`, {
        status: 400,
        hint: 'Ensure schema and query are non-empty strings within limits, and no unknown keys are sent.',
      });
    }

    // 6. Execute Pipeline
    const response = await deps.pipeline.run({
      schema: parsed.data.schema,
      query: parsed.data.query,
      presetId: parsed.data.presetId,
      requestId,
    });

    return c.json(response, 200);
  });

  return router;
}
