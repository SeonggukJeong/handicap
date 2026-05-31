# Area A2 — Named Run Presets Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user save a complete run config (profile + env) under a name, scoped to a scenario, then pick it from the RunDialog to fill the whole form in one click — the curated, persistent version of A1's run-retry.

**Architecture:** Presets are a new first-class REST resource backed by a `run_presets` table (migration 0005), reusing the existing `Profile` serde type verbatim (no new serde types). The run-create validation gate is extracted from `runs::create` into a reusable `validate_run_config` so both run-create and preset-save apply identical checks. The UI loads a preset into the **A1 prefill seam** (RunDialog reseeds its form on explicit load, remounting only the binding sub-panel), saves the current dialog state as a preset, and manages (rename/delete) presets. Deleting a dataset that a preset references is softly guarded (409 + the referencing-preset list, overridable with `?force=true`).

**Tech Stack:** Rust (axum 0.8, serde, sqlx 0.8 SQLite, tokio, ulid), TypeScript/React, Zod, React Query v5, Vitest + React Testing Library.

**Spec:** `docs/superpowers/specs/2026-05-30-run-presets-retry-design.md` (§2 data model, §3 REST API, §5 UI, §6 validation/edge cases, §7 tests, §8 A2 split).

---

## Prerequisites (read before Task 1)

