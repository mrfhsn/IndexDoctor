import { serve } from '@hono/node-server';

import { createApp } from './app.js';
import { parseConfig } from './config.js';
import { logger } from './logger.js';

function bootstrap(): void {
  const config = parseConfig();
  logger.setLevel(config.LOG_LEVEL);

  logger.info('Starting IndexDoctor server...', {
    nodeEnv: config.NODE_ENV,
    port: config.PORT,
    models: config.LLM_MODELS,
  });

  const app = createApp({ config });

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

  // Process-level termination and rejection handlers
  let isShuttingDown = false;

  function shutdown(signal: string): void {
    if (isShuttingDown) return;
    isShuttingDown = true;
    logger.info(`Received ${signal}. Initiating graceful shutdown...`);

    const forceExitTimeout = setTimeout(() => {
      logger.error('Graceful shutdown timed out after 8s. Forcing exit.');
      process.exit(1);
    }, 8000);
    forceExitTimeout.unref();

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
