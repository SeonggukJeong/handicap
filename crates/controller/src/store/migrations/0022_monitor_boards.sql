CREATE TABLE IF NOT EXISTS monitor_boards (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,
  config_json TEXT NOT NULL,
  enabled     INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
