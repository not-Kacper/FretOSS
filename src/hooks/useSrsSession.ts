/**
 * hooks/useSrsSession.ts — the port of `main()`'s session loop.
 * =============================================================================
 *
 * Wraps srs/queue.ts + storage/progress-idb.ts, exactly like main.py's
 * `main()` wrapped `ProgressStore` + `ConfigManager`.
 *
 * Phase 2: the store is partitioned by deckId. Changing instrument/tuning
 * reloads a different IndexedDB partition (fresh queue/points). Changing
 * fret range or per-string selection only filters `store.targets` — out of
 * range progress is never discarded.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { midiToName } from '../audio/note-helpers';
import type { ConfigManager } from '../config/config';
import type { FretboardTarget, NoteEvent } from '../deck/types';
import { DEFAULT_DECK_ID, ProgressStore, type DotKind } from '../storage/progress-idb';
import type { ProgressSync } from '../storage/sync';
import type { Scheduler } from '../srs/scheduler';
import { ratingForCorrectAnswer } from '../srs/scheduler';
import { Rating, type CardDict, type CardStats, type QueueStats } from '../srs/types';

export type SessionStatus = 'loading' | 'ready' | 'ended' | 'error';
export type TargetFeedback = 'idle' | 'correct' | 'wrong';

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
  /** Active deck partition (tuningId). Changing this fully swaps progress. */
  deckId?: string;
  /** Targets currently in the practice queue (string + fret-range filtered). */
  queueTargets?: FretboardTarget[];
  /** Targets shown on the fretboard (fret-range filtered, all strings). */
  viewTargets?: FretboardTarget[];
  /** Bump to force a reload (e.g. after import). */
  reloadToken?: number;
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
  /** Per-target FSRS colour, updated live after every review. */
  dotKinds: Record<string, DotKind>;
  /** Wrong-answer counter for the current prompt (reveal after 5). */
  wrongAttempts: number;
  revealed: boolean;
  /** CSS transition driver for the current-target ring. */
  targetFeedback: TargetFeedback;
}

const EMPTY_STATS: CardStats = { points: 0, attempts: 0, correct: 0, wrong: 0 };
const REVEAL_AFTER = 5;

