/**
 * Persisted UI/session preferences (theme, instrument, tuning, gain, …).
 * Per-deck string selection lives here, keyed by deckId (= tuningId).
 */

import { DEFAULT_INSTRUMENT_ID, getInstrument, stringNumbersFor } from '../deck/instruments';
import {
  DEFAULT_TUNING_ID,
  getTuning,
  stringNumbersOf,
  tuningsForInstrument,
  type TuningDef,
} from '../deck/tuning';

export const SETTINGS_KEY = 'srs-fretboard.settings';
export const THEME_KEY = 'srs-fretboard.theme';

export type ThemeName = 'light' | 'dark';
export type FretRangeMode = 'default' | 'max';

export interface UserSettings {
  theme: ThemeName;
  instrumentId: string;
  tuningId: string;
  customTunings: TuningDef[];
  fretRangeMode: FretRangeMode;
  /** Active string numbers, stored per deckId so Drop D can differ from Standard. */
  activeStringsByDeck: Record<string, number[]>;
  /** Input gain, 0–3, default 1. Applied before pitch detection. */
  inputGain: number;
}

export function detectSystemTheme(): ThemeName {
  try {
    if (typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: light)').matches) {
      return 'light';
    }
  } catch {
    // jsdom / Node: no matchMedia.
  }
  return 'dark';
}

export function readStoredTheme(): ThemeName | null {
  try {
    const raw = localStorage.getItem(THEME_KEY);
    if (raw === 'light' || raw === 'dark') return raw;
  } catch {
    // ignore
  }
  return null;
}

export function writeStoredTheme(theme: ThemeName): void {
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch {
    // ignore
  }
}

export function applyTheme(theme: ThemeName): void {
  if (typeof document === 'undefined') return;
  document.documentElement.dataset.theme = theme;
}

function defaultSettings(): UserSettings {
  return {
    theme: readStoredTheme() ?? detectSystemTheme(),
    instrumentId: DEFAULT_INSTRUMENT_ID,
    tuningId: DEFAULT_TUNING_ID,
    customTunings: [],
    fretRangeMode: 'default',
    activeStringsByDeck: {},
    inputGain: 1,
  };
}

function clampGain(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.min(3, Math.max(0, value));
}

export function parseSettings(raw: unknown): UserSettings {
  const fallback = defaultSettings();
  if (!raw || typeof raw !== 'object') return fallback;
  const value = raw as Partial<UserSettings>;
  const instrumentId =
    typeof value.instrumentId === 'string' && value.instrumentId ? value.instrumentId : fallback.instrumentId;
  const customTunings = Array.isArray(value.customTunings)
    ? value.customTunings.filter(
        (tuning): tuning is TuningDef =>
          !!tuning &&
          typeof tuning === 'object' &&
          typeof tuning.id === 'string' &&
          typeof tuning.instrumentId === 'string' &&
          typeof tuning.openStringMidi === 'object',
      )
    : [];
  const tuningId =
    typeof value.tuningId === 'string' && value.tuningId ? value.tuningId : fallback.tuningId;
  const theme = value.theme === 'light' || value.theme === 'dark' ? value.theme : fallback.theme;
  const fretRangeMode = value.fretRangeMode === 'max' ? 'max' : 'default';
  const activeStringsByDeck: Record<string, number[]> = {};
  if (value.activeStringsByDeck && typeof value.activeStringsByDeck === 'object') {
    for (const [deckId, strings] of Object.entries(value.activeStringsByDeck)) {
      if (!Array.isArray(strings)) continue;
      activeStringsByDeck[deckId] = strings.map((n) => Math.trunc(Number(n))).filter((n) => n > 0);
    }
  }
  return {
    theme,
    instrumentId,
    tuningId,
    customTunings,
    fretRangeMode,
    activeStringsByDeck,
    inputGain: clampGain(Number(value.inputGain ?? 1)),
  };
}

export function loadSettings(): UserSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return defaultSettings();
    return parseSettings(JSON.parse(raw));
  } catch {
    return defaultSettings();
  }
}

export function saveSettings(settings: UserSettings): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    writeStoredTheme(settings.theme);
  } catch {
    // ignore
  }
}

export function resolveTuning(settings: UserSettings): TuningDef {
  const instrument = getInstrument(settings.instrumentId);
  const tuning = getTuning(settings.tuningId, settings.customTunings);
  if (tuning.instrumentId === instrument.id) return tuning;
  return tuningsForInstrument(instrument.id, settings.customTunings)[0] ?? getTuning(DEFAULT_TUNING_ID);
}

export function activeStringsFor(settings: UserSettings, tuning: TuningDef): number[] {
  const saved = settings.activeStringsByDeck[tuning.id];
  const available = stringNumbersOf(tuning);
  if (!saved || saved.length === 0) return available;
  const allowed = new Set(available);
  const filtered = saved.filter((n) => allowed.has(n));
  return filtered.length > 0 ? filtered : available;
}

export function fretWindowFor(settings: UserSettings): { minFret: number; maxFret: number } {
  const instrument = getInstrument(settings.instrumentId);
  if (settings.fretRangeMode === 'max') {
    return { minFret: instrument.fretRangeMax[0], maxFret: instrument.fretRangeMax[1] };
  }
  return { minFret: instrument.fretRangeDefault[0], maxFret: instrument.fretRangeDefault[1] };
}

export function maxFretFor(settings: UserSettings): number {
  return getInstrument(settings.instrumentId).fretRangeMax[1];
}

export { stringNumbersFor };