- **A1 must be merged to `master` first.** A2 builds directly on A1's code: `RunDialog`'s `initial`/`scenarioChangedWarning` props, `ui/src/api/runPrefill.ts` (`envValueToRecord`, `normalizeProfile`, `RunPrefill`), the `scenario_yaml` field on `RunResponse`/`RunSchema`, and `CreateRunRequest.env: HashMap<String,String>`. If A1 is not yet on `master`, finish that first (its plan's finishing step: rebase onto `master` + `--ff-only`). Confirm with: `git log --oneline -1 -- ui/src/api/runPrefill.ts` should show the A1 commit `9ae2da6` (or later).
- **Start a fresh worktree off `master`** named `area-a2-run-presets` (root `CLAUDE.md` worktree section; `.claude/settings.local.json` already sets `worktree.baseRef: head`).
- **A new `EnterWorktree` worktree has no `ui/node_modules` or `target/`** (root `CLAUDE.md` "Subagent dispatch 노하우"). Before running any task: `cd ui && pnpm install` (seconds, global store) **and** `cargo build` from the worktree root, so the first test run has a baseline. This slice touches both Rust and UI — install both.

## Repo conventions the worker must honor

- **Pre-commit hook runs `cargo` only** (fmt + build + clippy `-D warnings` + test); it is skipped for docs-only (`.md`) commits and does **not** run `pnpm`. So **every UI task must end with `cd ui && pnpm test && pnpm build`** by hand — `pnpm build` (`tsc -b`) is the real type gate; `pnpm test` (esbuild) misses TS-strict errors (Zod nested `.default()` leak, discriminated-union mismatch). (`ui/CLAUDE.md`.)
- **TDD-guard hook**: editing `ui/src/*.tsx` or `crates/*/src/*.rs` is blocked unless a pending test file is in the working tree. Each task **writes its test first**, which unblocks the production edit. Rust files with an inline `#[cfg(test)] mod tests` pass automatically; for a **new** `crates/.../src/*.rs` file with no inline tests yet, create its test file (or add the inline `mod tests`) before the production body.
- **`userEvent.setup()` per `it`** (v14). Reuse each test file's existing `fetchMock` + `jsonResponse` + render harness — do not invent new ones.
- **Local run footgun:** `cargo run -p handicap-controller --bin controller` (the package has two binaries). Not needed for this plan's tests, but relevant for manual verification.
- **Migration registration is two edits, not one** (controller `CLAUDE.md`): a new `migrations/000N_*.sql` file does nothing until you add both `const MIGRATION_SQL_000N = include_str!(...)` and a `sqlx::query(MIGRATION_SQL_000N).execute(&pool).await?;` line in `store::connect()`. `CREATE TABLE/INDEX IF NOT EXISTS` is idempotent (Slice 6/7-1/8b pattern) — no `pragma_table_info` guard needed (that guard is only for non-idempotent `ALTER TABLE ADD COLUMN`).
- **`profile_json` is a JSON column** (controller `CLAUDE.md`): presets reuse the exact `Profile` serde type, so they inherit the `#[serde(default)]` evolution pattern for free — no new serde types, no per-field DB columns.
- Git topology: integration branch is `master`, **no remote**. Finish with a local rebase-onto-`master` + `--ff-only` merge (root `CLAUDE.md`).

---

## File Map

| File | Change |
|---|---|
| `crates/controller/src/store/migrations/0005_run_presets.sql` | **new** — `run_presets` table + `UNIQUE(scenario_id,name)` index |
| `crates/controller/src/store/mod.rs` | + `pub mod presets;`, + `MIGRATION_SQL_0005` const, + execute line in `connect()` |
| `crates/controller/src/store/presets.rs` | **new** — `PresetRow`, `PresetRef`, insert/get/list_by_scenario/update/delete/referencing_dataset + tests |
| `crates/controller/src/api/runs.rs` | extract `validate_run_config` (pub(crate)); `create` calls it + reuses returned meta |
| `crates/controller/src/api/presets.rs` | **new** — CRUD handlers + DTOs |
| `crates/controller/src/api/mod.rs` | + `pub mod presets;` |
| `crates/controller/src/app.rs` | + 2 routes (`/scenarios/{id}/presets`, `/presets/{id}`); datasets delete handler now takes `Query` |
| `crates/controller/src/api/datasets.rs` | `delete` gains `?force` + soft preset guard via `referencing_dataset` |
| `crates/controller/src/error.rs` | + `ConflictJson(serde_json::Value)` variant + `IntoResponse` arm |
| `crates/controller/tests/presets_api_test.rs` | **new** — preset CRUD + run-from-preset integration |
| `crates/controller/tests/datasets_api_test.rs` | + soft-guard (preset reference) delete tests |
| `ui/src/api/presets.ts` | **new** — schemas + client fns |
| `ui/src/api/__tests__/presets.test.ts` | **new** — schema round-trip + null `data_binding` |
| `ui/src/api/hooks.ts` | + preset hooks; `useDeleteDataset` mutation takes `{id, force}` |
| `ui/src/api/client.ts` | `deleteDataset` → `(id, force?)` returning a soft-conflict result |
| `ui/src/api/__tests__/datasets.test.ts` | + soft-conflict client result cases |
| `ui/src/components/RunDialog.tsx` | preset dropdown (load) + save/overwrite/delete/rename; binding sub-panel remount key |
| `ui/src/components/__tests__/RunDialog.test.tsx` | + preset load + save/manage cases |
| `ui/src/pages/RunDetailPage.tsx` | + "이 run 설정을 프리셋으로 저장" |
| `ui/src/pages/__tests__/RunDetailPage.test.tsx` | + save-preset case |
| `ui/src/pages/DatasetsPage.tsx` | soft-delete confirm flow + error banner |
| `ui/src/pages/__tests__/DatasetsPage.test.tsx` | + soft-409 confirm → force delete |
| `ui/src/components/DataBindingPanel.tsx` | "dataset deleted" notice + invalid when selected dataset 404s |
| `ui/src/components/__tests__/DataBindingPanel.test.tsx` | + dataset-gone notice case |
| docs (Task 10) | ADR-0024, spec status, controller/ui `CLAUDE.md`, root `CLAUDE.md` decisions, MEMORY |

---

## Architecture decisions locked here (read once)

1. **Preset = independent scenario-scoped resource** (spec §1/§2). New `run_presets` table, new `/api/.../presets` REST. `data_binding`/`loop_breakdown_cap`/env are all scenario-dependent, so a preset belongs to exactly one scenario.
2. **No `scenario_yaml` snapshot on presets** (spec §6). Presets intentionally follow the live scenario; the run-retry "scenario drifted" warning does **not** apply to presets. Instead the binding panel re-validates against the live scenario on load (stale-column highlight, already in A1) and shows a "dataset deleted" notice (Task 9).
3. **Validation runs twice, run-create is authoritative** (spec §6). `validate_run_config` catches obvious errors at save-time (bad binding / loop cap / vus·duration / empty name), but a dataset can be deleted afterward — the `POST /api/runs` gate is the final defense.
4. **Preset save reads live dialog state, so save lives inside RunDialog; load reseeds the dialog imperatively** (the A1 "no reseed effect" rule guards against *accidental* overwrites from refetches — an *explicit* user-triggered load is allowed to replace the form). The DataBinding sub-panel still seeds once-per-mount, so load bumps a panel `key` to remount it with the new binding.
5. **Overwrite is client-driven**: saving a name that already exists → confirm → `PUT` the existing preset id. The server `UNIQUE(scenario_id,name)` index is the backstop (→ 409).

---

### Task 1: Migration 0005 + `store/presets.rs`

**Files:**
- Create: `crates/controller/src/store/migrations/0005_run_presets.sql`
- Create: `crates/controller/src/store/presets.rs`
- Modify: `crates/controller/src/store/mod.rs`

- [ ] **Step 1: Write the migration SQL.** Create `crates/controller/src/store/migrations/0005_run_presets.sql`:

```sql
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
```

- [ ] **Step 2: Register the migration in `store/mod.rs`.** Add the module declaration near the top (after `pub mod metrics;`):

```rust
pub mod metrics;
pub mod presets;
pub mod runs;
```

Add the `include_str!` const (after the `MIGRATION_SQL_0004` line):

```rust
const MIGRATION_SQL_0004: &str = include_str!("migrations/0004_datasets.sql");
const MIGRATION_SQL_0005: &str = include_str!("migrations/0005_run_presets.sql");
```

And the execute line in `connect()` (after the `MIGRATION_SQL_0004` execute, before `Ok(pool)`):

```rust
    sqlx::query(MIGRATION_SQL_0004).execute(&pool).await?;
    sqlx::query(MIGRATION_SQL_0005).execute(&pool).await?;
    Ok(pool)
```

- [ ] **Step 3: Write the failing store tests.** Create `crates/controller/src/store/presets.rs` with the production stub **and** the test module up front (the inline `#[cfg(test)] mod tests` satisfies the TDD guard for a new Rust file). Write the whole file:

```rust
use serde::Serialize;
use sqlx::Row;
use ulid::Ulid;

use super::Db;
use super::runs::Profile;

/// One stored run preset (Profile + env), scoped to a scenario.
pub struct PresetRow {
    pub id: String,
    pub scenario_id: String,
    pub name: String,
    pub profile: Profile,
    pub env: serde_json::Value,
    pub created_at: i64,
    pub updated_at: i64,
}

/// A preset that references a given dataset — returned by the dataset DELETE
/// soft guard (spec §3 #14) so the UI can list what would break.
#[derive(Debug, Serialize)]
pub struct PresetRef {
    pub preset_id: String,
    pub name: String,
    pub scenario_id: String,
}

pub async fn insert(
    db: &Db,
    scenario_id: &str,
    name: &str,
    profile: &Profile,
    env: &serde_json::Value,
) -> sqlx::Result<PresetRow> {
    let id = Ulid::new().to_string();
    let now = super::now_ms();
    let profile_json = serde_json::to_string(profile).expect("serialize profile");
    let env_json = serde_json::to_string(env).expect("serialize env");
    sqlx::query(
        "INSERT INTO run_presets(id,scenario_id,name,profile_json,env_json,created_at,updated_at) \
         VALUES(?,?,?,?,?,?,?)",
    )
    .bind(&id)
    .bind(scenario_id)
    .bind(name)
    .bind(&profile_json)
    .bind(&env_json)
    .bind(now)
    .bind(now)
    .execute(db)
    .await?;
    Ok(PresetRow {
        id,
        scenario_id: scenario_id.to_string(),
        name: name.to_string(),
        profile: profile.clone(),
        env: env.clone(),
        created_at: now,
        updated_at: now,
    })
}

pub async fn get(db: &Db, id: &str) -> sqlx::Result<Option<PresetRow>> {
    let row = sqlx::query(
        "SELECT id,scenario_id,name,profile_json,env_json,created_at,updated_at \
         FROM run_presets WHERE id = ?",
    )
    .bind(id)
    .fetch_optional(db)
    .await?;
    let Some(r) = row else { return Ok(None) };
    let profile: Profile =
        serde_json::from_str(r.get::<String, _>("profile_json").as_str()).unwrap();
    let env: serde_json::Value =
        serde_json::from_str(r.get::<String, _>("env_json").as_str()).unwrap();
    Ok(Some(PresetRow {
        id: r.get("id"),
        scenario_id: r.get("scenario_id"),
        name: r.get("name"),
        profile,
        env,
        created_at: r.get("created_at"),
        updated_at: r.get("updated_at"),
    }))
}

pub async fn list_by_scenario(db: &Db, scenario_id: &str) -> sqlx::Result<Vec<PresetRow>> {
    let rows = sqlx::query(
        "SELECT id,scenario_id,name,profile_json,env_json,created_at,updated_at \
         FROM run_presets WHERE scenario_id = ? ORDER BY name",
    )
    .bind(scenario_id)
    .fetch_all(db)
    .await?;
    let mut out = Vec::with_capacity(rows.len());
    for r in rows {
        let profile: Profile =
            serde_json::from_str(r.get::<String, _>("profile_json").as_str()).unwrap();
        let env: serde_json::Value =
            serde_json::from_str(r.get::<String, _>("env_json").as_str()).unwrap();
        out.push(PresetRow {
            id: r.get("id"),
            scenario_id: r.get("scenario_id"),
            name: r.get("name"),
            profile,
            env,
            created_at: r.get("created_at"),
            updated_at: r.get("updated_at"),
        });
    }
    Ok(out)
}

/// Full-body replace. Returns `None` if no preset with `id` exists.
pub async fn update(
    db: &Db,
    id: &str,
    name: &str,
    profile: &Profile,
    env: &serde_json::Value,
) -> sqlx::Result<Option<PresetRow>> {
    let now = super::now_ms();
    let profile_json = serde_json::to_string(profile).expect("serialize profile");
    let env_json = serde_json::to_string(env).expect("serialize env");
    let res = sqlx::query(
        "UPDATE run_presets SET name = ?, profile_json = ?, env_json = ?, updated_at = ? \
         WHERE id = ?",
    )
    .bind(name)
    .bind(&profile_json)
    .bind(&env_json)
    .bind(now)
    .bind(id)
    .execute(db)
    .await?;
    if res.rows_affected() == 0 {
        return Ok(None);
    }
    get(db, id).await
}

pub async fn delete(db: &Db, id: &str) -> sqlx::Result<()> {
    sqlx::query("DELETE FROM run_presets WHERE id = ?")
        .bind(id)
        .execute(db)
        .await?;
    Ok(())
}

/// Presets whose `profile_json.data_binding.dataset_id` equals `dataset_id`.
/// Used by the dataset DELETE soft guard (spec §3 #14).
pub async fn referencing_dataset(db: &Db, dataset_id: &str) -> sqlx::Result<Vec<PresetRef>> {
    let rows = sqlx::query("SELECT id,scenario_id,name,profile_json FROM run_presets")
        .fetch_all(db)
        .await?;
    let mut out = Vec::new();
    for r in rows {
        let pj: String = r.get("profile_json");
        if let Ok(profile) = serde_json::from_str::<Profile>(&pj) {
            if let Some(b) = &profile.data_binding {
                if b.dataset_id == dataset_id {
                    out.push(PresetRef {
                        preset_id: r.get("id"),
                        name: r.get("name"),
                        scenario_id: r.get("scenario_id"),
                    });
                }
            }
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::binding::{BindingPolicy, DataBinding, Mapping};
    use crate::store;
    use crate::store::runs::Profile;
    use handicap_engine::Scenario;

    async fn db_with_scenario() -> (Db, String) {
        let db = store::connect("sqlite::memory:").await.unwrap();
        let yaml = "version: 1\nname: t\nsteps: []";
        let scenario: Scenario = serde_yaml::from_str(yaml).unwrap();
        let sc = store::scenarios::insert(&db, &scenario, yaml).await.unwrap();
        (db, sc.id)
    }

    fn profile() -> Profile {
        Profile {
            vus: 3,
            ramp_up_seconds: 1,
            duration_seconds: 9,
            loop_breakdown_cap: 256,
            data_binding: None,
        }
    }

    #[tokio::test]
    async fn insert_get_list_update_delete_roundtrip() {
        let (db, scenario_id) = db_with_scenario().await;
        let env = serde_json::json!({ "BASE_URL": "http://x" });
        let row = insert(&db, &scenario_id, "smoke", &profile(), &env)
            .await
            .unwrap();

        let got = get(&db, &row.id).await.unwrap().expect("preset");
        assert_eq!(got.name, "smoke");
        assert_eq!(got.profile.vus, 3);
        assert_eq!(got.env, env);

        let listed = list_by_scenario(&db, &scenario_id).await.unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].id, row.id);

        let mut p2 = profile();
        p2.vus = 10;
        let updated = update(&db, &row.id, "smoke2", &p2, &env)
            .await
            .unwrap()
            .expect("updated");
        assert_eq!(updated.name, "smoke2");
        assert_eq!(updated.profile.vus, 10);

        delete(&db, &row.id).await.unwrap();
        assert!(get(&db, &row.id).await.unwrap().is_none());
    }

    #[tokio::test]
    async fn unique_scenario_name_is_enforced() {
        let (db, scenario_id) = db_with_scenario().await;
        let env = serde_json::json!({});
        insert(&db, &scenario_id, "dup", &profile(), &env)
            .await
            .unwrap();
        let err = insert(&db, &scenario_id, "dup", &profile(), &env)
            .await
            .expect_err("second insert with same (scenario_id,name) must fail");
        assert!(
            err.as_database_error()
                .map(|d| d.is_unique_violation())
                .unwrap_or(false),
            "expected a UNIQUE violation, got {err:?}"
        );
    }

    #[tokio::test]
    async fn update_missing_returns_none() {
        let (db, _scenario_id) = db_with_scenario().await;
        let out = update(&db, "nope", "x", &profile(), &serde_json::json!({}))
            .await
            .unwrap();
        assert!(out.is_none());
    }

    #[tokio::test]
    async fn referencing_dataset_finds_bound_presets() {
        let (db, scenario_id) = db_with_scenario().await;
        let mut bound = profile();
        bound.data_binding = Some(DataBinding {
            dataset_id: "DS1".into(),
            policy: BindingPolicy::PerVu,
            mappings: vec![Mapping::Column {
                var: "u".into(),
                column: "user".into(),
            }],
        });
        insert(&db, &scenario_id, "bound", &bound, &serde_json::json!({}))
            .await
            .unwrap();
        insert(&db, &scenario_id, "unbound", &profile(), &serde_json::json!({}))
            .await
            .unwrap();

        let refs = referencing_dataset(&db, "DS1").await.unwrap();
        assert_eq!(refs.len(), 1);
        assert_eq!(refs[0].name, "bound");

        assert!(referencing_dataset(&db, "OTHER").await.unwrap().is_empty());
    }
}
```

- [ ] **Step 4: Run the store tests to verify they pass**

Run: `cargo test -p handicap-controller --lib presets`
Expected: 4 `store::presets::tests::*` PASS + `store::tests::opens_and_migrates_in_memory` still PASS (proves 0005 applied).

- [ ] **Step 5: Run the full controller suite + clippy** (catches the new module wiring):

Run: `cargo test -p handicap-controller && cargo clippy -p handicap-controller --all-targets -- -D warnings`
Expected: PASS. If `cargo fmt --check` complains, run `cargo fmt`.

- [ ] **Step 6: Commit**

```bash
git add crates/controller/src/store/migrations/0005_run_presets.sql \
  crates/controller/src/store/mod.rs crates/controller/src/store/presets.rs
git commit -m "feat(controller): run_presets table + store layer (A2)"
```

---

### Task 2: Extract `validate_run_config` from `runs::create` (refactor, no behavior change)

**Files:**
- Modify: `crates/controller/src/api/runs.rs`

This is a **pure refactor** that keeps existing behavior. The current gate (`runs.rs:47-102`) interleaves validation with binding resolution and returns `Some((b, meta))` so resolution reuses `meta` (TOCTOU avoidance — controller `CLAUDE.md`). We extract a `pub(crate) validate_run_config(&AppState, &Profile) -> Result<Option<DatasetMeta>, ApiError>` that returns the validated meta for the caller to resolve from, preserving the single-fetch guarantee. `runs::create` calls it; Task 3's preset handler reuses it.

- [ ] **Step 1: Add a characterization test (stays green before & after).** Append to `crates/controller/tests/api_test.rs` (reuses the file's `make_app`/`create_scenario` helpers). This pins the gate's "missing dataset → 400" behavior so the extraction can't silently drop it:

```rust
#[tokio::test]
async fn create_run_rejects_binding_to_missing_dataset() {
    let db = store::connect("sqlite::memory:").await.unwrap();
    let app = make_app(db.clone());
    let yaml = "version: 1\nname: bind\nsteps:\n  - id: a\n    name: a\n    type: http\n    request:\n      method: GET\n      url: http://x\n";
    let scenario_id = create_scenario(&app, yaml).await;

    let body = json!({
        "scenario_id": scenario_id,
        "profile": {
            "vus": 1,
            "duration_seconds": 1,
            "data_binding": { "dataset_id": "DOES_NOT_EXIST", "policy": "per_vu", "mappings": [] }
        },
        "env": {}
    });
    let req = Request::builder()
        .method(Method::POST)
        .uri("/api/runs")
        .header("content-type", "application/json")
        .body(Body::from(body.to_string()))
        .unwrap();
    let resp = app.clone().oneshot(req).await.unwrap();
    assert_eq!(
        resp.status(),
        StatusCode::BAD_REQUEST,
        "binding to a non-existent dataset must be rejected by the validation gate"
    );
}
```

- [ ] **Step 2: Run it — it should already PASS** (current code rejects this today). This is a guard, not a RED test:

Run: `cargo test -p handicap-controller --test api_test create_run_rejects_binding_to_missing_dataset`
Expected: PASS (pre-refactor behavior).

- [ ] **Step 3: Add the extracted function.** In `crates/controller/src/api/runs.rs`, add this above `pub async fn create` (right after `loop_cap_ok`):

```rust
/// Validate a run/preset config against the live datasets (spec §6). Returns the
/// validated dataset meta when a binding is present (so the caller resolves the
/// binding from it without a second `get_meta` — TOCTOU guard, controller
/// `CLAUDE.md`), or `None` when there is no binding. Shared by `runs::create`
/// (authoritative gate) and preset save (`api::presets`).
pub(crate) async fn validate_run_config(
    state: &AppState,
    profile: &Profile,
) -> Result<Option<crate::store::datasets::DatasetMeta>, ApiError> {
    if profile.vus == 0 || profile.duration_seconds == 0 {
        return Err(ApiError::BadRequest(
            "vus and duration_seconds must be > 0".into(),
        ));
    }
    if !loop_cap_ok(profile.loop_breakdown_cap) {
        return Err(ApiError::BadRequest(
            "loop_breakdown_cap must be <= 10000 (0 disables breakdown)".into(),
        ));
    }
    let Some(b) = &profile.data_binding else {
        return Ok(None);
    };
    use crate::binding::BindingPolicy;
    if matches!(b.policy, BindingPolicy::Unique) {
        return Err(ApiError::BadRequest(
            "unique 정책은 아직 지원하지 않습니다 (다음 슬라이스)".into(),
        ));
    }
    let meta = crate::store::datasets::get_meta(&state.db, &b.dataset_id)
        .await?
        .ok_or_else(|| ApiError::BadRequest("data_binding.dataset_id가 존재하지 않습니다".into()))?;
    if meta.row_count == 0 {
        return Err(ApiError::BadRequest(
            "빈 데이터셋은 바인딩할 수 없습니다".into(),
        ));
    }
    for col in b.referenced_columns() {
        if !meta.columns.iter().any(|c| c == col) {
            return Err(ApiError::BadRequest(format!(
                "매핑 컬럼 '{col}'이 데이터셋에 없습니다 (있는 컬럼: {:?})",
                meta.columns
            )));
        }
    }
    // per-iteration policies stream the whole dataset → cap. per_vu is sliced to
    // min(vus, rows) so it is never capped (spec §11).
    let per_iteration = matches!(
        b.policy,
        BindingPolicy::IterSequential | BindingPolicy::IterRandom
    );
    if per_iteration && (meta.row_count as u64) > state.dataset_max_rows {
        return Err(ApiError::BadRequest(format!(
            "per-iteration 바인딩 행 수 {}가 상한 {}을 초과합니다",
            meta.row_count, state.dataset_max_rows
        )));
    }
    Ok(Some(meta))
}
```

- [ ] **Step 4: Rewrite `create` to use it.** Replace the body of `create` from the `if body.profile.vus == 0 ...` block down through the `let data_binding = validated_binding.map(...)` block (i.e. `runs.rs:47-143`) with:

```rust
    let validated_meta = validate_run_config(&state, &body.profile).await?;

    // env is already map<string,string> (rejected at the API boundary otherwise).
    // Serialize back to a JSON object for storage; clone the map for the proto.
    let env_value = serde_json::to_value(&body.env).expect("env map serializes to a JSON object");
    let row = runs::insert(
        &state.db,
        &scenario.id,
        &scenario.yaml,
        &body.profile,
        &env_value,
    )
    .await?;

    // Resolve the binding for the worker (spec §4/§7): proto policy, a
    // deterministic seed folded from the run id, and the sliced row count.
    // Reuses the meta validate_run_config already fetched — no second DB call.
    let data_binding = match (&body.profile.data_binding, validated_meta) {
        (Some(b), Some(meta)) => {
            use crate::binding::BindingPolicy;
            let (policy, row_count) = match b.policy {
                BindingPolicy::PerVu => (
                    handicap_proto::v1::data_binding::Policy::PerVu,
                    (body.profile.vus as u64).min(meta.row_count as u64),
                ),
                BindingPolicy::IterSequential => (
                    handicap_proto::v1::data_binding::Policy::IterSequential,
                    meta.row_count as u64,
                ),
                BindingPolicy::IterRandom => (
                    handicap_proto::v1::data_binding::Policy::IterRandom,
                    meta.row_count as u64,
                ),
                BindingPolicy::Unique => unreachable!("unique rejected by validate_run_config"),
            };
            Some(crate::grpc::coordinator::PendingDataBinding {
                dataset_id: b.dataset_id.clone(),
                policy,
                seed: fold_seed(&row.id),
                mappings: b.mappings.clone(),
                row_count,
            })
        }
        _ => None,
    };
```

Everything below (`let assignment = ...`, dispatch, `Ok((StatusCode::CREATED, ...))`) stays unchanged. The `scenario` existence check at the top of `create` (`scenarios::get(...).ok_or(ApiError::NotFound)?`) also stays — `validate_run_config` does not check the scenario.

- [ ] **Step 5: Run the full controller suite to confirm zero behavior change**

Run: `cargo test -p handicap-controller && cargo clippy -p handicap-controller --all-targets -- -D warnings`
Expected: PASS (every existing run/binding test — `api_test`, `data_binding_api_test` — still green; the gate moved but behaves identically). `cargo fmt` if needed.

- [ ] **Step 6: Commit**

```bash
git add crates/controller/src/api/runs.rs crates/controller/tests/api_test.rs
git commit -m "refactor(controller): extract validate_run_config from runs::create (A2)"
```

---

### Task 3: `api/presets.rs` CRUD + routing

**Files:**
- Create: `crates/controller/src/api/presets.rs`
- Modify: `crates/controller/src/api/mod.rs`, `crates/controller/src/app.rs`
- Test: `crates/controller/tests/presets_api_test.rs` (new)

- [ ] **Step 1: Write the failing integration tests.** Create `crates/controller/tests/presets_api_test.rs`. It mirrors `api_test.rs`'s harness (copy `make_app`/`create_scenario` locally — integration tests don't share modules):

```rust
use std::sync::Arc;

use axum::body::Body;
use axum::http::{Method, Request, StatusCode};
use handicap_controller::dispatcher::subprocess::SubprocessDispatcher;
use handicap_controller::grpc::coordinator::CoordinatorState;
use handicap_controller::{app, store};
use serde_json::{Value, json};
use tower::ServiceExt;

fn make_app(db: handicap_controller::store::Db) -> axum::Router {
    let coord = CoordinatorState::new(db.clone());
    app::router(app::AppState {
        db,
        coord,
        dispatcher: Arc::new(SubprocessDispatcher::new(
            "/nonexistent".to_string(),
            "127.0.0.1:0".parse().unwrap(),
        )),
        ui_dir: None,
        dataset_max_rows: 1_000_000,
    })
}

async fn create_scenario(app: &axum::Router, yaml: &str) -> String {
    let req = Request::builder()
        .method(Method::POST)
        .uri("/api/scenarios")
        .header("content-type", "application/json")
        .body(Body::from(json!({ "yaml": yaml }).to_string()))
        .unwrap();
    let resp = app.clone().oneshot(req).await.unwrap();
    let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX).await.unwrap();
    let v: Value = serde_json::from_slice(&bytes).unwrap();
    v["id"].as_str().unwrap().to_string()
}

async fn post(app: &axum::Router, uri: &str, body: Value) -> (StatusCode, Value) {
    let req = Request::builder()
        .method(Method::POST)
        .uri(uri)
        .header("content-type", "application/json")
        .body(Body::from(body.to_string()))
        .unwrap();
    let resp = app.clone().oneshot(req).await.unwrap();
    let status = resp.status();
    let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX).await.unwrap();
    let v: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
    (status, v)
}

const YAML: &str = "version: 1\nname: presets\nsteps:\n  - id: a\n    name: a\n    type: http\n    request:\n      method: GET\n      url: http://x\n";

#[tokio::test]
async fn preset_create_list_get_roundtrip() {
    let db = store::connect("sqlite::memory:").await.unwrap();
    let app = make_app(db.clone());
    let sid = create_scenario(&app, YAML).await;

    let (status, created) = post(
        &app,
        &format!("/api/scenarios/{sid}/presets"),
        json!({
            "name": "baseline",
            "profile": { "vus": 4, "duration_seconds": 8, "ramp_up_seconds": 1 },
            "env": { "BASE_URL": "http://x" }
        }),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    let pid = created["id"].as_str().unwrap().to_string();
    assert_eq!(created["name"], "baseline");
    assert_eq!(created["profile"]["vus"], 4);
    assert_eq!(created["env"]["BASE_URL"], "http://x");

    // list returns a summary (id/name/vus/duration)
    let req = Request::builder()
        .method(Method::GET)
        .uri(format!("/api/scenarios/{sid}/presets"))
        .body(Body::empty())
        .unwrap();
    let resp = app.clone().oneshot(req).await.unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX).await.unwrap();
    let list: Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(list["presets"].as_array().unwrap().len(), 1);
    assert_eq!(list["presets"][0]["vus"], 4);

    // get returns the full profile + env
    let req = Request::builder()
        .method(Method::GET)
        .uri(format!("/api/presets/{pid}"))
        .body(Body::empty())
        .unwrap();
    let resp = app.clone().oneshot(req).await.unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX).await.unwrap();
    let full: Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(full["profile"]["ramp_up_seconds"], 1);
}

#[tokio::test]
async fn preset_duplicate_name_conflicts() {
    let db = store::connect("sqlite::memory:").await.unwrap();
    let app = make_app(db.clone());
    let sid = create_scenario(&app, YAML).await;
    let body = json!({ "name": "dup", "profile": { "vus": 1, "duration_seconds": 1 }, "env": {} });
    let (s1, _) = post(&app, &format!("/api/scenarios/{sid}/presets"), body.clone()).await;
    assert_eq!(s1, StatusCode::CREATED);
    let (s2, _) = post(&app, &format!("/api/scenarios/{sid}/presets"), body).await;
    assert_eq!(s2, StatusCode::CONFLICT);
}

#[tokio::test]
async fn preset_empty_name_rejected() {
    let db = store::connect("sqlite::memory:").await.unwrap();
    let app = make_app(db.clone());
    let sid = create_scenario(&app, YAML).await;
    let (s, _) = post(
        &app,
        &format!("/api/scenarios/{sid}/presets"),
        json!({ "name": "   ", "profile": { "vus": 1, "duration_seconds": 1 }, "env": {} }),
    )
    .await;
    assert_eq!(s, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn preset_create_validates_profile() {
    let db = store::connect("sqlite::memory:").await.unwrap();
    let app = make_app(db.clone());
    let sid = create_scenario(&app, YAML).await;
    // vus = 0 is caught by validate_run_config (shared with run-create).
    let (s, _) = post(
        &app,
        &format!("/api/scenarios/{sid}/presets"),
        json!({ "name": "bad", "profile": { "vus": 0, "duration_seconds": 1 }, "env": {} }),
    )
    .await;
    assert_eq!(s, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn preset_update_and_delete() {
    let db = store::connect("sqlite::memory:").await.unwrap();
    let app = make_app(db.clone());
    let sid = create_scenario(&app, YAML).await;
    let (_, created) = post(
        &app,
        &format!("/api/scenarios/{sid}/presets"),
        json!({ "name": "p", "profile": { "vus": 1, "duration_seconds": 1 }, "env": {} }),
    )
    .await;
    let pid = created["id"].as_str().unwrap().to_string();

    // PUT renames + bumps vus
    let req = Request::builder()
        .method(Method::PUT)
        .uri(format!("/api/presets/{pid}"))
        .header("content-type", "application/json")
        .body(Body::from(
            json!({ "name": "p2", "profile": { "vus": 5, "duration_seconds": 1 }, "env": {} }).to_string(),
        ))
        .unwrap();
    let resp = app.clone().oneshot(req).await.unwrap();
    assert_eq!(resp.status(), StatusCode::OK);

    // DELETE → 204, then GET → 404
    let req = Request::builder()
        .method(Method::DELETE)
        .uri(format!("/api/presets/{pid}"))
        .body(Body::empty())
        .unwrap();
    let resp = app.clone().oneshot(req).await.unwrap();
    assert_eq!(resp.status(), StatusCode::NO_CONTENT);
    let req = Request::builder()
        .method(Method::GET)
        .uri(format!("/api/presets/{pid}"))
        .body(Body::empty())
        .unwrap();
    let resp = app.clone().oneshot(req).await.unwrap();
    assert_eq!(resp.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn preset_put_nonexistent_is_404() {
    // The API-level counterpart to store::presets::update returning None: a PUT to
    // a bogus id with an otherwise-valid body must surface as 404 (handler's
    // `.ok_or(ApiError::NotFound)` after validate_run_config). Guards the gap
    // between the store unit test and the route.
    let db = store::connect("sqlite::memory:").await.unwrap();
    let app = make_app(db.clone());
    let _sid = create_scenario(&app, YAML).await; // a scenario exists, but no such preset
    let req = Request::builder()
        .method(Method::PUT)
        .uri("/api/presets/BOGUS_PRESET_ID")
        .header("content-type", "application/json")
        .body(Body::from(
            json!({ "name": "x", "profile": { "vus": 1, "duration_seconds": 1 }, "env": {} }).to_string(),
        ))
        .unwrap();
    let resp = app.clone().oneshot(req).await.unwrap();
    assert_eq!(resp.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn run_can_be_created_from_a_preset_profile() {
    // The preset carries a launchable profile+env: posting them to /api/runs works.
    let db = store::connect("sqlite::memory:").await.unwrap();
    let app = make_app(db.clone());
    let sid = create_scenario(&app, YAML).await;
    let (_, created) = post(
        &app,
        &format!("/api/scenarios/{sid}/presets"),
        json!({ "name": "p", "profile": { "vus": 2, "duration_seconds": 3 }, "env": { "K": "v" } }),
    )
    .await;
    let (s, run) = post(
        &app,
        "/api/runs",
        json!({ "scenario_id": sid, "profile": created["profile"], "env": created["env"] }),
    )
    .await;
    assert_eq!(s, StatusCode::CREATED);
    assert_eq!(run["profile"]["vus"], 2);
}
```

- [ ] **Step 2: Run them — confirm they fail** (route not wired yet):

Run: `cargo test -p handicap-controller --test presets_api_test`
Expected: compile fails or all FAIL (no `/presets` routes → 404 / 405).

- [ ] **Step 3: Write the handler module.** Create `crates/controller/src/api/presets.rs`:

```rust
use std::collections::HashMap;

use axum::Json;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use serde::{Deserialize, Serialize};

use crate::app::AppState;
use crate::error::ApiError;
use crate::store::presets;
use crate::store::runs::Profile;
use crate::store::scenarios;

#[derive(Debug, Deserialize)]
pub struct PresetBody {
    pub name: String,
    pub profile: Profile,
    #[serde(default)]
    pub env: HashMap<String, String>,
}

#[derive(Debug, Serialize)]
pub struct PresetResponse {
    pub id: String,
    pub scenario_id: String,
    pub name: String,
    pub profile: Profile,
    pub env: serde_json::Value,
    pub created_at: i64,
    pub updated_at: i64,
}

/// Lightweight list row (no profile/env body — the dropdown only needs these).
#[derive(Debug, Serialize)]
pub struct PresetSummary {
    pub id: String,
    pub name: String,
    pub vus: u32,
    pub duration_seconds: u32,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Serialize)]
pub struct PresetListResponse {
    pub presets: Vec<PresetSummary>,
}

fn to_response(r: presets::PresetRow) -> PresetResponse {
    PresetResponse {
        id: r.id,
        scenario_id: r.scenario_id,
        name: r.name,
        profile: r.profile,
        env: r.env,
        created_at: r.created_at,
        updated_at: r.updated_at,
    }
}

/// Map a UNIQUE(scenario_id,name) violation to a 409; anything else is a 500.
fn map_db_err(e: sqlx::Error) -> ApiError {
    if e.as_database_error()
        .map(|d| d.is_unique_violation())
        .unwrap_or(false)
    {
        return ApiError::Conflict("같은 이름의 프리셋이 이미 있습니다".into());
    }
    ApiError::from(e)
}

pub async fn create(
    State(state): State<AppState>,
    Path(scenario_id): Path<String>,
    Json(body): Json<PresetBody>,
) -> Result<(StatusCode, Json<PresetResponse>), ApiError> {
    scenarios::get(&state.db, &scenario_id)
        .await?
        .ok_or(ApiError::NotFound)?;
    let name = body.name.trim();
    if name.is_empty() {
        return Err(ApiError::BadRequest("이름은 비어 있을 수 없습니다".into()));
    }
    // Same gate run-create applies (spec §6). Save-time check; run-create is final.
    crate::api::runs::validate_run_config(&state, &body.profile).await?;
    let env_value = serde_json::to_value(&body.env).expect("env map serializes to a JSON object");
    let row = presets::insert(&state.db, &scenario_id, name, &body.profile, &env_value)
        .await
        .map_err(map_db_err)?;
    Ok((StatusCode::CREATED, Json(to_response(row))))
}

pub async fn list(
    State(state): State<AppState>,
    Path(scenario_id): Path<String>,
) -> Result<Json<PresetListResponse>, ApiError> {
    scenarios::get(&state.db, &scenario_id)
        .await?
        .ok_or(ApiError::NotFound)?;
    let rows = presets::list_by_scenario(&state.db, &scenario_id).await?;
    let presets = rows
        .into_iter()
        .map(|r| PresetSummary {
            id: r.id,
            name: r.name,
            vus: r.profile.vus,
            duration_seconds: r.profile.duration_seconds,
            created_at: r.created_at,
            updated_at: r.updated_at,
        })
        .collect();
    Ok(Json(PresetListResponse { presets }))
}

pub async fn get(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<PresetResponse>, ApiError> {
    let row = presets::get(&state.db, &id).await?.ok_or(ApiError::NotFound)?;
    Ok(Json(to_response(row)))
}

pub async fn update(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(body): Json<PresetBody>,
) -> Result<Json<PresetResponse>, ApiError> {
    let name = body.name.trim();
    if name.is_empty() {
        return Err(ApiError::BadRequest("이름은 비어 있을 수 없습니다".into()));
    }
    crate::api::runs::validate_run_config(&state, &body.profile).await?;
    let env_value = serde_json::to_value(&body.env).expect("env map serializes to a JSON object");
    let row = presets::update(&state.db, &id, name, &body.profile, &env_value)
        .await
        .map_err(map_db_err)?
        .ok_or(ApiError::NotFound)?;
    Ok(Json(to_response(row)))
}

pub async fn delete(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<StatusCode, ApiError> {
    presets::delete(&state.db, &id).await?;
    Ok(StatusCode::NO_CONTENT)
}
```

- [ ] **Step 4: Register the module.** In `crates/controller/src/api/mod.rs`:

```rust
pub mod datasets;
pub mod presets;
pub mod runs;
pub mod scenarios;
```

- [ ] **Step 5: Add the routes.** In `crates/controller/src/app.rs`, add `presets as presets_api` to the `use crate::api::{...}` import, then add two routes inside the `api` router (after the `/scenarios/{id}/runs` route):

```rust
        .route("/scenarios/{id}/runs", get(runs_api::list_for_scenario))
        .route(
            "/scenarios/{id}/presets",
            post(presets_api::create).get(presets_api::list),
        )
        .route(
            "/presets/{id}",
            get(presets_api::get)
                .put(presets_api::update)
                .delete(presets_api::delete),
        )
```

The import line becomes:

```rust
use crate::api::{
    datasets as datasets_api, presets as presets_api, runs as runs_api, scenarios as scenarios_api,
};
```

- [ ] **Step 6: Run the preset integration tests + full suite**

Run: `cargo test -p handicap-controller --test presets_api_test && cargo test -p handicap-controller && cargo clippy -p handicap-controller --all-targets -- -D warnings`
Expected: all 6 preset tests PASS, full suite PASS, clippy clean. `cargo fmt` if needed.

- [ ] **Step 7: Commit**

```bash
git add crates/controller/src/api/presets.rs crates/controller/src/api/mod.rs \
  crates/controller/src/app.rs crates/controller/tests/presets_api_test.rs
git commit -m "feat(controller): run-preset CRUD REST resource (A2)"
```

---

### Task 4: Dataset DELETE soft guard for preset references

**Files:**
- Modify: `crates/controller/src/error.rs`, `crates/controller/src/api/datasets.rs`
- Test: `crates/controller/tests/datasets_api_test.rs`

A dataset that an *active run* references is a hard 409 (existing, spec §3). A dataset that only a *preset* references is a **soft 409**: the body lists the referencing presets, and `?force=true` overrides. This needs a new `ApiError::ConflictJson` variant (the soft body is a JSON object, not a plain string) and `Query` parsing on the delete handler.

- [ ] **Step 1: Write the failing tests.** Append to `crates/controller/tests/datasets_api_test.rs`. **Verified helpers in that file:** `make_app(db) -> Router` and `upload_csv(&app, name, csv) -> String` (returns the dataset id) both exist — reuse them as-is. **There is NO `create_scenario` in this file** — copy the `create_scenario` helper from `presets_api_test.rs` (Task 3) into it. The snippet below uses `upload_csv`, `create_scenario`, and a module-level `PRESET_YAML` const (defined at the end of the snippet). Add:

```rust
#[tokio::test]
async fn delete_dataset_soft_blocks_when_referenced_by_preset() {
    let db = store::connect("sqlite::memory:").await.unwrap();
    let app = make_app(db.clone());
    let sid = create_scenario(&app, PRESET_YAML).await;
    let dataset_id = upload_csv(&app, "users", "user\nalice\nbob\n").await;

    // a preset bound to that dataset
    let req = Request::builder()
        .method(Method::POST)
        .uri(format!("/api/scenarios/{sid}/presets"))
        .header("content-type", "application/json")
        .body(Body::from(
            json!({
                "name": "bound",
                "profile": {
                    "vus": 1, "duration_seconds": 1,
                    "data_binding": {
                        "dataset_id": dataset_id,
                        "policy": "per_vu",
                        "mappings": [{ "kind": "column", "var": "u", "column": "user" }]
                    }
                },
                "env": {}
            })
            .to_string(),
        ))
        .unwrap();
    let resp = app.clone().oneshot(req).await.unwrap();
    assert_eq!(resp.status(), StatusCode::CREATED);

    // DELETE without force → soft 409 listing the preset
    let req = Request::builder()
        .method(Method::DELETE)
        .uri(format!("/api/datasets/{dataset_id}"))
        .body(Body::empty())
        .unwrap();
    let resp = app.clone().oneshot(req).await.unwrap();
    assert_eq!(resp.status(), StatusCode::CONFLICT);
    let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX).await.unwrap();
    let v: Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(v["presets"].as_array().unwrap().len(), 1);
    assert_eq!(v["presets"][0]["name"], "bound");

    // DELETE with ?force=true → 204
    let req = Request::builder()
        .method(Method::DELETE)
        .uri(format!("/api/datasets/{dataset_id}?force=true"))
        .body(Body::empty())
        .unwrap();
    let resp = app.clone().oneshot(req).await.unwrap();
    assert_eq!(resp.status(), StatusCode::NO_CONTENT);
}

const PRESET_YAML: &str = "version: 1\nname: ds-preset\nsteps:\n  - id: a\n    name: a\n    type: http\n    request:\n      method: GET\n      url: http://x/{{u}}\n";
```

> If `datasets_api_test.rs` has no `create_scenario`/`upload_csv` helpers, copy `create_scenario` from `presets_api_test.rs` and write a small `upload_csv` that POSTs a multipart `file` field to `/api/datasets` and returns `v["id"]`. Check the existing tests in the file first — `datasets_api_test.rs` already uploads datasets, so a helper almost certainly exists; reuse it verbatim.

- [ ] **Step 2: Run — confirm failure**

Run: `cargo test -p handicap-controller --test datasets_api_test delete_dataset_soft_blocks_when_referenced_by_preset`
Expected: FAIL — today delete returns 204 even with a referencing preset (presets are invisible to the guard).

- [ ] **Step 3: Add the `ConflictJson` error variant.** In `crates/controller/src/error.rs`, add the variant and handle it in `into_response`:

```rust
    #[error("bad request: {0}")]
    BadRequest(String),
    /// A 409 carrying a structured JSON body (returned verbatim, not wrapped in
    /// {error}). Used by the dataset-delete soft guard to list referencing presets.
    #[error("conflict")]
    ConflictJson(serde_json::Value),
    #[error("db: {0}")]
    Db(#[from] sqlx::Error),
```

Rewrite `into_response` so the `ConflictJson` body is returned verbatim:

```rust
impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        // ConflictJson carries a ready-made body — return it as-is.
        if let ApiError::ConflictJson(body) = self {
            return (StatusCode::CONFLICT, Json(body)).into_response();
        }
        let (status, msg) = match &self {
            ApiError::NotFound => (StatusCode::NOT_FOUND, "not found".to_string()),
            ApiError::Conflict(m) => (StatusCode::CONFLICT, m.clone()),
            ApiError::ConflictJson(_) => unreachable!("handled above"),
            ApiError::BadRequest(m) => (StatusCode::BAD_REQUEST, m.clone()),
            ApiError::Scenario(e) => (StatusCode::BAD_REQUEST, e.to_string()),
            ApiError::Db(e) => (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
            ApiError::Internal(e) => (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
        };
        (status, Json(json!({ "error": msg }))).into_response()
    }
}
```

- [ ] **Step 4: Add `?force` + the soft guard to the delete handler.** In `crates/controller/src/api/datasets.rs`, add `Query` to the axum import:

```rust
use axum::extract::{Multipart, Path, Query, State};
```

Add a query struct (near the top, after the response structs):

```rust
#[derive(Debug, Default, serde::Deserialize)]
pub struct DeleteQuery {
    #[serde(default)]
    pub force: bool,
}
```

Replace the `delete` handler:

```rust
/// DELETE /api/datasets/{id}
/// - 비종료(pending/running) run이 참조 → hard 409 (force로도 못 지움).
/// - 프리셋만 참조 → soft 409 + 참조 프리셋 목록. `?force=true`로 override.
pub async fn delete(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Query(q): Query<DeleteQuery>,
) -> Result<StatusCode, ApiError> {
    if crate::store::runs::dataset_in_use(&state.db, &id).await? {
        return Err(ApiError::Conflict(
            "이 데이터셋을 참조하는 실행 중(pending/running) run이 있어 삭제할 수 없습니다".into(),
        ));
    }
    if !q.force {
        let refs = crate::store::presets::referencing_dataset(&state.db, &id).await?;
        if !refs.is_empty() {
            return Err(ApiError::ConflictJson(serde_json::json!({
                "error": format!("{}개 프리셋이 이 데이터셋을 참조 중입니다", refs.len()),
                "presets": refs,
            })));
        }
    }
    store::datasets::delete(&state.db, &id).await?;
    Ok(StatusCode::NO_CONTENT)
}
```

- [ ] **Step 5: Run the soft-guard test + full suite**

Run: `cargo test -p handicap-controller --test datasets_api_test && cargo test -p handicap-controller && cargo clippy -p handicap-controller --all-targets -- -D warnings`
Expected: new test PASS, existing dataset-delete tests (hard 409 on active run; plain delete → 204 when unreferenced) still PASS. `cargo fmt` if needed.

- [ ] **Step 6: Commit**

```bash
git add crates/controller/src/error.rs crates/controller/src/api/datasets.rs \
  crates/controller/tests/datasets_api_test.rs
git commit -m "feat(controller): soft-guard dataset delete against preset refs (?force) (A2)"
```

---

### Task 5: UI presets API layer (schemas + client + hooks)

**Files:**
- Create: `ui/src/api/presets.ts`
- Modify: `ui/src/api/hooks.ts`
- Test: `ui/src/api/__tests__/presets.test.ts` (new)

Pure data-layer task — no component touched, build stays green. Presets use standalone client functions (mirroring `ui/src/api/datasets.ts` style is not available — `datasets` live on the `api` object; we keep presets in their own module to avoid bloating `client.ts`, using bare `fetch`).

> **⚠️ Zod nested-`.default()` leak (`ui/CLAUDE.md`, A1 hit this).** `PresetSchema.profile` nests `ProfileSchema`, whose `ramp_up_seconds.default(0)` / `loop_breakdown_cap.default(256)` leak `number | undefined` into the parent `z.infer`. So `Preset["profile"]` is **not** assignable to the standalone `Profile` type. **Rule for every consumer of a loaded preset: funnel `preset.profile` through `normalizeProfile` (= `ProfileSchema.parse`, from `runPrefill.ts`) before using it, and never destructure `preset.profile.<field>` directly.** Task 6's `loadPreset` already does `normalizeProfile(p.profile)` — keep that pattern everywhere. `pnpm test` (esbuild) will NOT catch a violation; only `pnpm build` (`tsc -b`) does. `PresetInput.profile: Profile` (the standalone type) is correct because the create/update bodies are built from clean form `number`s or from an already-`normalizeProfile`'d value, never from a raw `Preset["profile"]`.

- [ ] **Step 1: Write the failing schema test.** Create `ui/src/api/__tests__/presets.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { PresetSchema, PresetSummarySchema } from "../presets";

describe("PresetSchema", () => {
  it("parses a full preset with a data_binding", () => {
    const p = PresetSchema.parse({
      id: "P1",
      scenario_id: "S1",
      name: "baseline",
      profile: {
        vus: 4,
        duration_seconds: 8,
        ramp_up_seconds: 1,
        loop_breakdown_cap: 256,
        data_binding: { dataset_id: "D1", policy: "per_vu", mappings: [] },
      },
      env: { BASE_URL: "http://x" },
      created_at: 1,
      updated_at: 2,
    });
    expect(p.name).toBe("baseline");
    expect(p.profile.data_binding?.dataset_id).toBe("D1");
  });

  it("accepts data_binding: null (preset saved without a binding)", () => {
    const p = PresetSchema.parse({
      id: "P2",
      scenario_id: "S1",
      name: "no-binding",
      profile: { vus: 1, duration_seconds: 1, data_binding: null },
      env: {},
      created_at: 1,
      updated_at: 1,
    });
    expect(p.profile.data_binding ?? null).toBeNull();
  });

  it("summary parses id/name/vus/duration", () => {
    const s = PresetSummarySchema.parse({
      id: "P1",
      name: "x",
      vus: 2,
      duration_seconds: 5,
      created_at: 1,
      updated_at: 1,
    });
    expect(s.vus).toBe(2);
  });
});
```

- [ ] **Step 2: Run it — confirm failure**

Run: `cd ui && pnpm test -- presets`
Expected: FAIL — module `../presets` not found.

- [ ] **Step 3: Write the client module.** Create `ui/src/api/presets.ts`:

```ts
import { z } from "zod";
import { ProfileSchema, type Profile } from "./schemas";

const BASE = "/api";

export const PresetSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  vus: z.number().int(),
  duration_seconds: z.number().int(),
  created_at: z.number().int(),
  updated_at: z.number().int(),
});
export type PresetSummary = z.infer<typeof PresetSummarySchema>;

export const PresetSchema = z.object({
  id: z.string(),
  scenario_id: z.string(),
  name: z.string(),
  profile: ProfileSchema,
  // Backend stores env as a JSON object; decode with envValueToRecord for prefill.
  env: z.unknown(),
  created_at: z.number().int(),
  updated_at: z.number().int(),
});
export type Preset = z.infer<typeof PresetSchema>;

const PresetListSchema = z.object({ presets: z.array(PresetSummarySchema) });

/** Body for create/update — env is always string→string (API boundary). */
export type PresetInput = { name: string; profile: Profile; env: Record<string, string> };

async function errorMessage(res: Response): Promise<string> {
  try {
    const body = await res.json();
    if (body && typeof body.error === "string") return body.error;
  } catch {
    // non-JSON body
  }
  return `HTTP ${res.status}`;
}

export async function listPresets(scenarioId: string): Promise<PresetSummary[]> {
  const res = await fetch(`${BASE}/scenarios/${encodeURIComponent(scenarioId)}/presets`);
  if (!res.ok) throw new Error(await errorMessage(res));
  return PresetListSchema.parse(await res.json()).presets;
}

export async function getPreset(id: string): Promise<Preset> {
  const res = await fetch(`${BASE}/presets/${encodeURIComponent(id)}`);
  if (!res.ok) throw new Error(await errorMessage(res));
  return PresetSchema.parse(await res.json());
}

export async function createPreset(scenarioId: string, input: PresetInput): Promise<Preset> {
  const res = await fetch(`${BASE}/scenarios/${encodeURIComponent(scenarioId)}/presets`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error(await errorMessage(res));
  return PresetSchema.parse(await res.json());
}

export async function updatePreset(id: string, input: PresetInput): Promise<Preset> {
  const res = await fetch(`${BASE}/presets/${encodeURIComponent(id)}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error(await errorMessage(res));
  return PresetSchema.parse(await res.json());
}

