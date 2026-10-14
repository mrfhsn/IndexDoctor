import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';

import type { Config } from '../config.js';
import { AppError } from '../errors.js';
import { type Logger, logger as defaultLogger } from '../logger.js';
import {
  type EvaluatePayload,
  type EvaluateResult,
  type MainToWorkerMessage,
  type WorkerToMainMessage,
  workerToMainMessageSchema,
} from './protocol.js';

export type SandboxState = 'starting' | 'ready' | 'busy' | 'recovering' | 'dead' | 'stopped';

export interface SandboxStatus {
  state: SandboxState;
  respawns: number;
  jobsSinceSpawn: number;
  queueLength: number;
}

interface QueuedJob {
  id: string;
  payload: EvaluatePayload;
  deadlineMs: number;
  enqueuedAt: number;
  resolve: (res: EvaluateResult) => void;
  reject: (err: unknown) => void;
}

export interface SandboxManagerDependencies {
  config: Config;
  logger?: Logger;
  workerUrl?: URL;
}

function resolveWorkerUrl(): URL {
  const localJsUrl = new URL('./worker.js', import.meta.url);
  if (fs.existsSync(localJsUrl)) {
    return localJsUrl;
  }
  const distPath = path.resolve(process.cwd(), 'dist/server/sandbox/worker.js');
  if (fs.existsSync(distPath)) {
    return pathToFileURL(distPath);
  }
  return localJsUrl;
}

export class SandboxManager {
  private state: SandboxState = 'starting';
  private worker: Worker | null = null;
  private currentJob: QueuedJob | null = null;
  private jobTimer: NodeJS.Timeout | null = null;
  private queue: QueuedJob[] = [];
  private respawns = 0;
  private jobsSinceSpawn = 0;
  private consecutiveFailures = 0;
  private lastFailureTime = 0;
  private isShuttingDown = false;

  private readonly config: Config;
  private readonly log: Logger;
  private readonly workerUrl: URL;

  constructor(deps: SandboxManagerDependencies) {
    this.config = deps.config;
    this.log = deps.logger ?? defaultLogger;
    this.workerUrl = deps.workerUrl ?? resolveWorkerUrl();
  }

  public getStatus(): SandboxStatus {
    return {
      state: this.state,
      respawns: this.respawns,
      jobsSinceSpawn: this.jobsSinceSpawn,
      queueLength: this.queue.length,
    };
  }

  /**
   * Initializes and spawns the PGlite worker thread, running the startup canary.
   */
  public async start(): Promise<void> {
    if (this.isShuttingDown) return;
    this.state = 'starting';
    await this.spawnWorker();
  }

  /**
   * Gracefully shuts down the sandbox manager and terminates the worker.
   */
  public async stop(): Promise<void> {
    this.isShuttingDown = true;
    this.state = 'stopped';

    if (this.jobTimer) {
      clearTimeout(this.jobTimer);
      this.jobTimer = null;
    }

    if (this.worker) {
      await this.worker.terminate();
      this.worker = null;
    }

    while (this.queue.length > 0) {
      const job = this.queue.shift();
      job?.reject(new AppError('NOT_READY', 'Sandbox manager stopped.'));
    }

    if (this.currentJob) {
      this.currentJob.reject(new AppError('NOT_READY', 'Sandbox manager stopped.'));
      this.currentJob = null;
    }
  }

  /**
   * Evaluates candidate indexes against the schema and query in the sandbox.
   */
  public async evaluate(
    payload: EvaluatePayload,
    deadlineMs = this.config.REQUEST_DEADLINE_MS,
  ): Promise<EvaluateResult> {
    if (this.state === 'dead') {
      throw new AppError('NOT_READY', 'Sandbox engine is unavailable.', {
        status: 503,
        hint: 'The sandbox worker is recovering. Please retry shortly.',
      });
    }

    if (this.queue.length >= this.config.SANDBOX_QUEUE_MAX) {
      throw new AppError('BUSY', 'Sandbox evaluation queue is full.', {
        status: 503,
        hint: 'Server is handling maximum concurrent index evaluations. Retry shortly.',
      });
    }

    return new Promise<EvaluateResult>((resolve, reject) => {
      const job: QueuedJob = {
        id: crypto.randomUUID(),
        payload,
        deadlineMs,
        enqueuedAt: Date.now(),
        resolve,
        reject,
      };

      this.queue.push(job);
      this.processQueue();
    });
  }

