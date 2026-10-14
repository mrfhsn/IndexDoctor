import {
  TrendingDown,
  ArrowRight,
  Cpu,
  Clock,
  Sparkles,
  AlertTriangle,
  CheckCircle2,
  HelpCircle,
} from 'lucide-react';
import React from 'react';

import type { DiagnoseResponse, Severity } from '../../shared/contract.js';

interface ResultHeroProps {
  result: DiagnoseResponse;
}

const SEVERITY_CONFIG: Record<
  Severity,
  { label: string; bg: string; border: string; text: string }
> = {
  CRITICAL: {
    label: 'Critical Bottleneck',
    bg: 'bg-rose-950/60',
    border: 'border-rose-700/60',
    text: 'text-rose-300',
  },
  HIGH: {
    label: 'High Improvement',
    bg: 'bg-orange-950/60',
    border: 'border-orange-700/60',
    text: 'text-orange-300',
  },
  MODERATE: {
    label: 'Moderate Gain',
    bg: 'bg-amber-950/60',
    border: 'border-amber-700/60',
    text: 'text-amber-300',
  },
  OPTIMAL: {
    label: 'Optimal / No Index Needed',
    bg: 'bg-emerald-950/60',
    border: 'border-emerald-700/60',
    text: 'text-emerald-300',
  },
};

