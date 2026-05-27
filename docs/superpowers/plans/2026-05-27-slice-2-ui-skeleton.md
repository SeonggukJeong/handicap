# Slice 2 — UI Skeleton + Controller Static Serving Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up a minimal React/TypeScript SPA that exercises the existing Slice 1 backend end-to-end: list/create/edit scenarios (YAML textarea only — canvas + Monaco are Slice 3), trigger a run, and watch a single run's status + raw metrics summary update via 1-second polling. Controller serves the built SPA as static files. No charts (Slice 5), no canvas (Slice 3), no multi-step (Slice 4).

**Architecture:** Add a `ui/` Vite + React 18 + TypeScript workspace next to the Rust crates. UI talks to the controller over fetch + `@tanstack/react-query` for caching/polling. Controller's existing REST endpoints move under the `/api` prefix (forced by SPA path collision: e.g. `/scenarios/:id` is both an SPA route and was a REST route in Slice 1). Controller gains a `--ui-dir <path>` flag that mounts `tower_http::services::ServeDir` as the fallback service, with SPA HTML fallback for unknown paths so client-side routing works on hard refresh. Controller also gains three small REST additions needed by the UI: `PUT /api/scenarios/{id}`, `GET /api/scenarios` (list), `GET /api/scenarios/{id}/runs` (list runs per scenario).

