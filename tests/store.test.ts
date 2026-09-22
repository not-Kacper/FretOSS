/**
 * Progress store + queue parity test.
 *
 * `python3 tools/gen_store_fixture.py` runs a scripted session through the real
 * main.py `ProgressStore` (py-fsrs 6.3.1, fuzzing disabled, PRNG pinned) and
 * dumps:
 *
 *   - every touched record (card / points / attempts / correct / wrong /
 *     prompt_count / timestamps / review log entries)
 *   - a compact summary of all 78 cards
 *   - the queue buckets, `queue_stats`, `select_next_target` and `next_due`
 *
 * Here the identical session is replayed through src/storage/progress-idb.ts
 * (IndexedDB via fake-indexeddb) and srs/queue.ts. It also covers the two
 * persistence acceptance criteria: a reload resumes from IndexedDB, and a
 * hard-cleared client adopts the last server-synced (or imported) blob.
 */

import 'fake-indexeddb/auto';

import { beforeEach, describe, expect, it } from 'vitest';

import { buildTargets } from '../src/deck/deck';
import { createScheduler, type Scheduler } from '../src/srs/scheduler';
import { pickCandidate, type QueueCandidate } from '../src/srs/queue';
import { Rating, type CardRecord } from '../src/srs/types';
import { ProgressStore } from '../src/storage/progress-idb';
import type { FretboardTarget } from '../src/deck/types';
import fixture from './store-fixture.json';
import pythonProgress from '../progress.json';

const targets: FretboardTarget[] = buildTargets(fixture.config.deck);
const targetByKey = new Map(targets.map((target) => [target.key, target]));

function buildFixtureScheduler(): Scheduler {
  return createScheduler({
    ...fixture.config.srs,
    enable_fuzzing: false,
  });
}

/** The TS mirror of the fixture generator's `summarize()`. */
function summarize(record: CardRecord) {
  const isNew = record.card.last_review == null && Math.trunc(record.attempts ?? 0) === 0;
  return {
    card: { ...record.card, due: isNew ? 'NEW_CARD_DUE' : record.card.due },
    points: record.points,
    attempts: record.attempts,
    correct: record.correct,
    wrong: record.wrong,
    prompt_count: record.prompt_count ?? 0,
    last_prompted_at: record.last_prompted_at,
    last_reviewed_at: record.last_reviewed_at,
    review_count: record.reviews?.length ?? 0,
    reviews: record.reviews ?? [],
  };
}

/** Python writes "+00:00" ISO stamps, JS writes "Z" — compare instants. */
function expectSameInstant(actual: string | null, expected: string | null, label: string): void {
  if (expected === null) {
    expect(actual, label).toBeNull();
    return;
  }
  expect(actual, label).not.toBeNull();
  if (expected === 'NEW_CARD_DUE') {
    expect(Number.isNaN(Date.parse(actual as string)), label).toBe(false);
    return;
  }
  expect(Date.parse(actual as string), label).toBe(Date.parse(expected));
}

function expectSameNumber(actual: number | null, expected: number | null, label: string): void {
  if (expected === null) {
    expect(actual, label).toBeNull();
    return;
  }
  expect(actual, label).not.toBeNull();
  const tolerance = Math.max(1e-9, Math.abs(expected) * 1e-6);
  expect(Math.abs((actual as number) - expected), label).toBeLessThanOrEqual(tolerance);
}

