import { Package, Zap, BarChart3 } from 'lucide-react';
import React from 'react';

import type { PresetId } from '../../shared/contract.js';
import { PRESETS, type Preset } from '../../shared/presets/presets.js';

interface PresetBarProps {
  selectedPreset: PresetId | null;
  disabled: boolean;
  onSelect: (preset: Preset) => void;
}

const PRESET_ICONS: Record<PresetId, React.ComponentType<{ className?: string }>> = {
  'orders-composite': Package,
  'events-multitenant': Zap,
  'analytics-covering': BarChart3,
};

const PRESET_METRICS: Record<PresetId, { badge: string; desc: string }> = {
  'orders-composite': {
    badge: '99.9% Cost Reduction',
    desc: 'Seq Scan → Index Scan (status + created_at)',
  },
  'events-multitenant': {
    badge: '99.8% Cost Reduction',
    desc: 'Seq Scan → Bitmap Heap Scan (tenant_id + created_at)',
  },
  'analytics-covering': {
    badge: '85.7% Cost Reduction',
    desc: 'Bitmap Scan → Index Only Scan (INCLUDE total)',
  },
};

export function PresetBar({
  selectedPreset,
  disabled,
  onSelect,
}: PresetBarProps): React.JSX.Element {
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold uppercase tracking-wider text-slate-400">
          Try a Golden Preset (1-Click Run)
        </span>
        <span className="text-xs text-slate-500 hidden sm:inline">
          Pre-configured workloads verified on PGlite WASM
        </span>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        {PRESETS.map((preset) => {
          const Icon = PRESET_ICONS[preset.id];
          const metric = PRESET_METRICS[preset.id];
          const isSelected = selectedPreset === preset.id;

          return (
            <button
              key={preset.id}
              type="button"
              disabled={disabled}
              onClick={() => onSelect(preset)}
              aria-label={`Select ${preset.name} preset`}
              className={`text-left p-3.5 rounded-xl border transition-all duration-150 flex flex-col justify-between group ${
                isSelected
                  ? 'bg-slate-900 border-emerald-500/60 shadow-lg shadow-emerald-950/20 ring-1 ring-emerald-500/30'
                  : 'bg-slate-900/60 border-slate-800 hover:border-slate-700 hover:bg-slate-900'
              } ${disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}
            >
              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <div className="flex items-center gap-2">
                    <div
                      className={`p-1.5 rounded-lg ${
                        isSelected
                          ? 'bg-emerald-500/20 text-emerald-400'
                          : 'bg-slate-800 text-slate-400 group-hover:text-slate-200'
                      }`}
                    >
                      <Icon className="w-4 h-4" />
                    </div>
                    <span className="font-semibold text-sm text-slate-200 group-hover:text-white">
                      {preset.name}
                    </span>
                  </div>
                  <span className="text-[10px] font-mono px-2 py-0.5 rounded-full bg-emerald-950/80 border border-emerald-800/60 text-emerald-300">
                    {metric.badge}
                  </span>
                </div>
                <p className="text-xs text-slate-400 line-clamp-1">{preset.description}</p>
              </div>
              <div className="mt-2 text-[11px] font-mono text-slate-500 group-hover:text-slate-400 flex items-center justify-between">
                <span>{metric.desc}</span>
                <span className="text-emerald-400 group-hover:translate-x-0.5 transition-transform">
                  Run →
                </span>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
