/**
 * note-helpers.ts — pitch/level helpers ported 1:1 from main.py.
 *
 *   _NOTE_NAMES / midi_to_name  -> NOTE_NAMES / midiToName
 *   rms_to_db                   -> rmsToDb
 *   PitchProcessor._freq_to_midi-> freqToMidi
 */

/** main.py: `_NOTE_NAMES` (sharps only). */
export const NOTE_NAMES = [
  'C',
  'C#',
  'D',
  'D#',
  'E',
  'F',
  'F#',
  'G',
  'G#',
  'A',
  'A#',
  'B',
] as const;

/** main.py: `_BASE_NOTE_INDEX` — natural-note semitone offsets. */
export const BASE_NOTE_INDEX: Record<string, number> = {
  C: 0,
  D: 2,
  E: 4,
  F: 5,
  G: 7,
  A: 9,
  B: 11,
};

export const DB_FLOOR = -96.0;

/**
 * main.py: `midi_to_name(midi_note)` — e.g. 40 -> "E2".
 */
export function midiToName(midiNote: number): string {
  const octave = Math.floor(midiNote / 12) - 1;
  const name = NOTE_NAMES[((midiNote % 12) + 12) % 12];
  return `${name}${octave}`;
}

/**
 * main.py: `rms_to_db(samples)` — RMS level of an audio buffer in dBFS.
 *
 * Python floors silence at -96 dB and clamps the result to that floor; the
 * AudioWorklet already does this on the audio thread, this helper exists for
 * callers on the main thread (tests, fixtures, future DSP experiments).
 */
export function rmsToDb(samples: ArrayLike<number>): number {
  let sumSquares = 0;
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i];
    sumSquares += s * s;
  }
  const rms = Math.sqrt(sumSquares / samples.length);
  if (!(rms >= 1e-10)) return DB_FLOOR;
  return Math.max(DB_FLOOR, 20 * Math.log10(rms));
}

/**
 * main.py: `PitchProcessor._freq_to_midi(freq)`.
 *
 * Standard formula: MIDI = round(69 + 12*log2(f / 440)). Python returns 0 for
 * non-positive frequencies (via the `if freq <= 0` guard).
 */
export function freqToMidi(freq: number): number {
  if (!(freq > 0)) return 0;
  return Math.round(69 + 12 * Math.log2(freq / 440.0));
}

/** Reference frequency (Hz) for a MIDI note number — inverse of `freqToMidi`. */
export function midiToFreq(midiNote: number): number {
  return 440 * Math.pow(2, (midiNote - 69) / 12);
}

/**
 * Signed semitone distance between two MIDI notes. Instrument-agnostic — not
 * a guitar fret count — so a future interval-hint ladder can reuse it.
 */
export function semitoneInterval(fromMidi: number, toMidi: number): number {
  return Math.trunc(toMidi) - Math.trunc(fromMidi);
}

/**
 * main.py: `_format_wait(delta)` — "2h 5m" / "3m 20s" / "12s".
 * Python tracks milliseconds here because it deals with `timedelta`; the
 * formatting is identical.
 */
export function formatWait(deltaMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(deltaMs / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const remainder = totalSeconds % 3600;
  const minutes = Math.floor(remainder / 60);
  const seconds = remainder % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

/** main.py: `_format_local_datetime(value)` — "%Y-%m-%d %H:%M:%S %Z". */
export function formatLocalDateTime(value: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const tz =
    Intl.DateTimeFormat(undefined, { timeZoneName: 'short' })
      .formatToParts(value)
      .find((part) => part.type === 'timeZoneName')?.value ?? '';
  const stamp =
    `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())} ` +
    `${pad(value.getHours())}:${pad(value.getMinutes())}:${pad(value.getSeconds())}`;
  return tz ? `${stamp} ${tz}` : stamp;
}
