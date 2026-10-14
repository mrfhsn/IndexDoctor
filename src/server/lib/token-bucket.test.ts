import { describe, it, expect } from 'vitest';

import { TokenBucketRateLimiter, extractClientIp } from './token-bucket.js';

describe('extractClientIp', () => {
  it('extracts rightmost IP from X-Forwarded-For (trusted proxy hop = 1)', () => {
    const headers = {
      'x-forwarded-for': '203.0.113.10, 198.51.100.5, 192.0.2.1',
    };
    expect(extractClientIp(headers, 1)).toBe('192.0.2.1');
  });

  it('prevents client spoofing by ignoring leftmost entries', () => {
    // Client sends spoofed '1.2.3.4', Cloud Run appends client IP '35.192.10.5'
    const headers = {
      'x-forwarded-for': '1.2.3.4, 35.192.10.5',
    };
    expect(extractClientIp(headers, 1)).toBe('35.192.10.5');
  });

  it('handles single IP', () => {
    const headers = {
      'x-forwarded-for': '35.192.10.5',
    };
    expect(extractClientIp(headers, 1)).toBe('35.192.10.5');
  });

  it('handles web standard Headers object', () => {
    const headers = new Headers();
    headers.set('x-forwarded-for', '10.0.0.1, 10.0.0.2');
    expect(extractClientIp(headers, 1)).toBe('10.0.0.2');
  });

  it('falls back to 127.0.0.1 when header is missing or empty', () => {
    expect(extractClientIp({})).toBe('127.0.0.1');
    expect(extractClientIp({ 'x-forwarded-for': '' })).toBe('127.0.0.1');
  });
});

describe('TokenBucketRateLimiter', () => {
  it('allows requests within burst limit', () => {
    const limiter = new TokenBucketRateLimiter({ ratePerMin: 60, burst: 3 });

    expect(limiter.consume('1.1.1.1').allowed).toBe(true);
    expect(limiter.consume('1.1.1.1').allowed).toBe(true);
    expect(limiter.consume('1.1.1.1').allowed).toBe(true);

    const fourth = limiter.consume('1.1.1.1');
    expect(fourth.allowed).toBe(false);
    expect(fourth.retryAfterSec).toBeGreaterThanOrEqual(1);
  });

  it('tracks different IPs separately', () => {
    const limiter = new TokenBucketRateLimiter({ ratePerMin: 60, burst: 1 });

    expect(limiter.consume('ip-1').allowed).toBe(true);
    expect(limiter.consume('ip-1').allowed).toBe(false);

    expect(limiter.consume('ip-2').allowed).toBe(true);
    expect(limiter.consume('ip-2').allowed).toBe(false);
  });

  it('refills tokens over time', async () => {
    // 60000 per minute = 1 token per ms
    const limiter = new TokenBucketRateLimiter({ ratePerMin: 60000, burst: 1 });

    expect(limiter.consume('ip-fast').allowed).toBe(true);
    expect(limiter.consume('ip-fast').allowed).toBe(false);

    // Wait 5 ms to refill
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(limiter.consume('ip-fast').allowed).toBe(true);
  });
});
