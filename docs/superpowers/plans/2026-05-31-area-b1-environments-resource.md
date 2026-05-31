# Area B-1 — 환경(Environments) 리소스 + 관리 UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a top-level, cross-scenario **environments** resource (a named `{key:value}` bundle of `${ENV}` values) — migration + SQLite store + CRUD REST + a management page in the UI — so frequently-reused env values (`BASE_URL`, auth hosts, API keys) can be registered once and reused. **`POST /api/runs` and `RunDialog` are untouched in B-1** — the run-time overlay is B-2.

**Architecture:** Near-verbatim mirror of the existing run-presets resource (ADR-0024): `store/environments.rs` mirrors `store/presets.rs` (UNIQUE-name → 409, server-generated ULID), `api/environments.rs` mirrors `api/presets.rs` (`map_db_err` 409 mapping, `EnvironmentResponse`/`EnvironmentSummary` full-vs-summary split), `api/environments.ts` + `hooks.ts` mirror `api/presets.ts` + its React Query hooks, `EnvironmentsPage.tsx` mirrors `DatasetsPage.tsx`. The one new wrinkle vs presets: environments are **top-level** (no `scenario_id`, no FK, **no delete-guard** — nothing references them; the overlay is snapshot-based, B-2). Validation lives only on the CRUD endpoints (name non-empty + UNIQUE; var keys usable as `${KEY}`).

**Tech Stack:** Rust (controller: axum 0.8 + sqlx 0.8 SQLite + thiserror), TypeScript/React (Vite + Zod + React Query v5 + vitest/RTL + react-router-dom).

---

## Repo conventions the executor MUST know (read before Task 1)

- **Git topology:** integration branch is `master` (no `main`, no remote). Work in a worktree; finish with local rebase + `--ff-only` merge to `master`. (Root CLAUDE.md "git 토폴로지".)
- **Worktree baseline:** a fresh `EnterWorktree` worktree has **no `ui/node_modules` and no `target/`**. Before running tests, run `cd ui && pnpm install` and `cargo build` once. (Root CLAUDE.md "Subagent dispatch 노하우".)
- **Pre-commit hook** runs `cargo fmt --check + build + clippy -D warnings + test` on every non-`.md` commit. **It does NOT run UI checks** — for any task touching `ui/`, run `cd ui && pnpm test && pnpm build` (the `tsc -b` gate) **manually before committing**. (Root CLAUDE.md "검증 자동화".)
- **`.md`-only commits skip ALL gates** — a docs commit can carry a merge-conflict marker into master silently. After the docs task, run `grep -rn '^<<<<<<<\|^>>>>>>>' **/*.md` once. (Root CLAUDE.md.)
- **tdd-guard** (`.claude/hooks/tdd-guard.sh`) blocks Write/Edit on `crates/*/src/*.rs` or `ui/src/*.{ts,tsx}` unless the working tree has a **pending (uncommitted) test file** (or the edited `.rs` file has an inline `#[cfg(test)] mod tests`). Each task below orders its **test step first** to satisfy this; UI tasks keep the test file uncommitted until the task's final commit so the guard sees it pending while the production file is edited. Comment/whitespace-only edits auto-pass.
- **`cargo run -p handicap-controller` is ambiguous** (two binaries). Use `--bin controller`. (Root CLAUDE.md "로컬 dev 실행 함정".) Not needed for this plan's tests, but relevant for any manual check.
- **ULIDs in fixtures** must avoid `I/L/O/U` (Crockford base32). Environment ids are **server-generated** (`Ulid::new()`), so you never hand-write one; but if a test needs a scenario fixture, reuse a valid ULID. (engine CLAUDE.md.)

### ⚠️ Migration number — read this BEFORE Task 1

When this plan was written, master's highest migration was **`0005_run_presets`**, so this plan writes **0006** for `environments`. **But Slice 9d is in flight in a parallel worktree (`slice-9d-branch-metrics`) and also lands a new migration (`run_if_metrics`).** Whichever of {9d, this branch} merges *second* must take the higher number.

Therefore, **in Task 1 Step 1, run `ls crates/controller/src/store/migrations/` and use `(highest existing number) + 1`:**
- If 9d has **not** merged yet (highest is `0005_run_presets`) → use **0006** (as written below).
- If 9d **already** merged (highest is `0006_run_if_metrics`) → use **0007**, and substitute `0007` / `MIGRATION_SQL_0007` for every `0006` / `MIGRATION_SQL_0006` in Task 1.

The two tables are **disjoint** (no shared SQL; both `CREATE TABLE IF NOT EXISTS`, idempotent), so the migration number is a pure source-level label. Renumbering later is a mechanical 3-line edit with **zero runtime/data risk** — see the **Finishing** section for the rebase-time renumber procedure.

---

## Conflict surface with in-flight Slice 9d

9d (engine branch-decision metrics → report UI) and this branch are independent at the data layer. The **only** files both touch:

| File | 9d change | B-1 change | Resolution |
|---|---|---|---|
| `crates/controller/src/store/mod.rs` | adds `MIGRATION_SQL_0005` (run_if_metrics) const + execute line | adds `MIGRATION_SQL_0006` (environments) const + execute line + `pub mod environments;` | Both append at the tail → trivial keep-both merge **iff numbers differ** (see migration-number box). |
| root `CLAUDE.md`, `docs/roadmap.md`, `MEMORY.md` | append status/decision lines | append status/decision lines | Append-only; resolve by hand, grep for conflict markers. |
| ADRs | updates `0023` | creates new `0025` | No file conflict (different files). |

9d does **not** touch `app.rs`, `api/mod.rs`, `store/environments.rs` (new), `api/environments.ts` (new), `hooks.ts`, `routes.tsx`, `Layout.tsx`, or `EnvironmentsPage.tsx` (new). So B-1's API routing and all UI work are conflict-free. **B-2 (RunDialog overlay) is likewise conflict-free with 9d** (9d touches no RunDialog/EnvironmentPicker files).

---

## File structure

**Create:**
- `crates/controller/src/store/migrations/0006_environments.sql` — environments table + UNIQUE(name) index.
- `crates/controller/src/store/environments.rs` — `EnvironmentRow` + insert/get/list/update/delete + tests.
- `crates/controller/src/api/environments.rs` — DTOs + CRUD handlers + `validate_env` + `map_db_err`.
- `crates/controller/tests/environments_api_test.rs` — REST integration test.
- `ui/src/api/environments.ts` — Zod schemas + bare-fetch client.
- `ui/src/api/__tests__/environments.test.ts` — schema round-trip + client test.
- `ui/src/pages/EnvironmentsPage.tsx` — list + create/edit form + delete.
- `ui/src/pages/__tests__/EnvironmentsPage.test.tsx` — RTL tests.
- `docs/adr/0025-environments-resource.md` — the decision record.

