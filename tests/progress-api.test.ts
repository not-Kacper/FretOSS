import { describe, expect, it } from 'vitest';

import { onRequestGet, onRequestPut, readUserToken, readDeckId } from '../functions/api/progress';

const TOKEN = 'a'.repeat(64);

function request(method: string, url: string, headers: Record<string, string> = {}, body?: string): Request {
  return new Request(url, { method, headers, body });
}

describe('progress API identity', () => {
  it('rejects missing or malformed tokens', () => {
    expect(readUserToken(request('GET', 'https://example.test/api/progress'))).toBeNull();
    expect(
      readUserToken(request('GET', 'https://example.test/api/progress', { 'X-User-Token': 'uid-1' })),
    ).toBeNull();
    expect(
      readUserToken(request('GET', 'https://example.test/api/progress', { 'X-User-Token': TOKEN })),
    ).toBe(TOKEN);
  });

  it('reads deck_id from the query string', () => {
    expect(readDeckId(request('GET', 'https://example.test/api/progress'))).toBeNull();
    expect(readDeckId(request('GET', 'https://example.test/api/progress?deck_id=ukulele4-standard'))).toBe(
      'ukulele4-standard',
    );
  });

  it('GET returns 400 when the header is missing', async () => {
    const response = await onRequestGet({
      request: request('GET', 'https://example.test/api/progress?deck_id=guitar6-standard'),
      env: { DB: { prepare: () => ({ bind: () => ({ first: async () => null, run: async () => null }) }) } },
    } as never);
    expect(response.status).toBe(400);
  });

  it('PUT upserts under the composite (token, deck_id) key', async () => {
    const binds: unknown[][] = [];
    const db = {
      prepare: () => ({
        bind: (...values: unknown[]) => {
          binds.push(values);
          return {
            first: async () => null,
            run: async () => ({ ok: true }),
          };
        },
      }),
    };
    const body = JSON.stringify({
      version: 1,
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
      scheduler: {},
      cards: {},
    });
    const response = await onRequestPut({
      request: request(
        'PUT',
        'https://example.test/api/progress?deck_id=bass4-standard',
        { 'X-User-Token': TOKEN, 'content-type': 'application/json' },
        body,
      ),
      env: { DB: db },
    } as never);
    expect(response.status).toBe(200);
    expect(binds[0][0]).toBe(TOKEN);
    expect(binds[0][1]).toBe('bass4-standard');
  });
});