function expectSameRecord(actual: CardRecord, expected: ReturnType<typeof summarize>, key: string) {
  expect(actual.target.key, `${key} target.key`).toBe(key);
  expect(actual.card.card_id, `${key} card_id`).toBe(expected.card.card_id);
  expect(actual.card.state, `${key} state`).toBe(expected.card.state);
  expect(actual.card.step, `${key} step`).toBe(expected.card.step);
  expectSameNumber(actual.card.stability, expected.card.stability, `${key} stability`);
  expectSameNumber(actual.card.difficulty, expected.card.difficulty, `${key} difficulty`);
  expectSameInstant(actual.card.due, expected.card.due, `${key} due`);
  expectSameInstant(actual.card.last_review, expected.card.last_review, `${key} last_review`);

  expect(actual.points, `${key} points`).toBe(expected.points);
  expect(actual.attempts, `${key} attempts`).toBe(expected.attempts);
  expect(actual.correct, `${key} correct`).toBe(expected.correct);
  expect(actual.wrong, `${key} wrong`).toBe(expected.wrong);
  expect(actual.prompt_count ?? 0, `${key} prompt_count`).toBe(expected.prompt_count);
  expectSameInstant(actual.last_prompted_at, expected.last_prompted_at, `${key} last_prompted_at`);
  expectSameInstant(actual.last_reviewed_at, expected.last_reviewed_at, `${key} last_reviewed_at`);

  const reviews = actual.reviews ?? [];
  expect(reviews.length, `${key} review count`).toBe(expected.review_count);
  reviews.forEach((entry, index) => {
    const want = expected.reviews[index];
    expect(entry.card_id, `${key} review ${index} card_id`).toBe(want.card_id);
    expect(entry.rating, `${key} review ${index} rating`).toBe(want.rating);
    expect(entry.review_duration, `${key} review ${index} duration`).toBe(want.review_duration);
    expect(entry.target_key, `${key} review ${index} target_key`).toBe(want.target_key);
    expectSameInstant(entry.review_datetime, want.review_datetime, `${key} review ${index} datetime`);
    if ('detected_midi_note' in want) {
      expect(entry.detected_midi_note, `${key} review ${index} detected midi`).toBe(
        want.detected_midi_note,
      );
      expect(entry.detected_note_name, `${key} review ${index} detected name`).toBe(
        want.detected_note_name,
      );
    }
  });
}

async function loadFreshStore(dbName: string): Promise<ProgressStore> {
  return ProgressStore.load(buildFixtureScheduler(), targets, {
    dbName,
    now: () => new Date(fixture.session_start),
  });
}

async function replaySession(store: ProgressStore): Promise<void> {
  for (const entry of fixture.prompted) {
    const target = targetByKey.get(entry.key);
    if (!target) throw new Error(`unknown target ${entry.key}`);
    await store.markPrompted(target, new Date(entry.at));
  }
  for (const entry of fixture.script) {
    const target = targetByKey.get(entry.key);
    if (!target) throw new Error(`unknown target ${entry.key}`);
    await store.review(
      target,
      Rating[entry.rating as keyof typeof Rating],
      new Date(entry.at),
      entry.duration_ms,
      entry.detected_midi,
    );
  }
}

let counter = 0;
const nextDbName = () => `srs-fretboard-test-${counter++}`;

