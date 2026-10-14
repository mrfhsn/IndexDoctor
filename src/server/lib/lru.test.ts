import { describe, it, expect } from 'vitest';

import { LruCache } from './lru.js';

describe('LruCache', () => {
  it('stores and retrieves items', () => {
    const cache = new LruCache<string>({ maxEntries: 3, ttlMs: 10000 });
    cache.set('k1', 'v1');
    cache.set('k2', 'v2');

    expect(cache.get('k1')).toBe('v1');
    expect(cache.get('k2')).toBe('v2');
    expect(cache.get('k3')).toBeUndefined();
    expect(cache.size).toBe(2);
  });

  it('evicts least recently used item when maxEntries is exceeded', () => {
    const cache = new LruCache<number>({ maxEntries: 3, ttlMs: 10000 });
    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('c', 3);

    // Access 'a', making 'b' the oldest
    cache.get('a');

    // Add 'd' -> should evict 'b'
    cache.set('d', 4);

    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('a')).toBe(1);
    expect(cache.get('c')).toBe(3);
    expect(cache.get('d')).toBe(4);
    expect(cache.size).toBe(3);
  });

  it('evicts expired items', async () => {
    const cache = new LruCache<string>({ maxEntries: 3, ttlMs: 50 });
    cache.set('a', 'apple');

    expect(cache.get('a')).toBe('apple');
    await new Promise((resolve) => setTimeout(resolve, 80));

    expect(cache.get('a')).toBeUndefined();
    expect(cache.has('a')).toBe(false);
  });

  it('handles delete and clear', () => {
    const cache = new LruCache<string>({ maxEntries: 3, ttlMs: 10000 });
    cache.set('a', 'apple');
    cache.set('b', 'banana');

    expect(cache.delete('a')).toBe(true);
    expect(cache.has('a')).toBe(false);
    expect(cache.size).toBe(1);

    cache.clear();
    expect(cache.size).toBe(0);
  });
});
