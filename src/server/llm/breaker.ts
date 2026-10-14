import { logger } from '../logger.js';

type BreakerState = 'closed' | 'open';

export type ModelBreakerStatus = {
  state: BreakerState;
  openUntil: number | null;
  consecutiveFailures: number;
};

export type FailureDetails = {
  status?: number;
  retryAfterMs?: number;
  message?: string;
};

const TEN_MINUTES_MS = 10 * 60 * 1000;
const THIRTY_MINUTES_MS = 30 * 60 * 1000;
const SIXTY_SECONDS_MS = 60 * 1000;
const DEFAULT_COOLDOWN_MS = 30 * 1000;
const CONSECUTIVE_FAILURES_THRESHOLD = 3;

/**
 * Circuit breaker per model in the LLM chain.
 * Enforces architecture.md §11.3 cooldowns and failure policies.
 */
export class ModelCircuitBreaker {
  private readonly breakers = new Map<
    string,
    {
      consecutiveFailures: number;
      openUntil: number | null;
    }
  >();

  private getEntry(modelId: string) {
    let entry = this.breakers.get(modelId);
    if (!entry) {
      entry = { consecutiveFailures: 0, openUntil: null };
      this.breakers.set(modelId, entry);
    }
    return entry;
  }

  /**
   * Returns true if the circuit breaker for this model is currently open.
   */
  public isOpen(modelId: string, now = Date.now()): boolean {
    const entry = this.getEntry(modelId);
    if (entry.openUntil === null) {
      return false;
    }

    if (now >= entry.openUntil) {
      // Cooldown expired; return to half-open / closed
      entry.openUntil = null;
      return false;
    }

    return true;
  }

  /**
   * Records a successful call for the model, resetting consecutive failure counts.
   */
  public recordSuccess(modelId: string): void {
    const entry = this.getEntry(modelId);
    entry.consecutiveFailures = 0;
    entry.openUntil = null;
  }

  /**
   * Records a failure for the model and updates breaker state based on the error code.
   */
  public recordFailure(modelId: string, details: FailureDetails, now = Date.now()): void {
    const entry = this.getEntry(modelId);
    const status = details.status;

    // HTTP 400 is handled by capability downgrade ladder, not counted toward breaker
    if (status === 400) {
      return;
    }

    // 401 / 403: auth failure -> open 10 min
    if (status === 401 || status === 403) {
      entry.openUntil = now + TEN_MINUTES_MS;
      logger.error('Circuit breaker opened for auth error', {
        modelId,
        status,
        openMinutes: 10,
      });
      return;
    }

    // 404: model not found / retired -> open 30 min
    if (status === 404) {
      entry.openUntil = now + THIRTY_MINUTES_MS;
      logger.error('Circuit breaker opened: model not found', {
        modelId,
        status,
        openMinutes: 30,
      });
      return;
    }

    // 429: rate limited -> open for server retry-after or 60s
    if (status === 429) {
      const cooldown = details.retryAfterMs ?? SIXTY_SECONDS_MS;
      entry.openUntil = now + cooldown;
      logger.warn('Circuit breaker opened for rate limit', {
        modelId,
        status,
        cooldownMs: cooldown,
      });
      return;
    }

    // 5xx / timeout / network error: count consecutive failures
    entry.consecutiveFailures += 1;
    if (entry.consecutiveFailures >= CONSECUTIVE_FAILURES_THRESHOLD) {
      entry.openUntil = now + DEFAULT_COOLDOWN_MS;
      logger.warn('Circuit breaker opened after consecutive failures', {
        modelId,
        consecutiveFailures: entry.consecutiveFailures,
        cooldownMs: DEFAULT_COOLDOWN_MS,
      });
    }
  }

  /**
   * Returns current status summary for health endpoint and inspection.
   */
  public getStatus(modelId: string, now = Date.now()): ModelBreakerStatus {
    const open = this.isOpen(modelId, now);
    const entry = this.getEntry(modelId);
    return {
      state: open ? 'open' : 'closed',
      openUntil: entry.openUntil,
      consecutiveFailures: entry.consecutiveFailures,
    };
  }

  /**
   * Resets all circuit breaker states (primarily for testing).
   */
  public reset(): void {
    this.breakers.clear();
  }
}

export const circuitBreaker = new ModelCircuitBreaker();
