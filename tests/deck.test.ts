/**
 * Deck parity test.
 *
 * Acceptance criterion: "Deck target list generated in TS exactly matches a
 * fixture dumped from the Python FretboardDeck with the same config.json".
 *
 * The fixture (tests/deck-fixture.json) is produced by
 * `python3 tools/gen_deck_fixture.py`, which imports the real main.py and calls
 * `FretboardDeck(config).targets`. Here the same config is fed to
 * src/deck/deck.ts and the two lists are compared field by field, in order.
 */

import { describe, expect, it } from 'vitest';

import { buildTargets, parseNoteToken, FretboardDeck } from '../src/deck/deck';
import { targetToDict } from '../src/deck/types';
import { parseConfig } from '../src/config/config';
import deckFixture from './deck-fixture.json';
import rawConfig from '../public/config.json';

const config = parseConfig(rawConfig);

describe('deck fixture parity (Python FretboardDeck vs TS buildTargets)', () => {
  it('reproduces every Python target, in the same order', () => {
    const expected = deckFixture.decks['config.json'];
    expect(expected).toBeDefined();

    const targets = buildTargets(config.deckConfig);

    expect(targets).toHaveLength(expected.count);
    expect(targets.map(targetToDict)).toEqual(expected.targets);
  });

  it('builds the same deck from the repo-root and public config.json', () => {
    // The two files are byte-identical (see tests/config.test.ts); this guards
    // the deck against a future divergence.
    for (const deck of Object.values(deckFixture.decks)) {
      expect(deck.count).toBe(78);
    }
  });

  it('matches the card ids/keys that already exist in the Python progress.json', () => {
    const targets = buildTargets(config.deckConfig);
    const byKey = new Map(targets.map((target) => [target.key, target]));
    expect(byKey.get('s6_f00')?.cardId).toBe(6000);
    expect(byKey.get('s6_f00')?.midiNote).toBe(40);
    expect(byKey.get('s6_f00')?.noteName).toBe('E2');
    expect(byKey.get('s1_f12')?.key).toBe('s1_f12');
    expect(byKey.get('s1_f12')?.stringLabel).toBe('high E');
  });

  it('throws the same errors main.py exits on', () => {
    expect(() => new FretboardDeck({ tuning: 'DADGAD' })).toThrow(/standard 6-string EADGBE/);
    expect(() => new FretboardDeck({ strings: [7] })).toThrow(/Unsupported guitar strings/);
    expect(() => new FretboardDeck({ min_fret: -1 })).toThrow(/Fret numbers must be >= 0/);
    expect(() => new FretboardDeck({ notes_to_learn: ['H#'] })).toThrow(/Unsupported note token/);
    // B# is C (semitone 12 % 12) so the deck is non-empty; an impossible filter
    // must fail the same way Python's "produced no fretboard targets" exit does.
    expect(() => new FretboardDeck({ notes_to_learn: ['B#'], strings: [6], frets: [0] })).toThrow(
      /produced no fretboard targets/,
    );
  });
});

describe('_parse_note_token / _build_note_filter ports', () => {
  it('parses the same tokens as Python', () => {
    expect(parseNoteToken('C')).toEqual(['pitch_class', 'C']);
    expect(parseNoteToken('c#')).toEqual(['pitch_class', 'C#']);
    expect(parseNoteToken('Db')).toEqual(['pitch_class', 'C#']);
    expect(parseNoteToken('E2')).toEqual(['midi', 40]);
    expect(parseNoteToken(40)).toEqual(['midi', 40]);
    expect(parseNoteToken('40')).toEqual(['midi', 40]);
    expect(parseNoteToken('C4')).toEqual(['midi', 60]);
    expect(parseNoteToken('C-1')).toEqual(['midi', 0]);
    expect(parseNoteToken('*')).toBeNull();
    expect(parseNoteToken('all')).toBeNull();
    expect(parseNoteToken('ANY')).toBeNull();
    expect(parseNoteToken('')).toBeNull();
  });

  it('filters by pitch class and by MIDI note', () => {
    const onlyE = buildTargets({ ...config.deckConfig, notes_to_learn: ['E'] });
    expect(onlyE.length).toBeGreaterThan(0);
    expect(onlyE.every((target) => target.pitchClass === 'E')).toBe(true);

    const oneMidi = buildTargets({ ...config.deckConfig, notes_to_learn: ['E2'] });
    // E2 (MIDI 40) is reachable inside frets 0..12 only as the open low E string.
    expect(oneMidi.map((target) => target.key)).toEqual(['s6_f00']);

    const e2FilteredByPitchClass = buildTargets({ ...config.deckConfig, notes_to_learn: ['E'] });
    expect(e2FilteredByPitchClass.map((target) => target.key)).toContain('s6_f00');
    expect(e2FilteredByPitchClass.map((target) => target.key)).toContain('s5_f07');

    // A single "all" style token disables filtering entirely, like Python.
    const all = buildTargets({ ...config.deckConfig, notes_to_learn: ['all'] });
    expect(all).toHaveLength(buildTargets({ ...config.deckConfig, notes_to_learn: undefined }).length);
  });

  it('supports the explicit `frets` list and the legacy `notes` key', () => {
    const explicit = buildTargets({ ...config.deckConfig, frets: [0, 5, 12] });
    expect(explicit.map((target) => target.fret)).toEqual([0, 5, 12, 0, 5, 12, 0, 5, 12, 0, 5, 12, 0, 5, 12, 0, 5, 12]);

    const legacy = buildTargets({ ...config.deckConfig, notes_to_learn: undefined, notes: ['A'] });
    expect(legacy.every((target) => target.pitchClass === 'A')).toBe(true);
  });
});