export async function deletePreset(id: string): Promise<void> {
  const res = await fetch(`${BASE}/presets/${encodeURIComponent(id)}`, { method: "DELETE" });
  if (!res.ok) throw new Error(await errorMessage(res));
}
```

- [ ] **Step 4: Run the schema test — verify it passes**

Run: `cd ui && pnpm test -- presets`
Expected: PASS.

- [ ] **Step 5: Add preset hooks.** In `ui/src/api/hooks.ts`, add to the imports at the top:

```ts
import {
  createPreset,
  deletePreset,
  listPresets,
  updatePreset,
  type PresetInput,
} from "./presets";
```

Add to `queryKeys`:

```ts
  datasets: () => ["datasets"] as const,
  dataset: (id: string) => ["datasets", id] as const,
  presets: (scenarioId: string) => ["presets", scenarioId] as const,
  preset: (id: string) => ["preset", id] as const,
```

Append the hooks at the end of the file:

```ts
export function usePresets(scenarioId: string | undefined) {
  return useQuery({
    queryKey: scenarioId ? queryKeys.presets(scenarioId) : ["presets", "missing"],
    queryFn: () => listPresets(scenarioId!),
    enabled: Boolean(scenarioId),
  });
}

export function useCreatePreset(scenarioId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: PresetInput) => createPreset(scenarioId, input),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.presets(scenarioId) }),
  });
}

