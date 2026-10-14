import { describe, expect, it } from 'vitest';

import { ModelCircuitBreaker } from './breaker.js';

describe('llm/breaker', () => {
  it('starts in closed state with 0 failures', () => {
    const cb = new ModelCircuitBreaker();
    expect(cb.isOpen('model-1')).toBe(false);
    expect(cb.getStatus('model-1')).toEqual({
      state: 'closed',
      openUntil: null,
      consecutiveFailures: 0,
    });
  });

  it('opens breaker for 10 minutes on 401/403 auth errors', () => {
    const cb = new ModelCircuitBreaker();
    const t0 = 1000000;

    cb.recordFailure('model-1', { status: 401 }, t0);
    expect(cb.isOpen('model-1', t0)).toBe(true);
    expect(cb.isOpen('model-1', t0 + 9 * 60 * 1000)).toBe(true);
    expect(cb.isOpen('model-1', t0 + 10 * 60 * 1000 + 1)).toBe(false);

    cb.recordFailure('model-2', { status: 403 }, t0);
    expect(cb.isOpen('model-2', t0)).toBe(true);
  });

  it('opens breaker for 30 minutes on 404 model not found', () => {
    const cb = new ModelCircuitBreaker();
    const t0 = 1000000;

    cb.recordFailure('model-1', { status: 404 }, t0);
    expect(cb.isOpen('model-1', t0)).toBe(true);
    expect(cb.isOpen('model-1', t0 + 29 * 60 * 1000)).toBe(true);
    expect(cb.isOpen('model-1', t0 + 30 * 60 * 1000 + 1)).toBe(false);
  });

  it('opens breaker for 60 seconds on 429 rate limit (or retry-after)', () => {
    const cb = new ModelCircuitBreaker();
    const t0 = 1000000;

    // Default 60s
    cb.recordFailure('model-1', { status: 429 }, t0);
    expect(cb.isOpen('model-1', t0)).toBe(true);
    expect(cb.isOpen('model-1', t0 + 59 * 1000)).toBe(true);
    expect(cb.isOpen('model-1', t0 + 60 * 1000 + 1)).toBe(false);

    // Custom retry-after
    cb.recordFailure('model-2', { status: 429, retryAfterMs: 15000 }, t0);
    expect(cb.isOpen('model-2', t0 + 14000)).toBe(true);
    expect(cb.isOpen('model-2', t0 + 15001)).toBe(false);
  });

  it('does NOT open breaker on 400 (handled by downgrade ladder)', () => {
    const cb = new ModelCircuitBreaker();
    const t0 = 1000000;

    cb.recordFailure('model-1', { status: 400 }, t0);
    expect(cb.isOpen('model-1', t0)).toBe(false);
    expect(cb.getStatus('model-1', t0).consecutiveFailures).toBe(0);
  });

  it('requires 3 consecutive 5xx/network/timeout errors before opening', () => {
    const cb = new ModelCircuitBreaker();
    const t0 = 1000000;

    cb.recordFailure('model-1', { status: 500 }, t0);
    expect(cb.isOpen('model-1', t0)).toBe(false);
    expect(cb.getStatus('model-1', t0).consecutiveFailures).toBe(1);

    cb.recordFailure('model-1', { status: 503 }, t0);
    expect(cb.isOpen('model-1', t0)).toBe(false);
    expect(cb.getStatus('model-1', t0).consecutiveFailures).toBe(2);

    cb.recordFailure('model-1', { message: 'fetch failed' }, t0);
    expect(cb.isOpen('model-1', t0)).toBe(true);
    expect(cb.getStatus('model-1', t0).consecutiveFailures).toBe(3);

    // Cooldown is 30s
    expect(cb.isOpen('model-1', t0 + 29000)).toBe(true);
    expect(cb.isOpen('model-1', t0 + 30001)).toBe(false);
  });

  it('resets consecutive failures upon success', () => {
    const cb = new ModelCircuitBreaker();
    const t0 = 1000000;

    cb.recordFailure('model-1', { status: 500 }, t0);
    cb.recordFailure('model-1', { status: 500 }, t0);
    expect(cb.getStatus('model-1', t0).consecutiveFailures).toBe(2);

    cb.recordSuccess('model-1');
    expect(cb.getStatus('model-1', t0).consecutiveFailures).toBe(0);
    expect(cb.isOpen('model-1', t0)).toBe(false);
  });
});
