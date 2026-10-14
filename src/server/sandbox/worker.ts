import { parentPort } from 'node:worker_threads';

import { PGlite } from '@electric-sql/pglite';

import { evaluateJob } from './engine.js';
import { mainToWorkerMessageSchema, type WorkerToMainMessage } from './protocol.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

if (!parentPort) {
  throw new Error('sandbox/worker.ts must be run in a Worker thread.');
}

const port = parentPort;

async function runWorker(): Promise<void> {
  const pg = await PGlite.create();
  await pg.waitReady;

  const readyMsg: WorkerToMainMessage = { type: 'ready' };
  port.postMessage(readyMsg);

  port.on('message', async (rawMsg: unknown) => {
    try {
      const msg = mainToWorkerMessageSchema.parse(rawMsg);

      if (msg.type === 'job') {
        try {
          const result = await evaluateJob(pg, msg.payload);
          const responseMsg: WorkerToMainMessage = {
            type: 'result',
            id: msg.id,
            ok: true,
            data: result,
          };
          port.postMessage(responseMsg);
        } catch (jobErr: unknown) {
          const code =
            isRecord(jobErr) && typeof jobErr['code'] === 'string'
              ? jobErr['code']
              : 'SANDBOX_ERROR';
          const message =
            jobErr instanceof Error
              ? jobErr.message
              : isRecord(jobErr) && typeof jobErr['message'] === 'string'
                ? jobErr['message']
                : 'Sandbox execution error';

          const responseMsg: WorkerToMainMessage = {
            type: 'result',
            id: msg.id,
            ok: false,
            error: {
              code,
              message,
            },
          };
          port.postMessage(responseMsg);
        }
      } else if (msg.type === 'canary') {
        // Run canary self-test
        await pg.exec(`
          BEGIN;
          CREATE TABLE _canary_probe (id int);
          INSERT INTO _canary_probe VALUES (1);
          ANALYZE _canary_probe;
          ROLLBACK;
        `);
        const canaryOkMsg: WorkerToMainMessage = {
          type: 'canary_ok',
          id: msg.id,
        };
        port.postMessage(canaryOkMsg);
      }
    } catch (parseOrFatalErr: unknown) {
      const message =
        parseOrFatalErr instanceof Error ? parseOrFatalErr.message : 'Worker message parsing error';
      const fatalMsg: WorkerToMainMessage = {
        type: 'fatal',
        message,
      };
      port.postMessage(fatalMsg);
    }
  });
}

runWorker().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  const fatalMsg: WorkerToMainMessage = {
    type: 'fatal',
    message: `Worker startup failed: ${message}`,
  };
  port.postMessage(fatalMsg);
});
