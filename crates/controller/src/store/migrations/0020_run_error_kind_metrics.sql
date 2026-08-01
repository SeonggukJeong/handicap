-- migration 0020: send-실패 8종 분류(spec 2026-08-01 §3.1) counts-only 운반 테이블.
CREATE TABLE IF NOT EXISTS run_error_kind_metrics (
  run_id   TEXT    NOT NULL,
  step_id  TEXT    NOT NULL,
  kind     TEXT    NOT NULL,   -- spec 2026-08-01 §3.1 snake_case 8종
  count    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (run_id, step_id, kind)
);
