/**
 * srs/scheduler.ts — ts-fsrs wrapper: port of `ConfigManager.create_scheduler()`
 * and `ProgressStore.review()`'s rating logic.
 * =============================================================================
 *
 * Why a hand-written `reviewCard()` instead of `fsrs().next()`:
 *
 * py-fsrs (the reference implementation) and ts-fsrs agree on all FSRS-6 maths
 * (stability/difficulty/interval formulas, fuzz ranges, retention curve) — this
 * module reuses ts-fsrs's `FSRSAlgorithm` primitives for every one of those
 * formulas and never re-derives them. What they *disagree* on is the
 * learning-step bookkeeping in the surrounding scheduler:
 *
 *   - py-fsrs stores steps as `timedelta`s: `Hard` at a later step reschedules
 *     to *that step's* interval, and `Hard` at step 0 with two steps gives
 *     exactly (step0 + step1) / 2 seconds (e.g. 5m30s for [1m, 10m]).
 *   - ts-fsrs's BasicScheduler works in whole minutes and always uses the mean
 *     of the first two steps for `Hard` (6m for [1m, 10m]) regardless of the
 *     current step.
 *
 * The porting rules for this project say "port them FAITHFULLY — do not
 * simplify, reimagine or improve", and the acceptance criteria require FSRS
 * ratings/intervals to match py-fsrs for the same parameters and review
 * sequence. So `reviewCard()` below is a branch-for-branch port of
 * `fsrs.Scheduler.review_card()` (py-fsrs 6.3.1), while every numeric formula
 * comes from the ts-fsrs instance created in `createScheduler()`:
 *
 *   py-fsrs                                  ts-fsrs (used here)
 *   ───────────────────────────────────────  ──────────────────────────────────
 *   _initial_stability                       algorithm.init_stability
 *   _initial_difficulty                      algorithm.init_difficulty
 *   _next_difficulty                         algorithm.next_difficulty
 *   _next_stability / _next_recall_stability algorithm.next_recall_stability
 *   _next_forget_stability                   algorithm.next_forget_stability
 *   _short_term_stability                    algorithm.next_short_term_stability
 *   _next_interval                           algorithm.next_interval  (incl. fuzz)
 *   get_card_retrievability                  algorithm.forgetting_curve
 *   _get_fuzzed_interval                     ts-fsrs's seeded fuzzer (alea)
 *
 * Because ts-fsrs's `FSRS` instance is only used for the memory formulas, the
 * persistent card shape stays py-fsrs's (`card_id/state/step/stability/
 * difficulty/due/last_review`) and ts-fsrs's extra bookkeeping fields
 * (elapsed_days / scheduled_days / reps / lapses / learning_steps) are not
 * stored: they never influence the ported logic. `step` doubles as ts-fsrs's
 * `learning_steps`.
 *
 * Deviation worth knowing about (documented in README): py-fsrs fuzzing draws
 * from `random.random()`, so fuzzed intervals are not reproducible by design.
 * ts-fsrs's fuzzer is seeded instead (re-seeded per review from the review
 * timestamp, `reps` and the memory state — the same values ts-fsrs's own
 * DefaultInitSeedStrategy uses), which keeps the exact same fuzz *ranges* while
 * making an interval reproducible from the review time. Fuzz is only applied to
 * Review-state intervals >= 2.5 days, as in py-fsrs.
 */

import {
  createEmptyCard,
  fsrs,
  FSRS,
  generatorParameters,
  Rating as TsRating,
  State as TsState,
  type Grade as TsGrade,
} from 'ts-fsrs';

import type { CardDict, ReviewLogEntry, SchedulerDict, SrsConfig } from './types';
import { Rating, State } from './types';

const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;

/** py-fsrs: `DEFAULT_PARAMETERS` / ts-fsrs: `default_w` (FSRS-6, 21 weights). */
export const DEFAULT_PARAMETERS: readonly number[] = [
  0.212, 1.2931, 2.3065, 8.2956, 6.4133, 0.8334, 3.0194, 0.001, 1.8722, 0.1666,
  0.796, 1.4835, 0.0614, 0.2629, 1.6483, 0.6014, 1.8729, 0.5425, 0.0912, 0.0658,
  0.1542,
];

/** py-fsrs: `STABILITY_MIN`. */
const STABILITY_MIN = 0.001;
/** py-fsrs: `MIN_DIFFICULTY` / `MAX_DIFFICULTY`. */
const MIN_DIFFICULTY = 1.0;
const MAX_DIFFICULTY = 10.0;