export function useUpdatePreset(scenarioId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: PresetInput }) => updatePreset(id, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.presets(scenarioId) }),
  });
}

export function useDeletePreset(scenarioId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deletePreset(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.presets(scenarioId) }),
  });
}
```

- [ ] **Step 6: Build gate**

Run: `cd ui && pnpm test && pnpm build`
Expected: tests PASS; `tsc -b && vite build` succeeds.

- [ ] **Step 7: Commit**

```bash
git add ui/src/api/presets.ts ui/src/api/hooks.ts ui/src/api/__tests__/presets.test.ts
git commit -m "feat(ui): preset schemas + client + React Query hooks (A2)"
```

---

### Task 6: RunDialog — load a preset into the form

**Files:**
- Modify: `ui/src/components/RunDialog.tsx`
- Test: `ui/src/components/__tests__/RunDialog.test.tsx`

Add a "프리셋 불러오기" dropdown. Selecting a preset fetches its full profile+env (`getPreset`) and **imperatively** seeds every form field — this is an explicit user action, so it is allowed to replace the form (unlike the A1 "no reseed effect" rule, which guards against accidental refetch-driven overwrites). The DataBinding sub-panel seeds once-per-mount, so we bump a panel `key` to remount it with the loaded binding.

- [ ] **Step 1: Write the failing tests.** Append to `ui/src/components/__tests__/RunDialog.test.tsx` (reuses the file's `fetchMock`, `jsonResponse`, `QueryClient`):

```ts
describe("RunDialog — load preset (A2)", () => {
  function mockPresets() {
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url.endsWith("/api/scenarios/S1/presets") && (!init || init.method === "GET")) {
        return Promise.resolve(
          jsonResponse({
            presets: [
              { id: "P1", name: "heavy", vus: 50, duration_seconds: 60, created_at: 1, updated_at: 1 },
            ],
          }),
        );
      }
      if (url.endsWith("/api/presets/P1")) {
        return Promise.resolve(
          jsonResponse({
            id: "P1",
            scenario_id: "S1",
            name: "heavy",
            profile: {
              vus: 50,
              duration_seconds: 60,
              ramp_up_seconds: 5,
              loop_breakdown_cap: 256,
              data_binding: null,
            },
            env: { BASE_URL: "http://heavy" },
            created_at: 1,
            updated_at: 1,
          }),
        );
      }
      return Promise.resolve(jsonResponse({}, 404));
    });
  }

  function renderDialog() {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return render(
      <QueryClientProvider client={qc}>
        <RunDialog
          scenarioId="S1"
          hasLoop={true}
          scenario={null}
          onCreated={vi.fn()}
          onCancel={vi.fn()}
        />
      </QueryClientProvider>,
    );
  }

  it("renders the preset dropdown when presets exist", async () => {
    mockPresets();
    renderDialog();
    expect(await screen.findByLabelText("load preset")).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "heavy" })).toBeInTheDocument();
  });

  it("loads a preset's profile + env into the form on selection", async () => {
    const user = userEvent.setup();
    mockPresets();
    renderDialog();
    await user.selectOptions(await screen.findByLabelText("load preset"), "P1");
    await waitFor(() => expect(screen.getByLabelText("VUs")).toHaveValue(50));
    expect(screen.getByLabelText("Duration (s)")).toHaveValue(60);
    expect(screen.getByLabelText("Ramp-up (s)")).toHaveValue(5);
    expect(screen.getByLabelText("env key 0")).toHaveValue("BASE_URL");
    expect(screen.getByLabelText("env value 0")).toHaveValue("http://heavy");
  });
});
```

- [ ] **Step 2: Run — confirm failure**

Run: `cd ui && pnpm test -- RunDialog`
Expected: FAIL — no "load preset" control; selecting does nothing.

- [ ] **Step 3: Add preset-load to RunDialog.** In `ui/src/components/RunDialog.tsx`:

Add imports:

```ts
import { useQueryClient } from "@tanstack/react-query";
import { usePresets } from "../api/hooks";
import { getPreset } from "../api/presets";
import { envValueToRecord, normalizeProfile, type RunPrefill } from "../api/runPrefill";
```

> `RunPrefill` is already imported in A1 — keep a single import line; just add `envValueToRecord, normalizeProfile` to it. Remove the now-duplicate `import type { RunPrefill } from "../api/runPrefill";` if present.

Inside the component, after the existing `useState` declarations, add preset state + a binding-panel remount key. Replace the existing `binding` state line and the `DataBindingPanel` seed source with a dedicated `seedBinding` state so a load can re-seed it:

```ts
  const [binding, setBinding] = useState<DataBinding | null>(initial?.profile.data_binding ?? null);
  const [bindingValid, setBindingValid] = useState(true);
  // Binding the panel seeds from (changes only on preset load); panelKey remounts
  // the panel so it re-reads the new seed (it seeds once-per-mount).
  const [seedBinding, setSeedBinding] = useState<DataBinding | null>(
    initial?.profile.data_binding ?? null,
  );
  const [panelKey, setPanelKey] = useState(0);
  const [loadedPresetId, setLoadedPresetId] = useState<string | null>(null);
  const [presetName, setPresetName] = useState("");
  const [presetError, setPresetError] = useState<string | null>(null);

  const presets = usePresets(scenarioId);
  const qc = useQueryClient();

  async function loadPreset(id: string) {
    if (!id) return;
    setPresetError(null);
    try {
      const p = await qc.fetchQuery({ queryKey: ["preset", id], queryFn: () => getPreset(id) });
      const prof = normalizeProfile(p.profile);
      setVus(prof.vus);
      setDuration(prof.duration_seconds);
      setRampUp(prof.ramp_up_seconds);
      setLoopCap(prof.loop_breakdown_cap);
      setEnvEntries(
        Object.entries(envValueToRecord(p.env)).map(([key, value]) => ({ key, value })),
      );
      const b = prof.data_binding ?? null;
      setBinding(b);
      setSeedBinding(b);
      setPanelKey((k) => k + 1); // remount panel to re-seed from the loaded binding
      setLoadedPresetId(id);
      setPresetName(p.name);
    } catch (e) {
      setPresetError((e as Error).message);
    }
  }