export function ResultHero({ result }: ResultHeroProps): React.JSX.Element {
  const rec = result.recommendation;
  const verification = result.verification;

  const severityConfig =
    verification.status === 'verified'
      ? SEVERITY_CONFIG[verification.severity]
      : SEVERITY_CONFIG.MODERATE;

  return (
    <div className="space-y-4">
      {/* Hero Header & Headline */}
      <div className="p-5 rounded-2xl bg-slate-900 border border-slate-800 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <span
              className={`text-xs font-semibold px-2.5 py-1 rounded-full border ${severityConfig.bg} ${severityConfig.border} ${severityConfig.text}`}
            >
              {severityConfig.label}
            </span>

            {result.cached && (
              <span className="text-xs font-mono px-2 py-0.5 rounded-full bg-purple-950/80 border border-purple-800 text-purple-300">
                Cache Hit
              </span>
            )}

            <span className="text-xs text-slate-400 font-mono">
              req: {result.requestId.slice(0, 8)}
            </span>
          </div>

          <div className="flex items-center gap-2 text-xs text-slate-400 font-mono">
            <Clock className="w-3.5 h-3.5 text-slate-400" />
            <span>{result.timingsMs.total} ms total</span>
          </div>
        </div>

        {rec ? (
          <div>
            <h2 className="text-xl font-bold text-slate-100 tracking-tight">{rec.headline}</h2>
            <p className="text-sm text-slate-400 mt-1 leading-relaxed">{rec.explanation}</p>
          </div>
        ) : (
          <div>
            <h2 className="text-xl font-bold text-slate-100 tracking-tight">
              {result.outcome === 'not_improved'
                ? 'No beneficial index identified for this query'
                : 'Query diagnosis complete'}
            </h2>
            <p className="text-sm text-slate-400 mt-1 leading-relaxed">
              {result.outcome === 'not_improved'
                ? 'The PostgreSQL query planner evaluated candidate indexes in the PGlite WASM sandbox, but none produced a lower cost than the current execution plan.'
                : 'Evaluation could not verify candidate indexes with row simulation.'}
            </p>
          </div>
        )}
      </div>

      {/* Vital Signs Grid (3 Cards) */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        {/* Card 1: Cost Reduction */}
        <div className="p-4 rounded-xl bg-slate-900/80 border border-slate-800 flex flex-col justify-between">
          <div className="text-xs font-semibold uppercase tracking-wider text-slate-400 mb-2 flex items-center justify-between">
            <span>Planner Cost</span>
            <TrendingDown className="w-4 h-4 text-emerald-400" />
          </div>

          {verification.status === 'verified' ? (
            <div>
              <div className="flex items-baseline gap-2">
                <span className="text-2xl font-bold font-mono text-emerald-400">
                  {verification.costAfter.toLocaleString(undefined, {
                    maximumFractionDigits: 1,
                  })}
                </span>
                <span className="text-xs text-slate-400 font-mono line-through">
                  {verification.costBefore.toLocaleString(undefined, {
                    maximumFractionDigits: 1,
                  })}
                </span>
                <span className="text-xs font-bold font-mono px-2 py-0.5 rounded bg-emerald-950 border border-emerald-800 text-emerald-300 ml-auto">
                  -{verification.costReductionPercent}%
                </span>
              </div>
              <p className="text-[11px] text-slate-400 mt-1 font-mono">
                {verification.costRatio.toFixed(1)}x planner speedup factor
              </p>
            </div>
          ) : (
            <div>
              <div className="flex items-center gap-1.5 text-amber-400 font-semibold text-sm">
                <HelpCircle className="w-4 h-4" />
                <span>Unverified</span>
              </div>
              <p className="text-xs text-slate-400 mt-1">{verification.reason}</p>
            </div>
          )}
        </div>

        {/* Card 2: Scan Transformation */}
        <div className="p-4 rounded-xl bg-slate-900/80 border border-slate-800 flex flex-col justify-between">
          <div className="text-xs font-semibold uppercase tracking-wider text-slate-400 mb-2 flex items-center justify-between">
            <span>Scan Transformation</span>
            <ArrowRight className="w-4 h-4 text-slate-500" />
          </div>

          {result.plans.before && result.plans.after ? (
            <div>
              <div className="flex items-center gap-2 font-mono text-xs">
                <span className="px-2 py-1 rounded bg-rose-950/60 border border-rose-800/60 text-rose-300 font-medium truncate">
                  {result.plans.before.primaryScan}
                </span>
                <ArrowRight className="w-3.5 h-3.5 text-slate-600 shrink-0" />
                <span className="px-2 py-1 rounded bg-emerald-950/60 border border-emerald-800/60 text-emerald-300 font-medium truncate">
                  {result.plans.after.primaryScan}
                </span>
              </div>
              <p className="text-[11px] text-slate-400 mt-1 truncate">
                {result.plans.after.usesIndexes.length > 0
                  ? `Used: ${result.plans.after.usesIndexes.join(', ')}`
                  : 'Sequential scan retained'}
              </p>
            </div>
          ) : (
            <div className="text-xs text-slate-400 font-mono">
              <span>No plan transformation recorded</span>
            </div>
          )}
        </div>

        {/* Card 3: Engine Provenance */}
        <div className="p-4 rounded-xl bg-slate-900/80 border border-slate-800 flex flex-col justify-between">
          <div className="text-xs font-semibold uppercase tracking-wider text-slate-400 mb-2 flex items-center justify-between">
            <span>Advisor Provenance</span>
            <Cpu className="w-4 h-4 text-blue-400" />
          </div>

          <div>
            <div className="flex items-center gap-1.5 font-semibold text-sm text-slate-200">
              {result.source.proposedBy === 'llm' ? (
                <>
                  <Sparkles className="w-4 h-4 text-emerald-400" />
                  <span>{result.source.model ?? 'Gemini LLM Chain'}</span>
                </>
              ) : (
                <>
                  <CheckCircle2 className="w-4 h-4 text-blue-400" />
                  <span>Deterministic ESR Planner</span>
                </>
              )}
            </div>
            <p className="text-[11px] text-slate-400 font-mono mt-1">
              gate: {result.timingsMs.gate}ms • propose: {result.timingsMs.propose}ms • eval:{' '}
              {result.timingsMs.evaluate}ms
            </p>
          </div>
        </div>
      </div>

      {/* Notices & Fallbacks if any */}
      {result.notices.length > 0 && (
        <div className="p-3 rounded-xl bg-amber-950/30 border border-amber-800/40 text-amber-300 text-xs flex items-start gap-2">
          <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5 text-amber-400" />
          <div className="space-y-1">
            {result.notices.map((notice) => (
              <p key={notice}>{notice}</p>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
