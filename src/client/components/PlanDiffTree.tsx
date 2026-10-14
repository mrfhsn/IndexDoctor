import { ChevronDown, ChevronRight, Copy, Check, FileJson, GitCompare } from 'lucide-react';
import React, { useState } from 'react';

import type { PlanNode, PlanSummary } from '../../shared/contract.js';

interface PlanDiffTreeProps {
  before: PlanSummary | null;
  after: PlanSummary | null;
  showRawJson: boolean;
  onToggleRawJson: () => void;
}

function PlanNodeView({
  node,
  highlightIndexes,
  isAfter,
}: {
  node: PlanNode;
  highlightIndexes: string[];
  isAfter: boolean;
}): React.JSX.Element {
  const [expanded, setExpanded] = useState(true);
  const hasChildren = node.children.length > 0;
  const isIndexScan =
    node.type.includes('Index') ||
    node.type.includes('Bitmap Index') ||
    node.indexName !== undefined;
  const isUsedTargetIndex = node.indexName && highlightIndexes.includes(node.indexName);

  return (
    <div className="font-mono text-xs">
      <div
        className={`p-2.5 rounded-lg border mb-1.5 transition-all ${
          isUsedTargetIndex
            ? 'bg-emerald-950/40 border-emerald-500/50 shadow-sm shadow-emerald-950/40 ring-1 ring-emerald-500/30'
            : isAfter
              ? 'bg-slate-900/90 border-slate-800'
              : 'bg-slate-900/60 border-slate-800/80'
        }`}
      >
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-1.5 min-w-0">
            {hasChildren ? (
              <button
                type="button"
                onClick={() => setExpanded(!expanded)}
                className="text-slate-500 hover:text-slate-300 p-0.5 cursor-pointer"
                aria-label={expanded ? 'Collapse plan node' : 'Expand plan node'}
              >
                {expanded ? (
                  <ChevronDown className="w-3.5 h-3.5" />
                ) : (
                  <ChevronRight className="w-3.5 h-3.5" />
                )}
              </button>
            ) : (
              <span className="w-3.5 h-3.5 inline-block" />
            )}

            <span
              className={`font-semibold truncate ${
                isUsedTargetIndex
                  ? 'text-emerald-300'
                  : isIndexScan
                    ? 'text-blue-300'
                    : 'text-slate-300'
              }`}
            >
              {node.type}
            </span>

            {node.relation && (
              <span className="text-slate-400 text-[11px] truncate">on "{node.relation}"</span>
            )}
          </div>

          <div className="flex items-center gap-2 shrink-0 text-[11px]">
            <span className="text-slate-500">
              cost: <span className="text-slate-300">{node.totalCost.toFixed(1)}</span>
            </span>
            <span className="text-slate-500 hidden sm:inline">
              rows: <span className="text-slate-300">{node.planRows}</span>
            </span>
          </div>
        </div>

        {/* Index Name Pill */}
        {node.indexName && (
          <div className="mt-1.5 pl-5 flex items-center gap-2">
            <span
              className={`text-[10px] font-mono px-2 py-0.5 rounded-md border font-medium ${
                isUsedTargetIndex
                  ? 'bg-emerald-900/60 border-emerald-600 text-emerald-200'
                  : 'bg-slate-800 border-slate-700 text-slate-300'
              }`}
            >
              index: {node.indexName}
            </span>
          </div>
        )}

        {/* Index / Filter conditions */}
        {(node.indexCond || node.filter) && (
          <div className="mt-1 pl-5 text-[10px] text-slate-400 space-y-0.5">
            {node.indexCond && (
              <div className="truncate">
                <span className="text-slate-500">Index Cond:</span> {node.indexCond}
              </div>
            )}
            {node.filter && (
              <div className="truncate">
                <span className="text-slate-500">Filter:</span> {node.filter}
              </div>
            )}
          </div>
        )}
      </div>

      {hasChildren && expanded && (
        <div className="pl-4 border-l border-slate-800 ml-2 space-y-1">
          {node.children.map((child) => (
            <PlanNodeView
              key={`${child.type}-${child.relation ?? 'rel'}-${child.startupCost}-${child.totalCost}`}
              node={child}
              highlightIndexes={highlightIndexes}
              isAfter={isAfter}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export function PlanDiffTree({
  before,
  after,
  showRawJson,
  onToggleRawJson,
}: PlanDiffTreeProps): React.JSX.Element {
  const [copied, setCopied] = useState(false);

  const handleCopyJson = async () => {
    const json = JSON.stringify({ before, after }, null, 2);
    await navigator.clipboard.writeText(json);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  if (!before && !after) {
    return <></>;
  }

  const highlightIndexes = after?.usesIndexes ?? [];

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <GitCompare className="w-4 h-4 text-emerald-400" />
          <h3 className="text-sm font-semibold text-slate-200 uppercase tracking-wider">
            Execution Plan Comparison (Before vs. After)
          </h3>
        </div>

        <button
          type="button"
          onClick={onToggleRawJson}
          className="text-xs text-slate-400 hover:text-slate-200 px-2.5 py-1 rounded-lg border border-slate-800 bg-slate-900 flex items-center gap-1.5 transition-colors cursor-pointer"
        >
          <FileJson className="w-3.5 h-3.5" />
          <span>{showRawJson ? 'Visual Tree' : 'Raw JSON'}</span>
        </button>
      </div>

      {showRawJson ? (
        <div className="relative rounded-xl border border-slate-800 bg-slate-950 p-4 font-mono text-xs overflow-x-auto">
          <button
            type="button"
            onClick={handleCopyJson}
            className="absolute top-3 right-3 p-1.5 rounded-lg border border-slate-800 bg-slate-900 text-slate-400 hover:text-slate-200 transition-colors flex items-center gap-1 cursor-pointer"
          >
            {copied ? (
              <Check className="w-3.5 h-3.5 text-emerald-400" />
            ) : (
              <Copy className="w-3.5 h-3.5" />
            )}
            <span className="text-[10px]">{copied ? 'Copied' : 'Copy'}</span>
          </button>
          <pre className="text-slate-300">{JSON.stringify({ before, after }, null, 2)}</pre>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {/* Before Plan Column */}
          <div className="space-y-2 p-4 rounded-xl bg-slate-900/60 border border-slate-800/80">
            <div className="flex items-center justify-between pb-2 border-b border-slate-800">
              <span className="text-xs font-semibold text-rose-300 flex items-center gap-1.5">
                <span className="w-2 h-2 rounded-full bg-rose-500" />
                Before (Baseline Plan)
              </span>
              <span className="text-xs font-mono text-slate-400">
                total cost: {before?.totalCost.toFixed(1) ?? '—'}
              </span>
            </div>
            {before?.tree ? (
              <PlanNodeView node={before.tree} highlightIndexes={[]} isAfter={false} />
            ) : (
              <p className="text-xs text-slate-500 italic p-2">No before plan available</p>
            )}
          </div>

          {/* After Plan Column */}
          <div className="space-y-2 p-4 rounded-xl bg-slate-900/90 border border-slate-800">
            <div className="flex items-center justify-between pb-2 border-b border-slate-800">
              <span className="text-xs font-semibold text-emerald-300 flex items-center gap-1.5">
                <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
                After (With Recommended Index)
              </span>
              <span className="text-xs font-mono text-emerald-400 font-bold">
                total cost: {after?.totalCost.toFixed(1) ?? '—'}
              </span>
            </div>
            {after?.tree ? (
              <PlanNodeView node={after.tree} highlightIndexes={highlightIndexes} isAfter={true} />
            ) : (
              <p className="text-xs text-slate-500 italic p-2">No after plan available</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
