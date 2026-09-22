/**
 * storage/progress-idb.ts — IndexedDB persistence + the port of main.py's
 * `ProgressStore`.
 * =============================================================================
 *
 * Record shape: identical to Python's `ProgressStore` records
 * (`target`, `card`, `points`, `attempts`, `correct`, `wrong`, `prompt_count`,
 * `last_prompted_at`, `last_reviewed_at`, `reviews`), and `card` is py-fsrs's
 * `Card.to_dict()` shape, so a progress.json written by the Python app can be
 * imported unchanged (see `importProgressFile`).
 *
 * Layout (DB `srs-fretboard`, version 1):
 *   cards — one record per target, keyPath `key`          (CRUD here)
 *   meta  — "version" | "created_at" | "updated_at" | "scheduler" as key/value
 *
 * Python rewrites the whole progress.json on every save because a file has no
 * other option; IndexedDB does, so `save()` only writes back the records that
 * changed (tracked in `dirty`) plus the meta keys. The in-memory `data`
 * structure mirrors Python's dict exactly, which is also what `toProgressFile()`
 * hands to the sync layer.
 */

import { newCardDict, pointsFor, Scheduler } from '../srs/scheduler';
import {
  isNewCard,
  newCardAllowance,
  nextDue as nextDueInQueue,
  queueBuckets,
  queueStats,
  selectNextTarget,
  type QueueBuckets,
} from '../srs/queue';
import {
  Rating,
  type CardDict,
  type CardRecord,
  type CardStats,
  type ProgressFile,
  type QueueStats,
  type ReviewLogEntry,
} from '../srs/types';
import { midiToName } from '../audio/note-helpers';
import { targetToDict, type FretboardTarget } from '../deck/types';

export const DB_NAME = 'srs-fretboard';
export const DB_VERSION = 1;
const CARD_STORE = 'cards';
const META_STORE = 'meta';

export interface ProgressStoreOptions {
  dbName?: string;
  /** Overridable for deterministic tests. */
  now?: () => Date;
}

type MetaKey = 'version' | 'created_at' | 'updated_at' | 'scheduler';

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
  });
}

function openDatabase(dbName: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(dbName, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(CARD_STORE)) {
        db.createObjectStore(CARD_STORE, { keyPath: 'target.key' });
      }
      if (!db.objectStoreNames.contains(META_STORE)) {
        db.createObjectStore(META_STORE);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Could not open IndexedDB'));
  });
}

/**
 * Port of main.py's `ProgressStore`, backed by IndexedDB.
 *
 * Public method names are camelCased from the Python originals:
 *   _load_or_create -> load()
 *   _sync_targets   -> syncTargets()
 *   _new_record     -> newRecord()
 *   _record_for     -> recordFor()
 *   _queue_buckets  -> queueBuckets()
 *   _pick_candidate -> srs/queue.ts pickCandidate()
 *   _card_from_record -> cardFor()
 *   review / mark_prompted / queue_stats / select_next_target / is_new /
 *   has_new_cards / next_due / stats_for / save
 */
export class ProgressStore {
  static readonly VERSION = 1;

  readonly scheduler: Scheduler;
  readonly targets: FretboardTarget[];
  /** Same structure as Python's `self.data`. */
  private readonly state: {
    version: number;
    created_at: string;
    updated_at: string;
    scheduler: ReturnType<Scheduler['toDict']>;
    cards: Record<string, CardRecord>;
  };

  private readonly db: IDBDatabase;
  private readonly dirty = new Set<string>();
  private readonly now: () => Date;

  private constructor(
    db: IDBDatabase,
    scheduler: Scheduler,
    targets: FretboardTarget[],
    data: {
      version: number;
      created_at: string;
      updated_at: string;
      scheduler: ReturnType<Scheduler['toDict']>;
      cards: Record<string, CardRecord>;
    },
    now: () => Date,
  ) {
    this.db = db;
    this.scheduler = scheduler;
    this.targets = targets;
    this.state = data;
    this.now = now;
  }

  // -- construction ---------------------------------------------------------

