import { describe, it, expect, vi } from 'vitest';

import { SingleFlight } from './single-flight.js';

describe('SingleFlight', () => {
  it('runs underlying function once for concurrent calls with the same key', async () => {
    const group = new SingleFlight<string>();
    const fn = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      return 'computed-value';
    });

    const calls = Array.from({ length: 20 }, () => group.do('same-key', fn));
    const results = await Promise.all(calls);

    expect(fn).toHaveBeenCalledTimes(1);
    expect(results).toHaveLength(20);
    expect(results[0]?.result).toBe('computed-value');
    expect(results[0]?.shared).toBe(false);

    // Other 19 calls should be marked as shared
    const sharedCount = results.filter((r) => r.shared).length;
    expect(sharedCount).toBe(19);

    expect(group.inFlightCount).toBe(0);
  });

  it('runs separate executions for different keys', async () => {
    const group = new SingleFlight<string>();
    const fn = vi.fn(async (key: string) => `result-${key}`);

    const [resA, resB] = await Promise.all([
      group.do('key-a', () => fn('key-a')),
      group.do('key-b', () => fn('key-b')),
    ]);

    expect(fn).toHaveBeenCalledTimes(2);
    expect(resA.result).toBe('result-key-a');
    expect(resB.result).toBe('result-key-b');
    expect(resA.shared).toBe(false);
    expect(resB.shared).toBe(false);
  });

  it('propagates rejection to all concurrent callers and clears in-flight state', async () => {
    const group = new SingleFlight<string>();
    const fn = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      throw new Error('test-failure');
    });

    const calls = Array.from({ length: 5 }, () => group.do('fail-key', fn));
    const results = await Promise.allSettled(calls);

    expect(fn).toHaveBeenCalledTimes(1);
    for (const res of results) {
      expect(res.status).toBe('rejected');
      if (res.status === 'rejected' && res.reason instanceof Error) {
        expect(res.reason.message).toBe('test-failure');
      }
    }

    expect(group.inFlightCount).toBe(0);

    // Subsequent call should run again
    const subsequent = await group.do('fail-key', async () => 'recovered');
    expect(subsequent.result).toBe('recovered');
    expect(subsequent.shared).toBe(false);
  });
});
