-- migration 0027: 반복 밖 구간(준비 스텝, 와이어 글자 "setup")의 통계 (spec 2026-11-22-vu-setup-steps D9).
-- 배치마다 행을 추가만 한다 — 읽을 때 합친다(수·맵은 합, HDR은 merge, last_done_ms는 워커별 최대).
CREATE TABLE IF NOT EXISTS run_section_step_metrics (
  run_id TEXT NOT NULL, worker_id TEXT NOT NULL DEFAULT '',
  section TEXT NOT NULL, step_id TEXT NOT NULL,
  count INTEGER NOT NULL, error_count INTEGER NOT NULL,
  status_counts TEXT NOT NULL, failure_kinds TEXT NOT NULL, hdr_histogram BLOB NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_run_section_step_metrics_run ON run_section_step_metrics(run_id);
CREATE TABLE IF NOT EXISTS run_section_outcomes (
  run_id TEXT NOT NULL, worker_id TEXT NOT NULL DEFAULT '', section TEXT NOT NULL,
  ok INTEGER NOT NULL, failed INTEGER NOT NULL, interrupted INTEGER NOT NULL,
  last_done_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_run_section_outcomes_run ON run_section_outcomes(run_id);