```

Render the dropdown right under the drift-warning block (after the `{scenarioChangedWarning && (...)}` paragraph, before the VUs grid):

```tsx
      {presets.data && presets.data.length > 0 && (
        <div className="mb-3 flex items-center gap-2">
          <label className="text-sm text-slate-600" htmlFor="load-preset">
            프리셋 불러오기
          </label>
          <select
            id="load-preset"
            aria-label="load preset"
            className="border border-slate-300 rounded px-2 py-1 text-sm"
            value=""
            onChange={(e) => {
              if (e.target.value) loadPreset(e.target.value);
            }}
          >
            <option value="">— 선택 —</option>
            {presets.data.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </div>
      )}
      {presetError && (
        <p role="alert" className="mb-3 text-red-600 text-sm">
          프리셋 오류: {presetError}
        </p>
      )}
```

Change the `DataBindingPanel` render to remount on `panelKey` and seed from `seedBinding`:

```tsx
      {scenario && (
        <DataBindingPanel
          key={panelKey}
          scenario={scenario}
          initialBinding={seedBinding}
          onChange={setBinding}
          onValidityChange={setBindingValid}
        />
      )}
```

> The `select` is controlled with `value=""` so it always shows "— 선택 —" after a load (the loaded values now live in the form fields, not the dropdown). The loaded preset's name is tracked in `presetName` for Task 7's save/rename/delete controls.

- [ ] **Step 4: Run the tests — verify they pass**

Run: `cd ui && pnpm test -- RunDialog`
Expected: PASS (new cases + all existing — existing tests have no presets mocked, so `presets.data` is undefined and the dropdown stays hidden; the `key={panelKey}` change is inert when `scenario===null`).

- [ ] **Step 5: Build gate**

Run: `cd ui && pnpm test && pnpm build`
Expected: PASS + build succeeds.

- [ ] **Step 6: Commit**

```bash
git add ui/src/components/RunDialog.tsx ui/src/components/__tests__/RunDialog.test.tsx
git commit -m "feat(ui): RunDialog load preset into form (A2)"
```

---

### Task 7: RunDialog — save / overwrite / rename / delete a preset

**Files:**
- Modify: `ui/src/components/RunDialog.tsx`
- Test: `ui/src/components/__tests__/RunDialog.test.tsx`

Adds a "프리셋으로 저장" name input + button (reads the live form state), client-side overwrite-on-duplicate (`PUT` the existing id after `window.confirm`), and rename/delete for the loaded preset. `window.confirm`/`window.prompt` are stubbed in tests.

- [ ] **Step 1: Write the failing tests.** Append to `ui/src/components/__tests__/RunDialog.test.tsx` (reuses `mockPresets`/`renderDialog` from Task 6 — define them once at the top of a shared `describe` or re-declare in this block):

```ts
describe("RunDialog — save/manage preset (A2)", () => {
  function mockPresets(existing: Array<{ id: string; name: string }> = []) {
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url.endsWith("/api/scenarios/S1/presets") && (!init || init.method === "GET")) {
        return Promise.resolve(
          jsonResponse({
            presets: existing.map((p) => ({
              id: p.id,
              name: p.name,
              vus: 1,
              duration_seconds: 1,
              created_at: 1,
              updated_at: 1,
            })),
          }),
        );
      }
      if (url.endsWith("/api/scenarios/S1/presets") && init?.method === "POST") {
        return Promise.resolve(
          jsonResponse(
            {
              id: "NEW",
              scenario_id: "S1",
              name: "saved",
              profile: { vus: 2, duration_seconds: 5, ramp_up_seconds: 0, loop_breakdown_cap: 0 },
              env: {},
              created_at: 1,
              updated_at: 1,
            },
            201,
          ),
        );
      }
      if (url.match(/\/api\/presets\/[^/]+$/) && init?.method === "PUT") {
        return Promise.resolve(
          jsonResponse({
            id: "P1",
            scenario_id: "S1",
            name: "renamed",
            profile: { vus: 1, duration_seconds: 1, ramp_up_seconds: 0, loop_breakdown_cap: 0 },
            env: {},
            created_at: 1,
            updated_at: 2,
          }),
        );
      }
      return Promise.resolve(jsonResponse({}, 404));
    });
  }

  function renderDialog() {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return render(
      <QueryClientProvider client={qc}>
        <RunDialog
          scenarioId="S1"
          hasLoop={false}
          scenario={null}
          onCreated={vi.fn()}
          onCancel={vi.fn()}
        />
      </QueryClientProvider>,
    );
  }

  it("POSTs a new preset from the current form state", async () => {
    const user = userEvent.setup();
    mockPresets([]);
    renderDialog();
    await user.type(screen.getByLabelText("preset name"), "saved");
    await user.click(screen.getByRole("button", { name: "프리셋으로 저장" }));
    await waitFor(() => {
      const call = fetchMock.mock.calls.find(
        ([u, i]) =>
          String(u).endsWith("/api/scenarios/S1/presets") && (i as RequestInit)?.method === "POST",
      );
      expect(call).toBeTruthy();
      const body = JSON.parse((call![1] as RequestInit).body as string);
      expect(body.name).toBe("saved");
      expect(body.profile.vus).toBe(2); // default form vus
    });
  });

  it("confirms then PUTs when the name already exists", async () => {
    const user = userEvent.setup();
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    mockPresets([{ id: "P1", name: "dup" }]);
    renderDialog();
    await user.type(screen.getByLabelText("preset name"), "dup");
    await user.click(screen.getByRole("button", { name: "프리셋으로 저장" }));
    await waitFor(() => {
      const put = fetchMock.mock.calls.find(
        ([u, i]) => String(u).endsWith("/api/presets/P1") && (i as RequestInit)?.method === "PUT",
      );
      expect(put).toBeTruthy();
    });
    confirmSpy.mockRestore();
  });
});
```

- [ ] **Step 2: Run — confirm failure**

Run: `cd ui && pnpm test -- RunDialog`
Expected: FAIL — no "preset name" input / "프리셋으로 저장" button.

- [ ] **Step 3: Add save/manage to RunDialog.** Add hook imports:

```ts
import { useCreatePreset, useDeletePreset, usePresets, useUpdatePreset } from "../api/hooks";
```

> Merge with the Task-6 `usePresets` import line — one import.

Inside the component (after the Task-6 preset state), add the mutations + handlers:

```ts
  const createPreset = useCreatePreset(scenarioId);
  const updatePreset = useUpdatePreset(scenarioId);
  const deletePreset = useDeletePreset(scenarioId);

  function currentInput() {
    return {
      name: presetName.trim(),
      profile: {
        vus,
        duration_seconds: duration,
        ramp_up_seconds: rampUp,
        loop_breakdown_cap: hasLoop ? loopCap : 0,
        data_binding: binding ?? undefined,
      },
      env,
    };
  }

  function savePreset() {
    const name = presetName.trim();
    if (!name) {
      setPresetError("프리셋 이름을 입력하세요");
      return;
    }
    setPresetError(null);
    const existing = presets.data?.find((p) => p.name === name);
    if (existing) {
      if (!window.confirm(`'${name}' 프리셋을 덮어쓸까요?`)) return;
      updatePreset.mutate(
        { id: existing.id, body: currentInput() },
        {
          onError: (e) => setPresetError((e as Error).message),
          onSuccess: () => setLoadedPresetId(existing.id),
        },
      );
    } else {
      createPreset.mutate(currentInput(), {
        onError: (e) => setPresetError((e as Error).message),
        onSuccess: (p) => setLoadedPresetId(p.id),
      });
    }
  }

  // NOTE (UX, spec §3 #12 deviation): rename PUTs `currentInput()`, i.e. the live
  // form state — so if the user edited the form after loading the preset, rename
  // also persists those edits (it's "save current state under a new name", not a
  // pure metadata rename). This is intentional and safe (rename is only offered
  // when a preset is loaded), but differs from the spec's literal "GET then change
  // only name then PUT". If a pure-rename is ever wanted, GET the preset first and
  // PUT its body with only `name` changed.
  function renamePreset() {
    if (!loadedPresetId) return;
    const next = window.prompt("새 이름", presetName)?.trim();
    if (!next) return;
    setPresetError(null);
    updatePreset.mutate(
      { id: loadedPresetId, body: { ...currentInput(), name: next } },
      {
        onError: (e) => setPresetError((e as Error).message),
        onSuccess: () => setPresetName(next),
      },
    );
  }

  function removePreset() {
    if (!loadedPresetId) return;
    if (!window.confirm(`'${presetName}' 프리셋을 삭제할까요?`)) return;
    setPresetError(null);
    deletePreset.mutate(loadedPresetId, {
      onError: (e) => setPresetError((e as Error).message),
      onSuccess: () => {
        setLoadedPresetId(null);
        setPresetName("");
      },
    });
  }