**Modify:**
- `crates/controller/src/store/mod.rs` — `pub mod environments;` + migration 0006 const + execute line.
- `crates/controller/src/api/mod.rs` — `pub mod environments;`.
- `crates/controller/src/app.rs` — `environments as environments_api` import + `/environments` routes.
- `ui/src/api/hooks.ts` — `queryKeys.environments`/`environment` + 5 hooks.
- `ui/src/routes.tsx` — `/environments` route.
- `ui/src/components/Layout.tsx` — nav `<Link to="/environments">`.
- root `CLAUDE.md`, `crates/controller/CLAUDE.md`, `ui/CLAUDE.md`, `docs/roadmap.md`, the spec status line, `MEMORY.md` — Task 7.

---

## Task 1: Migration 0006 — `environments` table + registration

**Files:**
- Create: `crates/controller/src/store/migrations/0006_environments.sql`
- Modify: `crates/controller/src/store/mod.rs:1` (mod), `:28` (const), `:54` (execute)

`store/mod.rs` has an inline `#[cfg(test)] mod tests` → tdd-guard passes.

- [ ] **Step 1: Confirm the migration number**

Run: `ls crates/controller/src/store/migrations/`
Expected: highest is `0005_run_presets.sql` → use **0006** below. If you instead see `0006_run_if_metrics.sql` (9d merged first), use **0007** and substitute it for `0006`/`MIGRATION_SQL_0006` throughout this task.

- [ ] **Step 2: Create the migration**

Create `crates/controller/src/store/migrations/0006_environments.sql`:

```sql
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
```

- [ ] **Step 3: Register the module + migration const**

In `crates/controller/src/store/mod.rs`, add the module declaration after `pub mod datasets;` (line 1):

```rust
pub mod datasets;
pub mod environments;
```

After line 28 (`const MIGRATION_SQL_0005 = ...`), add:

```rust
const MIGRATION_SQL_0006: &str = include_str!("migrations/0006_environments.sql");
```

- [ ] **Step 4: Execute it in `connect`**

In `crates/controller/src/store/mod.rs`, after line 54 (`sqlx::query(MIGRATION_SQL_0005).execute(&pool).await?;`), add:

```rust
    sqlx::query(MIGRATION_SQL_0006).execute(&pool).await?;
```

- [ ] **Step 5: Verify migrations still run (idempotent)**

Run: `cargo test -p handicap-controller --lib store::tests::opens_and_migrates_in_memory`
Expected: PASS (`connect()` runs 0001–0006 without error).

> **On spec §6 "migration 0006 멱등 (두 번 적용 OK)":** this is guaranteed structurally by `CREATE TABLE IF NOT EXISTS` + `CREATE UNIQUE INDEX IF NOT EXISTS`, the same way 0003/0004/0005 are — the repo has **no** per-migration re-apply test (a controller restart re-runs every `connect()` migration, and the `IF NOT EXISTS` guards make that safe; that's the existing convention). No new idempotency test is required; the single-`connect()` test above is the established coverage. Do not add a bespoke re-apply test just to satisfy the literal spec wording.

- [ ] **Step 6: Commit**

```bash
git add crates/controller/src/store/migrations/0006_environments.sql crates/controller/src/store/mod.rs
git commit -m "feat(controller): add environments migration 0006 + register (B-1)"
```

---

## Task 2: Controller store — `store/environments.rs`

**Files:**
- Create: `crates/controller/src/store/environments.rs`

The new file's inline `#[cfg(test)] mod tests` satisfies tdd-guard. Write the whole file (production + tests) in one step, then verify.

- [ ] **Step 1: Write the module with tests**

Create `crates/controller/src/store/environments.rs`:

```rust
use std::collections::BTreeMap;

use sqlx::Row;
use ulid::Ulid;

use super::Db;

/// One stored environment: a named, cross-scenario bundle of `${ENV}` values.
/// `vars` is an ordered map so list output and round-trips are deterministic.
#[derive(Debug, Clone)]
pub struct EnvironmentRow {
    pub id: String,
    pub name: String,
    pub vars: BTreeMap<String, String>,
    pub created_at: i64,
    pub updated_at: i64,
}

pub async fn insert(
    db: &Db,
    name: &str,
    vars: &BTreeMap<String, String>,
) -> sqlx::Result<EnvironmentRow> {
    // Server-generated ULID — never trust a client/UUID (matches runs.rs/presets.rs).
    let id = Ulid::new().to_string();
    let now = super::now_ms();
    let vars_json = serde_json::to_string(vars).expect("serialize env vars");
    sqlx::query(
        "INSERT INTO environments(id,name,vars_json,created_at,updated_at) \
         VALUES(?,?,?,?,?)",
    )
    .bind(&id)
    .bind(name)
    .bind(&vars_json)
    .bind(now)
    .bind(now)
    .execute(db)
    .await?;
    Ok(EnvironmentRow {
        id,
        name: name.to_string(),
        vars: vars.clone(),
        created_at: now,
        updated_at: now,
    })
}

pub async fn get(db: &Db, id: &str) -> sqlx::Result<Option<EnvironmentRow>> {
    let row = sqlx::query(
        "SELECT id,name,vars_json,created_at,updated_at FROM environments WHERE id = ?",
    )
    .bind(id)
    .fetch_optional(db)
    .await?;
    let Some(r) = row else { return Ok(None) };
    let vars: BTreeMap<String, String> =
        serde_json::from_str(r.get::<String, _>("vars_json").as_str()).unwrap_or_default();
    Ok(Some(EnvironmentRow {
        id: r.get("id"),
        name: r.get("name"),
        vars,
        created_at: r.get("created_at"),
        updated_at: r.get("updated_at"),
    }))
}

pub async fn list(db: &Db) -> sqlx::Result<Vec<EnvironmentRow>> {
    let rows = sqlx::query(
        "SELECT id,name,vars_json,created_at,updated_at FROM environments ORDER BY name",
    )
    .fetch_all(db)
    .await?;
    let mut out = Vec::with_capacity(rows.len());
    for r in rows {
        let vars: BTreeMap<String, String> =
            serde_json::from_str(r.get::<String, _>("vars_json").as_str()).unwrap_or_default();
        out.push(EnvironmentRow {
            id: r.get("id"),
            name: r.get("name"),
            vars,
            created_at: r.get("created_at"),
            updated_at: r.get("updated_at"),
        });
    }
    Ok(out)
}

/// Full-body replace. Returns `None` if no environment with `id` exists.
pub async fn update(
    db: &Db,
    id: &str,
    name: &str,
    vars: &BTreeMap<String, String>,
) -> sqlx::Result<Option<EnvironmentRow>> {
    let now = super::now_ms();
    let vars_json = serde_json::to_string(vars).expect("serialize env vars");
    let res = sqlx::query(
        "UPDATE environments SET name = ?, vars_json = ?, updated_at = ? WHERE id = ?",
    )
    .bind(name)
    .bind(&vars_json)
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
    // No guard: nothing references an environment (snapshot overlay model, B-2).
    sqlx::query("DELETE FROM environments WHERE id = ?")
        .bind(id)
        .execute(db)
        .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store;

    fn vars(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
        pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect()
    }

    #[tokio::test]
    async fn insert_get_list_update_delete_roundtrip() {
        let db = store::connect("sqlite::memory:").await.unwrap();
        let v = vars(&[("BASE_URL", "http://x"), ("API_KEY", "sk-1")]);
        let row = insert(&db, "staging", &v).await.unwrap();

        let got = get(&db, &row.id).await.unwrap().expect("env");
        assert_eq!(got.name, "staging");
        assert_eq!(got.vars, v); // JSON round-trip preserves the map

        let listed = list(&db).await.unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].id, row.id);

        let v2 = vars(&[("BASE_URL", "http://y")]);
        let updated = update(&db, &row.id, "prod", &v2)
            .await
            .unwrap()
            .expect("updated");
        assert_eq!(updated.name, "prod");
        assert_eq!(updated.vars, v2);

        delete(&db, &row.id).await.unwrap();
        assert!(get(&db, &row.id).await.unwrap().is_none());
    }

    #[tokio::test]
    async fn unique_name_is_enforced() {
        let db = store::connect("sqlite::memory:").await.unwrap();
        insert(&db, "dup", &vars(&[])).await.unwrap();
        let err = insert(&db, "dup", &vars(&[]))
            .await
            .expect_err("second insert with same name must fail");
        assert!(
            err.as_database_error()
                .map(|d| d.is_unique_violation())
                .unwrap_or(false),
            "expected a UNIQUE violation, got {err:?}"
        );
    }

    #[tokio::test]
    async fn update_missing_returns_none() {
        let db = store::connect("sqlite::memory:").await.unwrap();
        let out = update(&db, "nope", "x", &vars(&[])).await.unwrap();
        assert!(out.is_none());
    }

    #[tokio::test]
    async fn empty_vars_roundtrips() {
        let db = store::connect("sqlite::memory:").await.unwrap();
        let row = insert(&db, "empty", &vars(&[])).await.unwrap();
        let got = get(&db, &row.id).await.unwrap().expect("env");
        assert!(got.vars.is_empty());
    }
}
```

- [ ] **Step 2: Run the store tests**

Run: `cargo test -p handicap-controller --lib store::environments`
Expected: PASS (4 tests). The `module not found` for `store::environments` is resolved because Task 1 added `pub mod environments;`.

- [ ] **Step 3: Commit**

```bash
git add crates/controller/src/store/environments.rs
git commit -m "feat(controller): environments store layer (insert/get/list/update/delete) (B-1)"
```

---

## Task 3: Controller REST — `api/environments.rs` + routing

**Files:**
- Create: `crates/controller/src/api/environments.rs`
- Modify: `crates/controller/src/api/mod.rs:1` (mod), `crates/controller/src/app.rs:8-10` (import) + `:60-69` region (routes)
- Test: `crates/controller/tests/environments_api_test.rs`

`api/environments.rs` will carry no inline tests; the integration test in `tests/` (written first) unblocks tdd-guard. The `app.rs`/`api/mod.rs` edits are wiring; the same pending integration test covers tdd-guard for them too.

- [ ] **Step 1: Write the failing integration test**

Create `crates/controller/tests/environments_api_test.rs`:

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

async fn send(app: &axum::Router, method: Method, uri: &str, body: Option<Value>) -> (StatusCode, Value) {
    // `Builder` methods take `self` by value, so `builder` is moved into exactly
    // one match arm — no `mut`, no clippy unused_mut warning under -D warnings.
    let builder = Request::builder().method(method).uri(uri);
    let req = match body {
        Some(b) => builder
            .header("content-type", "application/json")
            .body(Body::from(b.to_string()))
            .unwrap(),
        None => builder.body(Body::empty()).unwrap(),
    };
    let resp = app.clone().oneshot(req).await.unwrap();
    let status = resp.status();
    let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX).await.unwrap();
    let v: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
    (status, v)
}

