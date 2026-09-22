/**
 * FSRS parity test.
 *
 * Acceptance criterion: "FSRS ratings/intervals from ts-fsrs match py-fsrs
 * behavior for the same parameter set and review sequence".
 *
 * tests/fsrs-fixture.json is a py-fsrs 6.3.1 reference run (see
 * `python3 tools/gen_fsrs_fixture.py`) covering every branch of
 * `Scheduler.review_card()`: new cards, both learning steps, graduation,
 * same-day (short-term) reviews, review recalls/forgets, relearning steps,
 * Easy/Hard handling and multi-year intervals.
 *
 * Two passes are checked:
 *   1. fuzzing disabled — every field must match the Python reference exactly;
 *   2. fuzzing enabled  — memory state must still match exactly and the due
 *      date must fall inside the range py-fsrs's fuzzer would have drawn from
 *      (py-fsrs draws from `random()`, so the *value* is not reproducible by
 *      design; the range must be).
 */

import { describe, expect, it } from 'vitest';

import { createScheduler, elapsedDays, type Scheduler } from '../src/srs/scheduler';
import { Rating, State, type CardDict } from '../src/srs/types';
import fixture from './fsrs-fixture.json';

const cfg = fixture.config;

function buildScheduler(enableFuzzing: boolean): Scheduler {
  return createScheduler({
    parameters: cfg.parameters,
    desired_retention: cfg.desired_retention,
    learning_steps_minutes: cfg.learning_steps_minutes,
    relearning_steps_minutes: cfg.relearning_steps_minutes,
    maximum_interval_days: cfg.maximum_interval_days,
    enable_fuzzing: enableFuzzing,
  });
}

/**
 * ts-fsrs rounds its memory-state outputs to 8 decimals (py-fsrs keeps full
 * float64), so a stored stability of ~18 carries an absolute error up to ~2e-7
 * after a few hundred days of simulated history. Anything above a *relative*
 * 1e-6 would mean a different formula or branch (which changes these values by
 * >= 1%), so that is the bound used here.
 */
function expectClose(actual: number | null, expected: number | null, label: string): void {
  expect(actual, label).not.toBeNull();
  const tolerance = Math.max(1e-7, Math.abs(expected as number) * 1e-6);
  expect(Math.abs((actual as number) - (expected as number)), label).toBeLessThanOrEqual(tolerance);
}

const RATING_BY_NAME: Record<string, Rating> = {
  Again: Rating.Again,
  Hard: Rating.Hard,
  Good: Rating.Good,
  Easy: Rating.Easy,
};

function freshCard(): CardDict {
  return {
    card_id: fixture.card_id,
    state: State.Learning,
    step: 0,
    stability: null,
    difficulty: null,
    due: fixture.base_time,
    last_review: null,
  };
}