```

Render the save bar just below the env `<section>` and above the `{scenario && <DataBindingPanel .../>}` block:

```tsx
      <div className="mb-3 flex items-center gap-2">
        <input
          aria-label="preset name"
          className="w-48 border border-slate-300 rounded px-2 py-1 text-sm"
          placeholder="프리셋 이름"
          value={presetName}
          onChange={(e) => setPresetName(e.target.value)}
        />
        <button
          type="button"
          onClick={savePreset}
          disabled={createPreset.isPending || updatePreset.isPending}
          className="px-2 py-1 text-sm border border-slate-300 rounded disabled:opacity-50"
        >
          프리셋으로 저장
        </button>
        {loadedPresetId && (
          <>
            <button
              type="button"
              onClick={renamePreset}
              className="text-slate-700 hover:underline text-sm"
            >
              이름 변경
            </button>
            <button
              type="button"
              onClick={removePreset}
              className="text-red-600 hover:underline text-sm"
            >
              프리셋 삭제
            </button>
          </>
        )}
      </div>
```

- [ ] **Step 4: Run the tests — verify they pass**

Run: `cd ui && pnpm test -- RunDialog`
Expected: PASS (new cases + all existing). The save bar always renders; existing tests don't interact with it, and `presetName` defaults to empty so nothing is posted unless clicked.

- [ ] **Step 5: Build gate**

Run: `cd ui && pnpm test && pnpm build`
Expected: PASS + build succeeds. (Watch the `data_binding: binding ?? undefined` line — `binding` is `DataBinding | null`, `?? undefined` collapses to the `ProfileSchema.data_binding` `.nullish()` shape; if `tsc` complains, that's the fix.)

- [ ] **Step 6: Commit**

```bash
git add ui/src/components/RunDialog.tsx ui/src/components/__tests__/RunDialog.test.tsx
git commit -m "feat(ui): RunDialog save/overwrite/rename/delete preset (A2)"
```

---

### Task 8: RunDetailPage — "이 run 설정을 프리셋으로 저장"

**Files:**
- Modify: `ui/src/pages/RunDetailPage.tsx`
- Test: `ui/src/pages/__tests__/RunDetailPage.test.tsx`

A second save entry point: a completed run's profile+env saved under a name (spec §5). No dialog state needed — `window.prompt` for the name, then `createPreset`.

- [ ] **Step 1: Write the failing test.** Append to `ui/src/pages/__tests__/RunDetailPage.test.tsx`. **Verified harness** (this file, as it exists post-A1 — use these exact names, do NOT invent `mockTerminalRun`/`renderPage`):
>   - `fetchMock` (`vi.fn()` + `vi.stubGlobal`), `jsonResponse(body, status)`.
>   - `SCENARIO_YAML` (a one-step scenario whose url is `http://x/{{TOKEN}}`).
>   - `runResponse(over)` → run **`R1`**, scenario **`S1`**, `status: "completed"`, `profile: { vus: 6, ramp_up_seconds: 0, duration_seconds: 12, loop_breakdown_cap: 256 }`, `env: { TOKEN: "abc" }`.
>   - `reportResponse()`, and `mockApi(over)` which routes `GET /api/runs/R1`, `/api/runs/R1/metrics`, `/api/runs/R1/report`, `GET /api/scenarios/S1` — **but has NO preset-POST branch**.
>   - `renderWithRouter(runId)` (MemoryRouter with `/runs/:id` + `/scenarios/:id/runs`).
>
> Because `mockApi` uses `mockImplementation` (full replace) and lacks a POST branch, this test installs its **own** `fetchMock.mockImplementation` that reuses the file's `runResponse`/`reportResponse`/`jsonResponse`/`SCENARIO_YAML` fixtures and adds the preset POST. Assert against the **real** fixture (vus **6**, env **`{TOKEN:"abc"}`**), not invented values:

