import type { Outcome, PresetId } from '../../shared/contract.js';

export interface HistoryEntry {
  id: string;
  timestamp: number;
  schema: string;
  query: string;
  presetId?: PresetId;
  headline?: string;
  outcome?: Outcome;
}

const STORAGE_KEY = 'indexdoctor_history_v1';
const MAX_HISTORY_ITEMS = 10;

/**
 * Loads recent query history from local storage.
 * Gracefully recovers from corrupt storage or disabled storage in incognito.
 */
export function loadHistory(): HistoryEntry[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];

    return parsed.filter(
      (item): item is HistoryEntry =>
        typeof item === 'object' &&
        item !== null &&
        typeof item.id === 'string' &&
        typeof item.schema === 'string' &&
        typeof item.query === 'string',
    );
  } catch {
    return [];
  }
}

/**
 * Saves a new query to history and maintains bounded list length.
 */
export function saveHistoryEntry(entry: Omit<HistoryEntry, 'id' | 'timestamp'>): HistoryEntry[] {
  try {
    const existing = loadHistory();
    const newEntry: HistoryEntry = {
      ...entry,
      id: `hist_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      timestamp: Date.now(),
    };

    // Deduplicate if identical schema and query exist
    const filtered = existing.filter(
      (item) => item.schema !== entry.schema || item.query !== entry.query,
    );

    const updated = [newEntry, ...filtered].slice(0, MAX_HISTORY_ITEMS);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
    return updated;
  } catch {
    return [];
  }
}

/**
 * Clears saved query history.
 */
export function clearHistory(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Ignore storage errors in restricted contexts
  }
}
