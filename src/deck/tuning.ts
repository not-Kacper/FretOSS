/**
 * Tuning presets. deckId === tuningId for presets (each id already encodes
 * instrument + tuning). Custom tunings embed instrumentId in the derived id.
 */

import { NOTE_NAMES } from '../audio/note-helpers';
import { getInstrument, type InstrumentDef } from './instruments';

export interface TuningDef {
  id: string;
  label: string;
  instrumentId: string;
  openStringMidi: Record<number, number>;
}

export const DEFAULT_TUNING_ID = 'guitar6-standard';

/** Guitar 6: Standard EADGBE */
export const GUITAR6_STANDARD: TuningDef = {
  id: 'guitar6-standard',
  label: 'Standard (EADGBE)',
  instrumentId: 'guitar6',
  openStringMidi: { 6: 40, 5: 45, 4: 50, 3: 55, 2: 59, 1: 64 },
};

export const TUNINGS: TuningDef[] = [
  GUITAR6_STANDARD,
  {
    id: 'guitar6-drop-d',
    label: 'Drop D',
    instrumentId: 'guitar6',
    openStringMidi: { 6: 38, 5: 45, 4: 50, 3: 55, 2: 59, 1: 64 },
  },
  {
    id: 'guitar6-half-step-down',
    label: 'Half-Step Down',
    instrumentId: 'guitar6',
    openStringMidi: { 6: 39, 5: 44, 4: 49, 3: 54, 2: 58, 1: 63 },
  },
  {
    id: 'guitar6-open-g',
    label: 'Open G',
    instrumentId: 'guitar6',
    openStringMidi: { 6: 38, 5: 43, 4: 50, 3: 55, 2: 59, 1: 62 },
  },
  {
    id: 'guitar6-dadgad',
    label: 'DADGAD',
    instrumentId: 'guitar6',
    openStringMidi: { 6: 38, 5: 45, 4: 50, 3: 55, 2: 57, 1: 62 },
  },
  {
    id: 'guitar7-standard',
    label: 'Standard (BEADGBE)',
    instrumentId: 'guitar7',
    openStringMidi: { 7: 35, 6: 40, 5: 45, 4: 50, 3: 55, 2: 59, 1: 64 },
  },
  {
    id: 'bass4-standard',
    label: 'Standard (EADG)',
    instrumentId: 'bass4',
    openStringMidi: { 4: 28, 3: 33, 2: 38, 1: 43 },
  },
  {
    id: 'bass4-drop-d',
    label: 'Drop D',
    instrumentId: 'bass4',
    openStringMidi: { 4: 26, 3: 33, 2: 38, 1: 43 },
  },
  {
    id: 'bass5-standard',
    label: 'Standard (BEADG)',
    instrumentId: 'bass5',
    openStringMidi: { 5: 23, 4: 28, 3: 33, 2: 38, 1: 43 },
  },
  {
    id: 'ukulele4-standard',
    label: 'Standard (GCEA)',
    instrumentId: 'ukulele4',
    // Reentrant: G4 is HIGHER than C4. Do not "fix" this.
    openStringMidi: { 4: 67, 3: 60, 2: 64, 1: 69 },
  },
  {
    id: 'ukulele4-baritone',
    label: 'Baritone (DGBE)',
    instrumentId: 'ukulele4',
    openStringMidi: { 4: 50, 3: 55, 2: 59, 1: 64 },
  },
];

const PRESET_BY_ID = new Map(TUNINGS.map((tuning) => [tuning.id, tuning]));

export function normalizeOpenStringMidi(raw: Record<number, number>): Record<number, number> {
  const out: Record<number, number> = {};
  for (const [key, value] of Object.entries(raw)) {
    const stringNumber = Number(key);
    if (!Number.isFinite(stringNumber)) continue;
    out[stringNumber] = Math.trunc(Number(value));
  }
  return out;
}