  /**
   * main.py: `ProgressStore.__init__` + `_load_or_create` + `_sync_targets`.
   *
   * Loads every record from IndexedDB, creates the store header when the
   * database is empty, then ensures a record exists for each deck target.
   */
  static async load(
    scheduler: Scheduler,
    targets: FretboardTarget[],
    options: ProgressStoreOptions = {},
  ): Promise<ProgressStore> {
    const db = await openDatabase(options.dbName ?? DB_NAME);
    const now = options.now ?? (() => new Date());

    const metaTx = db.transaction(META_STORE, 'readonly');
    const metaStore = metaTx.objectStore(META_STORE);
    const [version, createdAt, updatedAt, schedulerDict] = await Promise.all([
      requestToPromise(metaStore.get('version') as IDBRequest<number | undefined>),
      requestToPromise(metaStore.get('created_at') as IDBRequest<string | undefined>),
      requestToPromise(metaStore.get('updated_at') as IDBRequest<string | undefined>),
      requestToPromise(metaStore.get('scheduler') as IDBRequest<ProgressFile['scheduler'] | undefined>),
    ]);

    const records = await requestToPromise(
      db.transaction(CARD_STORE, 'readonly').objectStore(CARD_STORE).getAll() as IDBRequest<CardRecord[]>,
    );

    const cards: Record<string, CardRecord> = {};
    for (const record of records) {
      const key = record?.target?.key;
      if (key) cards[key] = record;
    }

    const stamp = now().toISOString();
    const store = new ProgressStore(
      db,
      scheduler,
      targets,
      {
        version: version ?? ProgressStore.VERSION,
        created_at: createdAt ?? stamp,
        updated_at: updatedAt ?? stamp,
        scheduler: schedulerDict ?? scheduler.toDict(),
        cards,
      },
      now,
    );

    await store.syncTargets(targets);
    await store.save();
    return store;
  }

  // -- record access -------------------------------------------------------

  /** main.py: `_record_for(target)`. */
  recordFor(target: FretboardTarget): CardRecord {
    const record = this.state.cards[target.key];
    if (!record) throw new Error(`No progress record for target ${target.key}`);
    return record;
  }

  /** main.py: `_card_from_record(record)` (returns the stored dict as-is). */
  cardFor(target: FretboardTarget): CardDict {
    return this.recordFor(target).card;
  }

  /** main.py: `_new_record(target, now)` — `Card(card_id=..., due=now)`. */
  newRecord(target: FretboardTarget, when: Date): CardRecord {
    return {
      target: targetToDict(target),
      card: newCardDict(target.cardId, when),
      points: 0,
      attempts: 0,
      correct: 0,
      wrong: 0,
      prompt_count: 0,
      last_prompted_at: null,
      last_reviewed_at: null,
      reviews: [],
    };
  }

  /** main.py: `_sync_targets(targets)` — add missing cards, refresh targets. */
  async syncTargets(targets: FretboardTarget[]): Promise<void> {
    const now = this.now();
    for (const target of targets) {
      const existing = this.state.cards[target.key];
      if (!existing) {
        this.state.cards[target.key] = this.newRecord(target, now);
        this.dirty.add(target.key);
        continue;
      }

      existing.target = targetToDict(target);
      existing.card ??= newCardDict(target.cardId, now);
      existing.points ??= 0;
      existing.attempts ??= 0;
      existing.correct ??= 0;
      existing.wrong ??= 0;
      existing.reviews ??= [];
      this.dirty.add(target.key);
    }
    this.state.scheduler = this.scheduler.toDict();
    this.touch();
  }

  /** main.py: `_is_new_card(record, card)` wrapped per target. */
  isNew(target: FretboardTarget): boolean {
    const record = this.recordFor(target);
    return isNewCard(record.card, record);
  }

  /** main.py: `has_new_cards()`. */
  hasNewCards(): boolean {
    return this.targets.some((target) => this.isNew(target));
  }

  /** main.py: `stats_for(target)`. */
  statsFor(target: FretboardTarget): CardStats {
    const record = this.recordFor(target);
    return {
      points: Math.trunc(record.points ?? 0),
      attempts: Math.trunc(record.attempts ?? 0),
      correct: Math.trunc(record.correct ?? 0),
      wrong: Math.trunc(record.wrong ?? 0),
    };
  }