export function useSrsSession({
  config,
  resetStreak,
  sync = null,
  deckId = DEFAULT_DECK_ID,
  queueTargets = [],
  viewTargets = [],
  reloadToken = 0,
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
  const [dotKinds, setDotKinds] = useState<Record<string, DotKind>>({});
  const [wrongAttempts, setWrongAttempts] = useState(0);
  const [revealed, setRevealed] = useState(false);
  const [targetFeedback, setTargetFeedback] = useState<TargetFeedback>('idle');

  const storeRef = useRef<ProgressStore | null>(null);
  const schedulerRef = useRef<Scheduler | null>(null);
  const targetRef = useRef<FretboardTarget | null>(null);
  const readyRef = useRef(false);
  const sessionStartedAtRef = useRef(0);
  const newCardsStartedRef = useRef(0);
  const recentKeysRef = useRef<string[]>([]);
  const promptStartedAtRef = useRef(0);
  const wrongAttemptsRef = useRef(0);
  const revealedRef = useRef(false);
  const lastWrongMidiRef = useRef<number | null>(null);
  const lastWrongAtRef = useRef(0);
  const pauseUntilRef = useRef(0);
  const pauseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const busyRef = useRef(false);
  const resetStreakRef = useRef(resetStreak);
  resetStreakRef.current = resetStreak;
  const syncRef = useRef(sync);
  syncRef.current = sync;
  const configRef = useRef(config);
  configRef.current = config;
  const viewTargetsRef = useRef(viewTargets);
  viewTargetsRef.current = viewTargets;
  const queueTargetsRef = useRef(queueTargets);
  queueTargetsRef.current = queueTargets;

  const sessionElapsedSec = useCallback(
    () => Math.max(0, (performance.now() - sessionStartedAtRef.current) / 1000),
    [],
  );

  const newCardAllowance = useCallback(() => {
    const currentConfig = configRef.current;
    if (!currentConfig) return 0;
    return currentConfig.newCardAllowance(sessionElapsedSec());
  }, [sessionElapsedSec]);

  const refreshDots = useCallback(() => {
    const store = storeRef.current;
    if (!store) return;
    setDotKinds(store.dotKinds(viewTargetsRef.current));
  }, []);

  const refreshQueue = useCallback((): QueueStats | null => {
    const store = storeRef.current;
    const currentConfig = configRef.current;
    if (!store || !currentConfig) return null;
    const next = store.queueStats(new Date(), newCardAllowance(), newCardsStartedRef.current);
    setQueue(next);
    refreshDots();
    return next;
  }, [newCardAllowance, refreshDots]);

  const notifyProgressChanged = useCallback(() => {
    const store = storeRef.current;
    if (store && syncRef.current) syncRef.current.push(store.toProgressFile());
  }, []);

  const resetPromptBookkeeping = useCallback(() => {
    promptStartedAtRef.current = performance.now();
    wrongAttemptsRef.current = 0;
    revealedRef.current = false;
    lastWrongMidiRef.current = null;
    lastWrongAtRef.current = 0;
    setWrongAttempts(0);
    setRevealed(false);
    setTargetFeedback('idle');
    resetStreakRef.current();
  }, []);

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
    resetPromptBookkeeping();
    notifyProgressChanged();
  }, [newCardAllowance, notifyProgressChanged, refreshQueue, resetPromptBookkeeping]);

  // -- session bootstrap: full swap when config, deckId, or import token change
  useEffect(() => {
    if (!config) return;
    let cancelled = false;

    void (async () => {
      try {
        setStatus('loading');
        setError(null);
        readyRef.current = false;
        const scheduler = config.createScheduler();
        const initialQueue = queueTargetsRef.current;
        const store = await ProgressStore.load(scheduler, initialQueue, { deckId });

        if (cancelled) {
          store.close();
          return;
        }

        storeRef.current = store;
        schedulerRef.current = scheduler;
        setDeck(initialQueue);
        newCardsStartedRef.current = 0;
        recentKeysRef.current = [];
        setCompletedCards(0);

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
        setStatus('ready');
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
      if (flashTimerRef.current !== null) {
        clearTimeout(flashTimerRef.current);
        flashTimerRef.current = null;
      }
      readyRef.current = false;
      storeRef.current?.close();
      storeRef.current = null;
    };
    // queueTargets are applied via the filter effect below so string/fret
    // changes don't throw away the in-memory session (newCardsStarted, etc.).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config, deckId, reloadToken]);

  // -- fret-range / string-selection filter: never a new deck
  const queueKey = queueTargets.map((target) => target.key).join(',');
  useEffect(() => {
    const store = storeRef.current;
    if (!store || !readyRef.current) return;
    const nextTargets = queueTargetsRef.current;
    setDeck(nextTargets);
    void (async () => {
      await store.setTargets(nextTargets);
      const current = targetRef.current;
      if (current && !nextTargets.some((target) => target.key === current.key)) {
        await advanceToNextTarget();
      } else {
        refreshQueue();
      }
    })();
  }, [queueKey, advanceToNextTarget, refreshQueue]);

  const viewKey = viewTargets.map((target) => target.key).join(',');
  useEffect(() => {
    refreshDots();
  }, [viewKey, refreshDots]);

  const handleNoteEvent = useCallback(
    (event: NoteEvent) => {
      const store = storeRef.current;
      const currentConfig = configRef.current;
      const currentTarget = targetRef.current;

      if (!readyRef.current || !store || !currentConfig || !currentTarget) return;
      if (performance.now() < pauseUntilRef.current) return;
      if (busyRef.current) return;

      const noteName = midiToName(event.midiNote);
      const isMatch = event.midiNote === currentTarget.midiNote;
      const detectedAt = performance.now();

      if (isMatch) {
        busyRef.current = true;
        const elapsedSec = (detectedAt - promptStartedAtRef.current) / 1000;
        // After a reveal the match is always Again, bypassing Easy/Good timing.
        const rating = revealedRef.current
          ? Rating.Again
          : ratingForCorrectAnswer(elapsedSec, wrongAttemptsRef.current, currentConfig);

        setHeldMatch({
          midiNote: event.midiNote,
          noteName,
          frequency: event.frequency,
          confidence: event.confidence,
          isMatch: true,
          detectedAt,
        });
        setCompletedCards((count) => count + 1);
        setTargetFeedback('correct');
        setRevealed(false);

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

      const now = performance.now();
      const shouldRecordWrong =
        lastWrongMidiRef.current !== event.midiNote ||
        now - lastWrongAtRef.current >= currentConfig.wrongRepeatCooldownSec * 1000;

      resetStreakRef.current();

      if (!shouldRecordWrong) return;

      lastWrongMidiRef.current = event.midiNote;
      lastWrongAtRef.current = now;
      wrongAttemptsRef.current += 1;
      setWrongAttempts(wrongAttemptsRef.current);
      if (wrongAttemptsRef.current >= REVEAL_AFTER) {
        revealedRef.current = true;
        setRevealed(true);
      }
      setTargetFeedback('wrong');
      if (flashTimerRef.current !== null) clearTimeout(flashTimerRef.current);
      flashTimerRef.current = setTimeout(() => {
        setTargetFeedback('idle');
        flashTimerRef.current = null;
      }, 250);
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
      dotKinds,
      wrongAttempts,
      revealed,
      targetFeedback,
    }),
    [
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
      deck,
      handleNoteEvent,
      skipToNext,
      sessionElapsedSec,
      dotKinds,
      wrongAttempts,
      revealed,
      targetFeedback,
    ],
  );
}

/**
 * Local-first: a browser with real local progress wins unless the server copy
 * was updated later (e.g. reviewed on another device). Compared per deck.
 */
export function shouldAdoptRemote(
  remote: { updated_at?: string; cards?: Record<string, unknown> },
  store: ProgressStore,
): boolean {
  const hasLocalProgress = store.targets.some((entry) => {
    try {
      const record = store.recordFor(entry);
      return Math.trunc(record.attempts ?? 0) > 0 || record.last_reviewed_at != null;
    } catch {
      return false;
    }
  });
  if (!hasLocalProgress) return true;
  const remoteUpdated = remote.updated_at ? Date.parse(remote.updated_at) : NaN;
  const localUpdated = Date.parse(store.updatedAt);
  if (Number.isNaN(remoteUpdated)) return false;
  if (Number.isNaN(localUpdated)) return true;
  return remoteUpdated > localUpdated;
}
