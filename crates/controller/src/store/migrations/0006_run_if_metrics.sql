CREATE TABLE IF NOT EXISTS run_if_metrics (
  run_id   TEXT    NOT NULL,
  step_id  TEXT    NOT NULL,   -- the `if` node's id
  branch   TEXT    NOT NULL,   -- "then" | "elif_0".. | "else" | "none"
  count    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (run_id, step_id, branch)
);