  // -- queue ----------------------------------------------------------------

  /** main.py: `_queue_buckets(now)`. */
  queueBuckets(at: Date = this.now(), random: () => number = Math.random): QueueBuckets {
    return queueBuckets(
      this.targets,
      (target) => this.recordFor(target),
      (target) => this.cardFor(target),
      this.scheduler,
      at,
      random,
    );
  }

  /** main.py: `queue_stats(now, new_cards_allowed, new_cards_started)`. */
  queueStats(
    at: Date,
    newCardsAllowed: number,
    newCardsStarted: number,
    random: () => number = Math.random,
  ): QueueStats {
    return queueStats(this.queueBuckets(at, random), newCardsAllowed, newCardsStarted);
  }

  /** main.py: `select_next_target(...)`. */
  selectNextTarget(
    at: Date,
    newCardsAllowed: number,
    newCardsStarted: number,
    randomWindow: number,
    recentKeys: string[] = [],
    random: () => number = Math.random,
  ): FretboardTarget | null {
    return selectNextTarget(
      this.queueBuckets(at, random),
      newCardsAllowed,
      newCardsStarted,
      randomWindow,
      recentKeys,
      random,
    );
  }

  /** main.py: `next_due()`. */
  nextDue(): { target: FretboardTarget; card: CardDict } | null {
    return nextDueInQueue(
      this.targets,
      (target) => this.recordFor(target),
      (target) => this.cardFor(target),
    );
  }

  /** main.py: `ConfigManager.new_card_allowance()` bound to session time. */
  newCardAllowance(sessionElapsedSec: number, initialNewCards: number, newCardIntervalSec: number): number {
    return newCardAllowance(sessionElapsedSec, initialNewCards, newCardIntervalSec);
  }

  // -- mutations ------------------------------------------------------------

  /** main.py: `mark_prompted(target, when)`. */
  async markPrompted(target: FretboardTarget, when: Date = this.now()): Promise<void> {
    const record = this.recordFor(target);
    record.last_prompted_at = when.toISOString();
    record.prompt_count = Math.trunc(record.prompt_count ?? 0) + 1;
    this.dirty.add(target.key);
    this.touch();
    await this.save();
  }

  /**
   * main.py: `review(target, rating, review_datetime, review_duration_ms,
   * detected_midi)` — runs the FSRS scheduler and updates the points counters.
   */
  async review(
    target: FretboardTarget,
    rating: Rating,
    reviewDatetime: Date = this.now(),
    reviewDurationMs: number | null = null,
    detectedMidi: number | null = null,
  ): Promise<{ card: CardDict; reviewLog: ReviewLogEntry }> {
    const record = this.recordFor(target);
    const reviewedAt = new Date(reviewDatetime.getTime());

    const { card: updatedCard, reviewLog } = this.scheduler.reviewCard(
      record.card,
      rating,
      reviewedAt,
      reviewDurationMs,
    );

    record.card = updatedCard;
    record.attempts = Math.trunc(record.attempts ?? 0) + 1;
    record.last_reviewed_at = reviewedAt.toISOString();

    if (rating === Rating.Again) {
      record.wrong = Math.trunc(record.wrong ?? 0) + 1;
      record.points = Math.trunc(record.points ?? 0) - 1;
    } else {
      record.correct = Math.trunc(record.correct ?? 0) + 1;
      record.points = Math.trunc(record.points ?? 0) + pointsFor(rating);
    }

    const entry: ReviewLogEntry = { ...reviewLog, target_key: target.key };
    if (detectedMidi !== null && detectedMidi !== undefined) {
      entry.detected_midi_note = detectedMidi;
      entry.detected_note_name = midiToName(detectedMidi);
    }
    (record.reviews ??= []).push(entry);

    this.dirty.add(target.key);
    this.touch();
    await this.save();
    return { card: updatedCard, reviewLog: entry };
  }

