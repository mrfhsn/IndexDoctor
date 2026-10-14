import type { PresetId } from '../contract.js';
import { analyticsCoveringPreset } from './analytics-covering.js';
import { eventsMultitenantPreset } from './events-multitenant.js';
import { ordersCompositePreset } from './orders-composite.js';

interface PresetCandidate {
  name: string;
  ddl: string;
}

export interface Preset {
  id: PresetId;
  name: string;
  description: string;
  schema: string;
  query: string;
  candidateIndex: PresetCandidate;
}

export const PRESETS: readonly Preset[] = [
  ordersCompositePreset,
  eventsMultitenantPreset,
  analyticsCoveringPreset,
] as const;

export function getPresetById(id: string): Preset | undefined {
  return PRESETS.find((p) => p.id === id);
}