describe('ProgressStore parity (main.py reference fixture)', () => {
  let store: ProgressStore;

  beforeEach(async () => {
    store = await loadFreshStore(nextDbName());
    await replaySession(store);
  });

  it('reproduces every touched record field by field', () => {
    for (const [key, expected] of Object.entries(fixture.expected.records)) {
      const target = targetByKey.get(key);
      expect(target, `target ${key}`).toBeDefined();
      expectSameRecord(store.recordFor(target as FretboardTarget), expected, key);
    }
  });

  it('reproduces the summary of all 78 cards', () => {
    const expectedAll = fixture.expected.all_cards as Record<string, ReturnType<typeof summarize>>;
    expect(store.size).toBe(Object.keys(expectedAll).length);
    for (const [key, expected] of Object.entries(expectedAll)) {
      const target = targetByKey.get(key);
      expect(target, `target ${key}`).toBeDefined();
      const actual = store.recordFor(target as FretboardTarget);
      expect(actual.card.card_id).toBe(expected.card.card_id);
      expect(actual.card.state).toBe(expected.card.state);
      expect(actual.card.step).toBe(expected.card.step);
      expectSameInstant(actual.card.due, expected.card.due, `${key} due`);
      expect(actual.attempts).toBe(expected.attempts);
      expect(actual.points).toBe(expected.points);
      expect(actual.correct).toBe(expected.correct);
      expect(actual.wrong).toBe(expected.wrong);
      expect(actual.prompt_count ?? 0).toBe(expected.prompt_count);
    }
  });

  it('classifies and orders the queue buckets identically', () => {
    const pinnedRandom = () => 0;
    const buckets = store.queueBuckets(new Date(fixture.queue_now), pinnedRandom);
    expect(buckets.learning_due.map((entry) => entry.target.key)).toEqual(
      fixture.expected.queue.learning_due,
    );
    expect(buckets.review_due.map((entry) => entry.target.key)).toEqual(
      fixture.expected.queue.review_due,
    );
    expect(buckets.new.map((entry) => entry.target.key)).toEqual(fixture.expected.queue.new);
    expect(buckets.future.map((entry) => entry.target.key)).toEqual(
      fixture.expected.queue.future,
    );
  });

  it('reports the same queue_stats', () => {
    const stats = store.queueStats(
      new Date(fixture.queue_now),
      fixture.expected.selection.allowance,
      0,
      () => 0,
    );
    expect(stats).toEqual({
      learningDue: fixture.expected.queue.stats.learning_due,
      reviewDue: fixture.expected.queue.stats.review_due,
      newAvailable: fixture.expected.queue.stats.new_available,
      newTotal: fixture.expected.queue.stats.new_total,
      future: fixture.expected.queue.stats.future,
      available: fixture.expected.queue.stats.available,
    });
  });

  it('reproduces every _pick_candidate() probe (window, recent-key filter, single candidate)', () => {
    const { allowance } = fixture.expected.selection;
    const at = new Date(fixture.queue_now);
    const pinnedRandom = () => 0;
    const buckets = store.queueBuckets(at, pinnedRandom);

    for (const probe of fixture.expected.selection.probes) {
      if (probe.name === 'single_candidate') {
        // Python calls `_pick_candidate()` directly with a one-element list.
        expect(pickCandidate(buckets.learning_due.slice(0, 1), probe.random_window, new Set(), pinnedRandom).key).toBe(
          probe.expected_key,
        );
        continue;
      }
      const picked = store.selectNextTarget(
        at,
        allowance,
        0,
        probe.random_window,
        probe.recent_keys,
        pinnedRandom,
      );
      expect(picked?.key, probe.name).toBe(probe.expected_key);
    }

    // The recent-key filter must actually change the outcome in the fixture.
    const distinguished = fixture.expected.selection.probes.find(
      (probe) => probe.name === 'leading_two_recent',
    );
    expect(distinguished?.expected_key).not.toBe(fixture.expected.queue.learning_due[0]);
  });

  it('selects the same next targets and next_due', () => {
    const { allowance, recent_keys: recentKeys } = fixture.expected.selection;
    const withRecent = store.selectNextTarget(
      new Date(fixture.queue_now),
      allowance,
      0,
      fixture.config.random_candidate_window,
      recentKeys,
      () => 0,
    );
    expect(withRecent?.key).toBe(fixture.expected.selection.with_recent_keys);

    const withoutRecent = store.selectNextTarget(
      new Date(fixture.queue_now),
      allowance,
      0,
      fixture.config.random_candidate_window,
      [],
      () => 0,
    );
    expect(withoutRecent?.key).toBe(fixture.expected.selection.without_recent_keys);

    const nextDue = store.nextDue();
    const expectedNextDue = fixture.expected.next_due;
    if (expectedNextDue === null) {
      expect(nextDue).toBeNull();
    } else {
      expect(nextDue?.target.key).toBe(expectedNextDue.key);
      expect(Date.parse(nextDue?.card.due as string)).toBe(Date.parse(expectedNextDue.due));
    }
  });

  it('respects the adaptive new-card allowance (ConfigManager.new_card_allowance)', () => {
    // main.py: `initial_new_cards` now, plus one more every `new_card_interval_sec`.
    const { initial_new_cards: initial, new_card_interval_sec: interval } = fixture.config;
    const allowance = (elapsedSec: number) => store.newCardAllowance(elapsedSec, initial, interval);

    expect(allowance(0)).toBe(initial);
    expect(allowance(interval - 1)).toBe(initial);
    expect(allowance(interval)).toBe(initial + 1);
    expect(allowance(interval * 3 + 5)).toBe(initial + 3);
  });

  it('stops offering new cards once the allowance is used up', () => {
    const at = new Date(fixture.queue_now);
    const allowance = fixture.expected.selection.allowance;

    // With the allowance exhausted, the queue falls back to the due buckets.
    const exhausted = store.selectNextTarget(
      at,
      allowance,
      allowance,
      fixture.config.random_candidate_window,
      [],
      () => 0,
    );
    expect(exhausted?.key).toBe(fixture.expected.queue.learning_due[0]);
  });
});


