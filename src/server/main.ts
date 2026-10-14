import { serve } from '@hono/node-server';

import { createApp } from './app.js';
import { parseConfig } from './config.js';
import { logger } from './logger.js';
import { SandboxManager } from './sandbox/manager.js';

function bootstrap(): void {
  const config = parseConfig();
  logger.setLevel(config.LOG_LEVEL);

  logger.info('Starting IndexDoctor server...', {
    nodeEnv: config.NODE_ENV,
    port: config.PORT,
    models: config.LLM_MODELS,
  });

  const sandboxManager = new SandboxManager({ config, logger });
  const app = createApp({ config, logger, sandboxManager });

  const server = serve(
    {
      fetch: app.fetch,
      port: config.PORT,
    },
    (info) => {
      logger.info('IndexDoctor HTTP server listening', {
        port: info.port,
        address: info.address,
      });
    },
  );

  // Background start of sandbox worker & startup canary
  sandboxManager.start().catch((err: unknown) => {
    logger.error('Failed to start sandbox worker on startup', {
      error: err instanceof Error ? err.message : String(err),
    });
  });

  // Process-level termination and rejection handlers
  let isShuttingDown = false;

  async function shutdown(signal: string): Promise<void> {
    if (isShuttingDown) return;
    isShuttingDown = true;
    logger.info(`Received ${signal}. Initiating graceful shutdown...`);

    const forceExitTimeout = setTimeout(() => {
      logger.error('Graceful shutdown timed out after 8s. Forcing exit.');
      process.exit(1);
    }, 8000);
    forceExitTimeout.unref();

    try {
      await sandboxManager.stop();
    } catch (err) {
      logger.error('Error stopping sandbox manager', {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    server.close(() => {
      logger.info('Closed HTTP listener. Exiting cleanly.');
      process.exit(0);
    });
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  process.on('uncaughtException', (err: Error) => {
    logger.error('Uncaught Exception', {
      error: err.message,
      name: err.name,
    });
    process.exit(1);
  });

  process.on('unhandledRejection', (reason: unknown) => {
    logger.error('Unhandled Promise Rejection', {
      error: reason instanceof Error ? reason.message : String(reason),
    });
    process.exit(1);
  });
}

bootstrap();
