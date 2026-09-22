/**
 * srs/queue.ts — port of `ProgressStore`'s queue logic from main.py.
 *
 *   ProgressStore._queue_buckets   -> queueBuckets()
 *   ProgressStore.select_next_target -> selectNextTarget()
 *   ProgressStore.queue_stats      -> queueStats()
 *   ProgressStore._pick_candidate  -> pickCandidate()
 *   ProgressStore._learning_priority / _review_priority / _new_priority
 *   ConfigManager.new_card_allowance -> newCardAllowance()
 *
 * Everything in here is pure: the IDB-backed store (src/storage/progress-idb.ts)
 * owns the records and calls into these functions, exactly like the Python
 * class does.
 */

import type { Scheduler } from './scheduler';
import { State, type CardDict, type QueueStats } from './types';
import type { FretboardTarget } from '../deck/types';

/** One entry of a queue bucket: `(target, record, card, retrievability)`. */
export interface QueueCandidate {
  target: FretboardTarget;
  record: QueueRecordView;
  card: CardDict;
  retrievability: number;
}

/** The record fields the queue cares about (see CardRecord). */
export interface QueueRecordView {
  points: number;
  attempts: number;
  prompt_count: number;
}

export interface QueueBuckets {
  learning_due: QueueCandidate[];
  review_due: QueueCandidate[];
  new: QueueCandidate[];
  future: QueueCandidate[];
}

/**
 * main.py: `ConfigManager.new_card_allowance(session_elapsed_sec)`.
 *
 * `initial_new_cards` at the start of a session, plus one more every
 * `new_card_interval_sec` of practice time.
 */
export function newCardAllowance(
  sessionElapsedSec: number,
  initialNewCards: number,
  newCardIntervalSec: number,
): number {
  const extra = Math.floor(Math.max(0, sessionElapsedSec) / newCardIntervalSec);
  return initialNewCards + extra;
}

/**
 * main.py: `ProgressStore._is_new_card(record, card)`.
 *
 * A card is "new" until it has been reviewed *and* the record has attempts.
 */
export function isNewCard(card: CardDict, record: QueueRecordView): boolean {
  return card.last_review == null && Math.trunc(record.attempts ?? 0) === 0;
}

/**
 * main.py: `ProgressStore._queue_buckets(now)` — classify + sort every target.
 *
 * Buckets, in scheduling order:
 *   learning_due — overdue cards in Learning / Relearning (short-term steps)
 *   review_due   — overdue Review cards
 *   new          — never reviewed
 *   future       — scheduled ahead (used for "next due" reporting)
 */
export function queueBuckets(
  targets: FretboardTarget[],
  recordFor: (target: FretboardTarget) => QueueRecordView,
  cardFor: (target: FretboardTarget) => CardDict,
  scheduler: Scheduler,
  now: Date,
  /** Source of randomness (Python used `random.random()`); injectable for tests. */
  random: () => number = Math.random,
): QueueBuckets {
  const buckets: QueueBuckets = {
    learning_due: [],
    review_due: [],
    new: [],
    future: [],
  };

  for (const target of targets) {
    const record = recordFor(target);
    const card = cardFor(target);
    const retrievability = scheduler.getCardRetrievability(card, now);
    const candidate: QueueCandidate = { target, record, card, retrievability };

    if (isNewCard(card, record)) {
      buckets.new.push(candidate);
    } else if (dueOf(card) <= now.getTime() && isLearningState(card.state)) {
      buckets.learning_due.push(candidate);
    } else if (dueOf(card) <= now.getTime()) {
      buckets.review_due.push(candidate);
    } else {
      buckets.future.push(candidate);
    }
  }

  // Python sorts with an explicit key (`list.sort(key=...)`), so each element's
  // key list is computed exactly once — including the random tie-breaker in
  // `_new_priority`. `sortByKeys` reproduces that (and the stable ordering) by
  // decorating first instead of recomputing keys inside the comparator.
  sortByKeys(buckets.learning_due, learningPriority);
  sortByKeys(buckets.review_due, reviewPriority);
  sortByKeys(buckets.new, (candidate) => newPriority(candidate, random));
  sortByKeys(buckets.future, (candidate) => [dueOf(candidate.card)]);
  return buckets;
}

function isLearningState(state: number): boolean {
  return state === State.Learning || state === State.Relearning;
}

function dueOf(card: CardDict): number {
  return new Date(card.due).getTime();
}

/**
 * Port of Python's `list.sort(key=keyFn)` for tuple keys: compares each key in
 * turn and is stable (ties keep the deck order, like Python's Timsort).
 *
 * Computing the keys up-front matters for `_new_priority`, whose key contains a
 * random tie-breaker: Python draws that value once per element, and the
 * comparison must stay consistent.
 */
