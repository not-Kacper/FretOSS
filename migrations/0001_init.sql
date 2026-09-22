-- migrations/0001_init.sql
-- D1 schema for cross-device progress sync.
--
-- `user_id` is the anonymous UUID generated client-side and kept in
-- localStorage (src/storage/sync.ts). `data` is the whole progress.json blob:
-- { version, created_at, updated_at, scheduler, cards }, i.e. exactly what the
-- Python app wrote to disk and what src/storage/progress-idb.ts exports, so the
-- same payload can be produced/consumed by either front-end.
--
-- Apply locally:  npm run db:migrate:local
-- Apply remotely: npm run db:migrate:remote

CREATE TABLE IF NOT EXISTS progress (
  user_id    TEXT PRIMARY KEY,
  data       TEXT NOT NULL,
  updated_at TEXT DEFAULT (datetime('now'))
);