describe('local-first persistence (IndexedDB)', () => {
  it('resumes a session after a page refresh (reload from IndexedDB)', async () => {
    const dbName = nextDbName();
    const first = await loadFreshStore(dbName);
    await replaySession(first);
    const before = first.toProgressFile();
    first.close();

    // A page refresh re-opens the same database.
    const reloaded = await loadFreshStore(dbName);
    const after = reloaded.toProgressFile();

    expect(after.version).toBe(before.version);
    expect(Object.keys(after.cards).sort()).toEqual(Object.keys(before.cards).sort());
    for (const [key, record] of Object.entries(before.cards)) {
      const reloadedRecord = after.cards[key];
      expect(reloadedRecord.card.state, `${key} state`).toBe(record.card.state);
      expect(reloadedRecord.card.due, `${key} due`).toBe(record.card.due);
      expect(reloadedRecord.attempts, `${key} attempts`).toBe(record.attempts);
      expect(reloadedRecord.points, `${key} points`).toBe(record.points);
      expect(reloadedRecord.reviews?.length ?? 0, `${key} reviews`).toBe(record.reviews?.length ?? 0);
    }
    reloaded.close();
  });

  it('adopts the last synced blob after the local database is hard-cleared', async () => {
    const dbName = nextDbName();
    const first = await loadFreshStore(dbName);
    await replaySession(first);
    const synced = first.toProgressFile(); // what sync.ts would have PUT
    first.close();

    // Hard clear: a brand-new IndexedDB (private window / cleared storage).
    const cleared = await loadFreshStore(nextDbName());
    const emptyState = cleared.toProgressFile();
    expect(
      Object.values(emptyState.cards).every((record) => Math.trunc(record.attempts ?? 0) === 0),
    ).toBe(true);

    // ...then pull: the server copy is applied verbatim.
    await cleared.importProgressFile(synced);
    const restored = cleared.toProgressFile();

    const expectedAll = fixture.expected.all_cards as Record<string, ReturnType<typeof summarize>>;
    for (const [key, expected] of Object.entries(expectedAll)) {
      const target = targetByKey.get(key) as FretboardTarget;
      expectSameRecord(cleared.recordFor(target), expected, key);
    }
    expect(Object.keys(restored.cards).length).toBe(Object.keys(expectedAll).length);
    cleared.close();
  });

  it('can import a progress.json written by the Python app', async () => {
    const store = await loadFreshStore(nextDbName());
    await store.importProgressFile(pythonProgress as never);

    // progress.json in this repo has 78 cards, 11 of them reviewed.
    const reviewed = Object.values(store.toProgressFile().cards).filter(
      (record) => (record.reviews?.length ?? 0) > 0,
    );
    expect(reviewed.length).toBe(11);

    const s4f01 = targetByKey.get('s4_f01') as FretboardTarget;
    const record = store.recordFor(s4f01);
    expect(record.attempts).toBeGreaterThan(0);
    expect(record.card.state).toBeGreaterThanOrEqual(1);
    expect(record.card.last_review).not.toBeNull();

    // Py-fsrs wrote "+00:00" timestamps; the store must read them as instants.
    expect(Number.isNaN(Date.parse(record.card.last_review as string))).toBe(false);
    expect(store.isNew(targetByKey.get('s6_f00') as FretboardTarget)).toBe(true);
    store.close();
  });
});

describe('queue helpers', () => {
  it('pickCandidate prefers candidates that were not just shown', () => {
    const make = (key: string): QueueCandidate =>
      ({
        target: { key, cardId: 1, stringNumber: 1, stringLabel: 'high E', fret: 0, midiNote: 64, noteName: 'E4', pitchClass: 'E' },
        record: { points: 0, attempts: 0, prompt_count: 0 },
        card: { card_id: 1, state: 1, step: 0, stability: null, difficulty: null, due: new Date().toISOString(), last_review: null },
        retrievability: 0,
      }) as QueueCandidate;

    const pool = [make('a'), make('b'), make('c')];
    expect(pickCandidate(pool, 8, new Set(['a', 'b']), () => 0).key).toBe('c');
    expect(pickCandidate(pool, 8, new Set(), () => 0).key).toBe('a');
    expect(pickCandidate(pool, 1, new Set(['a']), () => 0).key).toBe('a');
  });
});
