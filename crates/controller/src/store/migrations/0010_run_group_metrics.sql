-- migration 0010 (A2-2): per-parallel-node page-load latency (group latency).
-- Append-only: HDR histograms can't be merged in SQL, so each metric batch's delta
-- histogram is its own row; build_report merges by step_id (Histogram::add). No
-- PK/UPSERT (contrast run_loop_metrics/run_if_metrics, which accumulate counts in
-- SQL). Safe without an idempotency key: metric batches are delivered once over the
-- single bidi stream (no mid-run resend). CREATE IF NOT EXISTS = idempotent.
CREATE TABLE IF NOT EXISTS run_group_metrics (
  run_id        TEXT    NOT NULL,
  step_id       TEXT    NOT NULL,
  hdr_histogram BLOB    NOT NULL,
  count         INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_run_group_metrics_run ON run_group_metrics(run_id);
