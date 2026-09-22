/**
 * Sync layer test — src/storage/sync.ts against a stub fetch.
 *
 * Covers the contract of the Pages Function (`GET` 200/404, `PUT` upsert) plus
 * the debouncing that keeps a busy practice session from hammering D1. Sync is
 * best-effort by design: no failure here may lose local progress.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createProgressSync, getUserId, type SyncState } from '../src/storage/sync';
import type { ProgressFile } from '../src/srs/types';

const blob = (updatedAt: string): ProgressFile => ({
  version: 1,
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: updatedAt,
  scheduler: {
    parameters: [],
    desired_retention: 0.9,
    learning_steps: [60, 600],
    relearning_steps: [600],
    maximum_interval: 36500,
    enable_fuzzing: true,
  },
  cards: {},
});

interface Call {
  method: string;
  url: string;
  body?: unknown;
}

function stubFetch(responder: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call: Call = {
      method: init?.method ?? 'GET',
      url: String(input),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    };
    calls.push(call);
    return responder(call);
  }) as typeof fetch;
  return { calls, fetchImpl };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('createProgressSync', () => {
  it('generates and reuses an anonymous uid (persisted in localStorage)', () => {
    const storage = new Map<string, string>();
    const previous = (globalThis as { localStorage?: unknown }).localStorage;
    (globalThis as { localStorage?: unknown }).localStorage = {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => void storage.set(key, value),
      removeItem: (key: string) => void storage.delete(key),
    };

    try {
      const first = getUserId();
      expect(first).toBeTruthy();
      expect(getUserId()).toBe(first); // re-used, not regenerated
      expect(storage.get('srs-fretboard.uid')).toBe(first);
    } finally {
      (globalThis as { localStorage?: unknown }).localStorage = previous;
    }
  });

  it('pulls the stored blob, and treats 404 as "nothing stored yet"', async () => {
    const stored = blob('2026-02-01T00:00:00.000Z');
    const { calls, fetchImpl } = stubFetch(() =>
      new Response(JSON.stringify(stored), { status: 200 }),
    );
    const sync = createProgressSync({ uid: 'uid-1', fetchImpl });

    const pulled = await sync.pull();
    expect(pulled).toEqual(stored);
    expect(calls[0].method).toBe('GET');
    expect(calls[0].url).toContain('/api/progress?uid=uid-1');

    const empty = stubFetch(() => new Response('{}', { status: 404 }));
    const syncEmpty = createProgressSync({ uid: 'uid-2', fetchImpl: empty.fetchImpl });
    expect(await syncEmpty.pull()).toBeNull();
    sync.dispose();
    syncEmpty.dispose();
  });

  it('stays offline-tolerant: a failed pull returns null instead of throwing', async () => {
    const { fetchImpl } = stubFetch(() => {
      throw new Error('network down');
    });
    const states: SyncState[] = [];
    const sync = createProgressSync({
      uid: 'uid-3',
      fetchImpl,
      onStateChange: (state) => states.push(state),
    });

    expect(await sync.pull()).toBeNull();
    expect(states[states.length - 1].status).toBe('offline');
    sync.dispose();
  });

  it('debounces and coalesces PUTs (only the newest blob is sent)', async () => {
    const { calls, fetchImpl } = stubFetch(() => new Response('{"ok":true}', { status: 200 }));
    const sync = createProgressSync({ uid: 'uid-4', fetchImpl, debounceMs: 1500 });

    sync.push(blob('2026-02-01T00:00:00.000Z'));
    sync.push(blob('2026-02-01T00:00:01.000Z'));
    sync.push(blob('2026-02-01T00:00:02.000Z'));
    expect(calls).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(1500);
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe('PUT');
    expect((calls[0].body as ProgressFile).updated_at).toBe('2026-02-01T00:00:02.000Z');
    expect(sync.getState().status).toBe('synced');
    sync.dispose();
  });

  it('flush() pushes immediately (page hide / manual save)', async () => {
    const { calls, fetchImpl } = stubFetch(() => new Response('{"ok":true}', { status: 200 }));
    const sync = createProgressSync({ uid: 'uid-5', fetchImpl, debounceMs: 10_000 });

    sync.push(blob('2026-02-01T00:00:00.000Z'));
    await sync.flush();
    expect(calls).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(20_000);
    expect(calls).toHaveLength(1); // the debounce timer was cancelled
    sync.dispose();
  });

  it('reports write failures without losing local state', async () => {
    const { fetchImpl } = stubFetch(() => new Response('nope', { status: 500 }));
    const sync = createProgressSync({ uid: 'uid-6', fetchImpl, debounceMs: 10 });

    sync.push(blob('2026-02-01T00:00:00.000Z'));
    await vi.advanceTimersByTimeAsync(20);

    const state = sync.getState();
    expect(state.status).toBe('error');
    expect(state.message).toContain('500');
    expect(state.lastSyncedAt).toBeNull();
    sync.dispose();
  });

  it('never talks to the network unless pull/push is called', async () => {
    const { calls, fetchImpl } = stubFetch(() => new Response('{}', { status: 200 }));
    const sync = createProgressSync({ uid: 'uid-7', fetchImpl });
    // The pitch pipeline must stay 100% client-side (acceptance criterion): the
    // sync client is inert until the store asks it to sync.
    expect(calls).toHaveLength(0);
    sync.dispose();
  });
});