// ---------------------------------------------------------------------------
//  Helpers — py-fsrs semantics for time arithmetic
// ---------------------------------------------------------------------------

/**
 * Python: `(a - b).days`. `timedelta.days` floors towards negative infinity
 * (timedelta(-0.5d).days === -1), which is what `Math.floor` does here.
 */
export function elapsedDays(from: Date, to: Date): number {
  return Math.floor((to.getTime() - from.getTime()) / DAY_MS);
}

function clampDifficulty(value: number): number {
  return Math.min(Math.max(value, MIN_DIFFICULTY), MAX_DIFFICULTY);
}

function clampStability(value: number): number {
  return Math.max(value, STABILITY_MIN);
}

/**
 * ts-fsrs describes learning steps as strings ("10m"/"2h"/"1d"); py-fsrs uses
 * `timedelta`s. Config keeps minutes, so the conversion is exact.
 */
function toStepStrings(stepsMs: readonly number[]): Array<`${number}m`> {
  return stepsMs.map((ms) => `${ms / MINUTE_MS}m` as const);
}

/**
 * Our `Rating` enum carries py-fsrs's values (Again=1..Easy=4, plus the
 * ts-fsrs-only Manual=0). The scheduling formulas only accept 1..4.
 */
function toGrade(rating: Rating): TsGrade {
  if (rating === Rating.Manual) {
    throw new Error('Manual ratings cannot be reviewed');
  }
  return rating as TsGrade;
}


// ---------------------------------------------------------------------------
//  Scheduler
// ---------------------------------------------------------------------------

/**
 * The subset of py-fsrs's `Scheduler` the app uses: `review_card()` and
 * `get_card_retrievability()`. Configured by `ConfigManager.create_scheduler()`.
 */
export class Scheduler {
  readonly parameters: readonly number[];
  readonly desiredRetention: number;
  /** `learning_steps`, in milliseconds (py-fsrs keeps `timedelta`s). */
  readonly learningStepsMs: readonly number[];
  /** `relearning_steps`, in milliseconds. */
  readonly relearningStepsMs: readonly number[];
  readonly maximumInterval: number;
  readonly enableFuzzing: boolean;

  /** ts-fsrs algorithm carrying the FSRS-6 maths (weights, curves, fuzzing). */
  private readonly algorithm: FSRS;
  private readonly decay: number;
  private readonly factor: number;

  constructor(options: {
    parameters?: number[];
    desiredRetention?: number;
    learningStepsMinutes?: number[];
    relearningStepsMinutes?: number[];
    maximumIntervalDays?: number;
    enableFuzzing?: boolean;
  }) {
    this.parameters = options.parameters ? [...options.parameters] : [...DEFAULT_PARAMETERS];
    this.desiredRetention = options.desiredRetention ?? 0.9;
    this.learningStepsMs = (options.learningStepsMinutes ?? [1, 10]).map((m) => m * MINUTE_MS);
    this.relearningStepsMs = (options.relearningStepsMinutes ?? [10]).map((m) => m * MINUTE_MS);
    this.maximumInterval = options.maximumIntervalDays ?? 36500;
    this.enableFuzzing = options.enableFuzzing ?? true;

    // ts-fsrs validates/clips the weights and owns the FSRS-6 formulas.
    this.algorithm = fsrs(
      generatorParameters({
        w: [...this.parameters],
        request_retention: this.desiredRetention,
        maximum_interval: this.maximumInterval,
        enable_fuzz: this.enableFuzzing,
        enable_short_term: true,
        learning_steps: toStepStrings(this.learningStepsMs),
        relearning_steps: toStepStrings(this.relearningStepsMs),
      }),
    );

    // `_DECAY = -parameters[20]`, `_FACTOR = 0.9 ** (1 / _DECAY) - 1` (py-fsrs).
    this.decay = -this.parameters[20];
    this.factor = Math.exp(Math.log(0.9) / this.decay) - 1;
  }

  /** py-fsrs: `Scheduler.to_dict()` — the `scheduler` block of progress.json. */
  toDict(): SchedulerDict {
    return {
      parameters: [...this.parameters],
      desired_retention: this.desiredRetention,
      learning_steps: this.learningStepsMs.map((ms) => Math.trunc(ms / 1000)),
      relearning_steps: this.relearningStepsMs.map((ms) => Math.trunc(ms / 1000)),
      maximum_interval: this.maximumInterval,
      enable_fuzzing: this.enableFuzzing,
    };
  }

