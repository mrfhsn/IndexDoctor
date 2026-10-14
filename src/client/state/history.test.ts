import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { loadHistory, saveHistoryEntry, clearHistory } from './history.js';

class MemoryStorage implements Storage {
  private store = new Map<string, string>();
  public get length(): number {
    return this.store.size;
  }
  public clear(): void {
    this.store.clear();
  }
  public getItem(key: string): string | null {
    return this.store.get(key) ?? null;
  }
  public key(index: number): string | null {
    return Array.from(this.store.keys())[index] ?? null;
  }
  public removeItem(key: string): void {
    this.store.delete(key);
  }
  public setItem(key: string, value: string): void {
    this.store.set(key, value);
  }
}

describe('Client History (state/history.ts)', () => {
  const originalStorage = globalThis.localStorage;

  afterEach(() => {
    Object.defineProperty(globalThis, 'localStorage', {
      value: originalStorage,
      writable: true,
      configurable: true,
    });
  });

  beforeEach(() => {
    Object.defineProperty(globalThis, 'localStorage', {
      value: new MemoryStorage(),
      writable: true,
      configurable: true,
    });
    clearHistory();
  });

  it('loads empty list when storage is empty', () => {
    expect(loadHistory()).toEqual([]);
  });

  it('saves entry and retrieves it', () => {
    const saved = saveHistoryEntry({
      schema: 'CREATE TABLE orders (id int);',
      query: 'SELECT * FROM orders;',
      presetId: 'orders-composite',
      headline: 'Index orders',
      outcome: 'improved',
    });

    expect(saved).toHaveLength(1);
    expect(saved[0]?.schema).toBe('CREATE TABLE orders (id int);');
    expect(saved[0]?.presetId).toBe('orders-composite');

    const loaded = loadHistory();
    expect(loaded).toHaveLength(1);
    expect(loaded[0]?.query).toBe('SELECT * FROM orders;');
  });

  it('deduplicates identical queries and moves latest to the front', () => {
    saveHistoryEntry({
      schema: 'CREATE TABLE t1 (id int);',
      query: 'SELECT 1;',
    });

    saveHistoryEntry({
      schema: 'CREATE TABLE t2 (id int);',
      query: 'SELECT 2;',
    });

    // Re-save t1 query
    const updated = saveHistoryEntry({
      schema: 'CREATE TABLE t1 (id int);',
      query: 'SELECT 1;',
      headline: 'Updated headline',
    });

    expect(updated).toHaveLength(2);
    expect(updated[0]?.schema).toBe('CREATE TABLE t1 (id int);');
    expect(updated[0]?.headline).toBe('Updated headline');
    expect(updated[1]?.schema).toBe('CREATE TABLE t2 (id int);');
  });

  it('bounds history to max 10 items', () => {
    for (let i = 0; i < 15; i++) {
      saveHistoryEntry({
        schema: `CREATE TABLE t_${i} (id int);`,
        query: `SELECT * FROM t_${i};`,
      });
    }

    const loaded = loadHistory();
    expect(loaded).toHaveLength(10);
    // Most recent is t_14
    expect(loaded[0]?.schema).toBe('CREATE TABLE t_14 (id int);');
  });

  it('clears history completely', () => {
    saveHistoryEntry({
      schema: 'CREATE TABLE t (id int);',
      query: 'SELECT * FROM t;',
    });
    expect(loadHistory()).toHaveLength(1);

    clearHistory();
    expect(loadHistory()).toHaveLength(0);
  });
});
