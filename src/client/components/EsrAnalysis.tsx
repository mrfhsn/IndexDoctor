import { Layers, AlertTriangle, Info } from 'lucide-react';
import React from 'react';

import type { Recommendation } from '../../shared/contract.js';

interface EsrAnalysisProps {
  recommendation: Recommendation;
}

const ROLE_STYLES: Record<string, { bg: string; border: string; text: string }> = {
  Equality: {
    bg: 'bg-amber-950/80',
    border: 'border-amber-700/60',
    text: 'text-amber-300',
  },
  Sort: {
    bg: 'bg-indigo-950/80',
    border: 'border-indigo-700/60',
    text: 'text-indigo-300',
  },
  Range: {
    bg: 'bg-blue-950/80',
    border: 'border-blue-700/60',
    text: 'text-blue-300',
  },
  Include: {
    bg: 'bg-emerald-950/80',
    border: 'border-emerald-700/60',
    text: 'text-emerald-300',
  },
  Other: {
    bg: 'bg-slate-800',
    border: 'border-slate-700',
    text: 'text-slate-300',
  },
};

export function EsrAnalysis({ recommendation }: EsrAnalysisProps): React.JSX.Element {
  const { esr, antiPatterns } = recommendation;

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <Layers className="w-4 h-4 text-amber-400" />
        <h3 className="text-sm font-semibold text-slate-200 uppercase tracking-wider">
          ESR Heuristic Breakdown (Equality → Sort → Range)
        </h3>
      </div>

      <div className="p-4 rounded-xl bg-slate-900/80 border border-slate-800 space-y-4">
        {/* Chain pills display */}
        <div className="flex flex-wrap items-center gap-2">
          {esr.map((item) => {
            const style = ROLE_STYLES[item.role] ?? ROLE_STYLES['Other']!;
            return (
              <div
                key={item.column}
                className="flex items-center gap-1.5 p-2 rounded-lg bg-slate-950 border border-slate-800"
              >
                <span
                  className={`text-[11px] font-mono font-bold px-2 py-0.5 rounded border uppercase ${style.bg} ${style.border} ${style.text}`}
                >
                  {item.role}
                </span>
                <span className="font-mono text-xs text-slate-200 font-medium">
                  "{item.column}"
                </span>
              </div>
            );
          })}
        </div>

        {/* Column details table */}
        <div className="space-y-2 pt-2 border-t border-slate-800">
          {esr.map((item) => (
            <div key={item.column} className="flex items-start gap-2 text-xs">
              <Info className="w-3.5 h-3.5 text-slate-400 shrink-0 mt-0.5" />
              <div>
                <span className="font-mono font-semibold text-slate-300">"{item.column}"</span>:
                <span className="text-slate-400 ml-1.5">{item.reason}</span>
              </div>
            </div>
          ))}
        </div>

        {/* Anti-patterns warning if present */}
        {antiPatterns.length > 0 && (
          <div className="p-3 rounded-lg bg-rose-950/40 border border-rose-800/60 text-xs text-rose-300 space-y-1">
            <div className="flex items-center gap-1.5 font-semibold text-rose-300">
              <AlertTriangle className="w-3.5 h-3.5" />
              <span>Query Anti-Patterns Detected</span>
            </div>
            <ul className="list-disc list-inside space-y-0.5 pl-1 text-slate-300">
              {antiPatterns.map((pat) => (
                <li key={pat}>{pat}</li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}
