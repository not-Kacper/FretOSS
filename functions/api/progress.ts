/**
 * functions/api/progress.ts — Cloudflare Pages Function (runs as a Worker).
 *
 *   GET /api/progress?uid=xxx -> the last stored progress blob for that uid
 *   PUT /api/progress?uid=xxx -> upsert the blob into D1
 *
 * No auth by design: `uid` is a client-generated anonymous UUID kept in
 * localStorage, used for cross-device convenience sync (never for security).
 * Anyone who knows a uid can read/write that blob.
 *
 * Response contract used by src/storage/sync.ts:
 *   200 { ...blob }   — stored payload (its `data` column, JSON-parsed)
 *   404 { error }     — nothing stored for this uid yet
 *   400 { error }     — missing uid / invalid JSON body
 *   500 { error }     — D1 failure
 */

// Minimal structural types so this file type-checks without pulling in
// @cloudflare/workers-types globally (which would clash with the DOM lib).
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

const MAX_BODY_BYTES = 8 * 1024 * 1024; // progress.json is ~70 KB in practice.

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

function readUid(request: Request): string | null {
  const uid = new URL(request.url).searchParams.get('uid');
  if (uid === null) return null;
  const trimmed = uid.trim();
  if (trimmed.length === 0 || trimmed.length > 200) return null;
  return trimmed;
}

/** GET /api/progress?uid=xxx */
export const onRequestGet = async (context: PagesContext): Promise<Response> => {
  const uid = readUid(context.request);
  if (!uid) return json({ error: 'missing uid' }, 400);
  if (!context.env?.DB) return json({ error: 'D1 binding DB is not configured' }, 500);

  try {
    const row = await context.env.DB.prepare(
      'SELECT data, updated_at FROM progress WHERE user_id = ?',
    )
      .bind(uid)
      .first<{ data: string; updated_at: string | null }>();

    if (!row?.data) return json({ error: 'no progress stored for this uid' }, 404);

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

/** PUT /api/progress?uid=xxx */
export const onRequestPut = async (context: PagesContext): Promise<Response> => {
  const uid = readUid(context.request);
  if (!uid) return json({ error: 'missing uid' }, 400);
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
      `INSERT INTO progress (user_id, data, updated_at)
       VALUES (?, ?, datetime('now'))
       ON CONFLICT(user_id) DO UPDATE SET
         data = excluded.data,
         updated_at = excluded.updated_at`,
    )
      .bind(uid, JSON.stringify(parsed))
      .run();

    return json({ ok: true, updated_at: new Date().toISOString() });
  } catch (error) {
    return json({ error: `D1 write failed: ${(error as Error).message}` }, 500);
  }
};

/** Anything else on /api/progress is a client bug. */
export const onRequest = async ({ request }: PagesContext): Promise<Response> =>
  json({ error: `method ${request.method} not allowed` }, 405);
