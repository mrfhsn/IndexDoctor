import { describe, expect, it } from 'vitest';

import { Semaphore } from './semaphore.js';

describe('lib/semaphore', () => {
  it('allows immediate acquisition under concurrency limit', async () => {
    const sem = new Semaphore(2);
    const release1 = await sem.acquire();
    const release2 = await sem.acquire();

    expect(sem.activeCount).toBe(2);
    expect(sem.queueLength).toBe(0);

    release1();
    expect(sem.activeCount).toBe(1);

    release2();
    expect(sem.activeCount).toBe(0);
  });

  it('queues callers when limit is reached and releases them in order', async () => {
    const sem = new Semaphore(1);
    const release1 = await sem.acquire();

    let task2Started = false;
    const task2 = sem.acquire().then((release) => {
      task2Started = true;
      release();
      return true;
    });

    expect(sem.activeCount).toBe(1);
    expect(sem.queueLength).toBe(1);
    expect(task2Started).toBe(false);

    release1();
    await task2;

    expect(task2Started).toBe(true);
    expect(sem.activeCount).toBe(0);
    expect(sem.queueLength).toBe(0);
  });
});
