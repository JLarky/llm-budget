export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS usage_events (
  id INTEGER PRIMARY KEY,
  timestamp TEXT NOT NULL,
  conversation_id TEXT,
  generation_id TEXT,
  event_type TEXT NOT NULL,
  model TEXT,
  dedupe_key TEXT UNIQUE
);

CREATE INDEX IF NOT EXISTS idx_usage_timestamp ON usage_events(timestamp);

CREATE TABLE IF NOT EXISTS app_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS warning_emissions (
  window_id TEXT NOT NULL,
  threshold REAL NOT NULL,
  period_key TEXT NOT NULL,
  fired_at TEXT NOT NULL,
  PRIMARY KEY (window_id, threshold, period_key)
);

-- Per-provider vendor usage cache + cross-process refresh lease (singleflight).
-- See src/llm/usage/cache.ts. Never stores tokens.
CREATE TABLE IF NOT EXISTS provider_usage_cache (
  provider_id TEXT PRIMARY KEY,
  result_json TEXT,
  result_at INTEGER,
  good_json TEXT,
  good_at INTEGER,
  seq INTEGER NOT NULL DEFAULT 0,
  failures INTEGER NOT NULL DEFAULT 0,
  backoff_until INTEGER,
  last_error TEXT,
  lease_owner TEXT,
  lease_pid INTEGER,
  lease_until INTEGER
);
`;
