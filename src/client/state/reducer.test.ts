import { describe, it, expect } from 'vitest';

import type { DiagnoseResponse } from '../../shared/contract.js';
import { appReducer, initialState, type AppState } from './reducer.js';

const mockDiagnoseResponse: DiagnoseResponse = {
  requestId: 'req-mock-1',
  cached: false,
  outcome: 'improved',
  verification: {
    status: 'verified',
    indexUsed: true,
    costBefore: 500,
    costAfter: 10,
    costReductionPercent: 98,
    costRatio: 50,
    severity: 'CRITICAL',
  },
  recommendation: null,
  plans: { before: null, after: null },
  source: { proposedBy: 'deterministic', model: null, attempts: [] },
  alternative: null,
  assumptions: {
    assumedRowCount: 500000,
    seededRows: 20000,
    plannerSettings: 'postgres-defaults',
    tablesScaledEqually: true,
  },
  notices: [],
  timingsMs: { gate: 1, propose: 1, evaluate: 1, total: 3 },
};

describe('Client State Reducer (state/reducer.ts)', () => {
  it('handles SET_SCHEMA and resets selectedPreset', () => {
    const start: AppState = { ...initialState, selectedPreset: 'orders-composite' };
    const next = appReducer(start, {
      type: 'SET_SCHEMA',
      payload: 'CREATE TABLE t (id int);',
    });

    expect(next.schema).toBe('CREATE TABLE t (id int);');
    expect(next.selectedPreset).toBeNull();
  });

  it('handles SET_QUERY and resets selectedPreset', () => {
    const start: AppState = { ...initialState, selectedPreset: 'orders-composite' };
    const next = appReducer(start, {
      type: 'SET_QUERY',
      payload: 'SELECT * FROM t;',
    });

    expect(next.query).toBe('SELECT * FROM t;');
    expect(next.selectedPreset).toBeNull();
  });

  it('handles SELECT_PRESET filling schema, query, and setting presetId', () => {
    const next = appReducer(initialState, {
      type: 'SELECT_PRESET',
      payload: {
        presetId: 'orders-composite',
        schema: 'CREATE TABLE orders (id int);',
        query: 'SELECT * FROM orders;',
      },
    });

    expect(next.selectedPreset).toBe('orders-composite');
    expect(next.schema).toBe('CREATE TABLE orders (id int);');
    expect(next.query).toBe('SELECT * FROM orders;');
    expect(next.error).toBeNull();
  });

  it('handles START_DIAGNOSE resetting elapsed time and setting running state', () => {
    const start: AppState = {
      ...initialState,
      status: 'error',
      elapsedSeconds: 15,
      error: { code: 'BAD', message: 'Fail' },
    };

    const next = appReducer(start, { type: 'START_DIAGNOSE' });
    expect(next.status).toBe('running');
    expect(next.elapsedSeconds).toBe(0);
    expect(next.error).toBeNull();
  });

  it('handles TICK_ELAPSED incrementing elapsed seconds', () => {
    const start: AppState = { ...initialState, elapsedSeconds: 2 };
    const next = appReducer(start, { type: 'TICK_ELAPSED' });
    expect(next.elapsedSeconds).toBe(3);
  });

  it('handles DIAGNOSE_SUCCESS updating result and state to success', () => {
    const next = appReducer(initialState, {
      type: 'DIAGNOSE_SUCCESS',
      payload: mockDiagnoseResponse,
    });

    expect(next.status).toBe('success');
    expect(next.result).toBe(mockDiagnoseResponse);
    expect(next.error).toBeNull();
  });

  it('handles DIAGNOSE_ERROR setting error and clearing result', () => {
    const start: AppState = {
      ...initialState,
      result: mockDiagnoseResponse,
    };

    const next = appReducer(start, {
      type: 'DIAGNOSE_ERROR',
      payload: {
        code: 'RATE_LIMITED',
        message: 'Too many requests',
        retryAfterSec: 30,
      },
    });

    expect(next.status).toBe('error');
    expect(next.error?.code).toBe('RATE_LIMITED');
    expect(next.error?.retryAfterSec).toBe(30);
    expect(next.result).toBeNull();
  });

  it('handles UI toggles and tabs', () => {
    let state = appReducer(initialState, {
      type: 'SET_MIGRATION_TAB',
      payload: 'drizzle',
    });
    expect(state.activeMigrationTab).toBe('drizzle');

    state = appReducer(state, { type: 'TOGGLE_RAW_JSON' });
    expect(state.showRawJson).toBe(true);

    state = appReducer(state, { type: 'SET_COPIED', payload: 'postgres-sql' });
    expect(state.copiedField).toBe('postgres-sql');
  });

  it('handles RESET maintaining history', () => {
    const start: AppState = {
      ...initialState,
      status: 'success',
      schema: 'some schema',
      history: [
        {
          id: '1',
          timestamp: 123,
          schema: 's',
          query: 'q',
        },
      ],
    };

    const next = appReducer(start, { type: 'RESET' });
    expect(next.status).toBe('idle');
    expect(next.schema).toBe('');
    expect(next.history).toHaveLength(1);
  });
});
