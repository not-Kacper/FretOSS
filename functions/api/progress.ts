/**
 * functions/api/progress.ts — Cloudflare Pages Function (runs as a Worker).
 *
 *   GET /api/progress?deck_id=xxx  + header X-User-Token
 *   PUT /api/progress?deck_id=xxx  + header X-User-Token
 *
 * No password, no email, no signup: the 256-bit random token IS the identity.
 * Composite D1 key is (user_token, deck_id) so two tunings never share a row.
 *
 * Response contract used by src/storage/sync.ts:
 *   200 { ...blob }   — stored payload (its `data` column, JSON-parsed)
 *   404 { error }     — nothing stored for this token+deck yet
 *   400 { error }     — missing/malformed token or deck_id / invalid JSON body
 *   500 { error }     — D1 failure
 */

interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = unknown>(): Promise<T | null>;
  run(): Promise<unknown>;
}

interface D1Database {
  prepare(query: string): D1PreparedStatement;
}

export interface Env {
  /** Binding declared in wrangler.toml ([[d1_databases]] binding = "DB"). */
  DB: D1Database;
}

interface PagesContext {
  request: Request;
  env: Env;
}

const MAX_BODY_BYTES = 8 * 1024 * 1024;
const USER_TOKEN_HEADER = 'X-User-Token';
const TOKEN_HEX_LENGTH = 64;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

export function readUserToken(request: Request): string | null {
  const header = request.headers.get(USER_TOKEN_HEADER) ?? request.headers.get(USER_TOKEN_HEADER.toLowerCase());
  if (header === null) return null;
  const trimmed = header.trim().toLowerCase();
  if (trimmed.length !== TOKEN_HEX_LENGTH || !/^[0-9a-f]+$/.test(trimmed)) return null;
  return trimmed;
}

export function readDeckId(request: Request): string | null {
  const fromHeader = request.headers.get('X-Deck-Id') ?? request.headers.get('x-deck-id');
  const fromQuery = new URL(request.url).searchParams.get('deck_id');
  const raw = (fromHeader ?? fromQuery ?? '').trim();
  if (raw.length === 0 || raw.length > 200) return null;
  if (!/^[A-Za-z0-9._:-]+$/.test(raw)) return null;
  return raw;
}

/** GET /api/progress?deck_id=xxx */
export const onRequestGet = async (context: PagesContext): Promise<Response> => {
  const token = readUserToken(context.request);
  if (!token) return json({ error: 'missing or malformed X-User-Token' }, 400);
  const deckId = readDeckId(context.request);
  if (!deckId) return json({ error: 'missing or malformed deck_id' }, 400);
  if (!context.env?.DB) return json({ error: 'D1 binding DB is not configured' }, 500);

  try {
    const row = await context.env.DB.prepare(
      'SELECT data, updated_at FROM progress WHERE user_token = ? AND deck_id = ?',
    )
      .bind(token, deckId)
      .first<{ data: string; updated_at: string | null }>();

    if (!row?.data) return json({ error: 'no progress stored for this token and deck' }, 404);

    let payload: unknown;
    try {
      payload = JSON.parse(row.data);
    } catch {
      return json({ error: 'stored progress is not valid JSON' }, 500);
    }
    return json(payload);
  } catch (error) {
    return json({ error: `D1 read failed: ${(error as Error).message}` }, 500);
  }
};

/** PUT /api/progress?deck_id=xxx */
export const onRequestPut = async (context: PagesContext): Promise<Response> => {
  const token = readUserToken(context.request);
  if (!token) return json({ error: 'missing or malformed X-User-Token' }, 400);
  const deckId = readDeckId(context.request);
  if (!deckId) return json({ error: 'missing or malformed deck_id' }, 400);
  if (!context.env?.DB) return json({ error: 'D1 binding DB is not configured' }, 500);

  const raw = await context.request.text();
  if (raw.length > MAX_BODY_BYTES) return json({ error: 'payload too large' }, 413);

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return json({ error: 'body must be valid JSON' }, 400);
  }
  if (parsed === null || typeof parsed !== 'object' || typeof (parsed as { cards?: unknown }).cards !== 'object') {
    return json({ error: 'body must be a progress file ({ version, cards, ... })' }, 400);
  }

  try {
    await context.env.DB.prepare(
      `INSERT INTO progress (user_token, deck_id, data, updated_at)
       VALUES (?, ?, ?, datetime('now'))
       ON CONFLICT(user_token, deck_id) DO UPDATE SET
         data = excluded.data,
         updated_at = excluded.updated_at`,
    )
      .bind(token, deckId, JSON.stringify(parsed))
      .run();

    return json({ ok: true, updated_at: new Date().toISOString() });
  } catch (error) {
    return json({ error: `D1 write failed: ${(error as Error).message}` }, 500);
  }
};

/** Anything else on /api/progress is a client bug. */
export const onRequest = async ({ request }: PagesContext): Promise<Response> =>
  json({ error: `method ${request.method} not allowed` }, 405);
