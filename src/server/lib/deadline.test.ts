import { describe, it, expect } from 'vitest';

import { createDeadline } from './deadline.js';

describe('Deadline Manager', () => {
  it('initializes with correct budget and remaining time', () => {
    const d = createDeadline(5000);
    expect(d.budgetMs).toBe(5000);
    expect(d.remainingMs).toBeGreaterThan(4900);
    expect(d.isExpired).toBe(false);
    expect(d.signal.aborted).toBe(false);
    expect(() => d.throwIfExpired()).not.toThrow();
    d.dispose();
  });

  it('expires immediately if budget is 0', () => {
    const d = createDeadline(0);
    expect(d.remainingMs).toBe(0);
    expect(d.isExpired).toBe(true);
    expect(d.signal.aborted).toBe(true);
    expect(() => d.throwIfExpired('gate')).toThrow(/deadline exceeded during gate/);
    d.dispose();
  });

  it('creates child deadline bounded by parent', () => {
    const parent = createDeadline(200);
    const child = parent.child(1000);
    // Child requested 1000ms, but parent only has ~200ms left
    expect(child.remainingMs).toBeLessThanOrEqual(200);
    expect(child.remainingMs).toBeGreaterThan(100);
    parent.dispose();
    child.dispose();
  });

  it('aborts signal on expiry', async () => {
    const d = createDeadline(50);
    expect(d.signal.aborted).toBe(false);

    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(d.isExpired).toBe(true);
    expect(d.signal.aborted).toBe(true);
    d.dispose();
  });
});
