/**
 * hooks/useSrsSession.ts — the port of `main()`'s session loop.
 * =============================================================================
 *
 * Wraps srs/queue.ts + storage/progress-idb.ts, exactly like main.py's
 * `main()` wrapped `ProgressStore` + `ConfigManager`:
 *
 *   target = _select_target()                     -> pickInitialTarget()
 *   progress.mark_prompted(target, now)           -> ProgressStore.markPrompted()
 *   if progress.is_new(target): new_cards_started -> same
 *   event = processor.process(samples)            -> handleNoteEvent(event)
 *   rating = rating_for_correct_answer(...)       -> scheduler.ratingForCorrectAnswer()
 *   progress.review(target, rating, ...)          -> ProgressStore.review()
 *   time.sleep(config.success_pause_sec)          -> `frozen` window below
 *   recent_target_keys = recent_target_keys[-6:]  -> recentKeysRef (last 6)
 *   should_record_wrong (cooldown)                -> same predicate
 *   processor.reset()                             -> resetStreak()
 *
 * The Python loop blocks on `time.sleep(success_pause_sec)` between prompts;
 * the hook instead marks a `frozen` window and ignores incoming notes until it
 * elapses, which keeps the React UI on the success screen for the same duration
 * without blocking the audio thread.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { midiToName } from '../audio/note-helpers';
import type { ConfigManager } from '../config/config';
import { FretboardDeck } from '../deck/deck';
import type { FretboardTarget, NoteEvent } from '../deck/types';
import { ProgressStore } from '../storage/progress-idb';
import type { ProgressSync } from '../storage/sync';
import type { Scheduler } from '../srs/scheduler';
import { ratingForCorrectAnswer } from '../srs/scheduler';
import { Rating, type CardDict, type CardStats, type QueueStats } from '../srs/types';

export type SessionStatus = 'loading' | 'ready' | 'ended' | 'error';

export interface SessionNote {
  midiNote: number;
  noteName: string;
  frequency: number;
  confidence: number;
  isMatch: boolean;
  detectedAt: number;
}

export interface UseSrsSessionOptions {
  config: ConfigManager | null;
  /** main.py: `processor.reset()` — wired to the audio hook. */
  resetStreak: () => void;
  /** Optional cross-device sync client (pull on load, debounced push after saves). */
  sync?: ProgressSync | null;
}

export interface UseSrsSessionResult {
  status: SessionStatus;
  error: string | null;
  target: FretboardTarget | null;
  stats: CardStats;
  queue: QueueStats | null;
  completedCards: number;
  /** Green "note validated" note held while the success pause runs. */
  heldMatch: SessionNote | null;
  /** True while the port of `time.sleep(success_pause_sec)` is running. */
  frozen: boolean;
  /** main.py: `progress.next_due()` for the end-of-session message. */
  nextDue: { target: FretboardTarget; card: CardDict } | null;
  hasNewCards: boolean;
  sessionElapsedSec: number;
  /** Feed every confirmed note here (from useAudio). */
  handleNoteEvent: (event: NoteEvent) => void;
  /** Test seam / "skip" control: move straight to the next prompt. */
  skipToNext: () => void;
  store: ProgressStore | null;
  deck: FretboardTarget[];
}

const EMPTY_STATS: CardStats = { points: 0, attempts: 0, correct: 0, wrong: 0 };