function sortByKeys(
  candidates: QueueCandidate[],
  keyFn: (candidate: QueueCandidate) => number[],
): void {
  const decorated = candidates.map((candidate, index) => ({
    candidate,
    key: keyFn(candidate),
    index,
  }));
  decorated.sort((a, b) => {
    for (let i = 0; i < a.key.length; i++) {
      if (a.key[i] < b.key[i]) return -1;
      if (a.key[i] > b.key[i]) return 1;
    }
    return a.index - b.index;
  });
  candidates.splice(0, candidates.length, ...decorated.map((entry) => entry.candidate));
}

/** main.py: `ProgressStore._learning_priority`. */
export function learningPriority(candidate: QueueCandidate): number[] {
  return [
    dueOf(candidate.card),
    Math.trunc(candidate.record.points ?? 0),
    candidate.retrievability,
    Math.trunc(candidate.record.attempts ?? 0),
    candidate.target.stringNumber,
    candidate.target.fret,
  ];
}

/** main.py: `ProgressStore._review_priority` (lowest retrievability first). */
export function reviewPriority(candidate: QueueCandidate): number[] {
  return [
    candidate.retrievability,
    dueOf(candidate.card),
    Math.trunc(candidate.record.points ?? 0),
    Math.trunc(candidate.record.attempts ?? 0),
    candidate.target.stringNumber,
    candidate.target.fret,
  ];
}

/**
 * main.py: `ProgressStore._new_priority` — least-prompted first, then points,
 * then a random tie-breaker so new cards come up in an arbitrary order.
 */
export function newPriority(
  candidate: QueueCandidate,
  random: () => number = Math.random,
): number[] {
  return [
    Math.trunc(candidate.record.prompt_count ?? 0),
    Math.trunc(candidate.record.points ?? 0),
    random(),
    candidate.target.stringNumber,
    candidate.target.fret,
  ];
}

/**
 * main.py: `ProgressStore._pick_candidate(candidates, random_window, recent_keys)`.
 *
 * Picks randomly from the first `random_window` candidates, preferring ones the
 * session has not just shown.
 */
export function pickCandidate(
  candidates: QueueCandidate[],
  randomWindow: number,
  recentKeys: Set<string>,
  random: () => number = Math.random,
): FretboardTarget {
  if (candidates.length === 1) return candidates[0].target;

  let pool = candidates.slice(0, Math.min(randomWindow, candidates.length));
  const withoutRecent = pool.filter((candidate) => !recentKeys.has(candidate.target.key));
  if (withoutRecent.length > 0) pool = withoutRecent;

  const index = Math.floor(random() * pool.length);
  return pool[Math.min(index, pool.length - 1)].target;
}

/**
 * main.py: `ProgressStore.select_next_target(...)`.
 *
 * Priority: due learning cards -> due review cards -> new cards (only while the
 * adaptive new-card allowance has not been used up). `null` means "nothing to
 * study right now".
 */
export function selectNextTarget(
  buckets: QueueBuckets,
  newCardsAllowed: number,
  newCardsStarted: number,
  randomWindow: number,
  recentKeys: string[] = [],
  random: () => number = Math.random,
): FretboardTarget | null {
  const recent = new Set(recentKeys);

  if (buckets.learning_due.length > 0) {
    return pickCandidate(buckets.learning_due, randomWindow, recent, random);
  }
  if (buckets.review_due.length > 0) {
    return pickCandidate(buckets.review_due, randomWindow, recent, random);
  }
  if (newCardsStarted < newCardsAllowed && buckets.new.length > 0) {
    return pickCandidate(buckets.new, randomWindow, recent, random);
  }
  return null;
}

/** main.py: `ProgressStore.queue_stats(now, new_cards_allowed, new_cards_started)`. */
export function queueStats(
  buckets: QueueBuckets,
  newCardsAllowed: number,
  newCardsStarted: number,
): QueueStats {
  const newRemaining = Math.max(0, newCardsAllowed - newCardsStarted);
  const learningDue = buckets.learning_due.length;
  const reviewDue = buckets.review_due.length;
  const newAvailable = Math.min(newRemaining, buckets.new.length);
  return {
    learningDue,
    reviewDue,
    newAvailable,
    newTotal: buckets.new.length,
    future: buckets.future.length,
    available: learningDue + reviewDue + newAvailable,
  };
}

/**
 * main.py: `ProgressStore.next_due()` — the soonest-due card that has already
 * been reviewed (used for the "next due at ..." message).
 */
export function nextDue(
  targets: FretboardTarget[],
  recordFor: (target: FretboardTarget) => QueueRecordView,
  cardFor: (target: FretboardTarget) => CardDict,
): { target: FretboardTarget; card: CardDict } | null {
  const upcoming: { target: FretboardTarget; card: CardDict }[] = [];
  for (const target of targets) {
    const record = recordFor(target);
    const card = cardFor(target);
    if (!isNewCard(card, record)) upcoming.push({ target, card });
  }
  if (upcoming.length === 0) return null;
  upcoming.sort((a, b) => dueOf(a.card) - dueOf(b.card));
  return upcoming[0];
}
