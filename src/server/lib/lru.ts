export interface LruCacheOptions {
  maxEntries: number;
  ttlMs: number;
}

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

/**
 * In-memory Least-Recently-Used (LRU) cache with time-to-live (TTL).
 * Uses a JavaScript Map to maintain MRU/LRU access ordering in O(1) operations.
 */
export class LruCache<T> {
  private readonly map = new Map<string, CacheEntry<T>>();
  private readonly maxEntries: number;
  private readonly ttlMs: number;

  public constructor(options: LruCacheOptions) {
    this.maxEntries = Math.max(1, options.maxEntries);
    this.ttlMs = Math.max(0, options.ttlMs);
  }

  public get(key: string): T | undefined {
    const entry = this.map.get(key);
    if (!entry) {
      return undefined;
    }

    if (Date.now() > entry.expiresAt) {
      this.map.delete(key);
      return undefined;
    }

    // Refresh LRU position by re-inserting
    this.map.delete(key);
    this.map.set(key, entry);
    return entry.value;
  }

  public set(key: string, value: T): void {
    if (this.map.has(key)) {
      this.map.delete(key);
    } else if (this.map.size >= this.maxEntries) {
      // Evict oldest (first key in map iterator)
      const oldestKey = this.map.keys().next().value;
      if (oldestKey !== undefined) {
        this.map.delete(oldestKey);
      }
    }

    this.map.set(key, {
      value,
      expiresAt: Date.now() + this.ttlMs,
    });
  }

  public has(key: string): boolean {
    return this.get(key) !== undefined;
  }

  public delete(key: string): boolean {
    return this.map.delete(key);
  }

  public clear(): void {
    this.map.clear();
  }

  public get size(): number {
    return this.map.size;
  }
}
