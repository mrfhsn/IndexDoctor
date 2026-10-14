import { AlertOctagon, RefreshCw, Clock } from 'lucide-react';
import React, { useEffect, useState } from 'react';

import type { UiError } from '../state/reducer.js';

interface ErrorStateProps {
  error: UiError;
  onRetry: () => void;
}

export function ErrorState({ error, onRetry }: ErrorStateProps): React.JSX.Element {
  const [countdown, setCountdown] = useState<number | null>(error.retryAfterSec ?? null);

  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | undefined;

    if (countdown !== null && countdown > 0) {
      timer = setInterval(() => {
        setCountdown((prev) => {
          if (prev === null || prev <= 1) {
            clearInterval(timer);
            return 0;
          }
          return prev - 1;
        });
      }, 1000);
    }

    return () => {
      if (timer) {
        clearInterval(timer);
      }
    };
  }, [countdown]);

  const isRateLimited = error.code === 'RATE_LIMITED';
  const isBusy = error.code === 'BUSY' || error.code === 'NOT_READY';

  return (
    <div
      role="alert"
      className="p-5 rounded-2xl bg-rose-950/30 border border-rose-800/60 text-slate-200 space-y-3"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <div className="p-2 rounded-xl bg-rose-900/40 border border-rose-700/60 text-rose-300 shrink-0 mt-0.5">
            <AlertOctagon className="w-5 h-5" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <span className="text-xs font-mono font-bold px-2 py-0.5 rounded bg-rose-950 border border-rose-800 text-rose-300">
                {error.code}
              </span>
              {error.requestId && (
                <span className="text-xs font-mono text-slate-500">
                  req: {error.requestId.slice(0, 8)}
                </span>
              )}
            </div>
            <h3 className="text-base font-bold text-rose-200 mt-1">{error.message}</h3>
            {error.hint && (
              <p className="text-xs text-slate-400 mt-1 leading-relaxed">{error.hint}</p>
            )}
          </div>
        </div>

        {/* Retry Button */}
        <button
          type="button"
          disabled={countdown !== null && countdown > 0}
          onClick={onRetry}
          className={`shrink-0 px-3.5 py-2 rounded-xl border text-xs font-semibold flex items-center gap-1.5 transition-colors cursor-pointer ${
            countdown !== null && countdown > 0
              ? 'bg-slate-900 border-slate-800 text-slate-500 cursor-not-allowed'
              : 'bg-slate-900 border-slate-700 hover:bg-slate-800 text-slate-200'
          }`}
        >
          {isRateLimited && countdown !== null && countdown > 0 ? (
            <>
              <Clock className="w-3.5 h-3.5 text-amber-400" />
              <span>Retry in {countdown}s</span>
            </>
          ) : (
            <>
              <RefreshCw className="w-3.5 h-3.5 text-emerald-400" />
              <span>{isBusy ? 'Retry Now' : 'Try Again'}</span>
            </>
          )}
        </button>
      </div>
    </div>
  );
}
