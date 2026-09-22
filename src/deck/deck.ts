/**
 * deck/deck.ts — port of main.py's fretboard deck construction.
 *
 *   FretboardDeck._build_targets -> buildTargets()
 *   _parse_note_token            -> parseNoteToken()
 *   _build_note_filter           -> buildNoteFilter()
 *   _STANDARD_TUNING_MIDI        -> STANDARD_TUNING_MIDI
 *   _STRING_LABELS               -> STRING_LABELS
 *
 * The output must match the Python deck byte-for-byte for the same config.json
 * (see tests/deck.test.ts against tests/deck-fixture.json).
 */

import { BASE_NOTE_INDEX, NOTE_NAMES, midiToName } from '../audio/note-helpers';
import type { FretboardTarget } from './types';

/** main.py: `_STANDARD_TUNING_MIDI` — open-string MIDI numbers, keyed by string number. */
export const STANDARD_TUNING_MIDI: Record<number, number> = {
  6: 40, // E2
  5: 45, // A2
  4: 50, // D3
  3: 55, // G3
  2: 59, // B3
  1: 64, // E4
};

/** main.py: `_STRING_LABELS`. */
export const STRING_LABELS: Record<number, string> = {
  6: 'low E',
  5: 'A',
  4: 'D',
  3: 'G',
  2: 'B',
  1: 'high E',
};

/** main.py: the accepted `deck.tuning` values (upper-cased, `-` -> `_`). */
const SUPPORTED_TUNINGS = new Set([
  'EADGBE',
  'STANDARD',
  'STANDARD_6_STRING_GUITAR',
]);

/** Raised for the same conditions where main.py prints an error and exits(1). */
export class DeckConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DeckConfigError';
  }
}

export type NoteFilter = { allowedMidi: Set<number>; allowedPitchClasses: Set<string> } | null;

/**
 * main.py: `_parse_note_token(value)`.
 *
 * Returns `['midi', 40]` or `['pitch_class', 'E']`, or `null` when the token
 * means "no restriction" (`*`, empty, `all`, `any`). Unsupported tokens throw,
 * exactly like Python's `ValueError`.
 */
