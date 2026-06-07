-- migration 0013 (B7-C): per-(step_id, phase) latency-phase breakdown (TTFB+download).
-- Append-only: HDR histograms can't be merged in SQL, so each metric batch's delta
-- histogram is its own row; build_report merges by (step_id, phase) (Histogram::add).
-- No PK — metric batches are delivered once (no mid-run resend). Mirrors
-- run_group_metrics (0010). CREATE IF NOT EXISTS = idempotent.
CREATE TABLE IF NOT EXISTS run_phase_metrics (
  run_id        TEXT    NOT NULL,
  step_id       TEXT    NOT NULL,
  phase         TEXT    NOT NULL,
  hdr_histogram BLOB    NOT NULL,
  count         INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_run_phase_metrics_run ON run_phase_metrics(run_id);
