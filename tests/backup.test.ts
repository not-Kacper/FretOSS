import 'fake-indexeddb/auto';

import { describe, expect, it } from 'vitest';

import { buildTargets } from '../src/deck/deck';
import { createScheduler } from '../src/srs/scheduler';
import { Rating } from '../src/srs/types';
import { applyImport, backupFilename, parseBackupFile, inspectImport } from '../src/storage/backup';
import { USER_TOKEN_KEY } from '../src/storage/identity';
import { ProgressStore } from '../src/storage/progress-idb';

function token(fill = 'ab'): string {
  return fill.repeat(32).slice(0, 64);
}

describe('backup JSON', () => {
  it('names the download srs-fretboard-backup-YYYY-MM-DD.json', () => {
    expect(backupFilename(new Date('2026-09-22T12:00:00Z'))).toBe('srs-fretboard-backup-2026-09-22.json');
  });

  it('rejects malformed files before writing anything', () => {
    expect(() => parseBackupFile(null)).toThrow(/JSON object/);
    expect(() => parseBackupFile({ format: 'srs-fretboard-backup' })).toThrow(/decks/);
    expect(() => parseBackupFile({ hello: true })).toThrow(/not an SRS fretboard backup/);
  });

  it('accepts a legacy progress.json as the guitar6-standard deck', () => {
    const parsed = parseBackupFile({
      version: 1,
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-02T00:00:00.000Z',
      scheduler: {
        parameters: [],
        desired_retention: 0.9,
        learning_steps: [60],
        relearning_steps: [60],
        maximum_interval: 36500,
        enable_fuzzing: false,
      },
      cards: {
        s6_f00: {
          target: { key: 's6_f00', card_id: 6000, string: 6, string_label: 'low E', fret: 0, midi_note: 40, note_name: 'E2', pitch_class: 'E' },
          card: { card_id: 6000, state: 1, step: 0, stability: null, difficulty: null, due: '2026-01-01T00:00:00.000Z', last_review: null },
          points: 0,
          attempts: 0,
          correct: 0,
          wrong: 0,
          prompt_count: 0,
          last_prompted_at: null,
          last_reviewed_at: null,
          reviews: [],
        },
      },
    });
    expect(parsed.decks['guitar6-standard']).toBeDefined();
    expect(parsed.user_token).toBe('');
  });

  it('never silently overwrites conflicting cards', async () => {
    const dbName = `backup-test-${Math.random().toString(16).slice(2)}`;
    const targets = buildTargets({ strings: [6], frets: [0] });
    const store = await ProgressStore.load(createScheduler({ enable_fuzzing: false }), targets, {
      dbName,
      deckId: 'guitar6-standard',
    });
    await store.review(targets[0], Rating.Easy, new Date('2026-01-01T00:00:00.000Z'), 200, 40);
    const localPoints = store.statsFor(targets[0]).points;
    store.close();

    const imported = parseBackupFile({
      format: 'srs-fretboard-backup',
      version: 1,
      exported_at: '2026-01-02T00:00:00.000Z',
      user_token: token('cd'),
      decks: {
        'guitar6-standard': {
          version: 1,
          created_at: '2026-01-01T00:00:00.000Z',
          updated_at: '2026-01-02T00:00:00.000Z',
          scheduler: {
            parameters: [],
            desired_retention: 0.9,
            learning_steps: [60],
            relearning_steps: [60],
            maximum_interval: 36500,
            enable_fuzzing: false,
          },
          cards: {
            s6_f00: {
              target: {
                key: 's6_f00',
                card_id: 6000,
                string: 6,
                string_label: 'low E',
                fret: 0,
                midi_note: 40,
                note_name: 'E2',
                pitch_class: 'E',
              },
              card: {
                card_id: 6000,
                state: 2,
                step: null,
                stability: 9,
                difficulty: 1,
                due: '2026-02-01T00:00:00.000Z',
                last_review: '2026-01-02T00:00:00.000Z',
              },
              points: 99,
              attempts: 9,
              correct: 9,
              wrong: 0,
              prompt_count: 9,
              last_prompted_at: null,
              last_reviewed_at: '2026-01-02T00:00:00.000Z',
              reviews: [],
            },
          },
        },
      },
    });

    const plan = await inspectImport(imported, dbName);
    expect(plan.conflicts).toBeGreaterThan(0);

    await applyImport(imported, 'keep-local', dbName);
    const kept = await ProgressStore.load(createScheduler({ enable_fuzzing: false }), targets, {
      dbName,
      deckId: 'guitar6-standard',
    });
    expect(kept.statsFor(targets[0]).points).toBe(localPoints);
    kept.close();

    await applyImport(imported, 'overwrite', dbName);
    const overwritten = await ProgressStore.load(createScheduler({ enable_fuzzing: false }), targets, {
      dbName,
      deckId: 'guitar6-standard',
    });
    expect(overwritten.statsFor(targets[0]).points).toBe(99);
    overwritten.close();
  });

  it('includes the user token in the backup shape', () => {
    const previous = (globalThis as { localStorage?: Storage }).localStorage;
    const map = new Map<string, string>([[USER_TOKEN_KEY, token('ef')]]);
    (globalThis as { localStorage?: unknown }).localStorage = {
      getItem: (key: string) => map.get(key) ?? null,
      setItem: (key: string, value: string) => void map.set(key, value),
      removeItem: (key: string) => void map.delete(key),
    };
    try {
      const parsed = parseBackupFile({
        format: 'srs-fretboard-backup',
        version: 1,
        exported_at: '2026-01-01T00:00:00.000Z',
        user_token: token('ef'),
        decks: {},
      });
      expect(parsed.user_token).toBe(token('ef'));
    } finally {
      (globalThis as { localStorage?: unknown }).localStorage = previous;
    }
  });
});
