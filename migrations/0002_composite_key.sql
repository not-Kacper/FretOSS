-- migrations/0002_composite_key.sql
-- Namespace D1 progress by (user_token, deck_id) so two tunings never share a row.
--
-- Existing rows (schema 0001: user_id PRIMARY KEY) are copied onto the
-- guitar6-standard deck — the only deck the pre-update app could produce.
--
-- Apply after 0001_init.sql:
--   wrangler d1 execute fretboard_progress --remote --file=./migrations/0002_composite_key.sql

CREATE TABLE IF NOT EXISTS progress_new (
  user_token TEXT NOT NULL,
  deck_id    TEXT NOT NULL,
  data       TEXT NOT NULL,
  updated_at TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (user_token, deck_id)
);

INSERT INTO progress_new (user_token, deck_id, data, updated_at)
SELECT user_id, 'guitar6-standard', data, updated_at FROM progress;

DROP TABLE progress;
ALTER TABLE progress_new RENAME TO progress;
