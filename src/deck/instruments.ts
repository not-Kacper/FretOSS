/**
 * Instrument presets. String count drives fretboard layout; fretRangeDefault
 * is the practice window (0–12) and fretRangeMax is the optional extension.
 * Fret range is a queue/view filter — it is never part of deckId.
 */

export interface InstrumentDef {
  id: string;
  label: string;
  stringCount: number;
  fretRangeDefault: [number, number];
  fretRangeMax: [number, number];
}

export const INSTRUMENTS: InstrumentDef[] = [
  {
    id: 'guitar6',
    label: 'Guitar 6-string',
    stringCount: 6,
    fretRangeDefault: [0, 12],
    fretRangeMax: [0, 24],
  },
  {
    id: 'guitar7',
    label: 'Guitar 7-string',
    stringCount: 7,
    fretRangeDefault: [0, 12],
    fretRangeMax: [0, 24],
  },
  {
    id: 'bass4',
    label: 'Bass 4-string',
    stringCount: 4,
    fretRangeDefault: [0, 12],
    fretRangeMax: [0, 24],
  },
  {
    id: 'bass5',
    label: 'Bass 5-string',
    stringCount: 5,
    fretRangeDefault: [0, 12],
    fretRangeMax: [0, 24],
  },
  {
    id: 'ukulele4',
    label: 'Ukulele 4-string',
    stringCount: 4,
    fretRangeDefault: [0, 12],
    fretRangeMax: [0, 15],
  },
];

export const DEFAULT_INSTRUMENT_ID = 'guitar6';

const BY_ID = new Map(INSTRUMENTS.map((instrument) => [instrument.id, instrument]));

export function getInstrument(id: string): InstrumentDef {
  return BY_ID.get(id) ?? INSTRUMENTS[0];
}

export function stringNumbersFor(instrument: InstrumentDef): number[] {
  const numbers: number[] = [];
  for (let n = instrument.stringCount; n >= 1; n--) numbers.push(n);
  return numbers;
}
