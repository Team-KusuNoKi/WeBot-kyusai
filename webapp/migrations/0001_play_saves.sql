-- Deleted saves retain their number reservation, so an old number never opens another player's game.
CREATE TABLE IF NOT EXISTS play_saves (
  scenario_id TEXT NOT NULL,
  code_hash TEXT NOT NULL CHECK (length(code_hash) = 64),
  creation_hash TEXT NOT NULL CHECK (length(creation_hash) = 64),
  allocation_nonce INTEGER NOT NULL CHECK (allocation_nonce >= 0),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  state_json TEXT CHECK (state_json IS NULL OR json_valid(state_json)),
  view_json TEXT CHECK (view_json IS NULL OR json_valid(view_json)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  PRIMARY KEY (scenario_id, code_hash),
  UNIQUE (scenario_id, creation_hash),
  CHECK ((deleted_at IS NULL AND state_json IS NOT NULL AND view_json IS NOT NULL)
    OR (deleted_at IS NOT NULL AND state_json IS NULL AND view_json IS NULL))
);

CREATE TABLE IF NOT EXISTS play_save_rate_limits (
  bucket_key TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('create', 'failed-code')),
  attempts INTEGER NOT NULL CHECK (attempts >= 1),
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (bucket_key, window_start, kind)
);
CREATE INDEX IF NOT EXISTS play_save_rate_expiry ON play_save_rate_limits (expires_at);
