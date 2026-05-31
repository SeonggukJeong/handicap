-- Named run presets: a reusable run config (Profile + env) scoped to a scenario.
-- profile_json uses the same serialization as runs.profile_json (the Rust Profile
-- type), so new Profile fields evolve via #[serde(default)] with no migration here.
-- NOTE: scenario_id has no ON DELETE CASCADE — there is no scenario-delete endpoint
-- today (spec §1). A future scenario-delete spec MUST add ON DELETE CASCADE here,
-- because the pool runs with foreign_keys=ON (store/mod.rs).
CREATE TABLE IF NOT EXISTS run_presets (
    id           TEXT PRIMARY KEY,                       -- ULID (Crockford base32)
    scenario_id  TEXT NOT NULL REFERENCES scenarios(id),
    name         TEXT NOT NULL,
    profile_json TEXT NOT NULL,
    env_json     TEXT NOT NULL,
    created_at   INTEGER NOT NULL,
    updated_at   INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_run_presets_scenario_name
    ON run_presets(scenario_id, name);
