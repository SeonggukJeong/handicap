CREATE TABLE IF NOT EXISTS scenarios (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  yaml        TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  version     INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS runs (
  id              TEXT PRIMARY KEY,
  scenario_id     TEXT NOT NULL REFERENCES scenarios(id),
  scenario_yaml   TEXT NOT NULL,
  profile_json    TEXT NOT NULL,
  env_json        TEXT NOT NULL,
  status          TEXT NOT NULL,
  started_at      INTEGER,
  ended_at        INTEGER,
  created_at      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS run_metrics (
  run_id           TEXT NOT NULL REFERENCES runs(id),
  ts_second        INTEGER NOT NULL,
  step_id          TEXT NOT NULL,
  count            INTEGER NOT NULL,
  error_count      INTEGER NOT NULL,
  hdr_histogram    BLOB NOT NULL,
  status_counts    TEXT NOT NULL,
  PRIMARY KEY (run_id, ts_second, step_id)
);

CREATE INDEX IF NOT EXISTS idx_runs_scenario ON runs(scenario_id);
CREATE INDEX IF NOT EXISTS idx_metrics_run ON run_metrics(run_id);
