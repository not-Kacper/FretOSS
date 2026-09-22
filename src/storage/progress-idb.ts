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
 * Layout (DB `srs-fretboard`, version 2):
 *   cardRecords — one record per target, keyPath `id` = `${deckId}::${target.key}`
 *   cards       — legacy v1 store (keyPath `target.key`); migrated once on load
 *   meta        — per-deck header keys `${deckId}::version` | created_at | …
 *
 * Switching instrument/tuning loads a different deckId partition: cards, FSRS
 * queue and points never mix across decks.
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
  State,
  type CardDict,
  type CardRecord,
  type CardStats,
  type ProgressFile,
  type QueueStats,
  type ReviewLogEntry,
} from '../srs/types';
import { midiToName } from '../audio/note-helpers';
import { targetToDict, type FretboardTarget } from '../deck/types';
import { DEFAULT_TUNING_ID } from '../deck/tuning';

export const DB_NAME = 'srs-fretboard';
export const DB_VERSION = 2;
export const CARD_STORE = 'cardRecords';
export const LEGACY_CARD_STORE = 'cards';
const META_STORE = 'meta';
export const DEFAULT_DECK_ID = DEFAULT_TUNING_ID;
export const ID_SEPARATOR = '::';

export type DotKind = 'new' | 'learning' | 'review-due' | 'review-future';

export interface StoredCardRecord extends CardRecord {
  id: string;
  deck_id: string;
}

export interface ProgressStoreOptions {
  dbName?: string;
  /** Overridable for deterministic tests. */
  now?: () => Date;
  /** Progress partition. Defaults to guitar6-standard (the pre-update deck). */
  deckId?: string;
}

type MetaField = 'version' | 'created_at' | 'updated_at' | 'scheduler';

export function namespacedId(deckId: string, targetKey: string): string {
  return `${deckId}${ID_SEPARATOR}${targetKey}`;
}

export function parseNamespacedId(id: string): { deckId: string; targetKey: string } {
  const index = id.indexOf(ID_SEPARATOR);
  if (index === -1) return { deckId: DEFAULT_DECK_ID, targetKey: id };
  return { deckId: id.slice(0, index), targetKey: id.slice(index + ID_SEPARATOR.length) };
}

function metaKey(deckId: string, field: MetaField): string {
  return `${deckId}${ID_SEPARATOR}${field}`;
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
  });
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB write failed'));
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB write aborted'));
  });
}

function openDatabase(dbName: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(dbName, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(CARD_STORE)) {
        db.createObjectStore(CARD_STORE, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(META_STORE)) {
        db.createObjectStore(META_STORE);
      }
      // Legacy `cards` store (v1, keyPath target.key) is left in place so the
      // one-time copy below can run after open. Fresh installs never create it.
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Could not open IndexedDB'));
  });
}

/**
 * One-time v1 → v2 copy: unnamespaced `cards` records (key = `s6_f00`) move
 * into `cardRecords` under `guitar6-standard::s6_f00`. Existing local data is
 * not discarded.
 */
export async function migrateLegacyCards(db: IDBDatabase): Promise<number> {
  if (!db.objectStoreNames.contains(LEGACY_CARD_STORE)) return 0;
  if (!db.objectStoreNames.contains(CARD_STORE)) return 0;

  const legacy = await requestToPromise(
    db.transaction(LEGACY_CARD_STORE, 'readonly').objectStore(LEGACY_CARD_STORE).getAll() as IDBRequest<CardRecord[]>,
  );
  if (!legacy || legacy.length === 0) return 0;

  const existing = await requestToPromise(
    db.transaction(CARD_STORE, 'readonly').objectStore(CARD_STORE).getAllKeys() as IDBRequest<IDBValidKey[]>,
  );
  const existingIds = new Set(existing.map(String));

  const tx = db.transaction([CARD_STORE, LEGACY_CARD_STORE, META_STORE], 'readwrite');
  const dest = tx.objectStore(CARD_STORE);
  const src = tx.objectStore(LEGACY_CARD_STORE);
  const meta = tx.objectStore(META_STORE);
  let migrated = 0;

  for (const record of legacy) {
    const targetKey = record?.target?.key;
    if (!targetKey) continue;
    const alreadyNamespaced = targetKey.includes(ID_SEPARATOR);
    const deckId = alreadyNamespaced ? parseNamespacedId(targetKey).deckId : DEFAULT_DECK_ID;
    const key = alreadyNamespaced ? parseNamespacedId(targetKey).targetKey : targetKey;
    const id = namespacedId(deckId, key);
    if (existingIds.has(id)) continue;
    dest.put({
      ...record,
      id,
      deck_id: deckId,
    } satisfies StoredCardRecord);
    migrated += 1;
  }

  // Copy unnamespaced meta onto the default deck so created_at/scheduler survive.
  for (const field of ['version', 'created_at', 'updated_at', 'scheduler'] as MetaField[]) {
    const value = await requestToPromise(meta.get(field));
    if (value !== undefined) {
      const namespaced = metaKey(DEFAULT_DECK_ID, field);
      const already = await requestToPromise(meta.get(namespaced));
      if (already === undefined) meta.put(value, namespaced);
    }
  }

  src.clear();
  await txDone(tx);
  return migrated;
}