  /** main.py: `_touch()`. */
  private touch(): void {
    this.state.updated_at = this.now().toISOString();
  }

  /** main.py: `save()` — writes the changed records + the store header. */
  async save(): Promise<void> {
    const tx = this.db.transaction([CARD_STORE, META_STORE], 'readwrite');
    const cardStore = tx.objectStore(CARD_STORE);
    const metaStore = tx.objectStore(META_STORE);

    for (const key of this.dirty) {
      const record = this.state.cards[key];
      if (record) cardStore.put(record);
    }
    this.dirty.clear();

    const meta: Record<MetaKey, unknown> = {
      version: this.state.version,
      created_at: this.state.created_at,
      updated_at: this.state.updated_at,
      scheduler: this.state.scheduler,
    };
    for (const [key, value] of Object.entries(meta)) metaStore.put(value, key);

    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('IndexedDB write failed'));
      tx.onabort = () => reject(tx.error ?? new Error('IndexedDB write aborted'));
    });
  }

  // -- import / export (sync + Python interop) ------------------------------

  /** Assembles the progress.json-shaped blob (what goes to D1). */
  toProgressFile(): ProgressFile {
    return {
      version: this.state.version,
      created_at: this.state.created_at,
      updated_at: this.state.updated_at,
      scheduler: this.state.scheduler,
      cards: { ...this.state.cards },
    };
  }

  get updatedAt(): string {
    return this.state.updated_at;
  }

  /**
   * Replaces the local store with a blob (a `progress.json` from the Python app
   * or the payload pulled from D1). Records for unknown targets are kept out of
   * the deck but preserved by key, exactly like a partially-matching
   * progress.json.
   */
  async importProgressFile(file: ProgressFile): Promise<void> {
    if (!file || typeof file !== 'object' || typeof file.cards !== 'object') {
      throw new Error('Progress payload is not a valid progress file.');
    }

    this.state.version = Number(file.version ?? ProgressStore.VERSION);
    this.state.created_at = String(file.created_at ?? this.now().toISOString());
    this.state.updated_at = String(file.updated_at ?? this.now().toISOString());
    if (file.scheduler) this.state.scheduler = file.scheduler;

    const cards: Record<string, CardRecord> = {};
    for (const [key, record] of Object.entries(file.cards)) {
      if (!record || typeof record !== 'object') continue;
      cards[key] = {
        ...record,
        points: Math.trunc(record.points ?? 0),
        attempts: Math.trunc(record.attempts ?? 0),
        correct: Math.trunc(record.correct ?? 0),
        wrong: Math.trunc(record.wrong ?? 0),
        prompt_count: Math.trunc(record.prompt_count ?? 0),
        reviews: record.reviews ?? [],
      };
    }
    this.state.cards = cards;

    // Only records that exist in the imported blob are written; stale local
    // records are removed so a hard-cleared client really adopts the server.
    await this.replaceAll(cards);
    await this.syncTargets(this.targets);
    await this.save();
  }

  private async replaceAll(cards: Record<string, CardRecord>): Promise<void> {
    const tx = this.db.transaction(CARD_STORE, 'readwrite');
    const store = tx.objectStore(CARD_STORE);
    await requestToPromise(store.clear());
    for (const record of Object.values(cards)) store.put(record);
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('IndexedDB write failed'));
    });
  }

  /** Empties both stores (used by tests and the "reset progress" control). */
  async clear(): Promise<void> {
    const tx = this.db.transaction([CARD_STORE, META_STORE], 'readwrite');
    tx.objectStore(CARD_STORE).clear();
    tx.objectStore(META_STORE).clear();
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('IndexedDB clear failed'));
    });
    this.state.cards = {};
    this.dirty.clear();
  }

  close(): void {
    this.db.close();
  }

  /** Number of stored records (diagnostics/tests). */
  get size(): number {
    return Object.keys(this.state.cards).length;
  }
}

/** main.py: `_format_wait(delta)` helper for the "next due" message. */
export function dueWaitMs(target: FretboardTarget, store: ProgressStore, at: Date = new Date()): number {
  return new Date(store.cardFor(target).due).getTime() - at.getTime();
}
