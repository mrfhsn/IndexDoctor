import { Copy, Check, Terminal, FileCode2, ShieldAlert } from 'lucide-react';
import React, { useState } from 'react';

import type { Recommendation } from '../../shared/contract.js';
import type { MigrationTab } from '../state/reducer.js';

interface MigrationOutputProps {
  recommendation: Recommendation;
  activeTab: MigrationTab;
  onTabChange: (tab: MigrationTab) => void;
}

export function MigrationOutput({
  recommendation,
  activeTab,
  onTabChange,
}: MigrationOutputProps): React.JSX.Element {
  const [copied, setCopied] = useState(false);
  const { migrations, migrationNotes, sql } = recommendation;

  const getActiveCode = (): string => {
    switch (activeTab) {
      case 'postgres':
        return migrations.postgres || sql.createConcurrently;
      case 'drizzle':
        return migrations.drizzle || '// Drizzle schema definition unavailable';
      case 'prisma':
        return migrations.prisma || '// Prisma schema definition unavailable';
      default:
        return '';
    }
  };

  const handleCopy = async () => {
    const code = getActiveCode();
    await navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Terminal className="w-4 h-4 text-emerald-400" />
          <h3 className="text-sm font-semibold text-slate-200 uppercase tracking-wider">
            Copy-Ready Migrations
          </h3>
        </div>

        {/* Tab Buttons */}
        <div
          role="tablist"
          aria-label="Migration format selector"
          className="flex items-center gap-1 p-1 rounded-lg bg-slate-900 border border-slate-800 text-xs"
        >
          <button
            type="button"
            role="tab"
            id="tab-postgres"
            aria-selected={activeTab === 'postgres'}
            aria-controls="migration-code-panel"
            onClick={() => onTabChange('postgres')}
            className={`px-3 py-1 rounded-md transition-colors cursor-pointer font-medium ${
              activeTab === 'postgres'
                ? 'bg-emerald-500 text-slate-950'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            Postgres DDL
          </button>
          <button
            type="button"
            role="tab"
            id="tab-drizzle"
            aria-selected={activeTab === 'drizzle'}
            aria-controls="migration-code-panel"
            onClick={() => onTabChange('drizzle')}
            className={`px-3 py-1 rounded-md transition-colors cursor-pointer font-medium ${
              activeTab === 'drizzle'
                ? 'bg-emerald-500 text-slate-950'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            Drizzle ORM
          </button>
          <button
            type="button"
            role="tab"
            id="tab-prisma"
            aria-selected={activeTab === 'prisma'}
            aria-controls="migration-code-panel"
            onClick={() => onTabChange('prisma')}
            className={`px-3 py-1 rounded-md transition-colors cursor-pointer font-medium ${
              activeTab === 'prisma'
                ? 'bg-emerald-500 text-slate-950'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            Prisma
          </button>
        </div>
      </div>

      {/* Code Display Area */}
      <div
        id="migration-code-panel"
        role="tabpanel"
        aria-labelledby={`tab-${activeTab}`}
        className="relative rounded-xl border border-slate-800 bg-slate-900 overflow-hidden"
      >
        <div className="px-4 py-2 bg-slate-950/60 border-b border-slate-800/80 flex items-center justify-between text-xs text-slate-400 font-mono">
          <div className="flex items-center gap-1.5">
            <FileCode2 className="w-3.5 h-3.5 text-slate-400" />
            <span>
              {activeTab === 'postgres'
                ? 'migration.sql (Non-blocking concurrent)'
                : activeTab === 'drizzle'
                  ? 'schema.ts (Drizzle index builder)'
                  : 'schema.prisma (Model @@index)'}
            </span>
          </div>

          <button
            type="button"
            onClick={handleCopy}
            className="flex items-center gap-1 px-2.5 py-1 rounded-md bg-slate-800 hover:bg-slate-700 text-slate-200 transition-colors text-xs font-semibold cursor-pointer"
            aria-label="Copy code to clipboard"
          >
            {copied ? (
              <>
                <Check className="w-3.5 h-3.5 text-emerald-400" />
                <span className="text-emerald-400">Copied!</span>
              </>
            ) : (
              <>
                <Copy className="w-3.5 h-3.5" />
                <span>Copy</span>
              </>
            )}
          </button>
        </div>

        <pre className="p-4 font-mono text-xs sm:text-sm text-emerald-300 overflow-x-auto leading-relaxed">
          <code>{getActiveCode()}</code>
        </pre>
      </div>

      {/* Migration Notes */}
      {migrationNotes.length > 0 && (
        <div className="p-3.5 rounded-xl bg-slate-900/60 border border-slate-800 text-xs space-y-1.5">
          <div className="flex items-center gap-1.5 font-semibold text-slate-300">
            <ShieldAlert className="w-3.5 h-3.5 text-amber-400" />
            <span>Production Deployment Notes</span>
          </div>
          <ul className="list-disc list-inside space-y-1 text-slate-400 pl-1">
            {migrationNotes.map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
