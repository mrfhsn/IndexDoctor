import { Play, Loader2, StopCircle, RotateCcw, Keyboard } from 'lucide-react';
import React from 'react';

import type { UiStatus } from '../state/reducer.js';

interface ActionBarProps {
  status: UiStatus;
  elapsedSeconds: number;
  hasInput: boolean;
  onRun: () => void;
  onCancel: () => void;
  onReset: () => void;
}

export function ActionBar({
  status,
  elapsedSeconds,
  hasInput,
  onRun,
  onCancel,
  onReset,
}: ActionBarProps): React.JSX.Element {
  const isRunning = status === 'running';
  const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/i.test(navigator.userAgent);
  const shortcutText = isMac ? '⌘ + Enter' : 'Ctrl + Enter';

  return (
    <div className="flex flex-col sm:flex-row items-center justify-between gap-3 pt-2">
      <div className="flex items-center gap-2 text-xs text-slate-400">
        <Keyboard className="w-3.5 h-3.5 text-slate-400" />
        <span>
          Press{' '}
          <kbd className="px-1.5 py-0.5 rounded bg-slate-900 border border-slate-700 text-slate-300 font-mono text-[11px]">
            {shortcutText}
          </kbd>{' '}
          to run
        </span>
      </div>

      <div className="flex items-center gap-3 w-full sm:w-auto">
        {hasInput && !isRunning && (
          <button
            type="button"
            onClick={onReset}
            className="px-3.5 py-2.5 rounded-xl border border-slate-800 bg-slate-900 text-slate-400 hover:text-slate-200 hover:bg-slate-800 text-xs font-semibold flex items-center justify-center gap-1.5 transition-colors cursor-pointer"
          >
            <RotateCcw className="w-3.5 h-3.5" />
            <span>Reset</span>
          </button>
        )}

        {isRunning ? (
          <button
            type="button"
            onClick={onCancel}
            className="w-full sm:w-auto px-6 py-2.5 rounded-xl border border-rose-500/40 bg-rose-950/30 text-rose-300 hover:bg-rose-900/40 font-semibold text-sm flex items-center justify-center gap-2 transition-all cursor-pointer"
          >
            <Loader2 className="w-4 h-4 animate-spin motion-reduce:animate-none text-rose-400" />
            <span>Diagnosing... ({elapsedSeconds}s)</span>
            <span className="text-xs text-rose-400/80 flex items-center gap-1 ml-1 border-l border-rose-500/30 pl-2">
              <StopCircle className="w-3.5 h-3.5" />
              Cancel
            </span>
          </button>
        ) : (
          <button
            type="button"
            disabled={!hasInput}
            onClick={onRun}
            className={`w-full sm:w-auto px-6 py-2.5 rounded-xl font-semibold text-sm flex items-center justify-center gap-2 transition-all duration-150 ${
              hasInput
                ? 'bg-emerald-500 hover:bg-emerald-400 text-slate-950 cursor-pointer active:scale-[0.98]'
                : 'bg-slate-800 text-slate-400 border border-slate-700 cursor-not-allowed'
            }`}
          >
            <Play className="w-4 h-4 fill-current" />
            <span>Diagnose Index</span>
          </button>
        )}
      </div>
    </div>
  );
}