**Offline-runtime constraint (locked):** The UI must render and operate fully with **no network access beyond same-origin `/api/*`** — this is an internal-corp-network tool ([ADR-0001](../../adr/0001-primary-user-internal-qa.md)) and must work in air-gapped staging. Concretely:
- No CDN-loaded fonts, icons, CSS, or scripts. System font stack only (Tailwind's defaults — `ui-sans-serif, system-ui, ...`).
- No telemetry, analytics, error reporters that phone home.
- A `Content-Security-Policy` meta tag in `index.html` restricts `default-src` to `'self'`, so any accidental future regression (a `<link>` to fonts.googleapis.com, a `fetch()` to a third party) fails loud in the browser console rather than silently degrading offline.
- Build-time + install-time network access is fine (pnpm install, Vite build). The constraint is **runtime**: after `pnpm build` produces `dist/`, the resulting site must work with the network panel set to "Offline" beyond `/api`.

**Slice 3 hand-off note (locked):** The YAML textarea editor in this slice is intentionally throwaway — Slice 3 replaces it with a React Flow canvas + Monaco YAML pane wired through Zustand + Zod + the `yaml` package's Document API ([ADR-0015](../../adr/0015-bidirectional-sync-impl.md)). Do not invest in textarea UX polish.

**Tech Stack (UI):** Node 20+, pnpm 9+, Vite 5, React 18, TypeScript 5 strict, Tailwind CSS 3, react-router 6, @tanstack/react-query 5, zod 3, vitest 1 (no React Testing Library this slice — testable units are pure: schemas + API client). Prettier + ESLint (flat config, eslint 9). Tailwind only for styling; add a component library dependency later if needed — write components so swapping a primitive (e.g. `<Button>`) does not require touching pages.

**Tech Stack (backend additions):** `tower-http` gains the `fs` feature for `ServeDir` + `ServeFile`. No new crates; only stdlib + existing deps for the three REST endpoint additions.

**Slice 2 scope (locked):**

| In | Out (deferred slice) |
|---|---|
| Vite + React + TS + Tailwind workspace under `ui/` | shadcn/ui, Mantine, design system (later if needed) |
| `/` scenario list, `/scenarios/new`, `/scenarios/:id` (YAML textarea edit) | React Flow canvas, Monaco editor, bidirectional sync (Slice 3) |
| `/scenarios/:id/runs` list + `RunDialog` modal to create a run | Multi-worker run, abort run, run profiles (Slice 4 / later) |
| `/runs/:id` polling status + raw window count table | Charts, percentile graphs, HTML report (Slice 5) |
| Controller serves SPA from `--ui-dir` with SPA fallback | Embed assets in binary via `rust-embed` (Slice 6 / K8s) |
| Move API endpoints under `/api/...` | Versioned API paths beyond `/api/` (e.g. `/api/v1`) — defer |
| `PUT /api/scenarios/{id}` with optimistic-lock check on `version` | Concurrent edit conflict UX (just surface 409 as alert this slice) |
| `GET /api/scenarios`, `GET /api/scenarios/{id}/runs` | Pagination, filtering, search (later) |
| Vitest unit tests for zod schemas + API client | RTL component tests (Slice 3 once canvas/sync logic is testable) |
| End-to-end Rust test that boots controller against a fixture `ui/dist` + asserts SPA + API both served correctly | Playwright e2e against real browser (later) |
| CI runs `pnpm install --frozen-lockfile && pnpm lint && pnpm test && pnpm build` | E2E in CI driving a real browser |
| Strict same-origin runtime: CSP meta tag, no web fonts, no CDN assets | Offline service worker / PWA install (defer if ever needed) |

**Prerequisites:**
- All Slice 1 prerequisites still required.
- Node.js ≥ 20 (`brew install node@20` or `nvm install 20`). Verify: `node --version`.
- pnpm ≥ 9 (`npm install -g pnpm`). Verify: `pnpm --version`.

---

## File structure (Slice 2 — only new/modified)

```
Cargo.toml                                       # workspace deps: tower-http += "fs"
Justfile                                         # + ui-install, ui-dev, ui-build, ui-test, dev (combined)
README.md                                        # + UI quickstart
.gitignore                                       # + ui/node_modules, ui/dist
.github/workflows/ci.yml                         # + node setup + ui pipeline
CLAUDE.md                                        # status → "Slice 2 complete"

crates/controller/Cargo.toml                     # + reqwest dev-dep already present
crates/controller/src/app.rs                     # /api nesting + ServeDir fallback when ui_dir is Some
crates/controller/src/main.rs                    # --ui-dir flag plumbing
crates/controller/src/api/scenarios.rs           # + list, update handlers
crates/controller/src/api/runs.rs                # + list_for_scenario handler (under scenarios route)
crates/controller/src/store/scenarios.rs         # + list, update with version check
crates/controller/src/store/runs.rs              # + list_by_scenario
crates/controller/src/error.rs                   # + Conflict variant for PUT version mismatch
crates/controller/tests/api_test.rs              # paths → /api/, + tests for list/update/list-by-scenario
crates/controller/tests/e2e_test.rs              # paths → /api/, build worker binary into target/debug as before
crates/controller/tests/static_test.rs           # new — SPA fallback + asset serving + API still works

ui/.gitignore
ui/package.json
ui/pnpm-workspace.yaml                           # (single-package, but committed for clarity)
ui/vite.config.ts
ui/tsconfig.json
ui/tsconfig.node.json
ui/tailwind.config.ts
ui/postcss.config.cjs
ui/eslint.config.js
ui/.prettierrc.json
ui/index.html
ui/src/main.tsx
ui/src/App.tsx
ui/src/index.css
ui/src/routes.tsx
ui/src/api/client.ts
ui/src/api/schemas.ts
ui/src/api/hooks.ts
ui/src/components/Layout.tsx
ui/src/components/Button.tsx
ui/src/components/StatusBadge.tsx
ui/src/components/RunDialog.tsx
ui/src/pages/ScenarioListPage.tsx
ui/src/pages/ScenarioNewPage.tsx
ui/src/pages/ScenarioEditPage.tsx
ui/src/pages/ScenarioRunsPage.tsx
ui/src/pages/RunDetailPage.tsx
ui/src/__tests__/schemas.test.ts
ui/src/__tests__/client.test.ts
ui/vitest.config.ts
```

**Conventions:**
- All API paths under `/api`. UI dev server proxies `/api` → `http://127.0.0.1:8080` (controller).
- All component props typed; React function components named `function Foo(...)`, not `const Foo = (...)`.
- One Tailwind utility class chain per element — break to multiple lines if more than ~6 classes.
- No emoji, no decorative comments. JSDoc only where the *why* is non-obvious.
- React Query: queries cached by `["scenarios"]`, `["scenarios", id]`, `["runs", id]`, `["runs", id, "metrics"]`, `["scenarios", id, "runs"]`. Polling only on the run detail page when `status ∈ {pending, running}`.

---

## Task 1: Workspace dep + backend API path refactor to `/api`

**Files:**
- Modify: `Cargo.toml` (workspace tower-http features)
- Modify: `crates/controller/src/app.rs`
- Modify: `crates/controller/tests/api_test.rs`
- Modify: `crates/controller/tests/e2e_test.rs`

Slice 1 mounted REST handlers at `/scenarios` and `/runs`. The SPA we are about to build owns `/scenarios/:id` as a client-side route, so the API must move under `/api`. Do this first, in isolation, so the tree compiles + tests pass before any UI shows up.

- [ ] **Step 1: Add `fs` feature to workspace `tower-http`**

Edit `Cargo.toml`:

```toml
tower-http = { version = "0.6", features = ["trace", "cors", "fs"] }
```

- [ ] **Step 2: Update `crates/controller/src/app.rs` — nest API under `/api`**

Replace the body of `router()` so that all four existing routes plus `/health` live under `/api`:

```rust
use std::net::SocketAddr;

use axum::routing::{get, post};
use axum::Router;

use crate::api::{runs as runs_api, scenarios as scenarios_api};
use crate::grpc::coordinator::CoordinatorState;
use crate::store::Db;

#[derive(Clone)]
pub struct AppState {
    pub db: Db,
    pub coord: CoordinatorState,
    pub worker_bin: String,
    pub grpc_addr: SocketAddr,
}

pub fn router(state: AppState) -> Router {
    let api = Router::new()
        .route("/health", get(|| async { "ok" }))
        .route("/scenarios", post(scenarios_api::create))
        .route("/scenarios/{id}", get(scenarios_api::get))
        .route("/runs", post(runs_api::create))
        .route("/runs/{id}", get(runs_api::get))
        .route("/runs/{id}/metrics", get(runs_api::metrics));

    Router::new().nest("/api", api).with_state(state)
}
```

(`with_state` is applied to the outer router; `nest` preserves state propagation for axum 0.8.)

- [ ] **Step 3: Update `crates/controller/tests/api_test.rs` — prefix all URIs with `/api`**

Every `.uri("/scenarios")` becomes `.uri("/api/scenarios")`, every `.uri("/runs")` becomes `.uri("/api/runs")`, and `format!("/scenarios/{id}")` becomes `format!("/api/scenarios/{id}")`. No other logic changes.

- [ ] **Step 4: Update `crates/controller/tests/e2e_test.rs` — prefix all URLs with `/api`**

In the existing e2e (Slice 1, Task 18) replace:
- `format!("{}/scenarios", rest_base)` → `format!("{}/api/scenarios", rest_base)`
- `format!("{}/runs", rest_base)` → `format!("{}/api/runs", rest_base)`
- `format!("{}/runs/{}", rest_base, run_id)` → `format!("{}/api/runs/{}", rest_base, run_id)`
- `format!("{}/runs/{}/metrics", rest_base, run_id)` → `format!("{}/api/runs/{}/metrics", rest_base, run_id)`

- [ ] **Step 5: Run tests**

```bash
cargo test -p handicap-controller
```

Expected: existing 4 api tests + e2e test pass.

- [ ] **Step 6: Commit**

```bash
git add Cargo.toml crates/controller
git commit -m "refactor(controller): move REST under /api prefix (clears SPA path collision)"
```

---

## Task 2: Backend additions — scenario list + update; runs-per-scenario list

**Files:**
- Modify: `crates/controller/src/error.rs`
- Modify: `crates/controller/src/store/scenarios.rs`
- Modify: `crates/controller/src/store/runs.rs`
- Modify: `crates/controller/src/api/scenarios.rs`
- Modify: `crates/controller/src/api/runs.rs`
- Modify: `crates/controller/src/app.rs`
- Modify: `crates/controller/tests/api_test.rs` (add coverage)

We add three endpoints the UI needs:

| Method | Path | Body | Returns |
|---|---|---|---|
| `GET` | `/api/scenarios` | — | `{"scenarios": [ScenarioResponse, ...]}` newest first |
| `PUT` | `/api/scenarios/{id}` | `{ "yaml": "...", "version": N }` | 200 `ScenarioResponse` w/ version N+1, or 409 if `version` stale |
| `GET` | `/api/scenarios/{id}/runs` | — | `{"runs": [RunResponse, ...]}` newest first |

`version` is the optimistic lock from Slice 1's schema (`scenarios.version INTEGER NOT NULL`). PUT increments it; mismatch → `409 Conflict`.

- [ ] **Step 1: Add `Conflict` to `ApiError` in `crates/controller/src/error.rs`**

Insert a new variant + map it to HTTP 409. Final file:

```rust
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde_json::json;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum ApiError {
    #[error("not found")]
    NotFound,
    #[error("conflict: {0}")]
    Conflict(String),
    #[error("bad request: {0}")]
    BadRequest(String),
    #[error("db: {0}")]
    Db(#[from] sqlx::Error),
    #[error("scenario: {0}")]
    Scenario(#[from] handicap_engine::EngineError),
    #[error("internal: {0}")]
    Internal(#[from] anyhow::Error),
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let (status, msg) = match &self {
            ApiError::NotFound => (StatusCode::NOT_FOUND, "not found".to_string()),
            ApiError::Conflict(m) => (StatusCode::CONFLICT, m.clone()),
            ApiError::BadRequest(m) => (StatusCode::BAD_REQUEST, m.clone()),
            ApiError::Scenario(e) => (StatusCode::BAD_REQUEST, e.to_string()),
            ApiError::Db(e) => (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
            ApiError::Internal(e) => (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
        };
        (status, Json(json!({ "error": msg }))).into_response()
    }
}
```

- [ ] **Step 2: Extend `crates/controller/src/store/scenarios.rs` with `list` + `update`**

Append (do not replace existing code) these two functions and bring `Row` into scope:

```rust
use sqlx::Row;

pub async fn list(db: &Db) -> sqlx::Result<Vec<ScenarioRow>> {
    let rows = sqlx::query(
        "SELECT id,name,yaml,created_at,updated_at,version FROM scenarios \
         ORDER BY updated_at DESC",
    )
    .fetch_all(db)
    .await?;
    Ok(rows
        .into_iter()
        .map(|r| ScenarioRow {
            id: r.get("id"),
            name: r.get("name"),
            yaml: r.get("yaml"),
            created_at: r.get("created_at"),
            updated_at: r.get("updated_at"),
            version: r.get("version"),
        })
        .collect())
}

pub enum UpdateOutcome {
    Updated(ScenarioRow),
    NotFound,
    VersionMismatch { current: i64 },
}

pub async fn update(
    db: &Db,
    id: &str,
    new_name: &str,
    new_yaml: &str,
    expected_version: i64,
) -> sqlx::Result<UpdateOutcome> {
    let mut tx = db.begin().await?;
    let row = sqlx::query("SELECT version FROM scenarios WHERE id = ?")
        .bind(id)
        .fetch_optional(&mut *tx)
        .await?;
    let Some(r) = row else {
        tx.commit().await?;
        return Ok(UpdateOutcome::NotFound);
    };
    let current: i64 = r.get("version");
    if current != expected_version {
        tx.commit().await?;
        return Ok(UpdateOutcome::VersionMismatch { current });
    }
    let now = now_ms();
    let new_version = current + 1;
    sqlx::query(
        "UPDATE scenarios SET name = ?, yaml = ?, updated_at = ?, version = ? \
         WHERE id = ?",
    )
    .bind(new_name)
    .bind(new_yaml)
    .bind(now)
    .bind(new_version)
    .bind(id)
    .execute(&mut *tx)
    .await?;
    let created_at: i64 = sqlx::query("SELECT created_at FROM scenarios WHERE id = ?")
        .bind(id)
        .fetch_one(&mut *tx)
        .await?
        .get("created_at");
    tx.commit().await?;
    Ok(UpdateOutcome::Updated(ScenarioRow {
        id: id.to_string(),
        name: new_name.to_string(),
        yaml: new_yaml.to_string(),
        created_at,
        updated_at: now,
        version: new_version,
    }))
}
```

- [ ] **Step 3: Extend `crates/controller/src/store/runs.rs` with `list_by_scenario`**

Append:

```rust
pub async fn list_by_scenario(db: &Db, scenario_id: &str) -> sqlx::Result<Vec<RunRow>> {
    let rows = sqlx::query(
        "SELECT id,scenario_id,scenario_yaml,profile_json,env_json,status,started_at,ended_at,created_at \
         FROM runs WHERE scenario_id = ? ORDER BY created_at DESC",
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
        let status = RunStatus::parse(r.get::<String, _>("status").as_str())
            .unwrap_or(RunStatus::Failed);
        out.push(RunRow {
            id: r.get("id"),
            scenario_id: r.get("scenario_id"),
            scenario_yaml: r.get("scenario_yaml"),
            profile,
            env,
            status,
            started_at: r.get("started_at"),
            ended_at: r.get("ended_at"),
            created_at: r.get("created_at"),
        });
    }
    Ok(out)
}
```

- [ ] **Step 4: Extend `crates/controller/src/api/scenarios.rs` with `list` + `update`**

Append two handlers + a list response wrapper:

```rust
use serde::Serialize;

#[derive(Debug, Serialize)]
pub struct ScenarioListResponse {
    pub scenarios: Vec<ScenarioResponse>,
}

#[derive(Debug, serde::Deserialize)]
pub struct UpdateRequest {
    pub yaml: String,
    pub version: i64,
}

pub async fn list(
    State(state): State<AppState>,
) -> Result<Json<ScenarioListResponse>, ApiError> {
    let rows = scenarios::list(&state.db).await?;
    Ok(Json(ScenarioListResponse {
        scenarios: rows
            .into_iter()
            .map(|r| ScenarioResponse {
                id: r.id,
                name: r.name,
                yaml: r.yaml,
                version: r.version,
                created_at: r.created_at,
                updated_at: r.updated_at,
            })
            .collect(),
    }))
}

pub async fn update(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(body): Json<UpdateRequest>,
) -> Result<Json<ScenarioResponse>, ApiError> {
    let parsed = Scenario::from_yaml(&body.yaml)?;
    let outcome = scenarios::update(&state.db, &id, &parsed.name, &body.yaml, body.version).await?;
    match outcome {
        scenarios::UpdateOutcome::Updated(row) => Ok(Json(ScenarioResponse {
            id: row.id,
            name: row.name,
            yaml: row.yaml,
            version: row.version,
            created_at: row.created_at,
            updated_at: row.updated_at,
        })),
        scenarios::UpdateOutcome::NotFound => Err(ApiError::NotFound),
        scenarios::UpdateOutcome::VersionMismatch { current } => Err(ApiError::Conflict(format!(
            "stale version: client sent {}, current is {}",
            body.version, current
        ))),
    }
}
```

Make sure `scenarios::UpdateOutcome` is imported (already in scope via `use crate::store::scenarios;`).

- [ ] **Step 5: Extend `crates/controller/src/api/runs.rs` with `list_for_scenario`**

Append:

```rust
#[derive(Debug, serde::Serialize)]
pub struct RunListResponse {
    pub runs: Vec<RunResponse>,
}

pub async fn list_for_scenario(
    State(state): State<AppState>,
    Path(scenario_id): Path<String>,
) -> Result<Json<RunListResponse>, ApiError> {
    // 404 if scenario doesn't exist (so the UI distinguishes empty from missing).
    let _ = scenarios::get(&state.db, &scenario_id)
        .await?
        .ok_or(ApiError::NotFound)?;
    let rows = runs::list_by_scenario(&state.db, &scenario_id).await?;
    Ok(Json(RunListResponse {
        runs: rows.into_iter().map(to_response).collect(),
    }))
}
```

`to_response` already exists in this file.

- [ ] **Step 6: Wire the new routes in `crates/controller/src/app.rs`**

Update the api Router builder to include three new routes (use axum 0.8 method-routing `.put`/`.get`):

```rust
let api = Router::new()
    .route("/health", get(|| async { "ok" }))
    .route("/scenarios", post(scenarios_api::create).get(scenarios_api::list))
    .route(
        "/scenarios/{id}",
        get(scenarios_api::get).put(scenarios_api::update),
    )
    .route("/scenarios/{id}/runs", get(runs_api::list_for_scenario))
    .route("/runs", post(runs_api::create))
    .route("/runs/{id}", get(runs_api::get))
    .route("/runs/{id}/metrics", get(runs_api::metrics));
```

- [ ] **Step 7: Add tests to `crates/controller/tests/api_test.rs`**

Append three tests after the existing ones:

```rust
#[tokio::test]
async fn list_scenarios_returns_what_was_created() {
    let db = store::connect("sqlite::memory:").await.unwrap();
    let coord = handicap_controller::grpc::coordinator::CoordinatorState::new(db.clone());
    let app = app::router(app::AppState {
        db,
        coord,
        worker_bin: "/nonexistent".to_string(),
        grpc_addr: "127.0.0.1:0".parse().unwrap(),
    });

    // empty initially
    let req = Request::builder()
        .method(Method::GET)
        .uri("/api/scenarios")
        .body(Body::empty())
        .unwrap();
    let resp = app.clone().oneshot(req).await.unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX).await.unwrap();
    let v: Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(v["scenarios"].as_array().unwrap().len(), 0);

    // create one
    let body = json!({
        "yaml": "version: 1\nname: t\nsteps:\n  - id: a\n    name: a\n    type: http\n    request:\n      method: GET\n      url: http://x\n"
    });
    let req = Request::builder()
        .method(Method::POST)
        .uri("/api/scenarios")
        .header("content-type", "application/json")
        .body(Body::from(body.to_string()))
        .unwrap();
    let resp = app.clone().oneshot(req).await.unwrap();
    assert_eq!(resp.status(), StatusCode::CREATED);

    // list now has one
    let req = Request::builder()
        .method(Method::GET)
        .uri("/api/scenarios")
        .body(Body::empty())
        .unwrap();
    let resp = app.clone().oneshot(req).await.unwrap();
    let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX).await.unwrap();
    let v: Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(v["scenarios"].as_array().unwrap().len(), 1);
}

#[tokio::test]
async fn update_scenario_bumps_version_and_rejects_stale() {
    let db = store::connect("sqlite::memory:").await.unwrap();
    let coord = handicap_controller::grpc::coordinator::CoordinatorState::new(db.clone());
    let app = app::router(app::AppState {
        db,
        coord,
        worker_bin: "/nonexistent".to_string(),
        grpc_addr: "127.0.0.1:0".parse().unwrap(),
    });

    let create_body = json!({
        "yaml": "version: 1\nname: t1\nsteps:\n  - id: a\n    name: a\n    type: http\n    request:\n      method: GET\n      url: http://x\n"
    });
    let req = Request::builder()
        .method(Method::POST)
        .uri("/api/scenarios")
        .header("content-type", "application/json")
        .body(Body::from(create_body.to_string()))
        .unwrap();
    let resp = app.clone().oneshot(req).await.unwrap();
    let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX).await.unwrap();
    let v: Value = serde_json::from_slice(&bytes).unwrap();
    let id = v["id"].as_str().unwrap().to_string();
    assert_eq!(v["version"], 1);

    // happy update
    let put_body = json!({
        "yaml": "version: 1\nname: t2\nsteps:\n  - id: a\n    name: a\n    type: http\n    request:\n      method: GET\n      url: http://x\n",
        "version": 1
    });
    let req = Request::builder()
        .method(Method::PUT)
        .uri(format!("/api/scenarios/{id}"))
        .header("content-type", "application/json")
        .body(Body::from(put_body.to_string()))
        .unwrap();
    let resp = app.clone().oneshot(req).await.unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX).await.unwrap();
    let v: Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(v["version"], 2);
    assert_eq!(v["name"], "t2");

    // stale PUT
    let stale = json!({ "yaml": v["yaml"], "version": 1 });
    let req = Request::builder()
        .method(Method::PUT)
        .uri(format!("/api/scenarios/{id}"))
        .header("content-type", "application/json")
        .body(Body::from(stale.to_string()))
        .unwrap();
    let resp = app.oneshot(req).await.unwrap();
    assert_eq!(resp.status(), StatusCode::CONFLICT);
}

#[tokio::test]
async fn list_runs_by_scenario() {
    let db = store::connect("sqlite::memory:").await.unwrap();
    let coord = handicap_controller::grpc::coordinator::CoordinatorState::new(db.clone());
    let app = app::router(app::AppState {
        db,
        coord,
        worker_bin: "/nonexistent".to_string(),
        grpc_addr: "127.0.0.1:0".parse().unwrap(),
    });

    let create_body = json!({
        "yaml": "version: 1\nname: rs\nsteps:\n  - id: a\n    name: a\n    type: http\n    request:\n      method: GET\n      url: http://x\n"
    });
    let req = Request::builder()
        .method(Method::POST)
        .uri("/api/scenarios")
        .header("content-type", "application/json")
        .body(Body::from(create_body.to_string()))
        .unwrap();
    let resp = app.clone().oneshot(req).await.unwrap();
    let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX).await.unwrap();
    let v: Value = serde_json::from_slice(&bytes).unwrap();
    let scenario_id = v["id"].as_str().unwrap().to_string();

    // 0 runs initially
    let req = Request::builder()
        .method(Method::GET)
        .uri(format!("/api/scenarios/{scenario_id}/runs"))
        .body(Body::empty())
        .unwrap();
    let resp = app.clone().oneshot(req).await.unwrap();
    let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX).await.unwrap();
    let v: Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(v["runs"].as_array().unwrap().len(), 0);

    // create a run (it'll fail to spawn — worker bin is bogus — but the row exists)
    let req = Request::builder()
        .method(Method::POST)
        .uri("/api/runs")
        .header("content-type", "application/json")
        .body(Body::from(
            json!({
                "scenario_id": scenario_id,
                "profile": { "vus": 1, "duration_seconds": 1 },
                "env": {}
            })
            .to_string(),
        ))
        .unwrap();
    let resp = app.clone().oneshot(req).await.unwrap();
    assert_eq!(resp.status(), StatusCode::CREATED);

    // now 1 run
    let req = Request::builder()
        .method(Method::GET)
        .uri(format!("/api/scenarios/{scenario_id}/runs"))
        .body(Body::empty())
        .unwrap();
    let resp = app.oneshot(req).await.unwrap();
    let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX).await.unwrap();
    let v: Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(v["runs"].as_array().unwrap().len(), 1);
}
```

- [ ] **Step 8: Run tests**

```bash
cargo test -p handicap-controller
```

Expected: all previously-passing tests plus the three new ones (8 controller tests total).

- [ ] **Step 9: Commit**

```bash
git add crates/controller
git commit -m "feat(controller): list scenarios, PUT scenario w/ version check, list runs per scenario"
```

---

## Task 3: Backend — static UI serving via `--ui-dir`

**Files:**
- Modify: `crates/controller/src/app.rs`
- Modify: `crates/controller/src/main.rs`
- Create: `crates/controller/tests/static_test.rs`

When `--ui-dir <path>` is provided, the controller serves files from that directory as the axum fallback service, with SPA fallback: any path that doesn't resolve to a real file falls back to `index.html` so React Router's client-side routing survives a hard refresh on `/scenarios/abc`.

When the flag is omitted, no fallback is mounted (404 on non-API paths) — preserves current behavior for tests + CI.

- [ ] **Step 1: Update `crates/controller/src/app.rs` — accept optional ui_dir + mount ServeDir**

Adjust `AppState` and `router()`:

```rust
use std::net::SocketAddr;
use std::path::PathBuf;

use axum::routing::{get, post};
use axum::Router;
use tower_http::services::{ServeDir, ServeFile};

use crate::api::{runs as runs_api, scenarios as scenarios_api};
use crate::grpc::coordinator::CoordinatorState;
use crate::store::Db;

#[derive(Clone)]
pub struct AppState {
    pub db: Db,
    pub coord: CoordinatorState,
    pub worker_bin: String,
    pub grpc_addr: SocketAddr,
    pub ui_dir: Option<PathBuf>,
}

pub fn router(state: AppState) -> Router {
    let api = Router::new()
        .route("/health", get(|| async { "ok" }))
        .route("/scenarios", post(scenarios_api::create).get(scenarios_api::list))
        .route(
            "/scenarios/{id}",
            get(scenarios_api::get).put(scenarios_api::update),
        )
        .route("/scenarios/{id}/runs", get(runs_api::list_for_scenario))
        .route("/runs", post(runs_api::create))
        .route("/runs/{id}", get(runs_api::get))
        .route("/runs/{id}/metrics", get(runs_api::metrics));

    let mut app = Router::new().nest("/api", api);

    if let Some(dir) = &state.ui_dir {
        let index = dir.join("index.html");
        let serve = ServeDir::new(dir).not_found_service(ServeFile::new(index));
        app = app.fallback_service(serve);
    }

    app.with_state(state)
}
```

Note: `ServeDir` with no fallback returns 404 for missing files; `not_found_service(ServeFile::new(index_path))` makes SPA routes resolve to `index.html`. `ServeDir`'s default `append_index_html_on_directories` (true) already maps `/` → `index.html`, so a request to `/` works for free.

- [ ] **Step 2: Update `crates/controller/src/main.rs` — add `--ui-dir` flag**

```rust
use std::net::SocketAddr;
use std::path::PathBuf;

use anyhow::Context;
use clap::Parser;
use handicap_controller::grpc::coordinator::{CoordinatorService, CoordinatorState};
use handicap_controller::{app, store};
use handicap_proto::v1::coordinator_server::CoordinatorServer;
use tokio::net::TcpListener;
use tracing::info;
use tracing_subscriber::EnvFilter;

#[derive(Debug, Parser)]
struct Args {
    #[arg(long, default_value = "./handicap.db")]
    db: String,
    #[arg(long, default_value = "127.0.0.1:8080")]
    rest: SocketAddr,
    #[arg(long, default_value = "127.0.0.1:8081")]
    grpc: SocketAddr,
    #[arg(long, default_value = "target/debug/worker")]
    worker_bin: String,
    /// Directory of built UI assets (e.g. ui/dist). If omitted, no static SPA is served.
    #[arg(long)]
    ui_dir: Option<PathBuf>,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")))
        .init();
    let args = Args::parse();
    info!(?args, "controller starting");

    if let Some(d) = &args.ui_dir {
        if !d.exists() {
            anyhow::bail!("--ui-dir {:?} does not exist", d);
        }
        if !d.join("index.html").exists() {
            anyhow::bail!("--ui-dir {:?} has no index.html", d);
        }
    }

    let db_url = store::url_from_path(&args.db);
    let db = store::connect(&db_url).await?;
    let coord_state = CoordinatorState::new(db.clone());

    let state = app::AppState {
        db: db.clone(),
        coord: coord_state.clone(),
        worker_bin: args.worker_bin.clone(),
        grpc_addr: args.grpc,
        ui_dir: args.ui_dir.clone(),
    };
    let app_router = app::router(state);

    let rest_listener = TcpListener::bind(args.rest).await.context("bind REST")?;
    info!(addr = %args.rest, "REST listening");

    let grpc_svc = CoordinatorServer::new(CoordinatorService { state: coord_state });

    let rest_fut = async {
        axum::serve(rest_listener, app_router).await.context("serve REST")
    };
    let grpc_fut = async {
        info!(addr = %args.grpc, "gRPC listening");
        tonic::transport::Server::builder()
            .add_service(grpc_svc)
            .serve(args.grpc)
            .await
            .context("serve gRPC")
    };

    tokio::try_join!(rest_fut, grpc_fut)?;
    Ok(())
}
```

- [ ] **Step 3: Update every existing `AppState` literal in tests**

Add `ui_dir: None` to **every** `app::AppState { ... }` literal — there is one per test in `crates/controller/tests/api_test.rs` (6 sites after Task 2's additions: 3 from Slice 1, 3 added in Task 2) and one in `crates/controller/tests/e2e_test.rs`. Change each from `app::AppState { db, coord, worker_bin: ..., grpc_addr: ... }` to `app::AppState { db, coord, worker_bin: ..., grpc_addr: ..., ui_dir: None }`. Task 14 will later flip the e2e site to `Some(...)`.

- [ ] **Step 4: Write `crates/controller/tests/static_test.rs`**

```rust
use std::path::PathBuf;

use axum::body::Body;
use axum::http::{Method, Request, StatusCode};
use handicap_controller::{app, store};
use tower::ServiceExt;

fn write_fixture(tmp: &std::path::Path) {
    std::fs::create_dir_all(tmp.join("assets")).unwrap();
    std::fs::write(
        tmp.join("index.html"),
        "<!doctype html><html><head><title>Handicap</title></head><body><div id=\"root\"></div></body></html>",
    )
    .unwrap();
    std::fs::write(tmp.join("assets/main.js"), "console.log('ok')").unwrap();
}

async fn build_state(ui_dir: Option<PathBuf>) -> app::AppState {
    let db = store::connect("sqlite::memory:").await.unwrap();
    let coord = handicap_controller::grpc::coordinator::CoordinatorState::new(db.clone());
    app::AppState {
        db,
        coord,
        worker_bin: "/nonexistent".to_string(),
        grpc_addr: "127.0.0.1:0".parse().unwrap(),
        ui_dir,
    }
}

#[tokio::test]
async fn serves_index_at_root() {
    let tmp = tempfile::tempdir().unwrap();
    write_fixture(tmp.path());
    let state = build_state(Some(tmp.path().to_path_buf())).await;
    let app = app::router(state);

    let req = Request::builder().method(Method::GET).uri("/").body(Body::empty()).unwrap();
    let resp = app.oneshot(req).await.unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let body = axum::body::to_bytes(resp.into_body(), usize::MAX).await.unwrap();
    assert!(
        String::from_utf8_lossy(&body).contains("Handicap"),
        "index.html should be served at /"
    );
}

#[tokio::test]
async fn serves_static_asset() {
    let tmp = tempfile::tempdir().unwrap();
    write_fixture(tmp.path());
    let state = build_state(Some(tmp.path().to_path_buf())).await;
    let app = app::router(state);

    let req = Request::builder()
        .method(Method::GET)
        .uri("/assets/main.js")
        .body(Body::empty())
        .unwrap();
    let resp = app.oneshot(req).await.unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let body = axum::body::to_bytes(resp.into_body(), usize::MAX).await.unwrap();
    assert_eq!(&body[..], b"console.log('ok')");
}

#[tokio::test]
async fn unknown_path_falls_back_to_index() {
    let tmp = tempfile::tempdir().unwrap();
    write_fixture(tmp.path());
    let state = build_state(Some(tmp.path().to_path_buf())).await;
    let app = app::router(state);

    let req = Request::builder()
        .method(Method::GET)
        .uri("/scenarios/01ABC")
        .body(Body::empty())
        .unwrap();
    let resp = app.oneshot(req).await.unwrap();
    assert_eq!(resp.status(), StatusCode::OK, "SPA fallback should serve index.html");
    let body = axum::body::to_bytes(resp.into_body(), usize::MAX).await.unwrap();
    assert!(String::from_utf8_lossy(&body).contains("<div id=\"root\">"));
}

#[tokio::test]
async fn api_still_works_with_ui_dir_set() {
    let tmp = tempfile::tempdir().unwrap();
    write_fixture(tmp.path());
    let state = build_state(Some(tmp.path().to_path_buf())).await;
    let app = app::router(state);

    let req = Request::builder()
        .method(Method::GET)
        .uri("/api/health")
        .body(Body::empty())
        .unwrap();
    let resp = app.oneshot(req).await.unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
}

#[tokio::test]
async fn without_ui_dir_returns_404_on_unknown_path() {
    let state = build_state(None).await;
    let app = app::router(state);

    let req = Request::builder()
        .method(Method::GET)
        .uri("/scenarios/01ABC")
        .body(Body::empty())
        .unwrap();
    let resp = app.oneshot(req).await.unwrap();
    assert_eq!(resp.status(), StatusCode::NOT_FOUND);
}
```

- [ ] **Step 5: Add `tempfile` to controller dev-deps**

In `crates/controller/Cargo.toml`, add under `[dev-dependencies]`:

```toml
tempfile = "3"
```

(No workspace entry needed — only the controller's tests use it.)

- [ ] **Step 6: Run tests**

```bash
cargo test -p handicap-controller
```

Expected: all prior tests + 5 new static_test tests pass.

- [ ] **Step 7: Commit**

```bash
git add crates/controller Cargo.toml
git commit -m "feat(controller): serve SPA from --ui-dir with SPA fallback for client routes"
```

---

## Task 4: UI workspace skeleton — package, build tooling, lint, test runner

**Files:**
- Create: `ui/.gitignore`
- Create: `ui/package.json`
- Create: `ui/pnpm-workspace.yaml`
- Create: `ui/tsconfig.json`
- Create: `ui/tsconfig.node.json`
- Create: `ui/vite.config.ts`
- Create: `ui/vitest.config.ts`
- Create: `ui/tailwind.config.ts`
- Create: `ui/postcss.config.cjs`
- Create: `ui/eslint.config.js`
- Create: `ui/.prettierrc.json`
- Create: `ui/index.html`
- Create: `ui/src/main.tsx`
- Create: `ui/src/App.tsx`
- Create: `ui/src/index.css`
- Modify: `.gitignore` (root)

- [ ] **Step 1: Write `ui/.gitignore`**

```
node_modules/
dist/
*.log
.vite/
coverage/
```

- [ ] **Step 2: Write `ui/package.json`**

```json
{
  "name": "handicap-ui",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc -b && vite build",
    "preview": "vite preview",
    "lint": "eslint . --max-warnings=0",
    "format": "prettier --check .",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "dependencies": {
    "@tanstack/react-query": "^5.59.0",
    "react": "^18.3.1",
    "react-dom": "^18.3.1",
    "react-router-dom": "^6.27.0",
    "zod": "^3.23.8"
  },
  "devDependencies": {
    "@types/react": "^18.3.12",
    "@types/react-dom": "^18.3.1",
    "@vitejs/plugin-react": "^4.3.3",
    "autoprefixer": "^10.4.20",
    "eslint": "^9.13.0",
    "eslint-plugin-react-hooks": "^5.0.0",
    "eslint-plugin-react-refresh": "^0.4.14",
    "globals": "^15.11.0",
    "jsdom": "^25.0.1",
    "postcss": "^8.4.49",
    "prettier": "^3.3.3",
    "tailwindcss": "^3.4.14",
    "typescript": "^5.6.3",
    "typescript-eslint": "^8.12.2",
    "vite": "^5.4.10",
    "vitest": "^2.1.4"
  },
  "engines": {
    "node": ">=20",
    "pnpm": ">=9"
  }
}
```

- [ ] **Step 3: Write `ui/pnpm-workspace.yaml`** (single-package, but required for pnpm to recognize the dir as a workspace if we later add packages):

```yaml
packages:
  - .
```

- [ ] **Step 4: Write `ui/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "useDefineForClassFields": true,
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "skipLibCheck": true,
    "moduleResolution": "bundler",
    "allowImportingTsExtensions": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "noEmit": true,
    "jsx": "react-jsx",
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noFallthroughCasesInSwitch": true,
    "noUncheckedSideEffectImports": true,
    "types": ["vitest/globals"]
  },
  "include": ["src", "vitest.config.ts", "vite.config.ts"],
  "references": [{ "path": "./tsconfig.node.json" }]
}
```

- [ ] **Step 5: Write `ui/tsconfig.node.json`**

```json
{
  "compilerOptions": {
    "composite": true,
    "skipLibCheck": true,
    "module": "ESNext",
    "moduleResolution": "bundler",
    "allowSyntheticDefaultImports": true,
    "strict": true
  },
  "include": ["vite.config.ts"]
}
```

- [ ] **Step 6: Write `ui/vite.config.ts`**

```ts
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const API_TARGET = process.env.HANDICAP_API ?? "http://127.0.0.1:8080";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: API_TARGET,
        changeOrigin: false,
      },
    },
  },
  build: {
    outDir: "dist",
    sourcemap: true,
  },
});
```

- [ ] **Step 7: Write `ui/vitest.config.ts`**

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "jsdom",
    include: ["src/**/__tests__/**/*.{test,spec}.{ts,tsx}"],
  },
});
```

- [ ] **Step 8: Write `ui/tailwind.config.ts`**

Tailwind's default `font-sans` is already the OS system stack (`ui-sans-serif, system-ui, ...`) — no web fonts fetched. If a future contributor wants a custom font, it must be bundled via `@fontsource/*` (locally served), never `<link rel="stylesheet">` to a CDN. Adding a brief comment to the config makes that intent durable.

```ts
import type { Config } from "tailwindcss";

// Offline-runtime constraint: do not add font family overrides that reference
// remote URLs (e.g. Google Fonts). Bundle locally via @fontsource/* if needed.
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {},
  },
  plugins: [],
} satisfies Config;
```

- [ ] **Step 9: Write `ui/postcss.config.cjs`**

```js
module.exports = {
  plugins: {
    tailwindcss: {},
    autoprefixer: {},
  },
};
```

- [ ] **Step 10: Write `ui/eslint.config.js`**

```js
import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist", "node_modules", "coverage"] },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      ecmaVersion: 2022,
      globals: globals.browser,
    },
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "react-refresh/only-export-components": [
        "warn",
        { allowConstantExport: true },
      ],
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
    },
  },
);
```

(`@eslint/js` is brought in transitively by `typescript-eslint`. If pnpm complains it isn't a direct dep, add `"@eslint/js": "^9.13.0"` to devDependencies and re-install.)

- [ ] **Step 11: Write `ui/.prettierrc.json`**

```json
{
  "semi": true,
  "singleQuote": false,
  "trailingComma": "all",
  "printWidth": 100,
  "tabWidth": 2
}
```

- [ ] **Step 12: Write `ui/index.html`**

The `Content-Security-Policy` meta tag enforces same-origin at runtime — any accidental future fetch/link to a third party fails loud in the browser console. `style-src 'unsafe-inline'` is needed because Vite injects styles inline during dev and Tailwind utilities are compiled to a hashed CSS file (no inline `<style>` in prod, but the directive must cover the dev case too). `'self'` already covers same-origin WebSocket so Vite HMR works.

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta
      http-equiv="Content-Security-Policy"
      content="default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self';"
    />
    <title>Handicap</title>
  </head>
  <body class="bg-slate-50 text-slate-900 antialiased">
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 13: Write `ui/src/index.css`**

```css
@tailwind base;
@tailwind components;
@tailwind utilities;
```

- [ ] **Step 14: Write `ui/src/main.tsx` (minimal — App + Router come next task)**

```tsx
import React from "react";
import ReactDOM from "react-dom/client";
import "./index.css";
import { App } from "./App";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
```

- [ ] **Step 15: Write `ui/src/App.tsx` (placeholder — fleshed out in Task 5)**

```tsx
export function App() {
  return (
    <div className="p-8">
      <h1 className="text-2xl font-semibold">Handicap</h1>
      <p className="text-slate-600">UI scaffolding online.</p>
    </div>
  );
}
```

- [ ] **Step 16: Update root `.gitignore`**

Append (preserve existing lines):

```
ui/node_modules
ui/dist
ui/.vite
ui/coverage
```

- [ ] **Step 17: Install + verify build + lint pipeline**

```bash
cd ui
pnpm install
pnpm lint
pnpm build
```

Expected:
- `pnpm install` completes; `pnpm-lock.yaml` is created.
- `pnpm lint` exits 0.
- `pnpm build` writes `dist/index.html` and `dist/assets/*`.

If `pnpm lint` fails on missing `@eslint/js`: add it explicitly per the note in Step 10, re-run `pnpm install`, retry.

- [ ] **Step 18: Commit (include the lockfile)**

```bash
git add ui/ .gitignore
git commit -m "feat(ui): vite + react + ts + tailwind + eslint + vitest scaffolding"
```

The committed `pnpm-lock.yaml` is required for reproducible CI builds.

---

## Task 5: UI — base layout, routing, App shell

**Files:**
- Modify: `ui/src/App.tsx`
- Create: `ui/src/routes.tsx`
- Create: `ui/src/components/Layout.tsx`

Top-level shell: a header with a "Handicap" title that links home, and a `<main>` body where routes render.

- [ ] **Step 1: Write `ui/src/components/Layout.tsx`**

```tsx
import { Link, Outlet } from "react-router-dom";

export function Layout() {
  return (
    <div className="min-h-screen flex flex-col">
      <header className="border-b border-slate-200 bg-white">
        <div className="max-w-5xl mx-auto px-6 py-4 flex items-center justify-between">
          <Link to="/" className="text-xl font-semibold tracking-tight">
            Handicap
          </Link>
          <nav className="text-sm text-slate-600">
            <Link to="/" className="hover:text-slate-900">
              Scenarios
            </Link>
          </nav>
        </div>
      </header>
      <main className="flex-1 max-w-5xl w-full mx-auto px-6 py-8">
        <Outlet />
      </main>
    </div>
  );
}
```

- [ ] **Step 2: Write `ui/src/routes.tsx`**

```tsx
import { createBrowserRouter, RouterProvider } from "react-router-dom";
import { Layout } from "./components/Layout";
import { ScenarioListPage } from "./pages/ScenarioListPage";
import { ScenarioNewPage } from "./pages/ScenarioNewPage";
import { ScenarioEditPage } from "./pages/ScenarioEditPage";
import { ScenarioRunsPage } from "./pages/ScenarioRunsPage";
import { RunDetailPage } from "./pages/RunDetailPage";

const router = createBrowserRouter([
  {
    path: "/",
    element: <Layout />,
    children: [
      { index: true, element: <ScenarioListPage /> },
      { path: "scenarios/new", element: <ScenarioNewPage /> },
      { path: "scenarios/:id", element: <ScenarioEditPage /> },
      { path: "scenarios/:id/runs", element: <ScenarioRunsPage /> },
      { path: "runs/:id", element: <RunDetailPage /> },
    ],
  },
]);

export function AppRouter() {
  return <RouterProvider router={router} />;
}
```

- [ ] **Step 3: Update `ui/src/App.tsx`** to host the QueryClient + Router

```tsx
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AppRouter } from "./routes";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      retry: 1,
    },
  },
});

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <AppRouter />
    </QueryClientProvider>
  );
}
```

- [ ] **Step 4: Create placeholder page modules** so the build does not error

For each page file below, create with a minimal "TODO" body — they'll be filled in over Tasks 8–12. Goal of this step is to make the router compile.

`ui/src/pages/ScenarioListPage.tsx`:

```tsx
export function ScenarioListPage() {
  return <div>Scenario list (todo)</div>;
}
```

`ui/src/pages/ScenarioNewPage.tsx`:

```tsx
export function ScenarioNewPage() {
  return <div>New scenario (todo)</div>;
}
```

`ui/src/pages/ScenarioEditPage.tsx`:

```tsx
export function ScenarioEditPage() {
  return <div>Edit scenario (todo)</div>;
}
```

`ui/src/pages/ScenarioRunsPage.tsx`:

```tsx
export function ScenarioRunsPage() {
  return <div>Scenario runs (todo)</div>;
}
```

`ui/src/pages/RunDetailPage.tsx`:

```tsx
export function RunDetailPage() {
  return <div>Run detail (todo)</div>;
}
```

- [ ] **Step 5: Build to confirm**

```bash
cd ui && pnpm build
```

Expected: build succeeds. `dist/index.html` and `dist/assets/*.js`/`*.css` exist.

- [ ] **Step 6: Commit**

```bash
git add ui
git commit -m "feat(ui): layout shell + react-router routes + react-query provider"
```

---

## Task 6: UI — API client + zod schemas

**Files:**
- Create: `ui/src/api/schemas.ts`
- Create: `ui/src/api/client.ts`

Schemas mirror the Rust API responses exactly. Keep them precise — extra fields parse fine by default but missing/typed-wrong fields throw.

- [ ] **Step 1: Write `ui/src/api/schemas.ts`**

```ts
import { z } from "zod";

export const ScenarioSchema = z.object({
  id: z.string(),
  name: z.string(),
  yaml: z.string(),
  version: z.number().int(),
  created_at: z.number().int(),
  updated_at: z.number().int(),
});
export type Scenario = z.infer<typeof ScenarioSchema>;

export const ScenarioListSchema = z.object({
  scenarios: z.array(ScenarioSchema),
});

export const RunStatusEnum = z.enum([
  "pending",
  "running",
  "completed",
  "failed",
  "aborted",
]);
export type RunStatus = z.infer<typeof RunStatusEnum>;

export const ProfileSchema = z.object({
  vus: z.number().int().nonnegative(),
  ramp_up_seconds: z.number().int().nonnegative().default(0),
  duration_seconds: z.number().int().nonnegative(),
});
export type Profile = z.infer<typeof ProfileSchema>;

export const RunSchema = z.object({
  id: z.string(),
  scenario_id: z.string(),
  status: RunStatusEnum,
  profile: ProfileSchema,
  // Backend stores env as serde_json::Value (could be null, object, or anything).
  // Accept any JSON value here; the run dialog only sends objects in Slice 2.
  env: z.unknown(),
  started_at: z.number().int().nullable(),
  ended_at: z.number().int().nullable(),
  created_at: z.number().int(),
});
export type Run = z.infer<typeof RunSchema>;

export const RunListSchema = z.object({
  runs: z.array(RunSchema),
});

export const WindowSummarySchema = z.object({
  ts_second: z.number().int(),
  step_id: z.string(),
  count: z.number().int().nonnegative(),
  error_count: z.number().int().nonnegative(),
  status_counts: z.record(z.string(), z.number().int().nonnegative()),
});
export type WindowSummary = z.infer<typeof WindowSummarySchema>;

export const MetricSummarySchema = z.object({
  run_id: z.string(),
  windows: z.array(WindowSummarySchema),
});
export type MetricSummary = z.infer<typeof MetricSummarySchema>;

export const ApiErrorSchema = z.object({ error: z.string() });
```

- [ ] **Step 2: Write `ui/src/api/client.ts`**

```ts
import { z } from "zod";
import {
  ApiErrorSchema,
  MetricSummarySchema,
  RunListSchema,
  RunSchema,
  ScenarioListSchema,
  ScenarioSchema,
  type Profile,
} from "./schemas";

const BASE = "/api";

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function request<T>(
  path: string,
  init: RequestInit | undefined,
  parser: z.ZodType<T>,
): Promise<T> {
  const resp = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  const text = await resp.text();
  if (!resp.ok) {
    let msg = text;
    try {
      const parsed = ApiErrorSchema.parse(JSON.parse(text));
      msg = parsed.error;
    } catch {
      // body is not in expected error shape — fall through with raw text.
    }
    throw new ApiError(resp.status, msg || `${resp.status} ${resp.statusText}`);
  }
  if (text.length === 0) {
    // For void responses; not used in slice 2 but cheap to allow.
    return parser.parse(undefined);
  }
  const json = JSON.parse(text);
  return parser.parse(json);
}

export const api = {
  listScenarios: () => request("/scenarios", { method: "GET" }, ScenarioListSchema),
  getScenario: (id: string) =>
    request(`/scenarios/${encodeURIComponent(id)}`, { method: "GET" }, ScenarioSchema),
  createScenario: (yaml: string) =>
    request("/scenarios", { method: "POST", body: JSON.stringify({ yaml }) }, ScenarioSchema),
  updateScenario: (id: string, yaml: string, version: number) =>
    request(
      `/scenarios/${encodeURIComponent(id)}`,
      { method: "PUT", body: JSON.stringify({ yaml, version }) },
      ScenarioSchema,
    ),
  listRunsForScenario: (id: string) =>
    request(
      `/scenarios/${encodeURIComponent(id)}/runs`,
      { method: "GET" },
      RunListSchema,
    ),
  createRun: (scenario_id: string, profile: Profile, env: Record<string, unknown>) =>
    request(
      "/runs",
      { method: "POST", body: JSON.stringify({ scenario_id, profile, env }) },
      RunSchema,
    ),
  getRun: (id: string) => request(`/runs/${encodeURIComponent(id)}`, { method: "GET" }, RunSchema),
  getRunMetrics: (id: string) =>
    request(
      `/runs/${encodeURIComponent(id)}/metrics`,
      { method: "GET" },
      MetricSummarySchema,
    ),
};
```

- [ ] **Step 3: Build to confirm types**

```bash
cd ui && pnpm build
```

Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add ui/src/api
git commit -m "feat(ui): zod schemas mirroring backend + fetch-based api client"
```

---

## Task 7: UI — React Query hooks

**Files:**
- Create: `ui/src/api/hooks.ts`

One hook per endpoint; mutations invalidate the queries they affect.

- [ ] **Step 1: Write `ui/src/api/hooks.ts`**

```ts
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "./client";
import type { Profile, RunStatus } from "./schemas";

export const queryKeys = {
  scenarios: () => ["scenarios"] as const,
  scenario: (id: string) => ["scenarios", id] as const,
  scenarioRuns: (id: string) => ["scenarios", id, "runs"] as const,
  run: (id: string) => ["runs", id] as const,
  runMetrics: (id: string) => ["runs", id, "metrics"] as const,
};

export function useScenarios() {
  return useQuery({ queryKey: queryKeys.scenarios(), queryFn: api.listScenarios });
}

export function useScenario(id: string | undefined) {
  return useQuery({
    queryKey: id ? queryKeys.scenario(id) : ["scenarios", "missing"],
    queryFn: () => api.getScenario(id!),
    enabled: Boolean(id),
  });
}

export function useCreateScenario() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (yaml: string) => api.createScenario(yaml),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.scenarios() });
    },
  });
}

export function useUpdateScenario(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ yaml, version }: { yaml: string; version: number }) =>
      api.updateScenario(id, yaml, version),
    onSuccess: (updated) => {
      qc.invalidateQueries({ queryKey: queryKeys.scenarios() });
      qc.setQueryData(queryKeys.scenario(id), updated);
    },
  });
}

export function useScenarioRuns(scenarioId: string | undefined) {
  return useQuery({
    queryKey: scenarioId ? queryKeys.scenarioRuns(scenarioId) : ["scenarios", "missing", "runs"],
    queryFn: () => api.listRunsForScenario(scenarioId!),
    enabled: Boolean(scenarioId),
  });
}

export function useCreateRun() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      scenarioId,
      profile,
      env,
    }: {
      scenarioId: string;
      profile: Profile;
      env: Record<string, unknown>;
    }) => api.createRun(scenarioId, profile, env),
    onSuccess: (run) => {
      qc.invalidateQueries({ queryKey: queryKeys.scenarioRuns(run.scenario_id) });
    },
  });
}

const TERMINAL: ReadonlyArray<RunStatus> = ["completed", "failed", "aborted"];

export function useRun(id: string | undefined) {
  return useQuery({
    queryKey: id ? queryKeys.run(id) : ["runs", "missing"],
    queryFn: () => api.getRun(id!),
    enabled: Boolean(id),
    // Poll at 1s while not terminal. Returning `false` stops polling.
    refetchInterval: (q) => {
      const data = q.state.data;
      if (!data) return 1000;
      return TERMINAL.includes(data.status) ? false : 1000;
    },
  });
}

export function useRunMetrics(id: string | undefined, paused: boolean) {
  return useQuery({
    queryKey: id ? queryKeys.runMetrics(id) : ["runs", "missing", "metrics"],
    queryFn: () => api.getRunMetrics(id!),
    enabled: Boolean(id),
    // Same 1s cadence while live; once paused (terminal status) refetch once and stop.
    refetchInterval: paused ? false : 1000,
  });
}
```

- [ ] **Step 2: Build**

```bash
cd ui && pnpm build
```

Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add ui/src/api/hooks.ts
git commit -m "feat(ui): react-query hooks for scenarios + runs + polling on run status"
```

---

## Task 8: UI — `ScenarioListPage` + `Button` primitive + `StatusBadge`

**Files:**
- Create: `ui/src/components/Button.tsx`
- Create: `ui/src/components/StatusBadge.tsx`
- Modify: `ui/src/pages/ScenarioListPage.tsx`

Component library decision (per Slice 2 brainstorm): Tailwind only, but each primitive lives in its own component so a future swap (e.g. shadcn) edits one file rather than every page.

- [ ] **Step 1: Write `ui/src/components/Button.tsx`**

```tsx
import { type ButtonHTMLAttributes, type ReactNode } from "react";

type Props = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "danger";
  children: ReactNode;
};

const STYLES: Record<NonNullable<Props["variant"]>, string> = {
  primary:
    "bg-slate-900 text-white hover:bg-slate-800 disabled:bg-slate-400",
  secondary:
    "bg-white text-slate-900 border border-slate-300 hover:bg-slate-50 disabled:text-slate-400",
  danger: "bg-red-600 text-white hover:bg-red-500 disabled:bg-red-300",
};

export function Button({ variant = "primary", className, children, ...rest }: Props) {
  return (
    <button
      {...rest}
      className={[
        "inline-flex items-center justify-center rounded-md px-4 py-2 text-sm font-medium transition-colors",
        STYLES[variant],
        className ?? "",
      ].join(" ")}
    >
      {children}
    </button>
  );
}
```

- [ ] **Step 2: Write `ui/src/components/StatusBadge.tsx`**

```tsx
import type { RunStatus } from "../api/schemas";

const COLORS: Record<RunStatus, string> = {
  pending: "bg-slate-200 text-slate-700",
  running: "bg-blue-200 text-blue-900",
  completed: "bg-emerald-200 text-emerald-900",
  failed: "bg-red-200 text-red-900",
  aborted: "bg-amber-200 text-amber-900",
};

export function StatusBadge({ status }: { status: RunStatus }) {
  return (
    <span
      className={[
        "inline-block rounded px-2 py-0.5 text-xs font-medium",
        COLORS[status],
      ].join(" ")}
    >
      {status}
    </span>
  );
}
```

- [ ] **Step 3: Replace `ui/src/pages/ScenarioListPage.tsx`**

```tsx
import { Link } from "react-router-dom";
import { useScenarios } from "../api/hooks";
import { Button } from "../components/Button";

export function ScenarioListPage() {
  const { data, isLoading, error } = useScenarios();

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-xl font-semibold">Scenarios</h2>
        <Link to="/scenarios/new">
          <Button>New scenario</Button>
        </Link>
      </div>

      {isLoading && <p className="text-slate-500">Loading…</p>}
      {error && <p className="text-red-600">Failed to load: {(error as Error).message}</p>}

      {data && data.scenarios.length === 0 && (
        <p className="text-slate-500">No scenarios yet. Create one to get started.</p>
      )}

      {data && data.scenarios.length > 0 && (
        <table className="min-w-full text-sm">
          <thead className="border-b border-slate-200 text-left text-slate-600">
            <tr>
              <th className="py-2 pr-4 font-medium">Name</th>
              <th className="py-2 pr-4 font-medium">Version</th>
              <th className="py-2 pr-4 font-medium">Updated</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {data.scenarios.map((s) => (
              <tr key={s.id} className="border-b border-slate-100">
                <td className="py-3 pr-4 font-medium">
                  <Link to={`/scenarios/${s.id}`} className="hover:underline">
                    {s.name}
                  </Link>
                </td>
                <td className="py-3 pr-4 text-slate-600">v{s.version}</td>
                <td className="py-3 pr-4 text-slate-600">
                  {new Date(s.updated_at).toLocaleString()}
                </td>
                <td className="py-3 pr-4 text-right">
                  <Link to={`/scenarios/${s.id}/runs`} className="text-slate-700 hover:underline">
                    runs →
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Build**

```bash
cd ui && pnpm build
```

Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add ui
git commit -m "feat(ui): scenario list page + Button + StatusBadge primitives"
```

---

## Task 9: UI — `ScenarioNewPage` (YAML textarea)

**Files:**
- Modify: `ui/src/pages/ScenarioNewPage.tsx`

A YAML textarea, a "Create" button, and error reporting from the backend. **No client-side validation** beyond non-empty — let the backend's `Scenario::from_yaml` be the source of truth this slice.

A textarea, not a canvas. Slice 3 replaces it.

- [ ] **Step 1: Replace `ui/src/pages/ScenarioNewPage.tsx`**

```tsx
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useCreateScenario } from "../api/hooks";
import { Button } from "../components/Button";

const STARTER_YAML = `version: 1
name: "My scenario"
variables:
  base_url: "http://localhost:8080"
steps:
  - id: "home"
    name: "GET /"
    type: http
    request:
      method: GET
      url: "{{base_url}}/"
    assert:
      - status: 200
`;

export function ScenarioNewPage() {
  const [yaml, setYaml] = useState(STARTER_YAML);
  const navigate = useNavigate();
  const mutation = useCreateScenario();

  return (
    <div>
      <h2 className="text-xl font-semibold mb-4">New scenario</h2>
      <p className="text-sm text-slate-600 mb-4">
        Slice 2 ships a raw YAML editor only — the drag-and-drop canvas and Monaco editor arrive in
        Slice 3.
      </p>

      <textarea
        className="w-full h-96 font-mono text-sm border border-slate-300 rounded-md p-3 focus:outline-none focus:ring-2 focus:ring-slate-400"
        value={yaml}
        onChange={(e) => setYaml(e.target.value)}
        spellCheck={false}
      />

      {mutation.error && (
        <p className="mt-3 text-red-600">
          {(mutation.error as Error).message}
        </p>
      )}

      <div className="mt-4 flex gap-2">
        <Button
          onClick={() =>
            mutation.mutate(yaml, {
              onSuccess: (created) => navigate(`/scenarios/${created.id}`),
            })
          }
          disabled={mutation.isPending || yaml.trim().length === 0}
        >
          {mutation.isPending ? "Creating…" : "Create"}
        </Button>
        <Button variant="secondary" onClick={() => navigate("/")}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Build**

```bash
cd ui && pnpm build
```

Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add ui
git commit -m "feat(ui): new scenario page with YAML textarea (slice-3 replaces with canvas)"
```

---

## Task 10: UI — `ScenarioEditPage` (load, edit, save with version)

**Files:**
- Modify: `ui/src/pages/ScenarioEditPage.tsx`

Edit existing scenario YAML. PUT with the `version` we got from GET; surface 409 errors as an explicit message that the user must reload.

Edits the same throwaway textarea as new — Slice 3 swaps both views together.

- [ ] **Step 1: Replace `ui/src/pages/ScenarioEditPage.tsx`**

```tsx
import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useScenario, useUpdateScenario } from "../api/hooks";
import { Button } from "../components/Button";

export function ScenarioEditPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { data, isLoading, error } = useScenario(id);
  const update = useUpdateScenario(id ?? "");
  const [yaml, setYaml] = useState<string>("");
  const [loadedVersion, setLoadedVersion] = useState<number | null>(null);

  useEffect(() => {
    if (data) {
      setYaml(data.yaml);
      setLoadedVersion(data.version);
    }
  }, [data]);

  if (isLoading) return <p className="text-slate-500">Loading…</p>;
  if (error) return <p className="text-red-600">Failed: {(error as Error).message}</p>;
  if (!data) return <p className="text-slate-500">Not found.</p>;

  const dirty = data.yaml !== yaml;

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="text-xl font-semibold">{data.name}</h2>
          <p className="text-sm text-slate-600">
            v{data.version} · updated {new Date(data.updated_at).toLocaleString()}
          </p>
        </div>
        <div className="flex gap-2">
          <Link to={`/scenarios/${data.id}/runs`}>
            <Button variant="secondary">Runs</Button>
          </Link>
        </div>
      </div>

      <textarea
        className="w-full h-96 font-mono text-sm border border-slate-300 rounded-md p-3 focus:outline-none focus:ring-2 focus:ring-slate-400"
        value={yaml}
        onChange={(e) => setYaml(e.target.value)}
        spellCheck={false}
      />

      {update.error && (
        <p className="mt-3 text-red-600">
          {(update.error as Error).message}
        </p>
      )}

      <div className="mt-4 flex gap-2">
        <Button
          onClick={() =>
            loadedVersion !== null &&
            update.mutate(
              { yaml, version: loadedVersion },
              {
                onSuccess: (next) => {
                  setLoadedVersion(next.version);
                },
              },
            )
          }
          disabled={!dirty || update.isPending || loadedVersion === null}
        >
          {update.isPending ? "Saving…" : "Save"}
        </Button>
        <Button variant="secondary" onClick={() => navigate("/")}>
          Back
        </Button>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Build**

```bash
cd ui && pnpm build
```

Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add ui
git commit -m "feat(ui): edit scenario YAML with optimistic-lock version"
```

---

## Task 11: UI — `ScenarioRunsPage` + `RunDialog`

**Files:**
- Create: `ui/src/components/RunDialog.tsx`
- Modify: `ui/src/pages/ScenarioRunsPage.tsx`

Run dialog: a basic inline form (not a true modal — keeps slice 2 lightweight). VU + duration only. `ramp_up_seconds` is wired but defaults to 0 since the engine ignores it in Slice 1.

- [ ] **Step 1: Write `ui/src/components/RunDialog.tsx`**

```tsx
import { useState } from "react";
import { useCreateRun } from "../api/hooks";
import { Button } from "./Button";

type Props = {
  scenarioId: string;
  onCreated: (runId: string) => void;
  onCancel: () => void;
};

export function RunDialog({ scenarioId, onCreated, onCancel }: Props) {
  const [vus, setVus] = useState(2);
  const [duration, setDuration] = useState(5);
  const mutation = useCreateRun();

  return (
    <div className="border border-slate-200 rounded-md p-4 bg-white">
      <h3 className="text-lg font-semibold mb-3">New run</h3>
      <div className="grid grid-cols-2 gap-4 mb-3">
        <label className="block text-sm">
          <span className="text-slate-600">VUs</span>
          <input
            type="number"
            min={1}
            value={vus}
            onChange={(e) => setVus(Number(e.target.value))}
            className="mt-1 block w-full rounded border border-slate-300 px-2 py-1"
          />
        </label>
        <label className="block text-sm">
          <span className="text-slate-600">Duration (s)</span>
          <input
            type="number"
            min={1}
            value={duration}
            onChange={(e) => setDuration(Number(e.target.value))}
            className="mt-1 block w-full rounded border border-slate-300 px-2 py-1"
          />
        </label>
      </div>

      {mutation.error && (
        <p className="mb-3 text-red-600 text-sm">
          {(mutation.error as Error).message}
        </p>
      )}

      <div className="flex gap-2">
        <Button
          onClick={() =>
            mutation.mutate(
              {
                scenarioId,
                profile: { vus, duration_seconds: duration, ramp_up_seconds: 0 },
                env: {},
              },
              { onSuccess: (run) => onCreated(run.id) },
            )
          }
          disabled={mutation.isPending || vus < 1 || duration < 1}
        >
          {mutation.isPending ? "Starting…" : "Run"}
        </Button>
        <Button variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Replace `ui/src/pages/ScenarioRunsPage.tsx`**

```tsx
import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useScenario, useScenarioRuns } from "../api/hooks";
import { Button } from "../components/Button";
import { RunDialog } from "../components/RunDialog";
import { StatusBadge } from "../components/StatusBadge";

export function ScenarioRunsPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const scenario = useScenario(id);
  const runs = useScenarioRuns(id);
  const [showDialog, setShowDialog] = useState(false);

  if (scenario.isLoading) return <p className="text-slate-500">Loading…</p>;
  if (scenario.error) return <p className="text-red-600">{(scenario.error as Error).message}</p>;
  if (!scenario.data) return <p className="text-slate-500">Not found.</p>;

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="text-xl font-semibold">Runs · {scenario.data.name}</h2>
          <Link to={`/scenarios/${scenario.data.id}`} className="text-sm text-slate-600 hover:underline">
            ← Edit scenario
          </Link>
        </div>
        {!showDialog && (
          <Button onClick={() => setShowDialog(true)}>Run scenario</Button>
        )}
      </div>

      {showDialog && (
        <div className="mb-6">
          <RunDialog
            scenarioId={scenario.data.id}
            onCreated={(runId) => {
              setShowDialog(false);
              navigate(`/runs/${runId}`);
            }}
            onCancel={() => setShowDialog(false)}
          />
        </div>
      )}

      {runs.isLoading && <p className="text-slate-500">Loading runs…</p>}
      {runs.data && runs.data.runs.length === 0 && (
        <p className="text-slate-500">No runs yet.</p>
      )}
      {runs.data && runs.data.runs.length > 0 && (
        <table className="min-w-full text-sm">
          <thead className="border-b border-slate-200 text-left text-slate-600">
            <tr>
              <th className="py-2 pr-4 font-medium">Status</th>
              <th className="py-2 pr-4 font-medium">VUs</th>
              <th className="py-2 pr-4 font-medium">Duration</th>
              <th className="py-2 pr-4 font-medium">Created</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {runs.data.runs.map((r) => (
              <tr key={r.id} className="border-b border-slate-100">
                <td className="py-3 pr-4">
                  <StatusBadge status={r.status} />
                </td>
                <td className="py-3 pr-4">{r.profile.vus}</td>
                <td className="py-3 pr-4">{r.profile.duration_seconds}s</td>
                <td className="py-3 pr-4 text-slate-600">
                  {new Date(r.created_at).toLocaleString()}
                </td>
                <td className="py-3 pr-4 text-right">
                  <Link to={`/runs/${r.id}`} className="text-slate-700 hover:underline">
                    view →
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Build**

```bash
cd ui && pnpm build
```

Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add ui
git commit -m "feat(ui): scenario runs page + inline run dialog (VUs + duration)"
```

---

## Task 12: UI — `RunDetailPage` with 1s polling

**Files:**
- Modify: `ui/src/pages/RunDetailPage.tsx`

Polls `/api/runs/:id` every second while status ∈ {pending, running}; once terminal, fetches `/api/runs/:id/metrics` once and renders a flat table of (ts_second, step_id, count, error_count). No charts — Slice 5.

- [ ] **Step 1: Replace `ui/src/pages/RunDetailPage.tsx`**

```tsx
import { Link, useParams } from "react-router-dom";
import { useRun, useRunMetrics } from "../api/hooks";
import { StatusBadge } from "../components/StatusBadge";
import type { RunStatus } from "../api/schemas";

const TERMINAL: ReadonlyArray<RunStatus> = ["completed", "failed", "aborted"];

export function RunDetailPage() {
  const { id } = useParams<{ id: string }>();
  const run = useRun(id);
  const terminal = run.data ? TERMINAL.includes(run.data.status) : false;
  const metrics = useRunMetrics(id, terminal);

  if (run.isLoading) return <p className="text-slate-500">Loading…</p>;
  if (run.error) return <p className="text-red-600">{(run.error as Error).message}</p>;
  if (!run.data) return <p className="text-slate-500">Not found.</p>;

  const r = run.data;
  const totalCount = metrics.data?.windows.reduce((acc, w) => acc + w.count, 0) ?? 0;
  const totalErrors = metrics.data?.windows.reduce((acc, w) => acc + w.error_count, 0) ?? 0;
  const rps =
    r.profile.duration_seconds > 0
      ? Math.round((totalCount / r.profile.duration_seconds) * 10) / 10
      : 0;

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-xl font-semibold flex items-center gap-3">
            Run <span className="font-mono text-base text-slate-600">{r.id.slice(0, 8)}</span>
            <StatusBadge status={r.status} />
          </h2>
          <p className="text-sm text-slate-600">
            <Link to={`/scenarios/${r.scenario_id}/runs`} className="hover:underline">
              ← Scenario runs
            </Link>
          </p>
        </div>
      </div>

      <div className="grid grid-cols-4 gap-4 mb-6 text-sm">
        <Card label="VUs">{r.profile.vus}</Card>
        <Card label="Duration">{r.profile.duration_seconds}s</Card>
        <Card label="Total requests">{totalCount}</Card>
        <Card label="Errors">{totalErrors}</Card>
      </div>

      <div className="grid grid-cols-2 gap-4 mb-6 text-sm">
        <Card label="Avg RPS">{rps}</Card>
        <Card label="Created">{new Date(r.created_at).toLocaleString()}</Card>
      </div>

      <h3 className="text-lg font-semibold mb-2">Metric windows</h3>
      {!metrics.data || metrics.data.windows.length === 0 ? (
        <p className="text-slate-500 text-sm">
          {terminal ? "No metrics recorded." : "Waiting for first batch…"}
        </p>
      ) : (
        <table className="min-w-full text-sm">
          <thead className="border-b border-slate-200 text-left text-slate-600">
            <tr>
              <th className="py-2 pr-4 font-medium">Second</th>
              <th className="py-2 pr-4 font-medium">Step</th>
              <th className="py-2 pr-4 font-medium">Count</th>
              <th className="py-2 pr-4 font-medium">Errors</th>
              <th className="py-2 pr-4 font-medium">Status codes</th>
            </tr>
          </thead>
          <tbody>
            {metrics.data.windows.map((w) => (
              <tr key={`${w.ts_second}-${w.step_id}`} className="border-b border-slate-100">
                <td className="py-2 pr-4 font-mono">{w.ts_second}</td>
                <td className="py-2 pr-4">{w.step_id}</td>
                <td className="py-2 pr-4">{w.count}</td>
                <td className="py-2 pr-4">{w.error_count}</td>
                <td className="py-2 pr-4 font-mono text-xs">
                  {Object.entries(w.status_counts)
                    .map(([s, c]) => `${s}:${c}`)
                    .join(" ")}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function Card({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="border border-slate-200 rounded-md p-3 bg-white">
      <div className="text-slate-500 text-xs">{label}</div>
      <div className="text-lg font-semibold">{children}</div>
    </div>
  );
}
```

- [ ] **Step 2: Build**

```bash
cd ui && pnpm build
```

Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add ui
git commit -m "feat(ui): run detail page — 1s polling + raw metric windows table"
```

---

## Task 13: UI — unit tests (zod schemas + API client)

**Files:**
- Create: `ui/src/__tests__/schemas.test.ts`
- Create: `ui/src/__tests__/client.test.ts`

The interesting logic this slice is: schemas accept correct shapes and reject wrong ones; the client raises a typed `ApiError` on non-2xx; the client URL/method/body match per endpoint.

- [ ] **Step 1: Write `ui/src/__tests__/schemas.test.ts`**

```ts
import { describe, expect, it } from "vitest";
import {
  ApiErrorSchema,
  MetricSummarySchema,
  RunListSchema,
  RunSchema,
  ScenarioListSchema,
  ScenarioSchema,
} from "../api/schemas";

describe("ScenarioSchema", () => {
  it("parses a valid scenario", () => {
    const v = {
      id: "01HX",
      name: "n",
      yaml: "version: 1\n",
      version: 1,
      created_at: 0,
      updated_at: 0,
    };
    expect(() => ScenarioSchema.parse(v)).not.toThrow();
  });

  it("rejects missing required field", () => {
    const bad: unknown = { id: "x", name: "n", yaml: "" };
    expect(() => ScenarioSchema.parse(bad)).toThrow();
  });
});

describe("RunSchema", () => {
  it("accepts a pending run with null timestamps", () => {
    const v = {
      id: "r",
      scenario_id: "s",
      status: "pending",
      profile: { vus: 1, duration_seconds: 1, ramp_up_seconds: 0 },
      env: {},
      started_at: null,
      ended_at: null,
      created_at: 1,
    };
    expect(() => RunSchema.parse(v)).not.toThrow();
  });

  it("rejects unknown status", () => {
    const v = {
      id: "r",
      scenario_id: "s",
      status: "weird",
      profile: { vus: 1, duration_seconds: 1, ramp_up_seconds: 0 },
      env: {},
      started_at: null,
      ended_at: null,
      created_at: 1,
    };
    expect(() => RunSchema.parse(v)).toThrow();
  });
});

describe("RunListSchema", () => {
  it("parses empty runs array", () => {
    expect(() => RunListSchema.parse({ runs: [] })).not.toThrow();
  });
});

describe("ScenarioListSchema", () => {
  it("parses empty scenarios array", () => {
    expect(() => ScenarioListSchema.parse({ scenarios: [] })).not.toThrow();
  });
});

describe("MetricSummarySchema", () => {
  it("parses an empty windows list", () => {
    expect(() =>
      MetricSummarySchema.parse({ run_id: "r", windows: [] }),
    ).not.toThrow();
  });

  it("parses one window with status counts", () => {
    expect(() =>
      MetricSummarySchema.parse({
        run_id: "r",
        windows: [
          {
            ts_second: 100,
            step_id: "a",
            count: 10,
            error_count: 0,
            status_counts: { "200": 10 },
          },
        ],
      }),
    ).not.toThrow();
  });
});

describe("ApiErrorSchema", () => {
  it("parses a typical error body", () => {
    expect(ApiErrorSchema.parse({ error: "nope" }).error).toBe("nope");
  });
});
```

- [ ] **Step 2: Write `ui/src/__tests__/client.test.ts`**

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, api } from "../api/client";

type FetchMock = ReturnType<typeof vi.fn>;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

let fetchMock: FetchMock;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("api.listScenarios", () => {
  it("GETs /api/scenarios and parses the result", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ scenarios: [] }));
    const out = await api.listScenarios();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/scenarios");
    expect(init.method).toBe("GET");
    expect(out.scenarios).toEqual([]);
  });
});

describe("api.createScenario", () => {
  it("POSTs the yaml as JSON body", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        {
          id: "x",
          name: "n",
          yaml: "y",
          version: 1,
          created_at: 0,
          updated_at: 0,
        },
        201,
      ),
    );
    await api.createScenario("y");
    const [, init] = fetchMock.mock.calls[0];
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ yaml: "y" });
  });
});

describe("api.updateScenario", () => {
  it("PUTs yaml + version", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        { id: "x", name: "n", yaml: "y", version: 2, created_at: 0, updated_at: 0 },
      ),
    );
    await api.updateScenario("x", "y", 1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/scenarios/x");
    expect(init.method).toBe("PUT");
    expect(JSON.parse(init.body as string)).toEqual({ yaml: "y", version: 1 });
  });
});

describe("error handling", () => {
  it("throws ApiError with parsed message on 4xx", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: "bad yaml" }, 400));
    await expect(api.createScenario("x")).rejects.toMatchObject({
      name: "ApiError",
      status: 400,
      message: "bad yaml",
    });
  });

  it("falls back to status text on non-JSON error body", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response("kaboom", { status: 500, headers: { "content-type": "text/plain" } }),
    );
    await expect(api.getRun("x")).rejects.toBeInstanceOf(ApiError);
  });
});
```

- [ ] **Step 3: Run the tests**

```bash
cd ui && pnpm test
```

Expected: all tests pass. Vitest exits 0.

- [ ] **Step 4: Commit**

```bash
git add ui/src/__tests__
git commit -m "test(ui): vitest unit coverage for zod schemas + api client"
```

---

## Task 14: End-to-end — controller + worker + built UI

**Files:**
- Modify: `crates/controller/tests/e2e_test.rs`

Extend the Slice 1 e2e so it also writes a tiny fixture `ui/` dir (no real React app — just an index.html with a marker string), passes `ui_dir: Some(...)` to `AppState`, and asserts both the SPA fallback and the API still work alongside a real worker run.

This is intentionally not "build the real UI" — that's covered by the UI's own `pnpm build` in CI. The point is to verify the controller wiring (`/api/*` + ServeDir + SPA fallback) within the existing real-gRPC-worker test, so we know the full deployed shape works end-to-end.

- [ ] **Step 1: Extend `crates/controller/tests/e2e_test.rs`**

Add at the top of the test, before binding ports — i.e. just after `tracing_subscriber::fmt()...` and before `let target = MockServer::start()...`:

```rust
let ui_dir = tempfile::tempdir().unwrap();
std::fs::write(
    ui_dir.path().join("index.html"),
    "<!doctype html><html><body><div id=\"root\">slice2-marker</div></body></html>",
)
.unwrap();
```

Then change the `app::AppState` construction to include `ui_dir: Some(ui_dir.path().to_path_buf())`.

Add two assertions before the test ends (just before `rest_handle.abort()`):

```rust
// Bonus: SPA fallback works for unknown route.
let resp = http
    .get(format!("{}/scenarios/nope", rest_base))
    .send()
    .await
    .unwrap();
assert_eq!(resp.status(), 200);
let body = resp.text().await.unwrap();
assert!(body.contains("slice2-marker"), "SPA fallback should serve index.html");

// API still works under /api after we added ui_dir.
let resp = http.get(format!("{}/api/health", rest_base)).send().await.unwrap();
assert_eq!(resp.status(), 200);
```

`tempfile` is already a dev-dep from Task 3.

- [ ] **Step 2: Run the e2e**

```bash
cargo test -p handicap-controller --test e2e_test -- --nocapture
```

Expected: passes; new assertions land.

- [ ] **Step 3: Commit**

```bash
git add crates/controller/tests/e2e_test.rs
git commit -m "test(controller): e2e covers ui_dir SPA fallback alongside real worker run"
```

---

## Task 15: Justfile + README + CI updates

**Files:**
- Modify: `Justfile`
- Modify: `README.md`
- Modify: `.github/workflows/ci.yml`

- [ ] **Step 1: Update `Justfile`** — add UI tasks + a `dev` combo

Append these recipes (do not remove existing ones; replace the existing `run-controller` to pass `--ui-dir` only if `dist` exists):

```make
ui-install:
    cd ui && pnpm install --frozen-lockfile

ui-dev:
    cd ui && pnpm dev

ui-build:
    cd ui && pnpm build

ui-lint:
    cd ui && pnpm lint

ui-test:
    cd ui && pnpm test

# Run the controller with the UI dir set (build the UI first if needed).
run-controller-with-ui:
    @if [ ! -f ui/dist/index.html ]; then just ui-build; fi
    RUST_LOG=info,handicap=debug cargo run -p controller -- \
      --db ./handicap.db \
      --rest 127.0.0.1:8080 \
      --grpc 127.0.0.1:8081 \
      --worker-bin target/debug/worker \
      --ui-dir ui/dist
```

- [ ] **Step 2: Update `README.md`** — add a UI quickstart section underneath the existing Slice 1 quickstart

```markdown
## Slice 2 — UI quickstart

```bash
# 1. Install Node deps (only first time)
just ui-install

# 2. Build the workers + UI
cargo build -p handicap-worker
just ui-build

# 3. Run controller serving the built UI on http://127.0.0.1:8080/
just run-controller-with-ui

# 4. (Alternative) UI dev server with hot reload on :5173, proxying /api → :8080:
cargo run -p controller -- --db ./handicap.db --worker-bin target/debug/worker  # in one terminal
just ui-dev                                                                      # in another
# Browse http://127.0.0.1:5173/
```
```

- [ ] **Step 3: Update `.github/workflows/ci.yml`** — add a UI job + Node step

Replace the `ci.yml` body with:

```yaml
name: ci
on:
  push:
    branches: [main, master]
  pull_request:

jobs:
  rust:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Install protoc
        run: sudo apt-get update && sudo apt-get install -y protobuf-compiler
      - uses: dtolnay/rust-toolchain@stable
        with:
          components: rustfmt, clippy
      - uses: Swatinem/rust-cache@v2
      - name: Format check
        run: cargo fmt --all -- --check
      - name: Clippy
        run: cargo clippy --workspace --all-targets -- -D warnings
      - name: Build
        run: cargo build --workspace
      - name: Test
        run: cargo test --workspace -- --nocapture
        env:
          RUST_LOG: info

  ui:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - uses: pnpm/action-setup@v4
        with:
          version: 9
      - name: Install
        working-directory: ui
        run: pnpm install --frozen-lockfile
      - name: Lint
        working-directory: ui
        run: pnpm lint
      - name: Test
        working-directory: ui
        run: pnpm test
      - name: Build
        working-directory: ui
        run: pnpm build
```

- [ ] **Step 4: Run the local equivalent**

```bash
just lint
just test
just ui-lint
just ui-test
just ui-build
```

Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add Justfile README.md .github/workflows/ci.yml
git commit -m "ci: add UI lint/test/build job; just recipes for ui-* and controller-with-ui"
```

---

## Task 16: Manual smoke + CLAUDE.md update

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Manual smoke (don't skip)**

```bash
cargo build -p handicap-worker
just ui-build
just run-controller-with-ui
```

In a browser at `http://127.0.0.1:8080/`:
- Scenario list page shows "No scenarios yet."
- Click "New scenario" → starter YAML appears in a textarea → "Create" → redirects to edit page.
- Edit page shows the scenario, "Runs" button leads to runs page.
- Runs page → "Run scenario" → set VUs=2, Duration=3 → "Run" → routes to run detail.
- Run detail polls; within ~5s status flips to `completed`; metric windows appear.

If any step fails, fix it before continuing. Common failure modes:
- 404 on `/` → `--ui-dir` not set or `ui/dist/` empty
- 404 on `/api/scenarios` → forgot to nest under `/api` in Task 1
- "Failed to load" → check controller logs for sqlite path / worker subprocess errors

- [ ] **Step 2: Update `CLAUDE.md`** — change the status block + add Slice 2 learnings section

Replace:

```markdown
**상태: Slice 1(backend skeleton) 구현 완료.** 디자인 문서 → `docs/superpowers/specs/`. 구현 계획 → `docs/superpowers/plans/`. 결정 기록 → `docs/adr/`.

Slice 1 결과: REST API(`/scenarios`, `/runs`, `/runs/{id}/metrics`) + gRPC Coordinator(bidi stream) + SQLite store + subprocess-spawn worker가 wiremock 타겟에 대해 end-to-end 동작. UI·K8s·ramp-up·multi-step은 후속 슬라이스. 라이브 대시보드는 MVP 범위 자체에서 제외(ADR-0009 — 종료 후 HTML/JSON 리포트로 충분, 실시간은 APM 사용).
```

With:

```markdown
**상태: Slice 2(UI skeleton + 정적 서빙) 구현 완료.** 디자인 문서 → `docs/superpowers/specs/`. 구현 계획 → `docs/superpowers/plans/`. 결정 기록 → `docs/adr/`.

Slice 1 결과: REST API(`/api/scenarios`, `/api/runs`, `/api/runs/{id}/metrics`) + gRPC Coordinator(bidi stream) + SQLite store + subprocess-spawn worker가 wiremock 타겟에 대해 end-to-end 동작.

Slice 2 결과: Vite + React + TS + Tailwind UI (`ui/`). 시나리오 목록·생성·편집(YAML textarea), run 다이얼로그, run 상세(1초 폴링 + 메트릭 표). 컨트롤러가 `--ui-dir` 경로의 SPA를 정적 서빙(unknown path는 index.html로 fallback). 캔버스·Monaco·양방향 sync는 Slice 3, 차트·HTML 리포트는 Slice 5, multi-step·extract·ramp-up은 Slice 4, K8s 배포는 Slice 6.

라이브 대시보드는 MVP 범위 자체에서 제외(ADR-0009 — 종료 후 HTML/JSON 리포트로 충분, 실시간은 APM 사용).
```

Then append a new section after "Slice 1에서 배운 함정들":

```markdown
## Slice 2에서 배운 함정들

- **axum 0.8 `nest` + `with_state`**: state는 outer router에 한 번만 붙인다. 안쪽 router에 `with_state`를 두 번 붙이면 컴파일은 되지만 nested router가 state를 못 봄.
- **`ServeDir::not_found_service`**: SPA fallback의 표준 패턴. `fallback_service`로 통째로 `ServeDir`를 거는 대신 `ServeDir::new(d).not_found_service(ServeFile::new(d.join("index.html")))`로 감싸야 `/assets/foo.js` 가 정상 200, `/scenarios/abc` 가 index.html을 반환한다. `append_index_html_on_directories`(기본 true)가 `/` → `index.html` 까지는 처리해주므로 root는 따로 안 다뤄도 됨.
- **React Query v5 `refetchInterval`의 시그니처**: `(query) => number | false`. `query.state.data`로 마지막 데이터에 접근. 4.x의 `(data) => ...` 시그니처와 다르니 마이그레이션 가이드 검색 시 주의.
- **`pnpm install --frozen-lockfile` in CI**: `pnpm-lock.yaml`을 반드시 커밋해야 함. 안 하면 CI가 `ERR_PNPM_NO_LOCKFILE`로 실패.
- **`/api` 프리픽스로 옮긴 이유**: SPA가 `/scenarios/:id` 같은 client-side route를 갖기 때문에 REST 경로와 충돌. 슬라이스 1 테스트도 함께 업데이트해야 통과.
- **오프라인 런타임 제약**: 사내망/에어갭 staging에서도 UI가 떠야 한다 (ADR-0001 — 1차 사용자 사내 QA). 그래서 `index.html`에 `Content-Security-Policy` 메타 태그로 `default-src 'self'` 강제, Tailwind 기본 시스템 폰트 스택만 사용 (Google Fonts 같은 CDN 폰트 금지), 외부 아이콘·스크립트 패키지 도입 시에도 npm 번들로만. 어기면 CSP가 브라우저 콘솔에서 즉시 실패시키므로 회귀가 조용히 들어오지 않는다. 향후 폰트 커스텀 필요하면 `@fontsource/*` 같은 로컬 번들 패키지로.
```

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "docs(CLAUDE.md): slice-2 status + gotchas (axum nest+state, ServeDir SPA fallback, RQ v5)"
```

---

## Slice 2 acceptance — checklist

Before declaring Slice 2 done, every box must be true locally:

- [ ] `just build` clean
- [ ] `just lint` clean (rust fmt + clippy w/ -D warnings)
- [ ] `just test` clean — includes new controller `static_test` (5 cases), new api tests (3 cases), and updated e2e
- [ ] `just ui-lint` clean
- [ ] `just ui-test` clean (vitest)
- [ ] `just ui-build` writes `ui/dist/index.html` and `ui/dist/assets/*`
- [ ] Manual smoke (Task 16 Step 1) goes from empty scenario list → completed run with metrics, all in the browser at `http://127.0.0.1:8080/`
- [ ] **Offline check**: in the browser DevTools Network panel, set throttling to "Offline" after the SPA has loaded (first paint complete). Click around: navigation between scenario list/edit/runs pages must still render (those are client-side routes). Existing in-memory React Query data must continue to display. Only `/api/*` calls should fail (with a visible error message). Open the Network tab and confirm **zero** requests to any host other than the controller's origin during a normal session.
- [ ] `pnpm-lock.yaml` checked in
- [ ] CLAUDE.md status + learnings updated

## Hand-off to Slice 3

Slice 2 leaves the YAML textarea editor as a throwaway. Slice 3 replaces it with:
- React Flow canvas (left: variables panel, center: nodes, right: inspector form)
- Monaco editor in a "YAML" tab
- Zustand canonical store + Zod schema + `yaml` package Document API (ADR-0015)
- 300ms debounced sync from Monaco; canvas edits sync instantly
- Stable ULID per step survives reorders

Slice 4 expands the engine: multi-step + `extract` (JSONPath body / header / cookie), env var substitution `${ENV}` from run config, linear ramp-up, gRPC reconnect/backoff. The current UI's RunDialog already passes `ramp_up_seconds: 0` so adding the field is one input + one prop change.

Slice 5 builds the reports page (replaces the raw window table in RunDetailPage): time-series charts (Recharts/ECharts), per-step table, status distribution bar chart, JSON download, HTML render.

Slice 6 swaps the subprocess worker spawn for a K8s Job (kube-rs), ships the Helm chart + kind setup, and hits the performance acceptance criteria in spec §4.3.
