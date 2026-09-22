/**
 * Sync layer test — src/storage/sync.ts against a stub fetch.
 *
 * Covers the contract of the Pages Function (`GET` 200/404, `PUT` upsert) plus
 * the debouncing that keeps a busy practice session from hammering D1. Sync is
 * best-effort by design: no failure here may lose local progress.
 *
 * The identity token is sent as X-User-Token (never as a URL query param).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createProgressSync, getUserId, USER_TOKEN_HEADER, type SyncState } from '../src/storage/sync';
import { getOrCreateUserId, generateUserToken, isValidUserToken, USER_TOKEN_KEY } from '../src/storage/identity';
import type { ProgressFile } from '../src/srs/types';

const TEST_TOKEN = 'a'.repeat(64);
const TEST_DECK = 'guitar6-standard';

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
  headers?: HeadersInit;
  body?: unknown;
}

function stubFetch(responder: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call: Call = {
      method: init?.method ?? 'GET',
      url: String(input),
      headers: init?.headers,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    };
    calls.push(call);
    return responder(call);
  }) as typeof fetch;
  return { calls, fetchImpl };
}

function headerOf(headers: HeadersInit | undefined, name: string): string | null {
  if (!headers) return null;
  if (headers instanceof Headers) return headers.get(name);
  if (Array.isArray(headers)) {
    const found = headers.find(([key]) => key.toLowerCase() === name.toLowerCase());
    return found ? found[1] : null;
  }
  const record = headers as Record<string, string>;
  return record[name] ?? record[name.toLowerCase()] ?? null;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('anonymous identity', () => {
  it('generates a 256-bit hex token via crypto.getRandomValues and reuses it', () => {
    const storage = new Map<string, string>();
    const previous = (globalThis as { localStorage?: unknown }).localStorage;
    (globalThis as { localStorage?: unknown }).localStorage = {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => void storage.set(key, value),
      removeItem: (key: string) => void storage.delete(key),
    };

    try {
      const first = getOrCreateUserId();
      expect(isValidUserToken(first)).toBe(true);
      expect(first).toHaveLength(64);
      expect(getOrCreateUserId()).toBe(first);
      expect(getUserId()).toBe(first);
      expect(storage.get(USER_TOKEN_KEY)).toBe(first);
      // Must not be a UUID (128-bit) or anything derived from Date/userAgent.
      expect(first.includes('-')).toBe(false);
      expect(generateUserToken()).not.toBe(first);
    } finally {
      (globalThis as { localStorage?: unknown }).localStorage = previous;
    }
  });
});

describe('createProgressSync', () => {
  it('sends the token as X-User-Token, never as a URL query param', async () => {
    const stored = blob('2026-02-01T00:00:00.000Z');
    const { calls, fetchImpl } = stubFetch(() => new Response(JSON.stringify(stored), { status: 200 }));
    const sync = createProgressSync({ uid: TEST_TOKEN, deckId: TEST_DECK, fetchImpl });

    const pulled = await sync.pull();
    expect(pulled).toEqual(stored);
    expect(calls[0].method).toBe('GET');
    expect(calls[0].url).toContain(`/api/progress?deck_id=${TEST_DECK}`);
    expect(calls[0].url).not.toContain('uid=');
    expect(calls[0].url).not.toContain(TEST_TOKEN);
    expect(headerOf(calls[0].headers, USER_TOKEN_HEADER)).toBe(TEST_TOKEN);
    sync.dispose();
  });

  it('pulls the stored blob, and treats 404 as "nothing stored yet"', async () => {
    const stored = blob('2026-02-01T00:00:00.000Z');
    const { fetchImpl } = stubFetch(() => new Response(JSON.stringify(stored), { status: 200 }));
    const sync = createProgressSync({ uid: TEST_TOKEN, deckId: TEST_DECK, fetchImpl });
    expect(await sync.pull()).toEqual(stored);

    const empty = stubFetch(() => new Response('{}', { status: 404 }));
    const syncEmpty = createProgressSync({ uid: TEST_TOKEN, deckId: TEST_DECK, fetchImpl: empty.fetchImpl });
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
      uid: TEST_TOKEN,
      deckId: TEST_DECK,
      fetchImpl,
      onStateChange: (state) => states.push(state),
    });

    expect(await sync.pull()).toBeNull();
    expect(states[states.length - 1].status).toBe('offline');
    sync.dispose();
  });

  it('debounces and coalesces PUTs (only the newest blob is sent)', async () => {
    const { calls, fetchImpl } = stubFetch(() => new Response('{"ok":true}', { status: 200 }));
    const sync = createProgressSync({ uid: TEST_TOKEN, deckId: TEST_DECK, fetchImpl, debounceMs: 1500 });

    sync.push(blob('2026-02-01T00:00:00.000Z'));
    sync.push(blob('2026-02-01T00:00:01.000Z'));
    sync.push(blob('2026-02-01T00:00:02.000Z'));
    expect(calls).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(1500);
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe('PUT');
    expect(headerOf(calls[0].headers, USER_TOKEN_HEADER)).toBe(TEST_TOKEN);
    expect(calls[0].url).not.toContain(TEST_TOKEN);
    expect((calls[0].body as ProgressFile).updated_at).toBe('2026-02-01T00:00:02.000Z');
    expect(sync.getState().status).toBe('synced');
    sync.dispose();
  });

  it('flush() pushes immediately (page hide / manual save)', async () => {
    const { calls, fetchImpl } = stubFetch(() => new Response('{"ok":true}', { status: 200 }));
    const sync = createProgressSync({ uid: TEST_TOKEN, deckId: TEST_DECK, fetchImpl, debounceMs: 10_000 });

    sync.push(blob('2026-02-01T00:00:00.000Z'));
    await sync.flush();
    expect(calls).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(20_000);
    expect(calls).toHaveLength(1);
    sync.dispose();
  });

  it('reports write failures without losing local state', async () => {
    const { fetchImpl } = stubFetch(() => new Response('nope', { status: 500 }));
    const sync = createProgressSync({ uid: TEST_TOKEN, deckId: TEST_DECK, fetchImpl, debounceMs: 10 });

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
    const sync = createProgressSync({ uid: TEST_TOKEN, deckId: TEST_DECK, fetchImpl });
    expect(calls).toHaveLength(0);
    sync.dispose();
  });
});
