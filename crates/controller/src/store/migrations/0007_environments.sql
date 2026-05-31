-- Named, cross-scenario environments: a reusable bundle of ${ENV} values.
-- Top-level (no scenario_id, no FK). Nothing references an environment by id —
-- the RunDialog overlay (B-2) snapshots resolved values into runs.env_json /
-- run_presets.env_json — so DELETE needs no guard. CREATE ... IF NOT EXISTS is
-- idempotent (re-run safe), matching 0003/0004/0005.
CREATE TABLE IF NOT EXISTS environments (
    id          TEXT PRIMARY KEY,   -- ULID (Crockford base32), server-generated
    name        TEXT NOT NULL,
    vars_json   TEXT NOT NULL,      -- map<string,string> JSON
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_environments_name ON environments(name);