```ts
describe("RunDetailPage — save preset (A2)", () => {
  it("saves the run's profile+env as a preset via prompt", async () => {
    const user = userEvent.setup();
    const promptSpy = vi.spyOn(window, "prompt").mockReturnValue("from-run");
    // Reuse the file's R1 fixtures; add the preset-POST branch the base mockApi lacks.
    // (Longer suffixes are matched first so /R1 doesn't shadow /R1/metrics etc.)
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url.endsWith("/api/scenarios/S1/presets") && init?.method === "POST") {
        return Promise.resolve(
          jsonResponse(
            {
              id: "P1",
              scenario_id: "S1",
              name: "from-run",
              profile: { vus: 6, duration_seconds: 12, ramp_up_seconds: 0, loop_breakdown_cap: 256 },
              env: { TOKEN: "abc" },
              created_at: 1,
              updated_at: 1,
            },
            201,
          ),
        );
      }
      if (url.endsWith("/api/runs/R1/metrics")) {
        return Promise.resolve(jsonResponse({ run_id: "R1", windows: [] }));
      }
      if (url.endsWith("/api/runs/R1/report")) {
        return Promise.resolve(jsonResponse(reportResponse()));
      }
      if (url.endsWith("/api/runs/R1")) {
        return Promise.resolve(jsonResponse(runResponse()));
      }
      if (url.endsWith("/api/scenarios/S1")) {
        return Promise.resolve(
          jsonResponse({
            id: "S1",
            name: "demo",
            yaml: SCENARIO_YAML,
            version: 1,
            created_at: 1,
            updated_at: 1,
          }),
        );
      }
      return Promise.resolve(jsonResponse({}, 404));
    });
    renderWithRouter("R1");

    await user.click(await screen.findByRole("button", { name: "프리셋으로 저장" }));

    await waitFor(() => {
      const post = fetchMock.mock.calls.find(
        ([u, i]) =>
          String(u).endsWith("/api/scenarios/S1/presets") && (i as RequestInit)?.method === "POST",
      );
      expect(post).toBeTruthy();
      const body = JSON.parse((post![1] as RequestInit).body as string);
      expect(body.name).toBe("from-run");
      expect(body.profile.vus).toBe(6);
      expect(body.env).toEqual({ TOKEN: "abc" });
    });
    promptSpy.mockRestore();
  });
});
```

- [ ] **Step 2: Run — confirm failure**

Run: `cd ui && pnpm test -- RunDetailPage`
Expected: FAIL — no "프리셋으로 저장" button.

- [ ] **Step 3: Wire the save button.** In `ui/src/pages/RunDetailPage.tsx`:

Add imports:

```ts
import { useCreatePreset } from "../api/hooks";
```

In the component body (near the other hooks, after `const createRun = useCreateRun();`):

```ts
  const createPreset = useCreatePreset(run.data?.scenario_id ?? "");
```

> `useCreatePreset` is called unconditionally with a possibly-empty `scenarioId`; the early returns below mean we only ever *invoke* the mutation once `run.data` exists. The empty-string fallback keeps hook order stable.

Add a handler (after `r` is bound, near the env extraction in the render-prep section):

```ts
  function saveAsPreset() {
    const name = window.prompt("프리셋 이름")?.trim();
    if (!name) return;
    createPreset.mutate({
      name,
      profile: normalizeProfile(r.profile),
      env: envValueToRecord(r.env),
    });
  }
```

Add the button to the `terminal` action group, after the existing "다시 실행" `<Link>` inside the `{terminal && (<>...</>)}` block:

```tsx
              <button
                type="button"
                onClick={saveAsPreset}
                disabled={createPreset.isPending}
                className="px-3 py-1.5 text-sm border border-slate-300 rounded hover:bg-slate-100 disabled:opacity-50"
              >
                {createPreset.isPending ? "저장 중…" : "프리셋으로 저장"}
              </button>
```

Add an error banner after the existing `{createRun.error && (...)}` banner:

```tsx
      {createPreset.error && (
        <div
          role="alert"
          className="mb-4 p-3 border border-red-200 bg-red-50 text-sm text-red-800 rounded"
        >
          프리셋 저장 실패: {(createPreset.error as Error).message}
        </div>
      )}
```

> `normalizeProfile` and `envValueToRecord` are already imported in RunDetailPage (A1). Reuse them.

- [ ] **Step 4: Run the test — verify it passes**

Run: `cd ui && pnpm test -- RunDetailPage`
Expected: PASS (new case + all existing A1 retry-button cases).

- [ ] **Step 5: Build gate**

Run: `cd ui && pnpm test && pnpm build`
Expected: PASS + build succeeds.

- [ ] **Step 6: Commit**

```bash
git add ui/src/pages/RunDetailPage.tsx ui/src/pages/__tests__/RunDetailPage.test.tsx
git commit -m "feat(ui): save a completed run's config as a preset (A2)"
```

---

### Task 9: Dataset delete soft-confirm + DataBindingPanel "dataset deleted" notice

**Files:**
- Modify: `ui/src/api/client.ts`, `ui/src/api/hooks.ts`, `ui/src/pages/DatasetsPage.tsx`, `ui/src/components/DataBindingPanel.tsx`
- Test: `ui/src/api/__tests__/datasets.test.ts`, `ui/src/pages/__tests__/DatasetsPage.test.tsx` (new), `ui/src/components/__tests__/DataBindingPanel.test.tsx`

Two related changes around dataset deletion affecting presets: (a) `deleteDataset` surfaces the soft-409 preset list so DatasetsPage can confirm + force; (b) DataBindingPanel shows a notice (and goes invalid) when its selected dataset has been deleted — the case a force-deleted dataset leaves in a preset.

- [ ] **Step 1: Write the failing client test.** Append to `ui/src/api/__tests__/datasets.test.ts` (reuse its fetch mock harness):

```ts
describe("deleteDataset soft-conflict (A2)", () => {
  it("returns deleted:true on 204", async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    const r = await api.deleteDataset("D1");
    expect(r).toEqual({ deleted: true });
  });

  it("returns the preset list on a soft 409", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ error: "1개 프리셋", presets: [{ preset_id: "P1", name: "x", scenario_id: "S1" }] }),
        { status: 409, headers: { "content-type": "application/json" } },
      ),
    );
    const r = await api.deleteDataset("D1");
    expect(r).toEqual({ deleted: false, presets: [{ preset_id: "P1", name: "x", scenario_id: "S1" }] });
  });

  it("force=true appends ?force=true", async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    await api.deleteDataset("D1", true);
    const call = fetchMock.mock.calls.at(-1);
    expect(String(call![0])).toContain("?force=true");
  });

  it("throws on a hard 409 (active run, no presets array)", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "run 중" }), {
        status: 409,
        headers: { "content-type": "application/json" },
      }),
    );
    await expect(api.deleteDataset("D1")).rejects.toThrow(/run 중/);
  });
});
```

> Confirm the existing `datasets.test.ts` imports `api` from `../client` and has a `fetchMock`. If it uses `vi.stubGlobal("fetch", fetchMock)`, mirror that.

- [ ] **Step 2: Run — confirm failure**

Run: `cd ui && pnpm test -- datasets`
Expected: FAIL — `deleteDataset` currently returns `void` and uses the shared `request` helper.

- [ ] **Step 3: Rewrite `deleteDataset` in `ui/src/api/client.ts`.** Replace the `deleteDataset` line in the `api` object:

```ts
  deleteDataset: (id: string, force = false): Promise<DeleteDatasetResult> =>
    deleteDatasetImpl(id, force),
```

Add the result type + impl above the `api` object (after `buildDatasetForm`):

```ts
export type PresetRef = { preset_id: string; name: string; scenario_id: string };
export type DeleteDatasetResult =
  | { deleted: true }
  | { deleted: false; presets: PresetRef[] };

/** DELETE a dataset. 204 → deleted. Soft 409 (only presets reference it) →
 *  {deleted:false, presets}. Hard 409 (active run) or other error → throws. */
async function deleteDatasetImpl(id: string, force: boolean): Promise<DeleteDatasetResult> {
  const res = await fetch(`${BASE}/datasets/${encodeURIComponent(id)}${force ? "?force=true" : ""}`, {
    method: "DELETE",
  });
  if (res.status === 204) return { deleted: true };
  if (res.status === 409) {
    const body = await res.json().catch(() => ({}) as Record<string, unknown>);
    if (Array.isArray((body as { presets?: unknown }).presets)) {
      return { deleted: false, presets: (body as { presets: PresetRef[] }).presets };
    }
    throw new ApiError(409, typeof (body as { error?: unknown }).error === "string"
      ? (body as { error: string }).error
      : "conflict");
  }
  throw new ApiError(res.status, `${res.status} ${res.statusText}`);
}
```