/**
 * Custom tuning ids must embed instrumentId so a 4-string custom uke can never
 * collide with a 4-string custom bass (or a future 4-string guitar).
 */
export function customTuningId(
  instrumentId: string,
  openStringMidi: Record<number, number>,
): string {
  const midi = normalizeOpenStringMidi(openStringMidi);
  const strings = Object.keys(midi)
    .map(Number)
    .sort((a, b) => b - a);
  const encoded = strings.map((stringNumber) => `${stringNumber}-${midi[stringNumber]}`).join('_');
  return `custom-${instrumentId}-${encoded}`;
}

export function isCustomTuningId(id: string): boolean {
  return id.startsWith('custom-');
}

export function tuningsForInstrument(instrumentId: string, extras: TuningDef[] = []): TuningDef[] {
  const presets = TUNINGS.filter((tuning) => tuning.instrumentId === instrumentId);
  const custom = extras.filter((tuning) => tuning.instrumentId === instrumentId);
  return [...presets, ...custom];
}

export function getTuning(
  id: string,
  extras: TuningDef[] = [],
): TuningDef {
  const preset = PRESET_BY_ID.get(id);
  if (preset) return preset;
  const custom = extras.find((tuning) => tuning.id === id);
  if (custom) {
    return { ...custom, openStringMidi: normalizeOpenStringMidi(custom.openStringMidi) };
  }
  return GUITAR6_STANDARD;
}

export function makeCustomTuning(
  instrumentId: string,
  openStringMidi: Record<number, number>,
  label = 'Custom',
): TuningDef {
  const midi = normalizeOpenStringMidi(openStringMidi);
  return {
    id: customTuningId(instrumentId, midi),
    label,
    instrumentId,
    openStringMidi: midi,
  };
}

export function defaultOpenStringMidi(instrument: InstrumentDef): Record<number, number> {
  const preset = TUNINGS.find((tuning) => tuning.instrumentId === instrument.id);
  if (preset) return { ...preset.openStringMidi };
  const midi: Record<number, number> = {};
  // Generic fallback: stacked fourths ending near E4, never used for presets.
  let note = 64;
  for (let n = 1; n <= instrument.stringCount; n++) {
    midi[n] = note;
    note -= 5;
  }
  return midi;
}

export function stringNumbersOf(tuning: TuningDef): number[] {
  return Object.keys(tuning.openStringMidi)
    .map(Number)
    .sort((a, b) => b - a);
}

/**
 * Human labels for each string. Duplicate pitch classes (e.g. the two E strings
 * on a guitar) get a low/high prefix so Standard 6-string still reads
 * "low E" / "high E", matching the Python deck.
 */
export function stringLabelsFor(tuning: TuningDef): Record<number, string> {
  const strings = stringNumbersOf(tuning);
  const pitchClass = (stringNumber: number): string => {
    const midi = tuning.openStringMidi[stringNumber];
    return NOTE_NAMES[((midi % 12) + 12) % 12];
  };
  const counts = new Map<string, number>();
  for (const stringNumber of strings) {
    const pc = pitchClass(stringNumber);
    counts.set(pc, (counts.get(pc) ?? 0) + 1);
  }
  const seen = new Map<string, number>();
  const labels: Record<number, string> = {};
  for (const stringNumber of strings) {
    const pc = pitchClass(stringNumber);
    const total = counts.get(pc) ?? 1;
    if (total <= 1) {
      labels[stringNumber] = pc;
      continue;
    }
    const index = seen.get(pc) ?? 0;
    seen.set(pc, index + 1);
    labels[stringNumber] = index === 0 ? `low ${pc}` : `high ${pc}`;
  }
  return labels;
}

export function tuningMatchesInstrument(tuning: TuningDef, instrument: InstrumentDef): boolean {
  return tuning.instrumentId === instrument.id && stringNumbersOf(tuning).length === instrument.stringCount;
}

export { getInstrument };