  // -- retrievability -------------------------------------------------------

  /**
   * py-fsrs: `Scheduler.get_card_retrievability(card, current_datetime)`.
   *
   * Returns 0 when the card has never been reviewed or has no stability yet
   * (a new card). Uses whole-day elapsed time, floored at 0.
   */
  getCardRetrievability(card: CardDict, at: Date = new Date()): number {
    if (card.last_review == null || card.stability == null) return 0;
    const days = Math.max(0, elapsedDays(new Date(card.last_review), at));
    return this.retrievability(days, card.stability);
  }

  /** `(1 + FACTOR * elapsed_days / stability) ** DECAY` */
  private retrievability(days: number, stability: number): number {
    return Math.pow(1 + (this.factor * days) / stability, this.decay);
  }

  // -- review ---------------------------------------------------------------

  /**
   * py-fsrs: `Scheduler.review_card(card, rating, review_datetime, review_duration)`.
   *
   * Returns the updated card (py-fsrs `Card.to_dict()` shape) and the review log.
   */
  reviewCard(
    card: CardDict,
    rating: Rating,
    reviewDatetime: Date = new Date(),
    reviewDurationMs: number | null = null,
  ): { card: CardDict; reviewLog: ReviewLogEntry; log: ReviewLogEntry; intervalMs: number } {
    if (!(reviewDatetime instanceof Date) || Number.isNaN(reviewDatetime.getTime())) {
      throw new Error('reviewCard: review_datetime must be a valid Date');
    }

    const updated: CardDict = { ...card };
    const lastReview = card.last_review ? new Date(card.last_review) : null;
    const daysSinceLastReview = lastReview ? elapsedDays(lastReview, reviewDatetime) : null;

    // Re-seed ts-fsrs's fuzzer with the values its own default strategy uses,
    // so a fuzzed interval is reproducible for a given review timestamp.
    const reps = card.step ?? 0;
    this.algorithm.seed = `${reviewDatetime.getTime()}_${reps}_${
      (card.difficulty ?? 0) * (card.stability ?? 0)
    }`;

    const isNewCard = card.stability == null || card.difficulty == null;
    if (isNewCard) {
      updated.stability = this.initStability(rating);
      updated.difficulty = clampDifficulty(this.algorithm.init_difficulty(toGrade(rating)));
    } else if (daysSinceLastReview != null && daysSinceLastReview < 1) {
      // Same-day re-review: short-term memory formula.
      updated.stability = this.shortTermStability(card.stability as number, rating);
      updated.difficulty = this.algorithm.next_difficulty(card.difficulty as number, toGrade(rating));
    } else {
      updated.stability = this.nextStability(
        card.difficulty as number,
        card.stability as number,
        this.retrievability(Math.max(0, daysSinceLastReview ?? 0), card.stability as number),
        rating,
      );
      updated.difficulty = this.algorithm.next_difficulty(card.difficulty as number, toGrade(rating));
    }

    const state = this.effectiveState(card);
    let intervalMs: number;

    switch (state) {
      case State.Learning: {
        // py-fsrs: `step` is 0 for a new Learning card.
        const step = card.step ?? 0;
        const steps = this.learningStepsMs;
        if (steps.length === 0 || (step >= steps.length && rating !== Rating.Again)) {
          // Edge case: card was scheduled by a Scheduler with more steps.
          updated.state = State.Review;
          updated.step = null;
          intervalMs = this.nextIntervalMs(updated.stability as number, daysSinceLastReview);
        } else {
          switch (rating) {
            case Rating.Again:
              updated.state = State.Learning;
              updated.step = 0;
              intervalMs = steps[0];
              break;
            case Rating.Hard:
              // The card's step stays the same.
              updated.state = State.Learning;
              updated.step = step;
              if (step === 0 && steps.length === 1) intervalMs = steps[0] * 1.5;
              else if (step === 0 && steps.length >= 2) intervalMs = (steps[0] + steps[1]) / 2;
              else intervalMs = steps[step];
              break;
            case Rating.Good:
              if (step + 1 === steps.length) {
                updated.state = State.Review;
                updated.step = null;
                intervalMs = this.nextIntervalMs(updated.stability as number, daysSinceLastReview);
              } else {
                updated.state = State.Learning;
                updated.step = step + 1;
                intervalMs = steps[step + 1];
              }
              break;
            case Rating.Easy:
              updated.state = State.Review;
              updated.step = null;
              intervalMs = this.nextIntervalMs(updated.stability as number, daysSinceLastReview);
              break;
            default:
              throw new Error(`Unknown rating: ${rating}`);
          }
        }
        break;
      }

      case State.Review: {
        switch (rating) {
          case Rating.Again: {
            if (this.relearningStepsMs.length === 0) {
              intervalMs = this.nextIntervalMs(updated.stability as number, daysSinceLastReview);
            } else {
              updated.state = State.Relearning;
              updated.step = 0;
              intervalMs = this.relearningStepsMs[0];
            }
            break;
          }
          case Rating.Hard:
          case Rating.Good:
          case Rating.Easy:
            intervalMs = this.nextIntervalMs(updated.stability as number, daysSinceLastReview);
            break;
          default:
            throw new Error(`Unknown rating: ${rating}`);
        }
        break;
      }

      case State.Relearning: {
        const step = card.step ?? 0;
        const steps = this.relearningStepsMs;
        if (steps.length === 0 || (step >= steps.length && rating !== Rating.Again)) {
          updated.state = State.Review;
          updated.step = null;
          intervalMs = this.nextIntervalMs(updated.stability as number, daysSinceLastReview);
        } else {
          switch (rating) {
            case Rating.Again:
              updated.state = State.Relearning;
              updated.step = 0;
              intervalMs = steps[0];
              break;
            case Rating.Hard:
              updated.state = State.Relearning;
              updated.step = step;
              if (step === 0 && steps.length === 1) intervalMs = steps[0] * 1.5;
              else if (step === 0 && steps.length >= 2) intervalMs = (steps[0] + steps[1]) / 2;
              else intervalMs = steps[step];
              break;
            case Rating.Good:
              if (step + 1 === steps.length) {
                updated.state = State.Review;
                updated.step = null;
                intervalMs = this.nextIntervalMs(updated.stability as number, daysSinceLastReview);
              } else {
                updated.state = State.Relearning;
                updated.step = step + 1;
                intervalMs = steps[step + 1];
              }
              break;
            case Rating.Easy:
              updated.state = State.Review;
              updated.step = null;
              intervalMs = this.nextIntervalMs(updated.stability as number, daysSinceLastReview);
              break;
            default:
              throw new Error(`Unknown rating: ${rating}`);
          }
        }
        break;
      }

      default:
        throw new Error(`Unknown card state: ${state}`);
    }

    updated.due = new Date(reviewDatetime.getTime() + intervalMs).toISOString();
    updated.last_review = reviewDatetime.toISOString();

    const reviewLog: ReviewLogEntry = {
      card_id: card.card_id,
      rating,
      review_datetime: updated.last_review,
      review_duration: reviewDurationMs,
      target_key: '',
    };

    return { card: updated, reviewLog, log: reviewLog, intervalMs };
  }

