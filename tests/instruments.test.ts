import { describe, expect, it } from 'vitest';

import { buildTargets } from '../src/deck/deck';
import { INSTRUMENTS, getInstrument } from '../src/deck/instruments';
import {
  TUNINGS,
  customTuningId,
  getTuning,
  makeCustomTuning,
  stringLabelsFor,
  tuningsForInstrument,
} from '../src/deck/tuning';

describe('instruments + tunings', () => {
  it('ships the five instrument presets with the specified string counts', () => {
    expect(INSTRUMENTS.map((entry) => [entry.id, entry.stringCount])).toEqual([
      ['guitar6', 6],
      ['guitar7', 7],
      ['bass4', 4],
      ['bass5', 5],
      ['ukulele4', 4],
    ]);
    expect(getInstrument('ukulele4').fretRangeMax).toEqual([0, 15]);
    expect(getInstrument('guitar6').fretRangeMax).toEqual([0, 24]);
  });

  it('uses preset tuning ids as deck ids and keeps ukulele GCEA reentrant', () => {
    const uke = getTuning('ukulele4-standard');
    expect(uke.id).toBe('ukulele4-standard');
    expect(uke.openStringMidi[4]).toBe(67); // G4, higher than C4
    expect(uke.openStringMidi[3]).toBe(60);
    expect(uke.openStringMidi[4]).toBeGreaterThan(uke.openStringMidi[3]);
  });

  it('embeds instrumentId in custom tuning ids', () => {
    const midi = { 4: 50, 3: 55, 2: 59, 1: 64 };
    const id = customTuningId('ukulele4', midi);
    expect(id).toContain('ukulele4');
    expect(id).not.toBe(customTuningId('bass4', midi));
    expect(makeCustomTuning('bass4', midi).instrumentId).toBe('bass4');
  });

  it('builds 4-string and 7-string decks without hardcoding 6', () => {
    const uke = buildTargets(getTuning('ukulele4-standard'), { minFret: 0, maxFret: 12 });
    expect(new Set(uke.map((t) => t.stringNumber))).toEqual(new Set([4, 3, 2, 1]));
    expect(uke).toHaveLength(4 * 13);

    const seven = buildTargets(getTuning('guitar7-standard'), { minFret: 0, maxFret: 0 });
    expect(seven.map((t) => t.stringNumber)).toEqual([7, 6, 5, 4, 3, 2, 1]);
    expect(seven.find((t) => t.stringNumber === 7)?.midiNote).toBe(35);
  });

  it('labels the two E strings on standard guitar as low/high E', () => {
    const labels = stringLabelsFor(getTuning('guitar6-standard'));
    expect(labels[6]).toBe('low E');
    expect(labels[1]).toBe('high E');
    expect(labels[5]).toBe('A');
  });

  it('filters tunings by instrument', () => {
    const bass = tuningsForInstrument('bass4');
    expect(bass.every((t) => t.instrumentId === 'bass4')).toBe(true);
    expect(bass.map((t) => t.id)).toContain('bass4-drop-d');
    expect(TUNINGS.length).toBeGreaterThan(bass.length);
  });
});
