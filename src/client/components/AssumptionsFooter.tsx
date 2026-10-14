import { ShieldCheck, Scale, Cpu, Lock } from 'lucide-react';
import React from 'react';

import type { DiagnoseResponse } from '../../shared/contract.js';

interface AssumptionsFooterProps {
  assumptions: DiagnoseResponse['assumptions'] | null;
}

export function AssumptionsFooter({ assumptions }: AssumptionsFooterProps): React.JSX.Element {
  const rowCount = assumptions?.assumedRowCount ?? 500000;

  return (
    <footer className="pt-8 pb-12 border-t border-slate-800 text-xs text-slate-400 space-y-6">
      {/* Honesty and Privacy Callout Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="p-4 rounded-xl bg-slate-900/40 border border-slate-800/80 space-y-2">
          <div className="flex items-center gap-2 text-slate-300 font-semibold">
            <Scale className="w-4 h-4 text-emerald-400" />
            <span>Planner Cost Estimation Methodology</span>
          </div>
          <p className="text-slate-400 leading-relaxed max-w-prose">
            Costs are estimated by the official PostgreSQL query planner running inside PGlite
            (WASM) scaled to{' '}
            <span className="font-mono text-slate-200">{rowCount.toLocaleString()}</span> simulated
            rows with simulated distribution statistics. This is a planner cost model comparison,
            not a hardware benchmark.
          </p>
        </div>

        <div className="p-4 rounded-xl bg-slate-900/40 border border-slate-800/80 space-y-2">
          <div className="flex items-center gap-2 text-slate-300 font-semibold">
            <Lock className="w-4 h-4 text-emerald-400" />
            <span>Zero-Storage & Privacy Guarantee</span>
          </div>
          <p className="text-slate-400 leading-relaxed max-w-prose">
            No accounts, no cookies, no tracking. Your schema and query text are processed entirely
            in memory during the diagnosis request and rolled back cleanly. Model prompts strip all
            comments and parameterize literals.
          </p>
        </div>
      </div>

      <div className="flex flex-col sm:flex-row items-center justify-between gap-3 text-slate-400 text-[11px] font-mono">
        <div className="flex items-center gap-2">
          <Cpu className="w-3.5 h-3.5 text-blue-400" />
          <span>Postgres Planner in WASM • Google Cloud Run us-central1</span>
        </div>
        <div className="flex items-center gap-1.5">
          <ShieldCheck className="w-3.5 h-3.5 text-emerald-400" />
          <span>IndexDoctor OSS • MIT License</span>
        </div>
      </div>
    </footer>
  );
}