#[tokio::test]
async fn environment_create_list_get_update_delete() {
    let db = store::connect("sqlite::memory:").await.unwrap();
    let app = make_app(db);

    // create
    let (status, created) = send(
        &app,
        Method::POST,
        "/api/environments",
        Some(json!({ "name": "staging", "vars": { "BASE_URL": "http://s", "API_KEY": "k" } })),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    let id = created["id"].as_str().unwrap().to_string();
    assert_eq!(created["name"], "staging");
    assert_eq!(created["vars"]["BASE_URL"], "http://s");

    // list (summary: var_count, no vars)
    let (status, list) = send(&app, Method::GET, "/api/environments", None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(list["environments"].as_array().unwrap().len(), 1);
    assert_eq!(list["environments"][0]["var_count"], 2);
    assert!(list["environments"][0].get("vars").is_none());

    // get (full: vars present)
    let (status, full) = send(&app, Method::GET, &format!("/api/environments/{id}"), None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(full["vars"]["API_KEY"], "k");

    // update (rename + replace vars)
    let (status, updated) = send(
        &app,
        Method::PUT,
        &format!("/api/environments/{id}"),
        Some(json!({ "name": "prod", "vars": { "BASE_URL": "http://p" } })),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(updated["name"], "prod");
    assert!(updated["vars"].get("API_KEY").is_none());

    // delete (204, unguarded)
    let (status, _) = send(&app, Method::DELETE, &format!("/api/environments/{id}"), None).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let (status, _) = send(&app, Method::GET, &format!("/api/environments/{id}"), None).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn duplicate_name_is_409() {
    let db = store::connect("sqlite::memory:").await.unwrap();
    let app = make_app(db);
    let (s1, _) = send(&app, Method::POST, "/api/environments", Some(json!({ "name": "x", "vars": {} }))).await;
    assert_eq!(s1, StatusCode::CREATED);
    let (s2, _) = send(&app, Method::POST, "/api/environments", Some(json!({ "name": "x", "vars": {} }))).await;
    assert_eq!(s2, StatusCode::CONFLICT);
}

#[tokio::test]
async fn empty_name_is_400() {
    let db = store::connect("sqlite::memory:").await.unwrap();
    let app = make_app(db);
    let (s, _) = send(&app, Method::POST, "/api/environments", Some(json!({ "name": "  ", "vars": {} }))).await;
    assert_eq!(s, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn invalid_var_key_is_400() {
    let db = store::connect("sqlite::memory:").await.unwrap();
    let app = make_app(db);
    // key contains ':' (conservative reject for the ${NAME:-default} separator).
    let (s, _) = send(
        &app,
        Method::POST,
        "/api/environments",
        Some(json!({ "name": "x", "vars": { "BAD:KEY": "v" } })),
    )
    .await;
    assert_eq!(s, StatusCode::BAD_REQUEST);
}
```

- [ ] **Step 2: Run to verify failure**

Run: `cargo test -p handicap-controller --test environments_api_test`
Expected: FAIL to compile — `/api/environments` routes don't exist yet (the test compiles but every request 404s, or `app.rs` lacks the route → assertions fail).

- [ ] **Step 3: Create the handler module**

Create `crates/controller/src/api/environments.rs`:

```rust
use std::collections::BTreeMap;

use axum::Json;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use serde::{Deserialize, Serialize};

use crate::app::AppState;
use crate::error::ApiError;
use crate::store::environments;

#[derive(Debug, Deserialize)]
pub struct EnvironmentBody {
    pub name: String,
    #[serde(default)]
    pub vars: BTreeMap<String, String>,
}

#[derive(Debug, Serialize)]
pub struct EnvironmentResponse {
    pub id: String,
    pub name: String,
    pub vars: BTreeMap<String, String>,
    pub created_at: i64,
    pub updated_at: i64,
}

/// Lightweight list row (no vars body — the dropdown/list only needs these).
#[derive(Debug, Serialize)]
pub struct EnvironmentSummary {
    pub id: String,
    pub name: String,
    pub var_count: usize,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Serialize)]
pub struct EnvironmentListResponse {
    pub environments: Vec<EnvironmentSummary>,
}

fn to_response(r: environments::EnvironmentRow) -> EnvironmentResponse {
    EnvironmentResponse {
        id: r.id,
        name: r.name,
        vars: r.vars,
        created_at: r.created_at,
        updated_at: r.updated_at,
    }
}

/// Map a UNIQUE(name) violation to a 409; anything else is a 500. Mirrors
/// api/presets.rs::map_db_err.
fn map_db_err(e: sqlx::Error) -> ApiError {
    if e.as_database_error()
        .map(|d| d.is_unique_violation())
        .unwrap_or(false)
    {
        return ApiError::Conflict("같은 이름의 환경이 이미 있습니다".into());
    }
    ApiError::from(e)
}

/// Validate a (name, vars) body. Name must be non-empty after trim. Var keys must
/// be usable as `${KEY}` env references: non-empty, and free of whitespace, `}`,
/// and `:`. The `:` ban is a conservative guard against the `:-` default separator
/// the engine's template.rs splits on (spec §5) — a bare `:` is wider than strictly
/// needed but keeps the rule simple. Reserved system-var names
/// (vu_id/iter_id/loop_index) are NOT rejected here — the engine resolves them to
/// system values regardless, so the UI surfaces a soft warning instead.
fn validate_env(name: &str, vars: &BTreeMap<String, String>) -> Result<(), ApiError> {
    if name.trim().is_empty() {
        return Err(ApiError::BadRequest("이름은 비어 있을 수 없습니다".into()));
    }
    for key in vars.keys() {
        let k = key.trim();
        if k.is_empty() {
            return Err(ApiError::BadRequest("변수 이름은 비어 있을 수 없습니다".into()));
        }
        if k.chars().any(|c| c.is_whitespace() || c == '}' || c == ':') {
            return Err(ApiError::BadRequest(format!(
                "변수 이름 '{key}'에 공백·중괄호·콜론은 쓸 수 없습니다"
            )));
        }
    }
    Ok(())
}

pub async fn create(
    State(state): State<AppState>,
    Json(body): Json<EnvironmentBody>,
) -> Result<(StatusCode, Json<EnvironmentResponse>), ApiError> {
    validate_env(&body.name, &body.vars)?;
    let row = environments::insert(&state.db, body.name.trim(), &body.vars)
        .await
        .map_err(map_db_err)?;
    Ok((StatusCode::CREATED, Json(to_response(row))))
}

pub async fn list(
    State(state): State<AppState>,
) -> Result<Json<EnvironmentListResponse>, ApiError> {
    let rows = environments::list(&state.db).await?;
    let environments = rows
        .into_iter()
        .map(|r| EnvironmentSummary {
            id: r.id,
            name: r.name,
            var_count: r.vars.len(),
            created_at: r.created_at,
            updated_at: r.updated_at,
        })
        .collect();
    Ok(Json(EnvironmentListResponse { environments }))
}

pub async fn get(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<EnvironmentResponse>, ApiError> {
    let row = environments::get(&state.db, &id)
        .await?
        .ok_or(ApiError::NotFound)?;
    Ok(Json(to_response(row)))
}

pub async fn update(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(body): Json<EnvironmentBody>,
) -> Result<Json<EnvironmentResponse>, ApiError> {
    validate_env(&body.name, &body.vars)?;
    let row = environments::update(&state.db, &id, body.name.trim(), &body.vars)
        .await
        .map_err(map_db_err)?
        .ok_or(ApiError::NotFound)?;
    Ok(Json(to_response(row)))
}

pub async fn delete(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<StatusCode, ApiError> {
    environments::delete(&state.db, &id).await?;
    Ok(StatusCode::NO_CONTENT)
}
```

- [ ] **Step 4: Register the module**

In `crates/controller/src/api/mod.rs`, add after `pub mod datasets;` (line 1):

```rust
pub mod datasets;
pub mod environments;
```

- [ ] **Step 5: Wire the routes**

In `crates/controller/src/app.rs`, extend the import list (lines 8-10) — note: the alias goes in **`app.rs`**, the `pub mod` went in `api/mod.rs` (Step 4):

```rust
use crate::api::{
    datasets as datasets_api, environments as environments_api, presets as presets_api,
    runs as runs_api, scenarios as scenarios_api,
};
```

Then add the two routes inside the `api` router (after the `/presets/{id}` route block at lines 64-69, before the closing `;` of the chain):

```rust
        .route(
            "/environments",
            post(environments_api::create).get(environments_api::list),
        )
        .route(
            "/environments/{id}",
            get(environments_api::get)
                .put(environments_api::update)
                .delete(environments_api::delete),
        );
```

(The previous route block currently ends in `;` — move that `;` to the end of the new `/environments/{id}` block.)

- [ ] **Step 6: Run the integration test + full controller suite**

Run: `cargo test -p handicap-controller --test environments_api_test`
Expected: PASS (4 tests).
Run: `cargo test -p handicap-controller`
Expected: PASS (existing suite unaffected — no shared state with existing routes).

- [ ] **Step 7: Commit**

```bash
git add crates/controller/src/api/environments.rs crates/controller/src/api/mod.rs crates/controller/src/app.rs crates/controller/tests/environments_api_test.rs
git commit -m "feat(controller): environments CRUD REST resource (B-1)"
```

---

## Task 4: UI client + React Query hooks — `api/environments.ts` + `hooks.ts`

**Files:**
- Create: `ui/src/api/environments.ts`
- Create: `ui/src/api/__tests__/environments.test.ts`
- Modify: `ui/src/api/hooks.ts:7-18` (queryKeys) + add 5 hooks + import

Write the test file first (uncommitted) so tdd-guard sees a pending test while you edit `environments.ts` and `hooks.ts`; commit everything at the end of the task.

- [ ] **Step 1: Write the failing schema/client test**

Create `ui/src/api/__tests__/environments.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  EnvironmentSchema,
  EnvironmentSummarySchema,
  listEnvironments,
  createEnvironment,
} from "../environments";

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

describe("environments schemas", () => {
  it("parses a full environment (vars present)", () => {
    const e = EnvironmentSchema.parse({
      id: "01J",
      name: "staging",
      vars: { BASE_URL: "http://s", API_KEY: "k" },
      created_at: 1,
      updated_at: 2,
    });
    expect(e.vars.BASE_URL).toBe("http://s");
  });

  it("parses a summary (var_count, no vars)", () => {
    const s = EnvironmentSummarySchema.parse({
      id: "01J",
      name: "staging",
      var_count: 2,
      created_at: 1,
      updated_at: 2,
    });
    expect(s.var_count).toBe(2);
  });
});

describe("environments client", () => {
  it("listEnvironments unwraps the {environments:[...]} envelope", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        environments: [{ id: "1", name: "s", var_count: 0, created_at: 1, updated_at: 1 }],
      }),
    );
    const out = await listEnvironments();
    expect(out).toHaveLength(1);
    expect(out[0].name).toBe("s");
  });

  it("createEnvironment surfaces the server error message on 409", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ error: "같은 이름의 환경이 이미 있습니다" }, 409),
    );
    await expect(createEnvironment({ name: "dup", vars: {} })).rejects.toThrow(/이미 있습니다/);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd ui && pnpm test environments`
Expected: FAIL — cannot resolve `../environments`.

- [ ] **Step 3: Write the client + schemas**

Create `ui/src/api/environments.ts`:

```ts
import { z } from "zod";

const BASE = "/api";

export const EnvironmentSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  var_count: z.number().int(),
  created_at: z.number().int(),
  updated_at: z.number().int(),
});
export type EnvironmentSummary = z.infer<typeof EnvironmentSummarySchema>;

// z.record(z.string(), z.string()) infers cleanly to Record<string,string> — NO
// nested .default() leak here (cf. ProfileSchema), so Environment["vars"] is usable
// directly. See ui/CLAUDE.md "Zod 중첩 .default() input 타입 누출" — N/A here. (Use the
// TWO-ARG form to match the codebase: model.ts / schemas.ts all spell it this way.)
export const EnvironmentSchema = z.object({
  id: z.string(),
  name: z.string(),
  vars: z.record(z.string(), z.string()),
  created_at: z.number().int(),
  updated_at: z.number().int(),
});
export type Environment = z.infer<typeof EnvironmentSchema>;

const EnvironmentListSchema = z.object({ environments: z.array(EnvironmentSummarySchema) });

export type EnvironmentInput = { name: string; vars: Record<string, string> };

async function errorMessage(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as unknown;
    if (body && typeof body === "object" && "error" in body && typeof body.error === "string") {
      return body.error;
    }
  } catch {
    // non-JSON body
  }
  return `HTTP ${res.status}`;
}

