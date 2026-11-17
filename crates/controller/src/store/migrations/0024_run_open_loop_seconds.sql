-- migration 0024: open-loop 초 단위 시작·완료·버림 계수 + 워커별 시작 시각 (spec 2026-11-18-stage-saturation-table §4.3).
CREATE TABLE IF NOT EXISTS run_open_loop_seconds (
  run_id TEXT NOT NULL, worker_id TEXT NOT NULL, ts_second INTEGER NOT NULL,
  launched INTEGER NOT NULL, completed INTEGER NOT NULL, dropped INTEGER NOT NULL,
  PRIMARY KEY (run_id, worker_id, ts_second));
CREATE TABLE IF NOT EXISTS run_worker_starts (
  run_id TEXT NOT NULL, worker_id TEXT NOT NULL, started_at_ms INTEGER NOT NULL,
  PRIMARY KEY (run_id, worker_id));