  // -- internals ------------------------------------------------------------

  /** py-fsrs branches on `State`, ts-fsrs adds `New` for never-seen cards. */
  private effectiveState(card: CardDict): State {
    if (card.state === State.New) return State.Learning;
    return card.state as State;
  }

  /**
   * py-fsrs: `Scheduler._initial_stability(rating)` = `max(w[rating-1], 0.001)`.
   *
   * ts-fsrs's `init_stability()` floors at 0.1 (Anki's behaviour), so the clamp
   * is applied here against py-fsrs's `STABILITY_MIN` to keep parity for
   * parameter sets whose initial weights are below 0.1.
   */
  private initStability(rating: Rating): number {
    return clampStability(this.parameters[rating - 1]);
  }

  /** py-fsrs: `Scheduler._next_stability()`. */
  private nextStability(
    difficulty: number,
    stability: number,
    retrievability: number,
    rating: Rating,
  ): number {
    if (rating === Rating.Again) {
      return this.forgetStability(difficulty, stability, retrievability);
    }
    return clampStability(
      this.algorithm.next_recall_stability(difficulty, stability, retrievability, toGrade(rating)),
    );
  }

  /**
   * py-fsrs: `Scheduler._short_term_stability()`.
   *
   *   S' = e^(w17 * (rating - 3 + w18)) * S^(-w19) * S
   *
   * Only Good/Easy clamp the increase to >= 1 — a Hard same-day review *lowers*
   * stability in py-fsrs. ts-fsrs's `next_short_term_stability()` masks the
   * increase for everything >= Hard, so the increase is computed here from the
   * same validated weight array to keep py-fsrs parity (tests/srs.test.ts
   * covers the Hard case, where the two diverge).
   */
  private shortTermStability(stability: number, rating: Rating): number {
    const w = this.parameters;
    let increase = Math.exp(w[17] * (rating - 3 + w[18])) * Math.pow(stability, -w[19]);
    if (rating === Rating.Good || rating === Rating.Easy) {
      increase = Math.max(increase, 1.0);
    }
    return clampStability(stability * increase);
  }

