import React, { useEffect, useReducer, useRef, useState } from 'react';

import type { HealthResponse } from '../shared/contract.js';
import type { Preset } from '../shared/presets/presets.js';
import { diagnose, fetchHealth, ApiClientError } from './api.js';
import { ActionBar } from './components/ActionBar.js';
import { AssumptionsFooter } from './components/AssumptionsFooter.js';
import { ErrorState } from './components/ErrorState.js';
import { EsrAnalysis } from './components/EsrAnalysis.js';
import { Header } from './components/Header.js';
import { MigrationOutput } from './components/MigrationOutput.js';
import { PlanDiffTree } from './components/PlanDiffTree.js';
import { PresetBar } from './components/PresetBar.js';
import { ResultHero } from './components/ResultHero.js';
import { SqlEditors } from './components/SqlEditors.js';
import { loadHistory, saveHistoryEntry } from './state/history.js';
import { appReducer, initialState } from './state/reducer.js';

export function App(): React.JSX.Element {
  const [state, dispatch] = useReducer(appReducer, initialState);
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Load query history and check health on mount
  useEffect(() => {
    dispatch({ type: 'SET_HISTORY', payload: loadHistory() });

    const checkHealth = async () => {
      try {
        const res = await fetchHealth();
        setHealth(res);
      } catch {
        // Standby
      }
    };

    void checkHealth();
    const healthInterval = setInterval(() => void checkHealth(), 30000);
    return () => clearInterval(healthInterval);
  }, []);

  const clearTimer = () => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  };

  const handleRunDiagnose = async (
    customSchema?: string,
    customQuery?: string,
    presetId?: Preset['id'],
  ) => {
    const targetSchema = customSchema ?? state.schema;
    const targetQuery = customQuery ?? state.query;

    if (!targetSchema.trim() || !targetQuery.trim()) {
      dispatch({
        type: 'DIAGNOSE_ERROR',
        payload: {
          code: 'MISSING_INPUT',
          message: 'Both schema DDL and query SQL are required to run diagnosis.',
          hint: 'Select one of the golden presets above or paste your DDL and query.',
        },
      });
      return;
    }

    // Cancel any in-flight request
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    const controller = new AbortController();
    abortControllerRef.current = controller;

    dispatch({ type: 'START_DIAGNOSE' });
    clearTimer();
    timerRef.current = setInterval(() => {
      dispatch({ type: 'TICK_ELAPSED' });
    }, 1000);

    try {
      const response = await diagnose(
        {
          schema: targetSchema,
          query: targetQuery,
          presetId: presetId ?? state.selectedPreset ?? undefined,
        },
        controller.signal,
      );

      clearTimer();
      dispatch({ type: 'DIAGNOSE_SUCCESS', payload: response });

      // Save to local history
      const updatedHistory = saveHistoryEntry({
        schema: targetSchema,
        query: targetQuery,
        presetId: presetId ?? state.selectedPreset ?? undefined,
        headline: response.recommendation?.headline,
        outcome: response.outcome,
      });
      dispatch({ type: 'SET_HISTORY', payload: updatedHistory });
    } catch (err: unknown) {
      clearTimer();

      if (err instanceof ApiClientError) {
        if (err.code === 'ABORTED') {
          // User cancelled; return to idle without banner
          dispatch({ type: 'RESET' });
          return;
        }

        dispatch({
          type: 'DIAGNOSE_ERROR',
          payload: {
            code: err.code,
            message: err.message,
            hint: err.hint,
            requestId: err.requestId,
            retryAfterSec: err.retryAfterSec,
          },
        });
      } else {
        dispatch({
          type: 'DIAGNOSE_ERROR',
          payload: {
            code: 'UNKNOWN_ERROR',
            message: 'An unexpected client error occurred while processing diagnosis.',
            hint: err instanceof Error ? err.message : String(err),
          },
        });
      }
    }
  };

  const handleCancel = () => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
    clearTimer();
    dispatch({ type: 'RESET' });
  };

  const handleSelectPreset = (preset: Preset) => {
    dispatch({
      type: 'SELECT_PRESET',
      payload: {
        presetId: preset.id,
        schema: preset.schema,
        query: preset.query,
      },
    });

    // 1-Click execution per acceptance criteria
    void handleRunDiagnose(preset.schema, preset.query, preset.id);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      if (state.status !== 'running') {
        void handleRunDiagnose();
      }
    }
  };

  const hasInput = Boolean(state.schema.trim() && state.query.trim());

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col font-sans selection:bg-emerald-500/30 selection:text-emerald-200">
      <Header health={health} />

      <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-8">
        {/* Hero Tagline */}
        <div className="text-center max-w-3xl mx-auto space-y-2">
          <h1 className="text-3xl sm:text-4xl font-extrabold tracking-tight text-slate-100">
            Real Postgres Planner Diffs. <span className="text-emerald-400">Zero Login.</span>
          </h1>
          <p className="text-sm sm:text-base text-slate-400 leading-relaxed">
            Validate composite indexes with the official Postgres planner running in WASM. Compare
            before and after plan trees with copy-ready DDL and ORM definitions.
          </p>
        </div>

        {/* 1-Click Golden Presets */}
        <PresetBar
          selectedPreset={state.selectedPreset}
          disabled={state.status === 'running'}
          onSelect={handleSelectPreset}
        />

        {/* Dual SQL Editors */}
        <div className="space-y-4">
          <SqlEditors
            schema={state.schema}
            query={state.query}
            disabled={state.status === 'running'}
            onSchemaChange={(val) => dispatch({ type: 'SET_SCHEMA', payload: val })}
            onQueryChange={(val) => dispatch({ type: 'SET_QUERY', payload: val })}
            onKeyDown={handleKeyDown}
          />

          <ActionBar
            status={state.status}
            elapsedSeconds={state.elapsedSeconds}
            hasInput={hasInput}
            onRun={() => void handleRunDiagnose()}
            onCancel={handleCancel}
            onReset={() => dispatch({ type: 'RESET' })}
          />
        </div>

        {/* Error Notification */}
        {state.error && <ErrorState error={state.error} onRetry={() => void handleRunDiagnose()} />}

        {/* Diagnosis Results Section */}
        {state.result && (
          <div className="space-y-6 pt-4 border-t border-slate-800 animate-in fade-in duration-300">
            {/* Vital Signs Hero Card */}
            <ResultHero result={state.result} />

            {/* Execution Plan Comparison Diff */}
            <PlanDiffTree
              before={state.result.plans.before}
              after={state.result.plans.after}
              showRawJson={state.showRawJson}
              onToggleRawJson={() => dispatch({ type: 'TOGGLE_RAW_JSON' })}
            />

            {/* ESR Rule Breakdown */}
            {state.result.recommendation && state.result.recommendation.esr.length > 0 && (
              <EsrAnalysis recommendation={state.result.recommendation} />
            )}

            {/* Migration Outputs (Postgres, Drizzle, Prisma) */}
            {state.result.recommendation && (
              <MigrationOutput
                recommendation={state.result.recommendation}
                activeTab={state.activeMigrationTab}
                onTabChange={(tab) => dispatch({ type: 'SET_MIGRATION_TAB', payload: tab })}
              />
            )}
          </div>
        )}

        {/* Assumptions and Honesty Methodology */}
        <AssumptionsFooter assumptions={state.result?.assumptions ?? null} />
      </main>
    </div>
  );
}