  private async spawnWorker(): Promise<void> {
    try {
      this.worker = new Worker(this.workerUrl);
      this.jobsSinceSpawn = 0;

      await new Promise<void>((resolve, reject) => {
        let isReady = false;

        const onMessage = async (raw: unknown) => {
          try {
            const msg = workerToMainMessageSchema.parse(raw);

            if (msg.type === 'ready') {
              // Run startup canary
              const canaryId = crypto.randomUUID();
              const canaryMsg: MainToWorkerMessage = { type: 'canary', id: canaryId };
              this.worker?.postMessage(canaryMsg);
            } else if (msg.type === 'canary_ok') {
              isReady = true;
              this.state = 'ready';
              this.consecutiveFailures = 0;
              this.log.info('Sandbox worker ready and verified by canary', {
                respawns: this.respawns,
                jobsSinceSpawn: this.jobsSinceSpawn,
              });
              resolve();
              this.processQueue();
            } else if (msg.type === 'result') {
              this.handleJobResult(msg);
            } else if (msg.type === 'fatal') {
              this.log.error('Worker fatal event', { message: msg.message });
              if (!isReady) reject(new Error(msg.message));
            }
          } catch (err) {
            this.log.error('Failed to parse worker message', { error: String(err) });
          }
        };

        const onError = (err: Error) => {
          this.log.error('Sandbox worker encountered error', { error: err.message });
          if (!isReady) reject(err);
          this.handleWorkerFailure();
        };

        const onExit = (code: number) => {
          this.log.warn('Sandbox worker exited', { code });
          if (!isReady) reject(new Error(`Worker exited before ready with code ${code}`));
          this.handleWorkerFailure();
        };

        this.worker?.on('message', onMessage);
        this.worker?.once('error', onError);
        this.worker?.once('exit', onExit);
      });
    } catch (err: unknown) {
      this.log.error('Worker spawn failure', { error: String(err) });
      this.handleWorkerFailure();
    }
  }

  private handleJobResult(msg: Extract<WorkerToMainMessage, { type: 'result' }>): void {
    if (!this.currentJob || this.currentJob.id !== msg.id) return;

    if (this.jobTimer) {
      clearTimeout(this.jobTimer);
      this.jobTimer = null;
    }

    const job = this.currentJob;
    this.currentJob = null;
    this.jobsSinceSpawn++;

    if (msg.ok) {
      job.resolve(msg.data);
    } else {
      job.reject(
        new AppError('INTERNAL', msg.error.message, {
          status: 500,
          hint: 'The sandbox planner failed to evaluate the candidate index.',
        }),
      );
    }

    // Check recycle threshold: if exceeded and no waiting jobs, trigger recycle
    if (this.jobsSinceSpawn >= this.config.SANDBOX_RECYCLE_JOBS && this.queue.length === 0) {
      this.log.info('Triggering scheduled worker recycle after job threshold', {
        jobsSinceSpawn: this.jobsSinceSpawn,
      });
      this.triggerRecycle().catch((err: unknown) => {
        this.log.error('Worker recycle failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
      return;
    }

    this.state = 'ready';
    this.processQueue();
  }

  private handleWorkerFailure(): void {
    if (this.isShuttingDown) return;

    if (this.jobTimer) {
      clearTimeout(this.jobTimer);
      this.jobTimer = null;
    }

    if (this.currentJob) {
      const job = this.currentJob;
      this.currentJob = null;
      job.reject(
        new AppError('NOT_READY', 'Sandbox worker terminated mid-execution.', {
          status: 503,
          hint: 'Worker recovered. Please retry.',
        }),
      );
    }

    const now = Date.now();
    if (now - this.lastFailureTime < 60000) {
      this.consecutiveFailures++;
    } else {
      this.consecutiveFailures = 1;
    }
    this.lastFailureTime = now;

    if (this.consecutiveFailures >= 5) {
      this.state = 'dead';
      this.log.error('Sandbox worker entered DEAD state after 5 consecutive failures.');
      return;
    }

    this.state = 'recovering';
    this.respawns++;

    // Backoff ladder: 0, 1000, 2000, 5000ms
    const delays = [0, 1000, 2000, 5000];
    const delay = delays[Math.min(this.consecutiveFailures, delays.length - 1)] || 1000;

    setTimeout(() => {
      if (!this.isShuttingDown) {
        this.spawnWorker().catch(() => {});
      }
    }, delay);
  }

  private async triggerRecycle(): Promise<void> {
    this.state = 'recovering';
    this.respawns++;
    if (this.worker) {
      await this.worker.terminate();
      this.worker = null;
    }
    await this.spawnWorker();
  }

  private processQueue(): void {
    if (this.state !== 'ready' || this.currentJob !== null || this.queue.length === 0) {
      return;
    }

    const job = this.queue.shift();
    if (!job) return;

    // Check queue wait limit
    const waitTime = Date.now() - job.enqueuedAt;
    if (waitTime > this.config.SANDBOX_QUEUE_WAIT_MS) {
      job.reject(
        new AppError(
          'BUSY',
          `Queued job timed out after ${waitTime}ms waiting for sandbox worker.`,
          {
            status: 503,
            hint: 'High sandbox load. Retry with exponential backoff.',
          },
        ),
      );
      this.processQueue();
      return;
    }

    this.state = 'busy';
    this.currentJob = job;

    // Calculate timeout: min(SANDBOX_JOB_TIMEOUT_MS, remaining deadline)
    const remainingDeadline = Math.max(1000, job.deadlineMs - waitTime);
    const timeoutMs = Math.min(this.config.SANDBOX_JOB_TIMEOUT_MS, remainingDeadline);

    this.jobTimer = setTimeout(() => {
      this.log.warn('Sandbox job timed out; terminating worker', {
        jobId: job.id,
        timeoutMs,
      });
      if (this.worker) {
        this.worker.terminate().catch(() => {});
        this.worker = null;
      }
      this.handleWorkerFailure();
    }, timeoutMs);

    const msg: MainToWorkerMessage = {
      type: 'job',
      id: job.id,
      kind: 'evaluate',
      payload: job.payload,
    };
    this.worker?.postMessage(msg);
  }
}