describe('py-fsrs parity (fsrs==6.3.1 reference fixture)', () => {
  it('replays the reference sequence with identical cards (fuzzing disabled)', () => {
    const scheduler = buildScheduler(false);
    let card = freshCard();
    let at = new Date(fixture.base_time);

    for (const step of fixture.steps) {
      at = new Date(at.getTime() + step.delta_seconds_from_previous * 1000);
      const result = scheduler.reviewCard(card, RATING_BY_NAME[step.rating], at, 1234);
      card = result.card;

      expect(card.state, `step ${step.index} state`).toBe(step.card.state);
      expect(card.step, `step ${step.index} step`).toBe(step.card.step);
      expectClose(card.stability, step.card.stability, `step ${step.index} stability`);
      expectClose(card.difficulty, step.card.difficulty, `step ${step.index} difficulty`);
      expect(new Date(card.due).getTime(), `step ${step.index} due`).toBe(
        new Date(step.card.due).getTime(),
      );
      // Python writes "+00:00", JS writes "Z"/milliseconds — the instant is what matters.
      expect(Date.parse(card.last_review as string)).toBe(Date.parse(step.card.last_review as string));
      // `intervalMs` is the exact scheduled delta (minutes for learning steps,
      // whole days for Review intervals).
      expect(new Date(card.due).getTime() - at.getTime()).toBe(result.intervalMs);
      if (card.state === State.Review) {
        expect(result.intervalMs / 86_400_000).toBe(step.interval_days_unfuzzed);
      }
    }
  });

  it('produces the same review log shape as fsrs.ReviewLog.to_dict()', () => {
    const scheduler = buildScheduler(false);
    const at = new Date(fixture.base_time);
    const { reviewLog } = scheduler.reviewCard(freshCard(), Rating.Good, at, 4321);

    expect(Object.keys(reviewLog).sort()).toEqual([
      'card_id',
      'rating',
      'review_datetime',
      'review_duration',
      'target_key',
    ]);
    expect(reviewLog.card_id).toBe(fixture.card_id);
    expect(reviewLog.rating).toBe(Rating.Good);
    expect(Date.parse(reviewLog.review_datetime)).toBe(at.getTime());
    expect(reviewLog.review_duration).toBe(4321);
  });

  it('never schedules a card before its review time', () => {
    const scheduler = buildScheduler(true);
    const at = new Date('2026-03-01T12:00:00Z');
    const { card } = scheduler.reviewCard(freshCard(), Rating.Again, at, null);
    expect(new Date(card.due).getTime()).toBeGreaterThan(at.getTime());
  });

  it('keeps the memory state identical and fuzz inside py-fsrs range (fuzzing enabled)', () => {
    const scheduler = buildScheduler(true);
    let card = freshCard();
    let at = new Date(fixture.base_time);

    for (const step of fixture.steps) {
      at = new Date(at.getTime() + step.delta_seconds_from_previous * 1000);
      const { card: next } = scheduler.reviewCard(card, RATING_BY_NAME[step.rating], at, null);
      card = next;

      expectClose(card.stability, step.card.stability, `step ${step.index} stability`);
      expectClose(card.difficulty, step.card.difficulty, `step ${step.index} difficulty`);
      expect(card.state, `step ${step.index} state`).toBe(step.card.state);

      const intervalDays = Math.round((new Date(card.due).getTime() - at.getTime()) / 86_400_000);
      const [minIvl, maxIvl] = step.fuzz_range_days;
      expect(intervalDays, `step ${step.index} fuzzed interval`).toBeGreaterThanOrEqual(minIvl);
      expect(intervalDays, `step ${step.index} fuzzed interval`).toBeLessThanOrEqual(maxIvl);
    }
  });
});

describe('time arithmetic matches Python timedelta semantics', () => {
  it('floors elapsed days towards negative infinity, like timedelta.days', () => {
    const start = new Date('2026-01-05T23:30:00Z');
    // 2h later → still the same "day" in Python's exact-timedelta arithmetic
    expect(elapsedDays(start, new Date('2026-01-06T01:30:00Z'))).toBe(0);
    // 26h later → exactly one day
    expect(elapsedDays(start, new Date('2026-01-07T01:30:00Z'))).toBe(1);
    // a review dated before the last review floors to -1 (as in Python)
    expect(elapsedDays(start, new Date('2026-01-05T22:30:00Z'))).toBe(-1);
  });

  it('treats same-day reviews through the short-term formula', () => {
    const scheduler = buildScheduler(false);
    const reviewed = new Date('2026-01-05T20:00:00Z');
    const first = scheduler.reviewCard(freshCard(), Rating.Good, reviewed, null).card;

    // Long-term path (>= 1 day later).
    const laterDay = new Date(reviewed.getTime() + 86_400_000 + 3_600_000);
    const longTerm = scheduler.reviewCard(first, Rating.Good, laterDay, null).card;

    // Short-term path (same day, 2 hours later) must use the short-term formula
    // and therefore produce a different stability for the same card.
    const sameDay = new Date(reviewed.getTime() + 2 * 3_600_000);
    const shortTerm = scheduler.reviewCard(first, Rating.Good, sameDay, null).card;

    expect(shortTerm.stability).not.toBeCloseTo(longTerm.stability as number, 6);
    expect(shortTerm.due).not.toBe(longTerm.due);
  });
});
