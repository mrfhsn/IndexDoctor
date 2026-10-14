import { Database, Sparkles, CheckCircle } from 'lucide-react';
import React from 'react';

export function App(): React.JSX.Element {
  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 p-8 flex flex-col items-center justify-center">
      <div className="max-w-xl text-center space-y-4">
        <div className="flex items-center justify-center gap-2 text-emerald-400">
          <Database className="w-8 h-8 animate-pulse" />
          <Sparkles className="w-6 h-6" />
        </div>
        <h1 className="text-3xl font-bold tracking-tight">IndexDoctor</h1>
        <p className="text-slate-400">
          Postgres index recommendations verified by an in-engine planner in WASM.
        </p>
        <div className="inline-flex items-center gap-2 px-3 py-1 bg-slate-800 border border-slate-700 rounded-full text-xs text-emerald-300">
          <CheckCircle className="w-3.5 h-3.5" />
          Walking Skeleton Online
        </div>
      </div>
    </div>
  );
}