> `BASE` and `ApiError` are already defined at the top of `client.ts`. The `z.undefined()` import for the old delete path may now be unused — if `tsc` warns, leave `z` imported (it's used elsewhere in the file).

- [ ] **Step 4: Update `useDeleteDataset`.** In `ui/src/api/hooks.ts`:

```ts
export function useDeleteDataset() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, force }: { id: string; force?: boolean }) => api.deleteDataset(id, force),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.datasets() }),
  });
}
```

- [ ] **Step 5: Run the client test**

Run: `cd ui && pnpm test -- datasets`
Expected: PASS (client cases). DatasetsPage test will fail to compile until Step 7 — that's expected; continue.

- [ ] **Step 6: Write the failing DatasetsPage test.** Create `ui/src/pages/__tests__/DatasetsPage.test.tsx`:

```ts
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DatasetsPage } from "../DatasetsPage";

const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <DatasetsPage />
    </QueryClientProvider>,
  );
}

describe("DatasetsPage — soft delete (A2)", () => {
  it("confirms then force-deletes when a preset references the dataset", async () => {
    const user = userEvent.setup();
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    let deleteCalls = 0;
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url.endsWith("/api/datasets") && (!init || init.method === "GET")) {
        return Promise.resolve(
          jsonResponse({
            datasets: [
              { id: "D1", name: "users", columns: ["user"], row_count: 2, byte_size: 1, created_at: 1 },
            ],
          }),
        );
      }
      if (url.includes("/api/datasets/D1") && init?.method === "DELETE") {
        deleteCalls += 1;
        if (url.includes("force=true")) return Promise.resolve(new Response(null, { status: 204 }));
        return Promise.resolve(
          jsonResponse({ error: "1개 프리셋", presets: [{ preset_id: "P1", name: "heavy", scenario_id: "S1" }] }, 409),
        );
      }
      return Promise.resolve(jsonResponse({}, 404));
    });

    renderPage();
    await user.click(await screen.findByRole("button", { name: "Delete" }));
    await waitFor(() => expect(confirmSpy).toHaveBeenCalled());
    // confirm message names the referencing preset
    expect(confirmSpy.mock.calls[0][0]).toMatch(/heavy/);
    await waitFor(() => expect(deleteCalls).toBe(2)); // soft 409 then force
    confirmSpy.mockRestore();
  });
});
```

- [ ] **Step 7: Implement the confirm flow in `ui/src/pages/DatasetsPage.tsx`.** Replace the file body:

```tsx
import { useState } from "react";
import { useDatasets, useDeleteDataset } from "../api/hooks";
import { Button } from "../components/Button";
import { UploadPanel } from "../components/datasets/UploadPanel";

export function DatasetsPage() {
  const { data, isLoading, error } = useDatasets();
  const del = useDeleteDataset();
  const [delError, setDelError] = useState<string | null>(null);

  async function handleDelete(id: string) {
    setDelError(null);
    try {
      const r = await del.mutateAsync({ id });
      if (!r.deleted) {
        const names = r.presets.map((p) => p.name).join(", ");
        if (
          window.confirm(
            `${r.presets.length}개 프리셋이 이 데이터셋을 참조 중입니다 (${names}). 그래도 삭제할까요?`,
          )
        ) {
          await del.mutateAsync({ id, force: true });
        }
      }
    } catch (e) {
      setDelError((e as Error).message);
    }
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-lg font-semibold">Datasets</h2>
      </div>

      <UploadPanel />

      {delError && (
        <p role="alert" className="mt-4 text-sm text-red-600">
          삭제 실패: {delError}
        </p>
      )}

      <section aria-label="dataset list" className="mt-8">
        {isLoading && <p className="text-slate-500">Loading…</p>}
        {error && <p className="text-red-600">Failed to load: {(error as Error).message}</p>}
        {data && data.datasets.length === 0 && <p className="text-slate-500">No datasets yet.</p>}
        {data && data.datasets.length > 0 && (
          <table className="min-w-full text-sm">
            <thead className="border-b border-slate-200 text-left text-slate-600">
              <tr>
                <th className="py-2 pr-4">Name</th>
                <th className="py-2 pr-4">Columns</th>
                <th className="py-2 pr-4">Rows</th>
                <th className="py-2 pr-4"></th>
              </tr>
            </thead>
            <tbody>
              {data.datasets.map((d) => (
                <tr key={d.id} className="border-b border-slate-100">
                  <td className="py-2 pr-4 font-medium">{d.name}</td>
                  <td className="py-2 pr-4 text-slate-600">{d.columns.join(", ")}</td>
                  <td className="py-2 pr-4">{d.row_count}</td>
                  <td className="py-2 pr-4">
                    <Button
                      variant="danger"
                      onClick={() => handleDelete(d.id)}
                      disabled={del.isPending}
                    >
                      Delete
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
```

- [ ] **Step 8: Write the failing DataBindingPanel "dataset gone" test.** Append to `ui/src/components/__tests__/DataBindingPanel.test.tsx` (reuse its `fetchMock`/`jsonResponse`/`makeScenario` harness). The dataset list omits `D1` and `GET /api/datasets/D1` 404s, so the seeded selection points at a deleted dataset:

```ts
describe("DataBindingPanel — deleted dataset notice (A2)", () => {
  function renderPanel() {
    fetchMock.mockImplementation((url: string) => {
      if (url.endsWith("/api/datasets")) {
        return Promise.resolve(jsonResponse({ datasets: [] }));
      }
      if (url.endsWith("/api/datasets/D1")) {
        return Promise.resolve(jsonResponse({ error: "not found" }, 404));
      }
      return Promise.resolve(jsonResponse({}, 404));
    });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const onValidity = vi.fn();
    render(
      <QueryClientProvider client={qc}>
        <DataBindingPanel
          scenario={makeScenario()}
          initialBinding={{ dataset_id: "D1", policy: "per_vu", mappings: [] }}
          onChange={() => {}}
          onValidityChange={onValidity}
        />
      </QueryClientProvider>,
    );
    return { onValidity };
  }

  it("shows a notice and goes invalid when the selected dataset is gone", async () => {
    const { onValidity } = renderPanel();
    expect(await screen.findByText(/데이터셋이 삭제/)).toBeInTheDocument();
    await waitFor(() => expect(onValidity).toHaveBeenCalledWith(false));
  });
});
```

- [ ] **Step 9: Add the notice + invalidity to `ui/src/components/DataBindingPanel.tsx`.** Derive a `datasetGone` flag and fold it into the validity emit + render a notice.

After `const dataset = useDataset(selectedId || undefined);` add:

```ts
  // The selected dataset failed to load (deleted out from under a preset, spec §6 #14).
  const datasetGone = !!selectedId && dataset.isError;
```

In the `onChange`/`onValidityChange` effect, change the final validity emit to also fail when the dataset is gone, and add `datasetGone` to the dep array:

```ts
    onValidityChange(uncoveredCount === 0 && noStaleColumns && !datasetGone);
  }, [
    selectedId,
    policy,
    rows,
    scannedVars,
    availableElsewhere,
    columnSet,
    datasetGone,
    onChange,
    onValidityChange,
  ]);
```

Render the notice right after the dataset `<select>`'s closing `</div>` (the block that ends at the comment `{/* Scanned var rows ... */}`):

```tsx
      {datasetGone && (
        <p role="alert" className="mb-3 text-sm text-amber-700">
          이 프리셋의 데이터셋이 삭제되었습니다 — 다시 선택하세요.
        </p>
      )}
```

- [ ] **Step 10: Run all three test files**

Run: `cd ui && pnpm test -- datasets DatasetsPage DataBindingPanel`
Expected: PASS (new cases + all existing — `datasetGone` is `false` whenever the dataset loads fine, so existing panel tests are unaffected).

- [ ] **Step 11: Build gate**

Run: `cd ui && pnpm test && pnpm build`
Expected: PASS + build succeeds.

- [ ] **Step 12: Commit**

```bash
git add ui/src/api/client.ts ui/src/api/hooks.ts ui/src/api/__tests__/datasets.test.ts \
  ui/src/pages/DatasetsPage.tsx ui/src/pages/__tests__/DatasetsPage.test.tsx \
  ui/src/components/DataBindingPanel.tsx ui/src/components/__tests__/DataBindingPanel.test.tsx
git commit -m "feat(ui): dataset delete soft-confirm + binding panel deleted-dataset notice (A2)"
```

---

### Task 10: Docs — ADR, spec status, CLAUDE.md, MEMORY

**Files:**
- Create: `docs/adr/0024-run-presets-independent-resource.md`
- Modify: `docs/superpowers/specs/2026-05-30-run-presets-retry-design.md`, `CLAUDE.md`, `crates/controller/CLAUDE.md`, `ui/CLAUDE.md`, the area-A MEMORY file

Docs-only commit — the pre-commit hook skips cargo for all-`.md` commits. No tests.

- [ ] **Step 1: Write ADR-0024.** Create `docs/adr/0024-run-presets-independent-resource.md` (MADR format), recording: run presets are a separate scenario-scoped `run_presets` table + first-class REST resource (not embedded in scenarios or runs); they reuse the `Profile` serde type; they store no `scenario_yaml` snapshot (follow live scenario); the run-create gate stays authoritative (`validate_run_config` shared); dataset delete is soft-guarded against preset refs with `?force`. Reference ADR-0013 (scenario↔run config split) and ADR-0022 (data-driven binding).

- [ ] **Step 2: Add the decision to root `CLAUDE.md`.** In the "알아둘 결정들" list, after the `0023` line:

```markdown
- **0024** Run 프리셋: scenario-scoped 독립 리소스(`run_presets`) + Profile 재사용 + snapshot 없음(라이브 추종) + validate_run_config 공유 + dataset delete soft-guard(`?force`)
```

- [ ] **Step 3: Update the spec status.** In `docs/superpowers/specs/2026-05-30-run-presets-retry-design.md`, change the `Status:` line (1) and the §8 A2 block to mark A2 implemented, with the plan path and commit range, mirroring how A1 is recorded.

- [ ] **Step 4: Add controller gotchas to `crates/controller/CLAUDE.md`.** Append to the "데이터 바인딩 / 주입" or "저장소 / 마이그레이션" section:
  - `validate_run_config`는 run-create와 preset-save가 공유하는 검증 게이트 — **검증 meta를 반환**해 resolution이 두 번째 `get_meta` 없이 재사용(TOCTOU 회피). preset 경로는 반환 meta를 무시.
  - `ApiError::ConflictJson(Value)`는 본문을 `{error}`로 감싸지 않고 그대로 반환 — dataset delete soft-guard가 참조 프리셋 목록을 실어 보낼 때 사용.
  - dataset DELETE 가드 2층: 활성 run = hard 409(force 불가), 프리셋만 참조 = soft 409 + `?force=true` override.

- [ ] **Step 5: Add UI gotchas to `ui/CLAUDE.md`.** Append to the "폼·입력 UX" subsection:
  - RunDialog 프리셋 **load는 명시적 사용자 액션이라 imperative reseed 허용**(A1 "no reseed effect" 규칙은 refetch발 우발적 덮어쓰기 방지용). DataBindingPanel은 mount-시 1회 seed라, load 시 `panelKey`를 bump해 패널만 remount.
  - `deleteDataset`은 이제 `(id, force?)` → `{deleted:true} | {deleted:false, presets}` 반환. soft 409(프리셋만 참조)는 throw 안 함 — DatasetsPage가 confirm 후 `force:true` 재요청. hard 409(활성 run)는 throw.

- [ ] **Step 6: Update the MEMORY index.** Update the area-A MEMORY entry (`run-presets-area-a.md` + the `MEMORY.md` pointer line) to record A2 done (plan path, commit range, worktree), and set "다음" appropriately (영역 A complete, or whatever the roadmap names next).

- [ ] **Step 7: Commit**

```bash
git add docs/adr/0024-run-presets-independent-resource.md \
  docs/superpowers/specs/2026-05-30-run-presets-retry-design.md \
  CLAUDE.md crates/controller/CLAUDE.md ui/CLAUDE.md
git commit -m "docs: A2 run presets — ADR-0024 + status + gotchas"
```

> The MEMORY files live outside the repo (`/Users/sgj/.claude/.../memory/`) — update them with the Write tool, not via git.

---

## spec-plan-reviewer findings — applied (2026-05-31)

Verdict was **CHANGES REQUESTED** (architecture sound; localized fixes). All applied:

- **M1 (Task 8 test harness)** — the plan had assumed `mockTerminalRun({...})` + `renderPage`, which don't exist. The real `RunDetailPage.test.tsx` harness is `mockApi(over)` (no preset-POST branch) + fixtures `runResponse`/`reportResponse`/`jsonResponse`/`SCENARIO_YAML` (run **R1**, vus **6**, env **`{TOKEN:"abc"}`**) + `renderWithRouter(runId)`. Task 8 Step 1 rewritten to install its own `fetchMock.mockImplementation` reusing those fixtures + a 201 preset-POST branch, asserting the real values. *(Verified against the file; the reviewer's guessed name `mockTerminalRun` was also approximate — actual is `mockApi`.)*
- **M2 (Zod leak on `Preset.profile`)** — added an explicit ⚠️ callout to Task 5: `PresetSchema.profile` re-leaks `number | undefined`, so every consumer must funnel `preset.profile` through `normalizeProfile` and never destructure fields directly; only `pnpm build` catches a violation.
- **M3 (`PUT /presets/{nonexistent}` → 404)** — added integration test `preset_put_nonexistent_is_404` to Task 3 (closes the gap between the store unit test and the route; auto-run by Task 3 Step 6).
- **Minor (Task 4 helper name)** — **verified** the real dataset-upload helper is `upload_csv(&app, name, csv)` (the reviewer's `upload_ds` was incorrect); my plan already used `upload_csv`. Tightened the note to state it's confirmed, and that `create_scenario` must be copied in from `presets_api_test.rs` (confirmed absent in `datasets_api_test.rs`).
- **Minor (rename UX, spec §3 #12)** — added a code comment to Task 7 `renamePreset` documenting that rename PUTs live form state (persists in-flight edits), an intentional, safe deviation from the literal "GET-then-change-name-then-PUT".

No BLOCKERs were raised; remaining reviewer "verified-correct" items (A1 seam present, TOCTOU meta-reuse, migration two-edit, `validate_run_config` signature consistency, no proto impact, hook-order safety, error.rs arm preservation) needed no change.

## Self-Review (checked against the spec)

**Spec coverage:**
- §2 data model (migration 0005, UNIQUE index, Profile reuse, FK-cascade comment, `store/presets.rs`) → Task 1. ✅
- §3 REST API (POST/GET-list/GET-one/PUT/DELETE incl. PUT-nonexistent→404, routing, `validate_run_config` extraction taking `&AppState`, PUT-vs-inline-rename via GET-then-PUT, dataset soft-guard + `referencing_dataset`) → Tasks 2, 3, 4. ✅ (Inline rename implemented in RunDialog Task 7 as load-cached-then-PUT; deviation documented inline. PUT-404 covered by `preset_put_nonexistent_is_404`.)
- §4 retry → already A1 (out of scope here). ✅
- §5 UI (RunDialog `initial` seam reuse + preset dropdown/save/delete/rename, RunDetail save, presets React Query client, env `map<string,string>`) → Tasks 5–8. ✅ (env constraint was A1; presets reuse `ProfileSchema`/`DataBindingSchema` + `envValueToRecord`/`normalizeProfile`.)
- §6 validation/edge cases (save-time + run-create double; preset follows live scenario, stale-mapping highlight reused from A1, deleted-dataset notice; empty-name 400; UNIQUE 409; plaintext env; empty/no-binding; 0 presets → hidden dropdown) → Tasks 3, 7, 9. ✅
- §7 tests (Rust: store CRUD + UNIQUE 409 + round-trip + `validate_run_config` via run-create + API integration incl. PUT-nonexistent→404 + dataset soft-guard + migration applied; UI: load fills form, save POST, rehydrate via A1 seam, deleted-dataset notice, PresetSchema round-trip + null `data_binding` + build) → every task's test steps. ✅
- §8 A2 split scope → this whole plan. ✅
- §9 out of scope (scenario clone, global vars, masking, cross-scenario presets) → untouched. ✅

**Type consistency:** `PresetInput` (TS) = `{name, profile: Profile, env: Record<string,string>}` matches `PresetBody` (Rust) `{name, profile: Profile, env: HashMap<String,String>}`. `PresetSummary` (TS Zod) fields = Rust `PresetSummary` serialize fields (id/name/vus/duration_seconds/created_at/updated_at). `PresetSchema` (TS) env = `z.unknown()` matches Rust `PresetResponse.env: serde_json::Value`. `PresetRef` (TS) `{preset_id,name,scenario_id}` matches Rust `PresetRef` serialize. `validate_run_config` returns `Option<DatasetMeta>` consumed identically by `runs::create` and discarded by presets. `useDeleteDataset` mutation var `{id, force?}` matches `api.deleteDataset(id, force)`.

**No placeholders:** every code step shows complete code; every test step shows the assertion; every run step shows the command + expected result. The two adaptation notes (datasets_api_test helper names in Task 4; RunDetailPage test harness names in Task 8) point at existing reusable harnesses rather than inventing new ones — the implementer reads the file's top and reuses it, per repo convention.

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-05-31-area-a2-run-presets.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks (spec-compliance then code-quality, per root `CLAUDE.md`), fast iteration. Note the A1 lesson: verify each task's real state with `git status`/`git diff`/tests, not the subagent's report.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints for review.

**Which approach?**
