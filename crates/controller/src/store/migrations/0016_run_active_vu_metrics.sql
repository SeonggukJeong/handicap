-- migration 0016: per-second active-VU gauge series (closed-loop VU curve only).
-- Scalar gauge (not HDR), single-worker (curve rejects capacity overflow with 400),
-- so no worker_id. UPSERT keep-last on (run_id, ts_second).
CREATE TABLE IF NOT EXISTS run_active_vu_metrics (
  run_id     TEXT    NOT NULL,
  ts_second  INTEGER NOT NULL,
  desired    INTEGER NOT NULL,
  actual     INTEGER NOT NULL,
  PRIMARY KEY (run_id, ts_second)
);