export async function listEnvironments(): Promise<EnvironmentSummary[]> {
  const res = await fetch(`${BASE}/environments`);
  if (!res.ok) throw new Error(await errorMessage(res));
  return EnvironmentListSchema.parse(await res.json()).environments;
}

export async function getEnvironment(id: string): Promise<Environment> {
  const res = await fetch(`${BASE}/environments/${encodeURIComponent(id)}`);
  if (!res.ok) throw new Error(await errorMessage(res));
  return EnvironmentSchema.parse(await res.json());
}

export async function createEnvironment(input: EnvironmentInput): Promise<Environment> {
  const res = await fetch(`${BASE}/environments`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error(await errorMessage(res));
  return EnvironmentSchema.parse(await res.json());
}

export async function updateEnvironment(id: string, input: EnvironmentInput): Promise<Environment> {
  const res = await fetch(`${BASE}/environments/${encodeURIComponent(id)}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error(await errorMessage(res));
  return EnvironmentSchema.parse(await res.json());
}

export async function deleteEnvironment(id: string): Promise<void> {
  const res = await fetch(`${BASE}/environments/${encodeURIComponent(id)}`, { method: "DELETE" });
  if (!res.ok) throw new Error(await errorMessage(res));
}
```

- [ ] **Step 4: Add queryKeys + hooks**

In `ui/src/api/hooks.ts`, add the import near the other client imports (after the `presets` import on line 4):

```ts
import {
  createEnvironment,
  deleteEnvironment,
  getEnvironment,
  listEnvironments,
  updateEnvironment,
  type EnvironmentInput,
} from "./environments";
```

In `queryKeys` (lines 7-18), add after `preset:` (before the closing `}`):

```ts
  environments: () => ["environments"] as const,
  environment: (id: string) => ["environments", id] as const,
```

At the end of the file (after `useDeletePreset`), add:

```ts
export function useEnvironments() {
  return useQuery({ queryKey: queryKeys.environments(), queryFn: listEnvironments });
}

export function useEnvironment(id: string | undefined) {
  return useQuery({
    queryKey: id ? queryKeys.environment(id) : ["environments", "missing"],
    queryFn: () => getEnvironment(id!),
    enabled: Boolean(id),
  });
}

export function useCreateEnvironment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: EnvironmentInput) => createEnvironment(input),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.environments() }),
  });
}

export function useUpdateEnvironment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: EnvironmentInput }) =>
      updateEnvironment(id, input),
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: queryKeys.environments() });
      qc.invalidateQueries({ queryKey: queryKeys.environment(vars.id) });
    },
  });
}

export function useDeleteEnvironment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deleteEnvironment(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.environments() }),
  });
}
```

- [ ] **Step 5: Run tests + the type gate**

Run: `cd ui && pnpm test environments && pnpm build`
Expected: tests PASS; `pnpm build` (`tsc -b`) clean.

- [ ] **Step 6: Commit**

```bash
git add ui/src/api/environments.ts ui/src/api/__tests__/environments.test.ts ui/src/api/hooks.ts
git commit -m "feat(ui): environments client + React Query hooks (B-1)"
```

---

## Task 5: UI management page — `EnvironmentsPage.tsx` + route + nav

**Files:**
- Create: `ui/src/pages/EnvironmentsPage.tsx`
- Create: `ui/src/pages/__tests__/EnvironmentsPage.test.tsx`
- Modify: `ui/src/routes.tsx` (import + route), `ui/src/components/Layout.tsx` (nav link)

The page test (uncommitted) keeps tdd-guard satisfied while you edit `routes.tsx`/`Layout.tsx` in the same task. Commit all at the end.

- [ ] **Step 1: Write the failing page test**

Create `ui/src/pages/__tests__/EnvironmentsPage.test.tsx`:

```tsx
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { EnvironmentsPage } from "../EnvironmentsPage";

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
      <MemoryRouter>
        <EnvironmentsPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("EnvironmentsPage", () => {
  it("lists environments with their var counts", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        environments: [{ id: "E1", name: "staging", var_count: 2, created_at: 1, updated_at: 1 }],
      }),
    );
    renderPage();
    expect(await screen.findByText("staging")).toBeInTheDocument();
    expect(screen.getByText("2")).toBeInTheDocument();
  });

  it("shows empty state", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ environments: [] }));
    renderPage();
    expect(await screen.findByText(/No environments yet/i)).toBeInTheDocument();
  });

  it("creates an environment", async () => {
    let posted: unknown = null;
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (String(url).endsWith("/api/environments") && (!init || init.method === "GET" || !init.method)) {
        return Promise.resolve(jsonResponse({ environments: [] }));
      }
      if (String(url).endsWith("/api/environments") && init?.method === "POST") {
        posted = JSON.parse(String(init.body));
        return Promise.resolve(
          jsonResponse({ id: "E9", name: "prod", vars: { BASE_URL: "http://p" }, created_at: 1, updated_at: 1 }, 201),
        );
      }
      return Promise.resolve(jsonResponse({}, 404));
    });
    const user = userEvent.setup();
    renderPage();
    await screen.findByText(/No environments yet/i);

    await user.click(screen.getByRole("button", { name: /new environment/i }));
    await user.type(screen.getByLabelText(/environment name/i), "prod");
    await user.type(screen.getByPlaceholderText("BASE_URL"), "BASE_URL");
    await user.type(screen.getByPlaceholderText(/value/i), "http://p");
    await user.click(screen.getByRole("button", { name: /^add$/i }));
    await user.click(screen.getByRole("button", { name: /^save$/i }));

    await waitFor(() => expect(posted).toEqual({ name: "prod", vars: { BASE_URL: "http://p" } }));
  });

  it("deletes an environment after confirm", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({ environments: [{ id: "E1", name: "staging", var_count: 0, created_at: 1, updated_at: 1 }] }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 })) // delete
      .mockResolvedValueOnce(jsonResponse({ environments: [] })); // refetch
    const user = userEvent.setup();
    renderPage();
    await screen.findByText("staging");
    await user.click(screen.getByRole("button", { name: /delete/i }));
    await waitFor(() => expect(screen.getByText(/No environments yet/i)).toBeInTheDocument());
    confirmSpy.mockRestore();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd ui && pnpm test EnvironmentsPage`
Expected: FAIL — cannot resolve `../EnvironmentsPage`.

- [ ] **Step 3: Implement the page**

Create `ui/src/pages/EnvironmentsPage.tsx`:

```tsx
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  queryKeys,
  useCreateEnvironment,
  useDeleteEnvironment,
  useEnvironments,
  useUpdateEnvironment,
} from "../api/hooks";
import { getEnvironment, type EnvironmentInput } from "../api/environments";
import { Button } from "../components/Button";

type VarRow = { key: string; value: string };
const RESERVED = new Set(["vu_id", "iter_id", "loop_index"]);

export function EnvironmentsPage() {
  const { data, isLoading, error } = useEnvironments();
  const createEnv = useCreateEnvironment();
  const updateEnv = useUpdateEnvironment();
  const deleteEnv = useDeleteEnvironment();
  const qc = useQueryClient();

  const [mode, setMode] = useState<"none" | "new" | "edit">("none");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [rows, setRows] = useState<VarRow[]>([]);
  const [newKey, setNewKey] = useState("");
  const [newValue, setNewValue] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  // Delete errors surface here (outside the form), since the form is hidden when
  // mode === "none" — mirrors DatasetsPage's `delError` banner.
  const [delError, setDelError] = useState<string | null>(null);

  function startNew() {
    setMode("new");
    setEditingId(null);
    setName("");
    setRows([]);
    setNewKey("");
    setNewValue("");
    setFormError(null);
  }

  // Imperative load on Edit (mirrors RunDialog.loadPreset) — avoids a reseed-effect race.
  async function startEdit(id: string) {
    setFormError(null);
    try {
      const env = await qc.fetchQuery({
        queryKey: queryKeys.environment(id),
        queryFn: () => getEnvironment(id),
      });
      setMode("edit");
      setEditingId(id);
      setName(env.name);
      setRows(Object.entries(env.vars).map(([key, value]) => ({ key, value })));
      setNewKey("");
      setNewValue("");
    } catch (e) {
      setFormError((e as Error).message);
    }
  }

  function buildInput(): EnvironmentInput | null {
    const trimmed = name.trim();
    if (!trimmed) {
      setFormError("이름을 입력하세요");
      return null;
    }
    const vars: Record<string, string> = {};
    for (const { key, value } of rows) {
      const k = key.trim();
      if (k) vars[k] = value;
    }
    return { name: trimmed, vars };
  }

  function save() {
    const input = buildInput();
    if (!input) return;
    setFormError(null);
    const done = { onSuccess: () => setMode("none"), onError: (e: Error) => setFormError(e.message) };
    if (mode === "edit" && editingId) {
      updateEnv.mutate({ id: editingId, input }, done);
    } else {
      createEnv.mutate(input, done);
    }
  }

  function handleDelete(id: string) {
    setDelError(null);
    if (!window.confirm("이 환경을 삭제할까요? (저장된 run/preset 설정은 스냅샷이라 영향 없음)")) return;
    deleteEnv.mutate(id, { onError: (e) => setDelError((e as Error).message) });
  }

  const reservedWarn = rows
    .map((r) => r.key.trim())
    .filter((k) => RESERVED.has(k));
  const saving = createEnv.isPending || updateEnv.isPending;

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-lg font-semibold">Environments</h2>
        {mode === "none" && (
          <Button onClick={startNew}>New environment</Button>
        )}
      </div>

      {mode !== "none" && (
        <section
          aria-label="environment form"
          className="mb-8 border border-slate-200 rounded-md p-4 bg-white"
        >
          <h3 className="text-md font-semibold mb-3">
            {mode === "edit" ? "Edit environment" : "New environment"}
          </h3>
          <label className="block text-sm mb-3">
            <span className="text-slate-600">Name</span>
            <input
              aria-label="environment name"
              className="mt-1 block w-64 rounded border border-slate-300 px-2 py-1"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="staging"
            />
          </label>

          <h4 className="text-sm font-semibold text-slate-700 mb-2">Variables</h4>
          <ul className="flex flex-col gap-2">
            {rows.map((entry, idx) => (
              <li key={idx} className="flex items-center gap-2">
                <input
                  aria-label={`var key ${idx}`}
                  className="w-40 border border-slate-300 rounded px-2 py-1 text-sm font-mono"
                  value={entry.key}
                  onChange={(e) =>
                    setRows((prev) => prev.map((p, i) => (i === idx ? { ...p, key: e.target.value } : p)))
                  }
                />
                <span className="text-slate-400 text-sm">=</span>
                <input
                  aria-label={`var value ${idx}`}
                  className="flex-1 border border-slate-300 rounded px-2 py-1 text-sm"
                  value={entry.value}
                  onChange={(e) =>
                    setRows((prev) => prev.map((p, i) => (i === idx ? { ...p, value: e.target.value } : p)))
                  }
                />
                <button
                  type="button"
                  onClick={() => setRows((prev) => prev.filter((_, i) => i !== idx))}
                  aria-label={`Remove var ${entry.key || idx}`}
                  className="text-slate-500 hover:text-red-600 text-sm"
                >
                  ×
                </button>
              </li>
            ))}
            {rows.length === 0 && <li className="text-xs text-slate-400 italic">No variables</li>}
          </ul>

          <div className="flex items-center gap-2 mt-2">
            <input
              aria-label="new var key"
              className="w-40 border border-slate-300 rounded px-2 py-1 text-sm font-mono"
              placeholder="BASE_URL"
              value={newKey}
              onChange={(e) => setNewKey(e.target.value)}
            />
            <span className="text-slate-400 text-sm">=</span>
            <input
              aria-label="new var value"
              className="flex-1 border border-slate-300 rounded px-2 py-1 text-sm"
              placeholder="value (e.g. https://staging.example)"
              value={newValue}
              onChange={(e) => setNewValue(e.target.value)}
            />
            <button
              type="button"
              onClick={() => {
                const k = newKey.trim();
                if (!k) return;
                setRows((prev) => [...prev, { key: k, value: newValue }]);
                setNewKey("");
                setNewValue("");
              }}
              disabled={newKey.trim().length === 0}
              className="px-2 py-1 text-sm border border-slate-300 rounded disabled:opacity-50"
            >
              Add
            </button>
          </div>

          {reservedWarn.length > 0 && (
            <p className="mt-2 text-xs text-amber-700">
              예약된 시스템 변수명({reservedWarn.join(", ")})은 런타임에 시스템 값으로 해석되어 이 환경 값이 무시됩니다.
            </p>
          )}
          {formError && (
            <p role="alert" className="mt-2 text-sm text-red-600">
              {formError}
            </p>
          )}

          <div className="flex gap-2 mt-4">
            <Button onClick={save} disabled={saving}>
              {saving ? "Saving…" : "Save"}
            </Button>
            <Button variant="secondary" onClick={() => setMode("none")}>
              Cancel
            </Button>
          </div>
        </section>
      )}

      {delError && (
        <p role="alert" className="mb-4 text-sm text-red-600">
          삭제 실패: {delError}
        </p>
      )}

      <section aria-label="environment list">
        {isLoading && <p className="text-slate-500">Loading…</p>}
        {error && <p className="text-red-600">Failed to load: {(error as Error).message}</p>}
        {data && data.length === 0 && mode === "none" && (
          <p className="text-slate-500">No environments yet.</p>
        )}
        {data && data.length > 0 && (
          <table className="min-w-full text-sm">
            <thead className="border-b border-slate-200 text-left text-slate-600">
              <tr>
                <th className="py-2 pr-4">Name</th>
                <th className="py-2 pr-4">Variables</th>
                <th className="py-2 pr-4"></th>
              </tr>
            </thead>
            <tbody>
              {data.map((e) => (
                <tr key={e.id} className="border-b border-slate-100">
                  <td className="py-2 pr-4 font-medium">{e.name}</td>
                  <td className="py-2 pr-4">{e.var_count}</td>
                  <td className="py-2 pr-4 flex gap-2">
                    <Button variant="secondary" onClick={() => void startEdit(e.id)}>
                      Edit
                    </Button>
                    <Button variant="danger" onClick={() => handleDelete(e.id)} disabled={deleteEnv.isPending}>
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

> If `Button` doesn't support a `variant="danger"`/`"secondary"`, check `ui/src/components/Button.tsx` — DatasetsPage uses `variant="danger"` and RunDialog uses `variant="secondary"`, so both exist. Match its prop API.

- [ ] **Step 4: Register the route**

In `ui/src/routes.tsx`, add the import after the `DatasetsPage` import (line 8):

```tsx
import { EnvironmentsPage } from "./pages/EnvironmentsPage";
```

And the route after the `datasets` route (line 20):

```tsx
      { path: "environments", element: <EnvironmentsPage /> },
```

- [ ] **Step 5: Add the nav link**

In `ui/src/components/Layout.tsx`, add after the Datasets `<Link>` (lines 15-17):

```tsx
            <Link to="/environments" className="hover:text-slate-900">
              Environments
            </Link>
```

- [ ] **Step 6: Run tests + type gate**

Run: `cd ui && pnpm test EnvironmentsPage && pnpm build`
Expected: tests PASS; `pnpm build` clean.

- [ ] **Step 7: Run the full UI suite** (catch any cross-file regression — `tsc -b` checks the whole project)

Run: `cd ui && pnpm test && pnpm build`
Expected: all PASS.

- [ ] **Step 8: Commit**

```bash
git add ui/src/pages/EnvironmentsPage.tsx ui/src/pages/__tests__/EnvironmentsPage.test.tsx ui/src/routes.tsx ui/src/components/Layout.tsx
git commit -m "feat(ui): Environments management page + route + nav (B-1)"
```

---

## Task 6: ADR-0025

**Files:**
- Create: `docs/adr/0025-environments-resource.md`

This is a docs file → `.md`-only commit skips cargo/UI gates (fast). Still keep it accurate.

- [ ] **Step 1: Write the ADR**

Create `docs/adr/0025-environments-resource.md` (MADR format), recording the decision: environments = env-namespace-only, top-level (cross-scenario) reusable resource, server-generated ULID, UNIQUE(name)→409, **no FK / no delete-guard** (the run-time overlay is snapshot-based, B-2), validation only on CRUD endpoints. Reference: spec `docs/superpowers/specs/2026-05-31-global-variables-environments-design.md`, ADR-0013 (scenario↔run config split), ADR-0014 (`${ENV}` namespace), ADR-0024 (run presets — the scenario-scoped sibling). Note the B-1/B-2 split and that the client-merge overlay keeps `POST /api/runs` unchanged.

Use this skeleton:

```markdown
# 0025. 환경(Environments): env-namespace 전용 top-level 재사용 리소스 + 클라이언트 오버레이 스냅샷

* Status: Accepted
* Date: 2026-05-31
* 관련: ADR-0013, ADR-0014, ADR-0011, ADR-0024

## Context
RunDialog의 env 입력창에 BASE_URL·인증 호스트·API 키를 run마다 손으로 다시 입력해야 한다.
영역 A(run 프리셋)는 한 시나리오 내 재사용을 풀었지만, 시나리오를 가로지르는 env 재사용은 미해결.

## Decision
- 스코프 = `${ENV}` 네임스페이스만. `{{var}}` 흐름변수는 범위 밖(별도 slice).
- 모델 = named environments: top-level 독립 리소스(`environments`, migration 0006/0007).
  scenario_id/FK 없음. 서버 생성 ULID, UNIQUE(name)→409.
- 오버레이(B-2) = 클라이언트 병합 + 스냅샷: 선택 환경=base, RunDialog env 입력=override(우선).
  RunDialog가 클라에서 병합해 기존 평탄 `env` 맵으로 제출 → `POST /api/runs` 무변경.
  run/preset은 해석값 스냅샷 저장 → 환경 수정/삭제가 과거 run/preset에 영향 없음.
- 참조 가드 불필요(스냅샷이라 environment_id 참조 없음) → DELETE 무가드.
- 검증은 environments CRUD에서만(이름 non-empty+UNIQUE, var 키 `${KEY}` 사용가능).

## Consequences
- presets/datasets 리소스의 near-verbatim 미러라 백엔드 위험 낮음.
- 환경 삭제가 자유로움(과거 설정 불변) — 의도된 동작.
- 후속: 민감값 마스킹, `{{var}}` 전역 등록, 시나리오 에디터 환경 선택 test-run(§7) — 모두 별도 slice.
- B-1(리소스+관리 UI)과 B-2(RunDialog 오버레이)로 분할 출하.
```

- [ ] **Step 2: Commit**

```bash
git add docs/adr/0025-environments-resource.md
git commit -m "docs(adr): 0025 environments resource (B-1)"
```

---

## Task 7: Docs — status lines, gotchas, roadmap, memory

**Files:**
- Modify: root `CLAUDE.md` (status line, "알아둘 결정들" add ADR-0025, 함정 인덱스 unchanged)
- Modify: `crates/controller/CLAUDE.md` (one gotcha line if any emerged)
- Modify: `ui/CLAUDE.md` (one gotcha line if any emerged)
- Modify: `docs/roadmap.md` (§A6/영역 B status → B-1 done, B-2 next)
- Modify: the spec status line (`docs/superpowers/specs/2026-05-31-global-variables-environments-design.md:3` Draft → B-1 구현 완료)
- Modify: `~/.claude/.../memory/MEMORY.md` + `memory/global-variables-area-b.md`

- [ ] **Step 1: Update root CLAUDE.md**

Add a one-line status note (alongside the other slice statuses) summarizing B-1: "영역 B-1(환경 리소스+관리 UI) 구현·머지 완료. 다음 = B-2(RunDialog 환경 오버레이)." Add `- **0025** 환경 = env-namespace 전용 top-level 재사용 리소스 + 클라 오버레이 스냅샷` to the "알아둘 결정들" list.

- [ ] **Step 2: Update domain CLAUDE.md gotchas (only real ones)**

If a footgun actually bit you, record it. Likely candidates: controller — "environments는 top-level, FK/delete-guard 없음 (presets와 대비) — 스냅샷 오버레이라 참조 없음"; ui — "environments.ts `z.record(z.string())`는 nested .default() 누출 없음 (presets와 달리 standalone Input 타입 불필요)". Skip if nothing non-obvious arose.

- [ ] **Step 3: Update roadmap + spec status + memory**

Roadmap §A6: mark B-1 done, B-2 next. Spec line 3: Draft → "구현: B-1 완료 / B-2 예정". Update `MEMORY.md` index line for `global-variables-area-b.md` and the memory file body to reflect B-1 merged + B-2 next + which migration number was actually used.

- [ ] **Step 4: Guard against conflict markers (md-only fast-path skips all gates)**

Run: `grep -rn '^<<<<<<<\|^>>>>>>>' **/*.md` (from repo root)
Expected: no output.

- [ ] **Step 5: Commit**

```bash
git add CLAUDE.md crates/controller/CLAUDE.md ui/CLAUDE.md docs/roadmap.md docs/superpowers/specs/2026-05-31-global-variables-environments-design.md
git commit -m "docs: record Area B-1 (environments resource) status + gotchas"
```

(Memory files live outside the repo — write them with the Write tool, not committed to git.)

---

## Finishing B-1 (merge to master) — handles the 9d migration collision

1. **Run the full gates** in the worktree:
   - `cargo test -p handicap-controller` (and `cargo build --workspace` + `cargo clippy --workspace --all-targets -- -D warnings`)
   - `cd ui && pnpm test && pnpm build`
2. **Rebase onto latest master** (repo git topology — no remote, local ff-only merge):
   ```bash
   git fetch  # no-op (no remote) — instead just rebase onto local master
   git rebase master   # from inside the worktree branch
   ```
3. **⚠️ If 9d merged into master during your session, the migration number now collides** (both 9d's `run_if_metrics` and your `environments` may claim the same `000N`). Renumber yours to `(highest on master) + 1`:
   ```bash
   git mv crates/controller/src/store/migrations/0006_environments.sql \
          crates/controller/src/store/migrations/0007_environments.sql
   # then in store/mod.rs: rename const MIGRATION_SQL_0006 → 0007 and its include_str! path,
   # and the matching .execute(MIGRATION_SQL_0007) line.
   cargo test -p handicap-controller --lib store::
   git add -A && git commit --amend --no-edit   # or a fresh "fix: renumber migration" commit
   ```
   **Zero data risk:** `environments` and `run_if_metrics` are disjoint tables, both `CREATE TABLE IF NOT EXISTS`. The number is a pure ordering label.
4. **Re-run gates** after the rebase (the rebase may have pulled in 9d's `store/mod.rs`/`metrics.rs` changes — confirm `cargo test -p handicap-controller` is green).
5. **ff-merge** to master: `git checkout master && git merge --ff-only <branch>`. Then `grep -rn '^<<<<<<<\|^>>>>>>>' **/*.md`.
6. **Clean up the worktree** with `ExitWorktree(discard_changes: true)` *after* confirming the merge landed (commits are already on master).

---

## Self-review checklist (run before declaring B-1 complete)

- **Spec coverage:** §2 (migration 0006) → Task 1; §2 store module → Task 2; §3 REST table (POST/GET list/GET id/PUT/DELETE) + 409 + routing-in-app.rs-not-mod.rs → Task 3; §4 management page (environments.ts + hooks + page + routes + nav, both registration sites) → Tasks 4-5; §5 validation (name+key rules, reserved-name soft warning, validation only on CRUD) → Task 3 `validate_env` + Task 5 reservedWarn; §6 tests (store roundtrip+UNIQUE, API integration, schema round-trip, page CRUD) → Tasks 2/3/4/5; ADR → Task 6. **`POST /api/runs` and RunDialog untouched (B-2)** ✅.
- **Migration number:** Task 1 Step 1 derives it from disk; Finishing §3 renumbers if 9d collided.
- **Type consistency:** `EnvironmentInput` ({name, vars}) used identically in client (Task 4) and page (Task 5); `EnvironmentSummary` (var_count, no vars) vs `Environment` (vars) split matches the Rust `EnvironmentSummary`/`EnvironmentResponse` DTOs (Task 3).
- **Placeholder scan:** no "TBD"/"add validation"/"similar to" — all code is inline.