  /**
   * py-fsrs: `Scheduler._next_forget_stability()` — the long-term forgetting
   * term capped by the short-term term `S / e^(w17 * w18)`.
   *
   * ts-fsrs's `next_forget_stability()` returns the long-term term alone (its
   * `next_state()` applies the cap separately), so the cap is applied here.
   */
  private forgetStability(
    difficulty: number,
    stability: number,
    retrievability: number,
  ): number {
    const longTerm = this.algorithm.next_forget_stability(
      difficulty,
      stability,
      retrievability,
    );
    const shortTermCap = stability / Math.exp(this.parameters[17] * this.parameters[18]);
    return clampStability(Math.min(longTerm, shortTermCap));
  }

  /**
   * py-fsrs: `Scheduler._next_interval()` — whole days, clamped to [1, maximum],
   * plus fuzzing when it is enabled *and* the resulting card is in Review state
   * (py-fsrs applies fuzz after the state transition, matching this call site).
   */
  private nextIntervalMs(stability: number, daysSinceLastReview: number | null): number {
    const days = this.algorithm.next_interval(stability, daysSinceLastReview ?? 0);
    return days * DAY_MS;
  }

  /** py-fsrs: `_initial_difficulty(rating, clamp=False)`, used by next_difficulty. */
  initialDifficulty(rating: Rating): number {
    return this.algorithm.init_difficulty(toGrade(rating));
  }

  /** Exposed for tests/diagnostics: the ts-fsrs instance backing the maths. */
  get tsFsrs(): FSRS {
    return this.algorithm;
  }
}

// ---------------------------------------------------------------------------
//  Rating logic
// ---------------------------------------------------------------------------

/**
 * main.py: `rating_for_correct_answer(elapsed_sec, wrong_attempts, config)`.
 *
 * Correct answers map to Easy / Good / Hard purely by how long they took, and
 * any correct answer that followed a mistake is Hard.
 */
export function ratingForCorrectAnswer(
  elapsedSec: number,
  wrongAttempts: number,
  config: { easyThresholdSec: number; hardThresholdSec: number },
): Rating {
  if (wrongAttempts > 0) return Rating.Hard;
  if (elapsedSec <= config.easyThresholdSec) return Rating.Easy;
  if (elapsedSec <= config.hardThresholdSec) return Rating.Good;
  return Rating.Hard;
}

/**
 * main.py: `ProgressStore._points_for(rating)`.
 */
export function pointsFor(rating: Rating): number {
  if (rating === Rating.Easy) return 3;
  if (rating === Rating.Good) return 2;
  return 1;
}

/**
 * py-fsrs: `ConfigManager.create_scheduler()` — builds a Scheduler from the
 * `srs` block of config.json.
 */
export function createScheduler(srs: SrsConfig = {}): Scheduler {
  return new Scheduler({
    parameters: srs.parameters,
    desiredRetention: srs.desired_retention ?? 0.9,
    learningStepsMinutes: srs.learning_steps_minutes ?? [1, 10],
    relearningStepsMinutes: srs.relearning_steps_minutes ?? [10],
    maximumIntervalDays: srs.maximum_interval_days ?? 36500,
    enableFuzzing: srs.enable_fuzzing ?? true,
  });
}

/**
 * py-fsrs: `ProgressStore._new_record()`'s card — `Card(card_id=..., due=now)`,
 * i.e. a never-reviewed card in the New/Learning state (stability & difficulty
 * unknown, `step` 0).
 */
export function newCardDict(cardId: number, now: Date): CardDict {
  const empty = createEmptyCard(now);
  return {
    card_id: cardId,
    state: empty.state === TsState.Review ? State.Review : State.Learning,
    step: 0,
    stability: null,
    difficulty: null,
    due: empty.due.toISOString(),
    last_review: null,
  };
}

/** Re-exported so callers do not need to import ts-fsrs directly. */
export { TsRating, TsState };
