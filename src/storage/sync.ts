/**
 * storage/sync.ts — cross-device progress sync against the Pages Function.
 *
 *   GET /api/progress?uid=xxx  -> pull the last synced progress.json blob
 *   PUT /api/progress?uid=xxx  -> upsert the blob into D1
 *
 * `uid` is a client-generated anonymous UUID kept in localStorage (no auth, by
 * design — this is convenience sync, not security).
 *
 * The Python app had no equivalent (it wrote progress.json locally); this adds
 * exactly the two operations main.py's persistence needs to survive a device
 * switch:
 *
 *   - `pull()` on first load: a client with an empty IndexedDB (fresh browser or
 *     "hard clear") adopts the last server-synced state.
 *   - `push()`: debounced PUT after local changes (Python's `save()` equivalent,
 *     coalesced so a busy review session does not hammer the endpoint).
 */

import type { ProgressFile } from '../srs/types';

const UID_STORAGE_KEY = 'srs-fretboard.uid';

export type SyncStatus = 'idle' | 'syncing' | 'synced' | 'offline' | 'error';

export interface SyncState {
  status: SyncStatus;
  lastSyncedAt: string | null;
  message: string | null;
}

/** Stable for the life of the page when localStorage is unavailable. */
let fallbackUid: string | null = null;

function newUid(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `uid-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

/** Anonymous per-browser id (Python had no counterpart: progress.json was local). */
export function getUserId(): string {
  try {
    const existing = localStorage.getItem(UID_STORAGE_KEY);
    if (existing) return existing;
    const uid = newUid();
    localStorage.setItem(UID_STORAGE_KEY, uid);
    return uid;
  } catch {
    // Storage blocked: fall back to a per-session id (sync becomes ephemeral,
    // but it must at least stay constant for this page).
    fallbackUid ??= `session-${newUid()}`;
    return fallbackUid;
  }
}

export interface ProgressSyncOptions {
  uid?: string;
  /** Coalescing window for pushes. */
  debounceMs?: number;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
  onStateChange?: (state: SyncState) => void;
}

export interface ProgressSync {
  /** GET the remote blob; `null` when the server has nothing stored yet. */
  pull: () => Promise<ProgressFile | null>;
  /** Schedule a debounced PUT of the given blob. */
  push: (file: ProgressFile) => void;
  /** Push immediately (page hide / manual "sync now"). */
  flush: () => Promise<void>;
  /** Current sync state + subscription for the UI. */
  getState: () => SyncState;
  subscribe: (listener: (state: SyncState) => void) => () => void;
  dispose: () => void;
}

function readErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export function createProgressSync(options: ProgressSyncOptions = {}): ProgressSync {
  const uid = options.uid ?? getUserId();
  const debounceMs = options.debounceMs ?? 1500;
  const doFetch = options.fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  const endpoint = `/api/progress?uid=${encodeURIComponent(uid)}`;

  let state: SyncState = { status: 'idle', lastSyncedAt: null, message: null };
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending: ProgressFile | null = null;
  let inFlight: Promise<void> | null = null;
  const listeners = new Set<(state: SyncState) => void>();

  const setState = (next: Partial<SyncState>): void => {
    state = { ...state, ...next };
    options.onStateChange?.(state);
    for (const listener of listeners) listener(state);
  };

  const send = async (file: ProgressFile): Promise<void> => {
    setState({ status: 'syncing', message: null });
    try {
      const response = await doFetch(endpoint, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(file),
      });
      if (!response.ok) {
        throw new Error(`PUT /api/progress failed with HTTP ${response.status}`);
      }
      setState({
        status: 'synced',
        lastSyncedAt: new Date().toISOString(),
        message: null,
      });
    } catch (error) {
      // Sync is best-effort: local IndexedDB remains the source of truth
      // (acceptance criteria: no data loss without a server).
      setState({ status: 'error', message: readErrorMessage(error) });
    }
  };

  const flush = async (): Promise<void> => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    const file = pending;
    pending = null;
    if (file) {
      inFlight = send(file);
      await inFlight;
      inFlight = null;
    } else if (inFlight) {
      await inFlight;
    }
  };

  return {
    pull: async () => {
      setState({ status: 'syncing', message: null });
      try {
        const response = await doFetch(endpoint, { method: 'GET' });
        if (response.status === 404) {
          setState({ status: 'synced', lastSyncedAt: new Date().toISOString(), message: null });
          return null;
        }
        if (!response.ok) {
          throw new Error(`GET /api/progress failed with HTTP ${response.status}`);
        }
        const payload = (await response.json()) as ProgressFile | null;
        setState({ status: 'synced', lastSyncedAt: new Date().toISOString(), message: null });
        return payload && typeof payload === 'object' ? payload : null;
      } catch (error) {
        // Offline / not deployed yet: keep practising locally.
        setState({ status: 'offline', message: readErrorMessage(error) });
        return null;
      }
    },

    push: (file: ProgressFile) => {
      pending = file;
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        void flush();
      }, debounceMs);
    },

    flush,

    getState: () => state,

    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    dispose: () => {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      listeners.clear();
    },
  };
}
