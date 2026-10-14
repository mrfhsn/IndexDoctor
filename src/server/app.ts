import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';

import type { HealthLiveResponse, HealthResponse } from '../shared/contract.js';
import type { Config } from './config.js';
import { AppError, toErrorEnvelope } from './errors.js';
import { type Logger, logger as defaultLogger } from './logger.js';
import type { SandboxManager } from './sandbox/manager.js';

export interface AppDependencies {
  config: Config;
  logger?: Logger;
  startTime?: number;
  sandboxManager?: SandboxManager;
}

export type AppEnv = {
  Variables: {
    requestId: string;
  };
};

export function createApp(deps: AppDependencies): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const log = deps.logger ?? defaultLogger;
  const startTime = deps.startTime ?? Date.now();
  let inFlightRequests = 0;

  // 1. Request ID and Request Logging Middleware
  app.use('*', async (c, next) => {
    const requestId = c.req.header('x-request-id') ?? crypto.randomUUID();
    c.set('requestId', requestId);
    c.header('x-request-id', requestId);

    // Security headers (architecture.md §7)
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Referrer-Policy', 'no-referrer');
    c.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    c.header('Cross-Origin-Opener-Policy', 'same-origin');
    c.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    c.header(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
    );

    await next();
  });

  // 2. In-Flight Cap Middleware
  app.use('*', async (c, next) => {
    if (inFlightRequests >= deps.config.MAX_IN_FLIGHT) {
      c.header('Retry-After', '2');
      throw new AppError('BUSY', 'Server is currently experiencing high load. Please retry.', {
        status: 503,
      });
    }

    inFlightRequests++;
    try {
      await next();
    } finally {
      inFlightRequests--;
    }
  });

  // 3. Health Live Probe Endpoint (I6 - never fails)
  app.get('/api/health/live', (c) => {
    const response: HealthLiveResponse = { status: 'ok' };
    return c.json(response, 200);
  });

  // 4. Health Startup/Readiness Probe Endpoint
  app.get('/api/health', (c) => {
    const uptimeSec = Math.floor((Date.now() - startTime) / 1000);
    const modelsList = deps.config.LLM_MODELS.split(',').map((id) => ({
      id: id.trim(),
      breaker: 'closed',
    }));

    const sandboxStatus = deps.sandboxManager?.getStatus() ?? {
      state: 'not_started',
      respawns: 0,
      jobsSinceSpawn: 0,
      queueLength: 0,
    };

    const isReady =
      deps.sandboxManager === undefined
        ? true
        : sandboxStatus.state === 'ready' || sandboxStatus.state === 'busy';

    const response: HealthResponse = {
      ready: isReady,
      version: '0.1.0',
      uptimeSec,
      sandbox: {
        state: sandboxStatus.state,
        respawns: sandboxStatus.respawns,
        jobsSinceSpawn: sandboxStatus.jobsSinceSpawn,
      },
      llm: {
        configured: Boolean(deps.config.GEMINI_API_KEY),
        models: modelsList,
      },
    };

    return c.json(response, isReady ? 200 : 503);
  });

  // 5. Static Assets & SPA Handling
  const clientDist = path.resolve(process.cwd(), 'dist/client');
  if (fs.existsSync(clientDist)) {
    app.use('/*', serveStatic({ root: './dist/client' }));
    app.get('*', serveStatic({ path: './dist/client/index.html' }));
  } else {
    app.get('/', (c) => {
      return c.html(`
        <!DOCTYPE html>
        <html lang="en">
          <head>
            <meta charset="utf-8" />
            <meta name="viewport" content="width=device-width, initial-scale=1" />
            <title>IndexDoctor</title>
          </head>
          <body style="background: #020617; color: #f8fafc; font-family: sans-serif; padding: 2rem;">
            <h1>IndexDoctor</h1>
            <p>Postgres index recommendations verified by an in-engine planner in WASM.</p>
            <p>Status: Walking Skeleton Online</p>
          </body>
        </html>
      `);
    });
  }

  // Global Error Handler
  app.onError((err, c) => {
    const requestId = c.get('requestId') ?? crypto.randomUUID();
    const { status, body } = toErrorEnvelope(err, requestId);

    log.error('Request error', {
      requestId,
      statusCode: status,
      error: err instanceof Error ? err.message : String(err),
      path: c.req.path,
      method: c.req.method,
    });

    return c.json(body, status);
  });

  return app;
}
