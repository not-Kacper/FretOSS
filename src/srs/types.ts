/**
 * srs/types.ts — FSRS / progress value objects.
 *
 * The persisted shapes mirror Python's `fsrs.Card.to_dict()`,
 * `fsrs.ReviewLog.to_dict()` and `ProgressStore`'s record dict **exactly** so a
 * progress.json exported by the Python app can be imported as-is (and so the
 * D1 sync blob is interchangeable between the two front-ends).
 */

/** Same enum values as `fsrs.State` (py-fsrs + ts-fsrs agree on 1/2/3). */
export enum State {
  New = 0,
  Learning = 1,
  Review = 2,
  Relearning = 3,
}

/** Same enum values as `fsrs.Rating` / ts-fsrs `Rating`. */
export enum Rating {
  Manual = 0,
  Again = 1,
  Hard = 2,
  Good = 3,
  Easy = 4,
}

/** `fsrs.Card.to_dict()` — note `step` is None for Review-state cards. */
export interface CardDict {
  card_id: number;
  state: number;
  step: number | null;
  stability: number | null;
  difficulty: number | null;
  due: string;
  last_review: string | null;
}

/** `fsrs.ReviewLog.to_dict()` plus the extras ProgressStore.review() appends. */
export interface ReviewLogEntry {
  card_id: number;
  rating: number;
  review_datetime: string;
  review_duration: number | null;
  target_key: string;
  detected_midi_note?: number;
  detected_note_name?: string;
}

/** One card of the progress store — `ProgressStore._new_record()`. */
export interface CardRecord {
  target: {
    key: string;
    card_id: number;
    string: number;
    string_label: string;
    fret: number;
    midi_note: number;
    note_name: string;
    pitch_class: string;
  };
  card: CardDict;
  points: number;
  attempts: number;
  correct: number;
  wrong: number;
  prompt_count: number;
  last_prompted_at: string | null;
  last_reviewed_at: string | null;
  reviews: ReviewLogEntry[];
}

/** main.py: `@dataclass(frozen=True) class QueueStats`. */
export interface QueueStats {
  learningDue: number;
  reviewDue: number;
  newAvailable: number;
  newTotal: number;
  future: number;
  available: number;
}

/** main.py: `ProgressStore.stats_for()` — the per-target counters shown in the UI. */
export interface CardStats {
  points: number;
  attempts: number;
  correct: number;
  wrong: number;
}

/**
 * The full sync payload — byte-for-byte the structure of the Python
 * `progress.json` (and therefore of the `data` TEXT column in D1).
 */
export interface ProgressFile {
  version: number;
  created_at: string;
  updated_at: string;
  scheduler: SchedulerDict;
  cards: Record<string, CardRecord>;
}

/** `fsrs.Scheduler.to_dict()`. */
export interface SchedulerDict {
  parameters: number[];
  desired_retention: number;
  learning_steps: number[];
  relearning_steps: number[];
  maximum_interval: number;
  enable_fuzzing: boolean;
}

/** The `srs` section of config.json. */
export interface SrsConfig {
  progress_path?: string;
  parameters?: number[];
  desired_retention?: number;
  learning_steps_minutes?: number[];
  relearning_steps_minutes?: number[];
  maximum_interval_days?: number;
  enable_fuzzing?: boolean;
  initial_new_cards?: number;
  new_card_interval_sec?: number;
  random_candidate_window?: number;
  easy_threshold_sec?: number;
  hard_threshold_sec?: number;
  wrong_repeat_cooldown_sec?: number;
  success_pause_sec?: number;
}
