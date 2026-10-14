import { Code2, FileCode, XCircle } from 'lucide-react';
import React from 'react';

interface SqlEditorsProps {
  schema: string;
  query: string;
  disabled: boolean;
  onSchemaChange: (val: string) => void;
  onQueryChange: (val: string) => void;
  onKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
}

const MAX_SCHEMA_LENGTH = 20000;
const MAX_QUERY_LENGTH = 8000;

export function SqlEditors({
  schema,
  query,
  disabled,
  onSchemaChange,
  onQueryChange,
  onKeyDown,
}: SqlEditorsProps): React.JSX.Element {
  const schemaNearLimit = schema.length > MAX_SCHEMA_LENGTH * 0.9;
  const queryNearLimit = query.length > MAX_QUERY_LENGTH * 0.9;

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
      {/* Schema Editor */}
      <div className="flex flex-col bg-slate-900/80 border border-slate-800 rounded-xl overflow-hidden focus-within:border-slate-700 focus-within:ring-1 focus-within:ring-slate-700 transition-all">
        <div className="px-4 py-2.5 bg-slate-900 border-b border-slate-800 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <FileCode className="w-4 h-4 text-emerald-400" />
            <label htmlFor="schema-input" className="text-xs font-semibold text-slate-300">
              Postgres Schema (DDL)
            </label>
          </div>
          <div className="flex items-center gap-3">
            <span
              className={`text-[11px] font-mono ${
                schemaNearLimit ? 'text-amber-400 font-bold' : 'text-slate-400'
              }`}
            >
              {schema.length.toLocaleString()} / {MAX_SCHEMA_LENGTH.toLocaleString()}
            </span>
            {schema.length > 0 && !disabled && (
              <button
                type="button"
                onClick={() => onSchemaChange('')}
                className="p-1 -m-1 text-slate-400 hover:text-slate-200 transition-colors flex items-center justify-center min-w-[28px] min-h-[28px] rounded cursor-pointer"
                title="Clear schema"
                aria-label="Clear schema input"
              >
                <XCircle className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
        </div>

        <div className="relative flex-1">
          <textarea
            id="schema-input"
            value={schema}
            disabled={disabled}
            onChange={(e) => onSchemaChange(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={`-- Paste your CREATE TABLE / CREATE INDEX DDL here\nCREATE TABLE orders (\n  id SERIAL PRIMARY KEY,\n  customer_id INT NOT NULL,\n  status TEXT NOT NULL,\n  created_at TIMESTAMPTZ NOT NULL\n);`}
            rows={10}
            maxLength={MAX_SCHEMA_LENGTH}
            spellCheck={false}
            className="w-full h-full p-4 font-mono text-xs sm:text-sm text-slate-200 bg-transparent resize-y focus:outline-none placeholder:text-slate-500 disabled:opacity-50 leading-relaxed"
          />
        </div>
      </div>

      {/* Query Editor */}
      <div className="flex flex-col bg-slate-900/80 border border-slate-800 rounded-xl overflow-hidden focus-within:border-slate-700 focus-within:ring-1 focus-within:ring-slate-700 transition-all">
        <div className="px-4 py-2.5 bg-slate-900 border-b border-slate-800 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Code2 className="w-4 h-4 text-emerald-400" />
            <label htmlFor="query-input" className="text-xs font-semibold text-slate-300">
              Query SQL
            </label>
          </div>
          <div className="flex items-center gap-3">
            <span
              className={`text-[11px] font-mono ${
                queryNearLimit ? 'text-amber-400 font-bold' : 'text-slate-400'
              }`}
            >
              {query.length.toLocaleString()} / {MAX_QUERY_LENGTH.toLocaleString()}
            </span>
            {query.length > 0 && !disabled && (
              <button
                type="button"
                onClick={() => onQueryChange('')}
                className="p-1 -m-1 text-slate-400 hover:text-slate-200 transition-colors flex items-center justify-center min-w-[28px] min-h-[28px] rounded cursor-pointer"
                title="Clear query"
                aria-label="Clear query input"
              >
                <XCircle className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
        </div>

        <div className="relative flex-1">
          <textarea
            id="query-input"
            value={query}
            disabled={disabled}
            onChange={(e) => onQueryChange(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={`-- Paste your SELECT query here\nSELECT id, customer_id, created_at\nFROM orders\nWHERE status = 'pending'\nORDER BY created_at DESC\nLIMIT 50;`}
            rows={10}
            maxLength={MAX_QUERY_LENGTH}
            spellCheck={false}
            className="w-full h-full p-4 font-mono text-xs sm:text-sm text-slate-200 bg-transparent resize-y focus:outline-none placeholder:text-slate-500 disabled:opacity-50 leading-relaxed"
          />
        </div>
      </div>
    </div>
  );
}
