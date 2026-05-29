CREATE TABLE IF NOT EXISTS run_loop_metrics (
  run_id      TEXT    NOT NULL,
  step_id     TEXT    NOT NULL,
  loop_index  INTEGER NOT NULL,   -- 4294967295 = overflow bucket (>= cap)
  count       INTEGER NOT NULL DEFAULT 0,
  error_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (run_id, step_id, loop_index)
);