export function parseNoteToken(value: unknown): ['midi', number] | ['pitch_class', string] | null {
  if (typeof value === 'number') {
    return ['midi', Math.trunc(value)];
  }

  const raw = String(value).trim();
  if (raw === '' || raw === '*') return null;
  if (['all', 'any'].includes(raw.toLowerCase())) return null;
  if (/^-?\d+$/.test(raw)) return ['midi', parseInt(raw, 10)];

  const match = /^([A-Ga-g])([#b]?)(-?\d+)?$/.exec(raw);
  if (match === null) {
    throw new Error(`Unsupported note token in config.json: ${String(value)}`);
  }

  const letter = match[1].toUpperCase();
  const accidental = match[2];
  const octave = match[3];

  let semitone = BASE_NOTE_INDEX[letter];
  if (accidental === '#') semitone += 1;
  else if (accidental === 'b') semitone -= 1;
  semitone = ((semitone % 12) + 12) % 12;

  if (octave === undefined) {
    return ['pitch_class', NOTE_NAMES[semitone]];
  }
  return ['midi', (parseInt(octave, 10) + 1) * 12 + semitone];
}

/**
 * main.py: `_build_note_filter(raw_notes)`.
 *
 * Builds MIDI/pitch-class allowlists; `null` means all notes are allowed (which
 * is also what a single unparseable token such as `"all"` in the list implies).
 */
export function buildNoteFilter(rawNotes: unknown): NoteFilter {
  if (rawNotes === undefined || rawNotes === null) return null;
  const notes = Array.isArray(rawNotes) ? rawNotes : [rawNotes];
  if (notes.length === 0) return null;

  const allowedMidi = new Set<number>();
  const allowedPitchClasses = new Set<string>();

  for (const rawNote of notes) {
    const parsed = parseNoteToken(rawNote);
    if (parsed === null) return null; // "all"/"*" anywhere => no filtering at all
    const [kind, parsedValue] = parsed;
    if (kind === 'midi') allowedMidi.add(parsedValue);
    else allowedPitchClasses.add(parsedValue);
  }

  return { allowedMidi, allowedPitchClasses };
}

/** The `deck` block of config.json. */
export interface DeckConfig {
  tuning?: string;
  strings?: number[];
  min_fret?: number;
  max_fret?: number;
  frets?: number[];
  notes_to_learn?: unknown;
  notes?: unknown;
}

/**
 * main.py: `FretboardDeck._build_targets()`.
 *
 * Walks the requested strings x frets in config order (no sorting — the Python
 * code appends as it iterates), and keeps only notes allowed by
 * `deck.notes_to_learn` (`deck.notes` is the legacy key).
 */
export function buildTargets(deck: DeckConfig): FretboardTarget[] {
  const tuning = String(deck.tuning ?? 'EADGBE')
    .toUpperCase()
    .replace(/-/g, '_');
  if (!SUPPORTED_TUNINGS.has(tuning)) {
    throw new DeckConfigError(
      'Only standard 6-string EADGBE tuning is supported right now.',
    );
  }

  const rawStrings = deck.strings ?? [6, 5, 4, 3, 2, 1];
  const strings = rawStrings.map((stringNumber) => Math.trunc(Number(stringNumber)));
  const unknownStrings = [...new Set(strings)]
    .filter((stringNumber) => !(stringNumber in STANDARD_TUNING_MIDI))
    .sort((a, b) => a - b);
  if (unknownStrings.length > 0) {
    throw new DeckConfigError(
      `Unsupported guitar strings in config.json: [${unknownStrings.join(', ')}]`,
    );
  }

  const rawFrets = deck.frets;
  let frets: number[];
  if (rawFrets === undefined || rawFrets === null) {
    const minFret = Math.trunc(Number(deck.min_fret ?? 0));
    const maxFret = Math.trunc(Number(deck.max_fret ?? 12));
    frets = [];
    for (let fret = minFret; fret <= maxFret; fret++) frets.push(fret);
  } else {
    frets = rawFrets.map((fret) => Math.trunc(Number(fret)));
  }

  if (frets.some((fret) => fret < 0)) {
    throw new DeckConfigError('Fret numbers must be >= 0.');
  }

  const noteFilter = buildNoteFilter(deck.notes_to_learn ?? deck.notes);

  const targets: FretboardTarget[] = [];
  for (const stringNumber of strings) {
    const openMidi = STANDARD_TUNING_MIDI[stringNumber];
    for (const fret of frets) {
      const midiNote = openMidi + fret;
      const noteName = midiToName(midiNote);
      const pitchClass = NOTE_NAMES[((midiNote % 12) + 12) % 12];

      if (noteFilter !== null) {
        const { allowedMidi, allowedPitchClasses } = noteFilter;
        if (!allowedMidi.has(midiNote) && !allowedPitchClasses.has(pitchClass)) {
          continue;
        }
      }

      targets.push({
        key: `s${stringNumber}_f${String(fret).padStart(2, '0')}`,
        cardId: stringNumber * 1000 + fret,
        stringNumber,
        stringLabel: STRING_LABELS[stringNumber],
        fret,
        midiNote,
        noteName,
        pitchClass,
      });
    }
  }

  return targets;
}

/**
 * main.py: `FretboardDeck.__init__` — builds the deck and refuses to run with an
 * empty one (Python prints an error and exits).
 */
export class FretboardDeck {
  readonly targets: FretboardTarget[];

  constructor(deckConfig: DeckConfig) {
    this.targets = buildTargets(deckConfig);
    if (this.targets.length === 0) {
      throw new DeckConfigError('config.json deck produced no fretboard targets.');
    }
  }

  get targetByKey(): Map<string, FretboardTarget> {
    return new Map(this.targets.map((target) => [target.key, target]));
  }
}
