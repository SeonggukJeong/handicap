-- migration 0019: persisted pool-worker operator control overrides (LAN ops follow-up).
-- Keyed by stable worker_id (operator-assigned --worker-id). Only stable workers get a
-- row; re-attached on the INSERT (entry-absent) branch of pool_register_idle. `updated_at`
-- is write-only in v1 (forward GC/debug metadata).
CREATE TABLE IF NOT EXISTS pool_worker_overrides (
  worker_id         TEXT    PRIMARY KEY,
  drained           INTEGER NOT NULL DEFAULT 0,
  capacity_override INTEGER,
  label             TEXT,
  updated_at        INTEGER NOT NULL
);
