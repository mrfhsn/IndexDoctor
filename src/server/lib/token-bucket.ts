export interface TokenBucketOptions {
  ratePerMin: number;
  burst: number;
}

export interface RateLimitResult {
  allowed: boolean;
  retryAfterSec?: number;
}

interface Bucket {
  tokens: number;
  lastRefill: number;
}

/**
 * Extracts the real client IP from incoming headers.
 * In accordance with architecture.md §5 and §7, extracts the rightmost
 * entry from X-Forwarded-For appended by the trusted Cloud Run front-end proxy.
 */
export function extractClientIp(
  headers: Headers | Record<string, string | string[] | undefined>,
  trustedHops = 1,
): string {
  let xffValue: string | undefined;

  if (headers instanceof Headers) {
    xffValue = headers.get('x-forwarded-for') ?? undefined;
  } else {
    const raw = headers['x-forwarded-for'];
    if (Array.isArray(raw)) {
      xffValue = raw.join(', ');
    } else if (typeof raw === 'string') {
      xffValue = raw;
    }
  }

  if (!xffValue) {
    return '127.0.0.1';
  }

  const parts = xffValue
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);

  if (parts.length === 0) {
    return '127.0.0.1';
  }

  const index = Math.max(0, parts.length - Math.max(1, trustedHops));
  return parts[index] ?? '127.0.0.1';
}

/**
 * Token bucket rate limiter with burst capability and per-IP state tracking.
 */
export class TokenBucketRateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private readonly ratePerMin: number;
  private readonly burst: number;
  private readonly tokensPerMs: number;
  private lastPurge = Date.now();

  public constructor(options: TokenBucketOptions) {
    this.ratePerMin = Math.max(1, options.ratePerMin);
    this.burst = Math.max(1, options.burst);
    this.tokensPerMs = this.ratePerMin / 60000;
  }

  public consume(ip: string): RateLimitResult {
    const now = Date.now();
    this.maybePurge(now);

    let bucket = this.buckets.get(ip);
    if (!bucket) {
      bucket = {
        tokens: this.burst,
        lastRefill: now,
      };
      this.buckets.set(ip, bucket);
    } else {
      const elapsed = Math.max(0, now - bucket.lastRefill);
      bucket.tokens = Math.min(this.burst, bucket.tokens + elapsed * this.tokensPerMs);
      bucket.lastRefill = now;
    }

    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return { allowed: true };
    }

    const needed = 1 - bucket.tokens;
    const waitMs = Math.ceil(needed / this.tokensPerMs);
    const retryAfterSec = Math.max(1, Math.ceil(waitMs / 1000));

    return {
      allowed: false,
      retryAfterSec,
    };
  }

  public reset(): void {
    this.buckets.clear();
  }

  public get activeBucketsCount(): number {
    return this.buckets.size;
  }

  private maybePurge(now: number): void {
    // Purge idle full buckets every 5 minutes if bucket count grows
    if (now - this.lastPurge < 300000 && this.buckets.size < 500) {
      return;
    }

    this.lastPurge = now;
    const maxIdleMs = 60000;

    for (const [ip, b] of this.buckets.entries()) {
      if (b.tokens >= this.burst && now - b.lastRefill > maxIdleMs) {
        this.buckets.delete(ip);
      }
    }
  }
}
