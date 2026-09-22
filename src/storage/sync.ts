/**
 * storage/sync.ts — cross-device progress sync against the Pages Function.
 *
 *   GET /api/progress?deck_id=xxx   + header X-User-Token
 *   PUT /api/progress?deck_id=xxx   + header X-User-Token
 *
 * The token is a 256-bit random secret (src/storage/identity.ts), sent as a
 * header so it does not leak into server/proxy access logs via the URL.
 * deck_id is a non-secret query param so each tuning has its own D1 row.
 *
 *   - `pull()` on first load: a client with an empty IndexedDB (fresh browser or
 *     "hard clear") adopts the last server-synced state for this deck.
 *   - `push()`: debounced PUT after local changes, coalesced so a busy review
 *     session does not hammer the endpoint.
 */

import type { ProgressFile } from '../srs/types';
import { DEFAULT_DECK_ID } from './progress-idb';
import { getOrCreateUserId } from './identity';

export const USER_TOKEN_HEADER = 'X-User-Token';

export type SyncStatus = 'idle' | 'syncing' | 'synced' | 'offline' | 'error';

export interface SyncState {
  status: SyncStatus;
  lastSyncedAt: string | null;
  message: string | null;
}

/** @deprecated Use getOrCreateUserId from identity.ts. Kept as a thin alias. */
export function getUserId(): string {
  return getOrCreateUserId();
}

export interface ProgressSyncOptions {
  uid?: string;
  deckId?: string;
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
  readonly deckId: string;
}

function readErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export function createProgressSync(options: ProgressSyncOptions = {}): ProgressSync {
  const uid = options.uid ?? getOrCreateUserId();
  const deckId = options.deckId ?? DEFAULT_DECK_ID;
  const debounceMs = options.debounceMs ?? 1500;
  const doFetch = options.fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  const endpoint = `/api/progress?deck_id=${encodeURIComponent(deckId)}`;
  const headers = (): Record<string, string> => ({
    'content-type': 'application/json',
    [USER_TOKEN_HEADER]: uid,
  });

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
        headers: headers(),
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
    deckId,

    pull: async () => {
      setState({ status: 'syncing', message: null });
      try {
        const response = await doFetch(endpoint, { method: 'GET', headers: headers() });
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