function stripStored(record: StoredCardRecord | CardRecord): CardRecord {
  const { id: _id, deck_id: _deckId, ...rest } = record as StoredCardRecord & {
    id?: string;
    deck_id?: string;
  };
  return rest;
}

export function dotKindFor(card: CardDict, record: { attempts?: number }, now: Date): DotKind {
  if (isNewCard(card, { points: 0, attempts: record.attempts ?? 0, prompt_count: 0 })) return 'new';
  const due = new Date(card.due).getTime();
  if (card.state === State.Learning || card.state === State.Relearning) return 'learning';
  if (due <= now.getTime()) return 'review-due';
  return 'review-future';
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
  readonly deckId: string;
  private _targets: FretboardTarget[];
  /** Same structure as Python's `self.data`, keyed by target.key (unnamespaced). */
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
    deckId: string,
  ) {
    this.db = db;
    this.scheduler = scheduler;
    this._targets = targets;
    this.state = data;
    this.now = now;
    this.deckId = deckId;
  }

  get targets(): FretboardTarget[] {
    return this._targets;
  }

  // -- construction ---------------------------------------------------------

  /**
   * main.py: `ProgressStore.__init__` + `_load_or_create` + `_sync_targets`.
   *
   * Loads every record for `deckId` from IndexedDB, creates the store header
   * when the partition is empty, then ensures a record exists for each deck
   * target. Other decks' records are left untouched.
   */
  static async load(
    scheduler: Scheduler,
    targets: FretboardTarget[],
    options: ProgressStoreOptions = {},
  ): Promise<ProgressStore> {
    const db = await openDatabase(options.dbName ?? DB_NAME);
    await migrateLegacyCards(db);
    const now = options.now ?? (() => new Date());
    const deckId = options.deckId ?? DEFAULT_DECK_ID;

    const metaTx = db.transaction(META_STORE, 'readonly');
    const metaStore = metaTx.objectStore(META_STORE);
    const [version, createdAt, updatedAt, schedulerDict] = await Promise.all([
      requestToPromise(metaStore.get(metaKey(deckId, 'version')) as IDBRequest<number | undefined>),
      requestToPromise(metaStore.get(metaKey(deckId, 'created_at')) as IDBRequest<string | undefined>),
      requestToPromise(metaStore.get(metaKey(deckId, 'updated_at')) as IDBRequest<string | undefined>),
      requestToPromise(
        metaStore.get(metaKey(deckId, 'scheduler')) as IDBRequest<ProgressFile['scheduler'] | undefined>,
      ),
    ]);

    const records = await requestToPromise(
      db.transaction(CARD_STORE, 'readonly').objectStore(CARD_STORE).getAll() as IDBRequest<StoredCardRecord[]>,
    );

    const cards: Record<string, CardRecord> = {};
    const prefix = `${deckId}${ID_SEPARATOR}`;
    for (const record of records) {
      if (!record) continue;
      const id = record.id ?? '';
      if (record.deck_id === deckId || id.startsWith(prefix)) {
        const targetKey = record.target?.key ?? parseNamespacedId(id).targetKey;
        if (targetKey) cards[targetKey] = stripStored(record);
      }
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
      deckId,
    );

    await store.syncTargets(targets);
    await store.save();
    return store;
  }

  /** Swap the queued/viewed target list (fret-range / string-selection filter). */
  async setTargets(targets: FretboardTarget[]): Promise<void> {
    this._targets = targets;
    await this.syncTargets(targets);
    await this.save();
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

  /** Live FSRS colour for the fretboard — one entry per provided target. */
  dotKinds(targets: FretboardTarget[], at: Date = this.now()): Record<string, DotKind> {
    const kinds: Record<string, DotKind> = {};
    for (const target of targets) {
      const record = this.state.cards[target.key];
      if (!record) {
        kinds[target.key] = 'new';
        continue;
      }
      kinds[target.key] = dotKindFor(record.card, record, at);
    }
    return kinds;
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

  private toStored(record: CardRecord): StoredCardRecord {
    return {
      ...record,
      id: namespacedId(this.deckId, record.target.key),
      deck_id: this.deckId,
    };
  }

  /** main.py: `save()` — writes the changed records + the store header. */
  async save(): Promise<void> {
    const tx = this.db.transaction([CARD_STORE, META_STORE], 'readwrite');
    const cardStore = tx.objectStore(CARD_STORE);
    const metaStore = tx.objectStore(META_STORE);

    for (const key of this.dirty) {
      const record = this.state.cards[key];
      if (record) cardStore.put(this.toStored(record));
    }
    this.dirty.clear();

    const meta: Record<MetaField, unknown> = {
      version: this.state.version,
      created_at: this.state.created_at,
      updated_at: this.state.updated_at,
      scheduler: this.state.scheduler,
    };
    for (const [field, value] of Object.entries(meta)) {
      metaStore.put(value, metaKey(this.deckId, field as MetaField));
    }

    await txDone(tx);
  }

  // -- import / export (sync + Python interop) ------------------------------

  /** Assembles the progress.json-shaped blob (what goes to D1) for THIS deck. */
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
   * Replaces THIS deck's local store with a blob. Other decks are not touched.
   * Records for unknown targets are kept out of the queue but preserved by key.
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
      const targetKey = record.target?.key ?? parseNamespacedId(key).targetKey;
      cards[targetKey] = {
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

    await this.replaceAll(cards);
    await this.syncTargets(this.targets);
    await this.save();
  }

  private belongsToThisDeck(record: StoredCardRecord): boolean {
    if (record.deck_id === this.deckId) return true;
    return typeof record.id === 'string' && record.id.startsWith(`${this.deckId}${ID_SEPARATOR}`);
  }

  private async replaceAll(cards: Record<string, CardRecord>): Promise<void> {
    const tx = this.db.transaction(CARD_STORE, 'readwrite');
    const store = tx.objectStore(CARD_STORE);
    const existing = await requestToPromise(store.getAll() as IDBRequest<StoredCardRecord[]>);
    for (const record of existing) {
      if (this.belongsToThisDeck(record) && record.id) store.delete(record.id);
    }
    for (const record of Object.values(cards)) store.put(this.toStored(record));
    await txDone(tx);
  }

  /** Empties THIS deck's partition (used by tests). Other decks are kept. */
  async clear(): Promise<void> {
    const tx = this.db.transaction([CARD_STORE, META_STORE], 'readwrite');
    const cardStore = tx.objectStore(CARD_STORE);
    const metaStore = tx.objectStore(META_STORE);
    const existing = await requestToPromise(cardStore.getAll() as IDBRequest<StoredCardRecord[]>);
    for (const record of existing) {
      if (this.belongsToThisDeck(record) && record.id) cardStore.delete(record.id);
    }
    for (const field of ['version', 'created_at', 'updated_at', 'scheduler'] as MetaField[]) {
      metaStore.delete(metaKey(this.deckId, field));
    }
    await txDone(tx);
    this.state.cards = {};
    this.dirty.clear();
  }

  close(): void {
    this.db.close();
  }

  /** Number of stored records in this deck (diagnostics/tests). */
  get size(): number {
    return Object.keys(this.state.cards).length;
  }
}

/** Read every deck partition (export / import). */
export async function readAllDeckProgress(dbName: string = DB_NAME): Promise<Record<string, ProgressFile>> {
  const db = await openDatabase(dbName);
  await migrateLegacyCards(db);
  const records = await requestToPromise(
    db.transaction(CARD_STORE, 'readonly').objectStore(CARD_STORE).getAll() as IDBRequest<StoredCardRecord[]>,
  );
  const metaStore = db.transaction(META_STORE, 'readonly').objectStore(META_STORE);
  const grouped: Record<string, Record<string, CardRecord>> = {};
  for (const record of records) {
    if (!record) continue;
    const deckId = record.deck_id ?? parseNamespacedId(record.id ?? '').deckId;
    const targetKey = record.target?.key ?? parseNamespacedId(record.id ?? '').targetKey;
    if (!deckId || !targetKey) continue;
    grouped[deckId] ??= {};
    grouped[deckId][targetKey] = stripStored(record);
  }

  const decks: Record<string, ProgressFile> = {};
  for (const [deckId, cards] of Object.entries(grouped)) {
    const [version, createdAt, updatedAt, scheduler] = await Promise.all([
      requestToPromise(metaStore.get(metaKey(deckId, 'version')) as IDBRequest<number | undefined>),
      requestToPromise(metaStore.get(metaKey(deckId, 'created_at')) as IDBRequest<string | undefined>),
      requestToPromise(metaStore.get(metaKey(deckId, 'updated_at')) as IDBRequest<string | undefined>),
      requestToPromise(
        metaStore.get(metaKey(deckId, 'scheduler')) as IDBRequest<ProgressFile['scheduler'] | undefined>,
      ),
    ]);
    decks[deckId] = {
      version: version ?? ProgressStore.VERSION,
      created_at: createdAt ?? new Date().toISOString(),
      updated_at: updatedAt ?? new Date().toISOString(),
      scheduler: scheduler ?? {
        parameters: [],
        desired_retention: 0.9,
        learning_steps: [60, 600],
        relearning_steps: [600],
        maximum_interval: 36500,
        enable_fuzzing: true,
      },
      cards,
    };
  }
  db.close();
  return decks;
}

export type ConflictStrategy = 'keep-local' | 'overwrite';

/** Merge imported decks into IndexedDB. Never silently drops local-only cards. */
export async function mergeDeckProgress(
  imported: Record<string, ProgressFile>,
  strategy: ConflictStrategy,
  dbName: string = DB_NAME,
): Promise<{ written: number; conflicts: number; keptLocal: number }> {
  const db = await openDatabase(dbName);
  await migrateLegacyCards(db);
  const existingRecords = await requestToPromise(
    db.transaction(CARD_STORE, 'readonly').objectStore(CARD_STORE).getAll() as IDBRequest<StoredCardRecord[]>,
  );
  const existingById = new Map<string, StoredCardRecord>();
  for (const record of existingRecords) {
    if (record?.id) existingById.set(record.id, record);
  }

  let written = 0;
  let conflicts = 0;
  let keptLocal = 0;
  const tx = db.transaction([CARD_STORE, META_STORE], 'readwrite');
  const cardStore = tx.objectStore(CARD_STORE);
  const metaStore = tx.objectStore(META_STORE);

  for (const [deckId, file] of Object.entries(imported)) {
    if (!file?.cards) continue;
    for (const [key, record] of Object.entries(file.cards)) {
      if (!record || typeof record !== 'object') continue;
      const targetKey = record.target?.key ?? parseNamespacedId(key).targetKey;
      const id = namespacedId(deckId, targetKey);
      const local = existingById.get(id);
      if (local) {
        conflicts += 1;
        if (strategy === 'keep-local') {
          keptLocal += 1;
          continue;
        }
      }
      cardStore.put({
        ...record,
        points: Math.trunc(record.points ?? 0),
        attempts: Math.trunc(record.attempts ?? 0),
        correct: Math.trunc(record.correct ?? 0),
        wrong: Math.trunc(record.wrong ?? 0),
        prompt_count: Math.trunc(record.prompt_count ?? 0),
        reviews: record.reviews ?? [],
        id,
        deck_id: deckId,
      } satisfies StoredCardRecord);
      written += 1;
    }
    if (file.version !== undefined) metaStore.put(file.version, metaKey(deckId, 'version'));
    if (file.created_at) metaStore.put(file.created_at, metaKey(deckId, 'created_at'));
    if (file.updated_at) metaStore.put(file.updated_at, metaKey(deckId, 'updated_at'));
    if (file.scheduler) metaStore.put(file.scheduler, metaKey(deckId, 'scheduler'));
  }

  await txDone(tx);
  db.close();
  return { written, conflicts, keptLocal };
}

export async function countConflicts(
  imported: Record<string, ProgressFile>,
  dbName: string = DB_NAME,
): Promise<number> {
  const db = await openDatabase(dbName);
  await migrateLegacyCards(db);
  const existing = await requestToPromise(
    db.transaction(CARD_STORE, 'readonly').objectStore(CARD_STORE).getAllKeys() as IDBRequest<IDBValidKey[]>,
  );
  const ids = new Set(existing.map(String));
  db.close();
  let conflicts = 0;
  for (const [deckId, file] of Object.entries(imported)) {
    if (!file?.cards) continue;
    for (const [key, record] of Object.entries(file.cards)) {
      const targetKey = record?.target?.key ?? parseNamespacedId(key).targetKey;
      if (ids.has(namespacedId(deckId, targetKey))) conflicts += 1;
    }
  }
  return conflicts;
}

/** main.py: `_format_wait(delta)` helper for the "next due" message. */
export function dueWaitMs(target: FretboardTarget, store: ProgressStore, at: Date = new Date()): number {
  return new Date(store.cardFor(target).due).getTime() - at.getTime();
}
