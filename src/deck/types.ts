/**
 * deck/types.ts — value objects shared by the deck, the audio pipeline and the
 * session layer. Mirrors the Python dataclasses in main.py.
 */

/**
 * main.py: `@dataclass(frozen=True) class FretboardTarget` — one schedulable
 * guitar position: a specific string and fret.
 *
 * `key` is also the primary key used by the IndexedDB progress store and by the
 * `cards` map in the synced JSON blob, so it must stay identical to Python's
 * `f"s{string_number}_f{fret:02d}"`.
 */
export interface FretboardTarget {
  key: string;
  cardId: number;
  stringNumber: number;
  stringLabel: string;
  fret: number;
  midiNote: number;
  noteName: string;
  pitchClass: string;
}

/** main.py: `@dataclass class NoteEvent` — emitted once a note is confirmed. */
export interface NoteEvent {
  midiNote: number;
  frequency: number;
  confidence: number;
}

/** main.py: `FretboardTarget.prompt_label` — "F#3 on D string". */
export function promptLabel(target: FretboardTarget): string {
  return `${target.noteName} on ${target.stringLabel} string`;
}

/** main.py: `FretboardTarget.to_dict()`. */
export function targetToDict(target: FretboardTarget): {
  key: string;
  card_id: number;
  string: number;
  string_label: string;
  fret: number;
  midi_note: number;
  note_name: string;
  pitch_class: string;
} {
  return {
    key: target.key,
    card_id: target.cardId,
    string: target.stringNumber,
    string_label: target.stringLabel,
    fret: target.fret,
    midi_note: target.midiNote,
    note_name: target.noteName,
    pitch_class: target.pitchClass,
  };
}
