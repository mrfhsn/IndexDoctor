import type { DiagnoseResponse, PresetId } from '../../shared/contract.js';
import type { HistoryEntry } from './history.js';

export type UiStatus = 'idle' | 'running' | 'success' | 'error';
export type MigrationTab = 'postgres' | 'drizzle' | 'prisma';

export interface UiError {
  code: string;
  message: string;
  hint?: string;
  requestId?: string;
  retryAfterSec?: number;
}

export interface AppState {
  status: UiStatus;
  schema: string;
  query: string;
  selectedPreset: PresetId | null;
  elapsedSeconds: number;
  result: DiagnoseResponse | null;
  error: UiError | null;
  activeMigrationTab: MigrationTab;
  showRawJson: boolean;
  copiedField: string | null;
  history: HistoryEntry[];
}

export type AppAction =
  | { type: 'SET_SCHEMA'; payload: string }
  | { type: 'SET_QUERY'; payload: string }
  | { type: 'SELECT_PRESET'; payload: { presetId: PresetId; schema: string; query: string } }
  | { type: 'START_DIAGNOSE' }
  | { type: 'TICK_ELAPSED' }
  | { type: 'DIAGNOSE_SUCCESS'; payload: DiagnoseResponse }
  | { type: 'DIAGNOSE_ERROR'; payload: UiError }
  | { type: 'RESET' }
  | { type: 'SET_MIGRATION_TAB'; payload: MigrationTab }
  | { type: 'TOGGLE_RAW_JSON' }
  | { type: 'SET_COPIED'; payload: string | null }
  | { type: 'SET_HISTORY'; payload: HistoryEntry[] };

export const initialState: AppState = {
  status: 'idle',
  schema: '',
  query: '',
  selectedPreset: null,
  elapsedSeconds: 0,
  result: null,
  error: null,
  activeMigrationTab: 'postgres',
  showRawJson: false,
  copiedField: null,
  history: [],
};

export function appReducer(state: AppState, action: AppAction): AppState {
  switch (action.type) {
    case 'SET_SCHEMA':
      return {
        ...state,
        schema: action.payload,
        selectedPreset: null,
      };

    case 'SET_QUERY':
      return {
        ...state,
        query: action.payload,
        selectedPreset: null,
      };

    case 'SELECT_PRESET':
      return {
        ...state,
        selectedPreset: action.payload.presetId,
        schema: action.payload.schema,
        query: action.payload.query,
        error: null,
      };

    case 'START_DIAGNOSE':
      return {
        ...state,
        status: 'running',
        elapsedSeconds: 0,
        error: null,
      };

    case 'TICK_ELAPSED':
      return {
        ...state,
        elapsedSeconds: state.elapsedSeconds + 1,
      };

    case 'DIAGNOSE_SUCCESS':
      return {
        ...state,
        status: 'success',
        result: action.payload,
        error: null,
      };

    case 'DIAGNOSE_ERROR':
      return {
        ...state,
        status: 'error',
        error: action.payload,
        result: null,
      };

    case 'RESET':
      return {
        ...initialState,
        history: state.history,
      };

    case 'SET_MIGRATION_TAB':
      return {
        ...state,
        activeMigrationTab: action.payload,
      };

    case 'TOGGLE_RAW_JSON':
      return {
        ...state,
        showRawJson: !state.showRawJson,
      };

    case 'SET_COPIED':
      return {
        ...state,
        copiedField: action.payload,
      };

    case 'SET_HISTORY':
      return {
        ...state,
        history: action.payload,
      };

    default:
      return state;
  }
}