export function useSrsSession({
  config,
  resetStreak,
  sync = null,
}: UseSrsSessionOptions): UseSrsSessionResult {
  const [status, setStatus] = useState<SessionStatus>('loading');
  const [error, setError] = useState<string | null>(null);
  const [target, setTarget] = useState<FretboardTarget | null>(null);
  const [stats, setStats] = useState<CardStats>(EMPTY_STATS);
  const [queue, setQueue] = useState<QueueStats | null>(null);
  const [completedCards, setCompletedCards] = useState(0);
  const [heldMatch, setHeldMatch] = useState<SessionNote | null>(null);
  const [frozen, setFrozen] = useState(false);
  const [nextDue, setNextDue] = useState<{ target: FretboardTarget; card: CardDict } | null>(null);
  const [hasNewCards, setHasNewCards] = useState(false);
  const [deck, setDeck] = useState<FretboardTarget[]>([]);

  const storeRef = useRef<ProgressStore | null>(null);
  const schedulerRef = useRef<Scheduler | null>(null);
  const targetRef = useRef<FretboardTarget | null>(null);
  const readyRef = useRef(false);
  const sessionStartedAtRef = useRef(0);
  const newCardsStartedRef = useRef(0);
  const recentKeysRef = useRef<string[]>([]);
  const promptStartedAtRef = useRef(0);
  const wrongAttemptsRef = useRef(0);
  const lastWrongMidiRef = useRef<number | null>(null);
  const lastWrongAtRef = useRef(0);
  const pauseUntilRef = useRef(0);
  const pauseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const busyRef = useRef(false);
  const resetStreakRef = useRef(resetStreak);
  resetStreakRef.current = resetStreak;
  const syncRef = useRef(sync);
  syncRef.current = sync;
  const configRef = useRef(config);
  configRef.current = config;

  /** main.py: `_session_elapsed_sec()`. */
  const sessionElapsedSec = useCallback(
    () => Math.max(0, (performance.now() - sessionStartedAtRef.current) / 1000),
    [],
  );

  /** main.py: `_new_card_allowance()`. */
  const newCardAllowance = useCallback(() => {
    const currentConfig = configRef.current;
    if (!currentConfig) return 0;
    return currentConfig.newCardAllowance(sessionElapsedSec());
  }, [sessionElapsedSec]);

  /** main.py: `_queue_stats()`. */
  const refreshQueue = useCallback((): QueueStats | null => {
    const store = storeRef.current;
    const currentConfig = configRef.current;
    if (!store || !currentConfig) return null;
    const next = store.queueStats(new Date(), newCardAllowance(), newCardsStartedRef.current);
    setQueue(next);
    return next;
  }, [newCardAllowance]);

  const notifyProgressChanged = useCallback(() => {
    const store = storeRef.current;
    if (store && syncRef.current) syncRef.current.push(store.toProgressFile());
  }, []);

  /**
   * main.py: the block after a successful review — pick the next prompt, mark it
   * prompted, count new cards and reset the per-prompt bookkeeping.
   */
  const advanceToNextTarget = useCallback(async (): Promise<void> => {
    const store = storeRef.current;
    const currentConfig = configRef.current;
    if (!store || !currentConfig) return;

    const next = store.selectNextTarget(
      new Date(),
      newCardAllowance(),
      newCardsStartedRef.current,
      currentConfig.randomCandidateWindow,
      recentKeysRef.current,
    );

    if (!next) {
      targetRef.current = null;
      setTarget(null);
      setStatus('ended');
      setNextDue(store.nextDue());
      setHasNewCards(store.hasNewCards());
      refreshQueue();
      return;
    }

    await store.markPrompted(next, new Date());
    if (store.isNew(next)) newCardsStartedRef.current += 1;

    targetRef.current = next;
    setTarget(next);
    setStats(store.statsFor(next));
    refreshQueue();

    promptStartedAtRef.current = performance.now();
    wrongAttemptsRef.current = 0;
    lastWrongMidiRef.current = null;
    lastWrongAtRef.current = 0;
    resetStreakRef.current();
    notifyProgressChanged();
  }, [newCardAllowance, notifyProgressChanged, refreshQueue]);

  // -- session bootstrap (main.py's `main()` prologue) ----------------------

  useEffect(() => {
    if (!config) return;
    let cancelled = false;

    void (async () => {
      try {
        const scheduler = config.createScheduler();
        const fretboard = new FretboardDeck(config.deckConfig);
        const store = await ProgressStore.load(scheduler, fretboard.targets);

        if (cancelled) {
          store.close();
          return;
        }

        storeRef.current = store;
        schedulerRef.current = scheduler;
        setDeck(fretboard.targets);

        // Cross-device sync: adopt the last server-synced state when this
        // browser has no local progress (fresh install or a hard IndexedDB
        // clear), or when the server copy is newer.
        const client = syncRef.current;
        if (client) {
          const remote = await client.pull();
          if (remote && !cancelled && shouldAdoptRemote(remote, store)) {
            await store.importProgressFile(remote);
          }
        }
        if (cancelled) return;

        readyRef.current = true;
        sessionStartedAtRef.current = performance.now();

        // First prompt.
        await advanceToNextTarget();
        if (!cancelled) setStatus((current) => (current === 'ended' ? 'ended' : 'ready'));
      } catch (cause) {
        if (cancelled) return;
        readyRef.current = false;
        setError(cause instanceof Error ? cause.message : String(cause));
        setStatus('error');
      }
    })();

    return () => {
      cancelled = true;
      if (pauseTimerRef.current !== null) {
        clearTimeout(pauseTimerRef.current);
        pauseTimerRef.current = null;
      }
      readyRef.current = false;
      storeRef.current?.close();
      storeRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config]);

  // -- per-note handling (main.py's `while running:` loop body) --------------

  const handleNoteEvent = useCallback(
    (event: NoteEvent) => {
      const store = storeRef.current;
      const currentConfig = configRef.current;
      const currentTarget = targetRef.current;

      if (!readyRef.current || !store || !currentConfig || !currentTarget) return;
      // `time.sleep(config.success_pause_sec)` window — notes are ignored.
      if (performance.now() < pauseUntilRef.current) return;
      // One review at a time: the Python loop was synchronous, IDB writes are not.
      if (busyRef.current) return;

      const noteName = midiToName(event.midiNote);
      const isMatch = event.midiNote === currentTarget.midiNote;
      const detectedAt = performance.now();

      if (isMatch) {
        busyRef.current = true;
        const elapsedSec = (detectedAt - promptStartedAtRef.current) / 1000;
        const rating = ratingForCorrectAnswer(elapsedSec, wrongAttemptsRef.current, currentConfig);

        setHeldMatch({
          midiNote: event.midiNote,
          noteName,
          frequency: event.frequency,
          confidence: event.confidence,
          isMatch: true,
          detectedAt,
        });
        setCompletedCards((count) => count + 1);

        void (async () => {
          try {
            await store.review(
              currentTarget,
              rating,
              new Date(),
              Math.round(elapsedSec * 1000),
              event.midiNote,
            );
            setStats(store.statsFor(currentTarget));
            refreshQueue();

            // Hold the success screen for `success_pause_sec` (main.py sleeps
            // here), then move on.
            setFrozen(true);
            pauseUntilRef.current = performance.now() + currentConfig.successPauseSec * 1000;
            await new Promise<void>((resolve) => {
              pauseTimerRef.current = setTimeout(resolve, currentConfig.successPauseSec * 1000);
            });
            pauseTimerRef.current = null;
            pauseUntilRef.current = 0;
            setFrozen(false);

            recentKeysRef.current = [...recentKeysRef.current, currentTarget.key].slice(-6);
            notifyProgressChanged();
            await advanceToNextTarget();
            setHeldMatch(null);
          } finally {
            busyRef.current = false;
          }
        })();
        return;
      }

      // ---- Mismatch (main.py's `else:` branch) --------------------------
      const now = performance.now();
      const shouldRecordWrong =
        lastWrongMidiRef.current !== event.midiNote ||
        now - lastWrongAtRef.current >= currentConfig.wrongRepeatCooldownSec * 1000;

      // main.py calls `processor.reset()` after *every* non-matching event, so
      // the correct note must be held cleanly from scratch.
      resetStreakRef.current();

      if (!shouldRecordWrong) return;

      lastWrongMidiRef.current = event.midiNote;
      lastWrongAtRef.current = now;
      wrongAttemptsRef.current += 1;
      busyRef.current = true;

      void (async () => {
        try {
          await store.review(
            currentTarget,
            Rating.Again,
            new Date(),
            Math.round(now - promptStartedAtRef.current),
            event.midiNote,
          );
          setStats(store.statsFor(currentTarget));
          refreshQueue();
          notifyProgressChanged();
        } finally {
          busyRef.current = false;
        }
      })();
    },
    [advanceToNextTarget, notifyProgressChanged, refreshQueue],
  );

  const skipToNext = useCallback(() => {
    if (busyRef.current) return;
    const currentTarget = targetRef.current;
    if (currentTarget) {
      recentKeysRef.current = [...recentKeysRef.current, currentTarget.key].slice(-6);
    }
    busyRef.current = true;
    void (async () => {
      try {
        await advanceToNextTarget();
      } finally {
        busyRef.current = false;
      }
    })();
  }, [advanceToNextTarget]);

  return useMemo(
    () => ({
      status,
      error,
      target,
      stats,
      queue,
      completedCards,
      heldMatch,
      frozen,
      nextDue,
      hasNewCards,
      sessionElapsedSec: Math.round(sessionElapsedSec()),
      handleNoteEvent,
      skipToNext,
      store: storeRef.current,
      deck,
    }),
    // The elapsed value only needs to refresh on the state changes above.
    [status, error, target, stats, queue, completedCards, heldMatch, frozen, nextDue, hasNewCards, deck, handleNoteEvent, skipToNext, sessionElapsedSec],
  );
}

/**
 * main.py had no remote copy to reconcile; the browser keeps local-first
 * semantics: a browser with real local progress wins unless the server copy was
 * updated later (e.g. reviewed on another device).
 */
export function shouldAdoptRemote(
  remote: { updated_at?: string; cards?: Record<string, unknown> },
  store: ProgressStore,
): boolean {
  const hasLocalProgress = store.targets.some((entry) => {
    const record = store.recordFor(entry);
    return Math.trunc(record.attempts ?? 0) > 0 || record.last_reviewed_at != null;
  });
  if (!hasLocalProgress) return true;
  const remoteUpdated = remote.updated_at ? Date.parse(remote.updated_at) : NaN;
  const localUpdated = Date.parse(store.updatedAt);
  if (Number.isNaN(remoteUpdated)) return false;
  if (Number.isNaN(localUpdated)) return true;
  return remoteUpdated > localUpdated;
}
