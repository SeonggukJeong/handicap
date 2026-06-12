# 스텝 템플릿 (저장/복사-삽입) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 에디터의 최상위 스텝 시퀀스를 이름 붙여 서버에 저장하고, 아무 시나리오에서나 복사-삽입(스냅샷, 새 ULID)하는 스텝 템플릿 기능.

**Architecture:** 컨트롤러에 `step_templates` top-level 리소스(migration 0015 + store/api, environments 미러) 추가. UI는 yamlDoc 순수 헬퍼(fragment 파싱/추출/ULID 재발급) + `insertSteps` Edit + 에디터 헤더 다이얼로그 2개(저장/삽입). **엔진(타입 재사용만)·워커·proto 무변경.**

**Tech Stack:** Rust(axum/sqlx/serde_yaml) + TS(React/Zod/`yaml` Document API/Zustand/React Query).

**Spec:** `docs/superpowers/specs/2026-06-12-step-templates-design.md` (사용자 승인 + spec-plan-reviewer 반영 완료. 본 plan과 충돌 시 spec이 권위.)

---

## 전 task 공통 (orchestrator가 subagent prompt에 박을 것)

- 첫 줄: `cd /Users/sgj/develop/handicap/.claude/worktrees/step-templates`
- **commit은 단일 FOREGROUND 호출**(`run_in_background: false`, timeout 600000ms), 파이프(`| tail` 등) 금지, 직후 `git log -1 --oneline`으로 landed 확인.
- `git add`는 **명시 경로만**(`-A` 금지).
- cargo-영향 task(T1·T2)는 커밋 전 `cargo build -p handicap-worker && cargo build --workspace`로 warm(cold-build e2e flake 예방). pre-commit이 전체 workspace 게이트를 돌리므로 **task당 1 green 커밋**(RED-only/헬퍼-only 커밋 금지).
- UI task(T3–T7)는 커밋 전 `cd ui && pnpm lint && pnpm test && pnpm build` (hook은 cargo만 — UI 게이트는 수동).
- TDD guard: 새 src 파일을 만들기 **전에** 그 task의 테스트 파일부터 디스크에 써라(자기-unblock). T1만 인라인 `#[cfg(test)]`라 keepalive 필요(Step 0 참조).

---

### Task 1: 컨트롤러 store — migration 0015 + `store/step_templates.rs`

**Files:**
- Create: `crates/controller/src/store/migrations/0015_step_templates.sql`
- Create: `crates/controller/src/store/step_templates.rs`
- Modify: `crates/controller/src/store/mod.rs` (모듈 선언 + migration const/execute)

- [ ] **Step 0: TDD guard keepalive 생성** (새 src 파일 + 인라인 테스트 조합은 guard가 pending으로 안 침)

```bash
printf '#[test]\nfn keepalive() {}\n' > crates/controller/tests/_tdd_keepalive.rs
```

- [ ] **Step 1: migration SQL 작성**

`crates/controller/src/store/migrations/0015_step_templates.sql`:

```sql
-- step_templates: 재사용 스텝 시퀀스 스냅샷 (ADR-0036).
-- steps_yaml = 시나리오 `steps:` 배열과 동일 포맷의 YAML 텍스트.
-- 복사-삽입 시맨틱이라 어디서도 참조하지 않음 → DELETE 무가드 (environments와 동일).
-- created_at/updated_at = epoch milliseconds (now_ms — UI가 new Date(ms) 가정).
CREATE TABLE IF NOT EXISTS step_templates (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL DEFAULT '',
  steps_yaml TEXT NOT NULL,
  step_count INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
```

- [ ] **Step 2: store 모듈 작성 (인라인 RED 테스트 포함)**

`crates/controller/src/store/step_templates.rs` (environments.rs 미러 — `find_by_name`은 api의 409 ConflictJson `{error,id}`용 신규):

```rust
use sqlx::Row;
use ulid::Ulid;

use super::Db;

/// One stored step template: a named, cross-scenario snapshot of a step sequence.
/// `steps_yaml` is the same YAML format as a scenario's `steps:` array. Copy-on-insert
/// semantics — nothing references a template, so DELETE is unguarded (ADR-0036).
#[derive(Debug, Clone)]
pub struct StepTemplateRow {
    pub id: String,
    pub name: String,
    pub description: String,
    pub steps_yaml: String,
    pub step_count: i64,
    pub created_at: i64,
    pub updated_at: i64,
}

fn row_from(r: sqlx::sqlite::SqliteRow) -> StepTemplateRow {
    StepTemplateRow {
        id: r.get("id"),
        name: r.get("name"),
        description: r.get("description"),
        steps_yaml: r.get("steps_yaml"),
        step_count: r.get("step_count"),
        created_at: r.get("created_at"),
        updated_at: r.get("updated_at"),
    }
}

pub async fn insert(
    db: &Db,
    name: &str,
    description: &str,
    steps_yaml: &str,
    step_count: i64,
) -> sqlx::Result<StepTemplateRow> {
    // Server-generated ULID — never trust a client id (matches environments.rs).
    let id = Ulid::new().to_string();
    let now = super::now_ms();
    sqlx::query(
        "INSERT INTO step_templates(id,name,description,steps_yaml,step_count,created_at,updated_at) \
         VALUES(?,?,?,?,?,?,?)",
    )
    .bind(&id)
    .bind(name)
    .bind(description)
    .bind(steps_yaml)
    .bind(step_count)
    .bind(now)
    .bind(now)
    .execute(db)
    .await?;
    Ok(StepTemplateRow {
        id,
        name: name.to_string(),
        description: description.to_string(),
        steps_yaml: steps_yaml.to_string(),
        step_count,
        created_at: now,
        updated_at: now,
    })
}

pub async fn get(db: &Db, id: &str) -> sqlx::Result<Option<StepTemplateRow>> {
    let row = sqlx::query(
        "SELECT id,name,description,steps_yaml,step_count,created_at,updated_at \
         FROM step_templates WHERE id = ?",
    )
    .bind(id)
    .fetch_optional(db)
    .await?;
    Ok(row.map(row_from))
}

/// Name lookup for the 409 ConflictJson body — the UI's overwrite flow needs the
/// conflicting row's id to issue a PUT (spec §4.3).
pub async fn find_by_name(db: &Db, name: &str) -> sqlx::Result<Option<StepTemplateRow>> {
    let row = sqlx::query(
        "SELECT id,name,description,steps_yaml,step_count,created_at,updated_at \
         FROM step_templates WHERE name = ?",
    )
    .bind(name)
    .fetch_optional(db)
    .await?;
    Ok(row.map(row_from))
}

pub async fn list(db: &Db) -> sqlx::Result<Vec<StepTemplateRow>> {
    let rows = sqlx::query(
        "SELECT id,name,description,steps_yaml,step_count,created_at,updated_at \
         FROM step_templates ORDER BY name",
    )
    .fetch_all(db)
    .await?;
    Ok(rows.into_iter().map(row_from).collect())
}

/// Full-body replace. Returns `None` if no template with `id` exists.
pub async fn update(
    db: &Db,
    id: &str,
    name: &str,
    description: &str,
    steps_yaml: &str,
    step_count: i64,
) -> sqlx::Result<Option<StepTemplateRow>> {
    let now = super::now_ms();
    let res = sqlx::query(
        "UPDATE step_templates SET name = ?, description = ?, steps_yaml = ?, \
         step_count = ?, updated_at = ? WHERE id = ?",
    )
    .bind(name)
    .bind(description)
    .bind(steps_yaml)
    .bind(step_count)
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
    // No guard: nothing references a template (copy-on-insert snapshot, ADR-0036).
    sqlx::query("DELETE FROM step_templates WHERE id = ?")
        .bind(id)
        .execute(db)
        .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store;

    const YAML: &str = "- id: A\n  name: x\n  type: http\n  request:\n    method: GET\n    url: /x\n";

    #[tokio::test]
    async fn insert_get_list_update_delete_roundtrip() {
        let db = store::connect("sqlite::memory:").await.unwrap();
        let row = insert(&db, "login-flow", "로그인", YAML, 1).await.unwrap();

        let got = get(&db, &row.id).await.unwrap().expect("template");
        assert_eq!(got.name, "login-flow");
        assert_eq!(got.description, "로그인");
        assert_eq!(got.steps_yaml, YAML);
        assert_eq!(got.step_count, 1);

        let listed = list(&db).await.unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].id, row.id);

        let updated = update(&db, &row.id, "login-v2", "", YAML, 1)
            .await
            .unwrap()
            .expect("updated");
        assert_eq!(updated.name, "login-v2");
        assert!(updated.updated_at >= row.updated_at);

        delete(&db, &row.id).await.unwrap();
        assert!(get(&db, &row.id).await.unwrap().is_none());
    }

    #[tokio::test]
    async fn unique_name_is_enforced() {
        let db = store::connect("sqlite::memory:").await.unwrap();
        insert(&db, "dup", "", YAML, 1).await.unwrap();
        let err = insert(&db, "dup", "", YAML, 1)
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
    async fn find_by_name_hit_and_miss() {
        let db = store::connect("sqlite::memory:").await.unwrap();
        let row = insert(&db, "exists", "", YAML, 1).await.unwrap();
        assert_eq!(
            find_by_name(&db, "exists").await.unwrap().expect("hit").id,
            row.id
        );
        assert!(find_by_name(&db, "nope").await.unwrap().is_none());
    }

    #[tokio::test]
    async fn update_missing_returns_none() {
        let db = store::connect("sqlite::memory:").await.unwrap();
        let out = update(&db, "nope", "x", "", YAML, 1).await.unwrap();
        assert!(out.is_none());
    }
}
```

- [ ] **Step 3: store/mod.rs 배선** — ⚠ const 선언 + execute 호출 **두 줄 다** (이 repo가 두 번 겪은 "execute 라인 누락" 함정)

`crates/controller/src/store/mod.rs` 세 군데:

```rust
// (1) 파일 상단 모듈 목록(알파벳 순)에 추가:
pub mod step_templates;

// (2) const 블록 끝에 추가:
const MIGRATION_SQL_0015: &str = include_str!("migrations/0015_step_templates.sql");

// (3) connect()의 마지막 migration(ensure_run_group_metrics_branch) 뒤에 추가:
    sqlx::query(MIGRATION_SQL_0015).execute(&pool).await?; // migration 0015: step_templates
```

- [ ] **Step 4: 교차검증 + RED→GREEN 확인**

```bash
grep -c "MIGRATION_SQL_0015" crates/controller/src/store/mod.rs
# Expected: 2  (const 1 + execute 1)
cargo test -p handicap-controller step_templates
# Expected: 위 인라인 테스트 4개가 passed (여러 테스트 바이너리가 돌아 "0 passed"
#           라인이 다수 섞임 — step_templates 매치 합계 4 passed / 0 failed면 OK)
```

- [ ] **Step 5: keepalive 제거 + warm build + commit**

```bash
rm crates/controller/tests/_tdd_keepalive.rs
cargo build -p handicap-worker && cargo build --workspace
git add crates/controller/src/store/migrations/0015_step_templates.sql \
        crates/controller/src/store/step_templates.rs \
        crates/controller/src/store/mod.rs
git commit -m "feat(controller): step_templates store + migration 0015 — 스텝 템플릿 리소스 (ADR-0036)"
git log -1 --oneline
```

---

### Task 2: 컨트롤러 API — `api/step_templates.rs` + 라우트

**Files:**
- Create: `crates/controller/tests/step_templates_api_test.rs` (먼저 — TDD guard 자기-unblock)
- Create: `crates/controller/src/api/step_templates.rs`
- Modify: `crates/controller/src/api/mod.rs` (`pub mod step_templates;` 추가, 알파벳 순)
- Modify: `crates/controller/src/app.rs` (import + 라우트 2줄)

- [ ] **Step 1: 통합 테스트 먼저 작성 (RED)**

`crates/controller/tests/step_templates_api_test.rs` (`environments_api_test.rs`의 `make_app`/`send` 헬퍼 미러 — 그 파일 상단 50줄을 그대로 복사해 시작):

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
        db: db.clone(),
        coord,
        dispatcher: Arc::new(SubprocessDispatcher::new(
            "/nonexistent".to_string(),
            "127.0.0.1:0".parse().unwrap(),
            db,
        )),
        ui_dir: None,
        dataset_max_rows: 1_000_000,
        scheduler_tz: chrono_tz::UTC,
    })
}

async fn send(
    app: &axum::Router,
    method: Method,
    uri: &str,
    body: Option<Value>,
) -> (StatusCode, Value) {
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
    let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX)
        .await
        .unwrap();
    let v: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
    (status, v)
}

const VALID_STEPS: &str = "- id: 01HX0000000000000000000001\n  name: Login\n  type: http\n  request:\n    method: POST\n    url: /login\n  assert:\n    - status: 200\n";

fn body(name: &str, steps_yaml: &str) -> Value {
    json!({ "name": name, "description": "d", "steps_yaml": steps_yaml })
}

#[tokio::test]
async fn template_crud_roundtrip() {
    let db = store::connect("sqlite::memory:").await.unwrap();
    let app = make_app(db);

    // create → 201 full (steps_yaml 포함)
    let (status, created) = send(
        &app,
        Method::POST,
        "/api/step-templates",
        Some(body("login-flow", VALID_STEPS)),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    assert_eq!(created["name"], "login-flow");
    assert_eq!(created["step_count"], 1);
    assert_eq!(created["steps_yaml"], VALID_STEPS);
    let id = created["id"].as_str().unwrap().to_string();

    // list → {templates: [Summary…]} (steps_yaml 없음)
    let (status, listed) = send(&app, Method::GET, "/api/step-templates", None).await;
    assert_eq!(status, StatusCode::OK);
    let templates = listed["templates"].as_array().unwrap();
    assert_eq!(templates.len(), 1);
    assert_eq!(templates[0]["id"], id.as_str());
    assert!(templates[0].get("steps_yaml").is_none(), "summary must omit steps_yaml");

    // get → full
    let (status, got) = send(&app, Method::GET, &format!("/api/step-templates/{id}"), None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(got["steps_yaml"], VALID_STEPS);

    // put → 전체 교체 (이름변경)
    let (status, updated) = send(
        &app,
        Method::PUT,
        &format!("/api/step-templates/{id}"),
        Some(body("login-v2", VALID_STEPS)),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(updated["name"], "login-v2");

    // delete → 204, get → 404
    let (status, _) = send(&app, Method::DELETE, &format!("/api/step-templates/{id}"), None).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let (status, _) = send(&app, Method::GET, &format!("/api/step-templates/{id}"), None).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn duplicate_name_is_409_conflictjson_with_id() {
    let db = store::connect("sqlite::memory:").await.unwrap();
    let app = make_app(db);
    let (_, first) = send(
        &app,
        Method::POST,
        "/api/step-templates",
        Some(body("dup", VALID_STEPS)),
    )
    .await;
    let (status, conflict) = send(
        &app,
        Method::POST,
        "/api/step-templates",
        Some(body("dup", VALID_STEPS)),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT);
    // ConflictJson 본문 = {error, id} — UI 덮어쓰기 PUT이 이 id를 쓴다 (spec §4.3)
    assert_eq!(conflict["id"], first["id"]);
    assert!(conflict["error"].as_str().unwrap().contains("이미"));
}

#[tokio::test]
async fn rename_onto_other_template_is_409_with_that_id() {
    let db = store::connect("sqlite::memory:").await.unwrap();
    let app = make_app(db);
    let (_, a) = send(&app, Method::POST, "/api/step-templates", Some(body("a", VALID_STEPS))).await;
    let (_, b) = send(&app, Method::POST, "/api/step-templates", Some(body("b", VALID_STEPS))).await;
    let b_id = b["id"].as_str().unwrap();
    let (status, conflict) = send(
        &app,
        Method::PUT,
        &format!("/api/step-templates/{b_id}"),
        Some(body("a", VALID_STEPS)),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(conflict["id"], a["id"]);
    // 자기 자신 이름 유지 PUT은 409가 아니다
    let (status, _) = send(
        &app,
        Method::PUT,
        &format!("/api/step-templates/{b_id}"),
        Some(body("b", VALID_STEPS)),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
}

#[tokio::test]
async fn invalid_steps_yaml_is_422_and_empty_is_422() {
    let db = store::connect("sqlite::memory:").await.unwrap();
    let app = make_app(db);
    // 엔진 serde 파싱 불가 (스텝이 아닌 맵)
    let (status, _) = send(
        &app,
        Method::POST,
        "/api/step-templates",
        Some(body("bad", "not: steps\n")),
    )
    .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    // 빈 배열
    let (status, _) = send(
        &app,
        Method::POST,
        "/api/step-templates",
        Some(body("empty", "[]\n")),
    )
    .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
}

#[tokio::test]
async fn empty_name_is_400_and_name_is_trimmed() {
    let db = store::connect("sqlite::memory:").await.unwrap();
    let app = make_app(db);
    let (status, _) = send(
        &app,
        Method::POST,
        "/api/step-templates",
        Some(body("   ", VALID_STEPS)),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let (_, created) = send(
        &app,
        Method::POST,
        "/api/step-templates",
        Some(body("  trimmed  ", VALID_STEPS)),
    )
    .await;
    assert_eq!(created["name"], "trimmed");
}

#[tokio::test]
async fn wild_non_ulid_step_id_is_accepted() {
    // §4.3: 서버는 스텝 id의 ULID 유효성을 안 본다 — 삽입 시 클라가 전부 재발급.
    let db = store::connect("sqlite::memory:").await.unwrap();
    let app = make_app(db);
    let wild = "- id: login-1\n  name: Login\n  type: http\n  request:\n    method: GET\n    url: /x\n";
    let (status, created) = send(
        &app,
        Method::POST,
        "/api/step-templates",
        Some(body("wild", wild)),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    assert_eq!(created["step_count"], 1);
}

#[tokio::test]
async fn missing_id_is_404() {
    let db = store::connect("sqlite::memory:").await.unwrap();
    let app = make_app(db);
    let (status, _) = send(&app, Method::GET, "/api/step-templates/nope", None).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let (status, _) = send(
        &app,
        Method::PUT,
        "/api/step-templates/nope",
        Some(body("x", VALID_STEPS)),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}
```

- [ ] **Step 2: RED 확인**

```bash
cargo test -p handicap-controller --test step_templates_api_test
# Expected: 6 failed / 1 passed — 테스트 파일은 컴파일되지만(라우터만 사용) 라우트가
#           아직 없어 404/405 assert 실패. 단 missing_id_is_404는 라우트 부재에도
#           404가 와서 RED 단계부터 통과(정상).
```

- [ ] **Step 3: API 핸들러 작성**

`crates/controller/src/api/step_templates.rs`:

```rust
use axum::Json;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::app::AppState;
use crate::error::ApiError;
use crate::store::step_templates;

#[derive(Debug, Deserialize)]
pub struct StepTemplateBody {
    pub name: String,
    #[serde(default)]
    pub description: String,
    pub steps_yaml: String,
}

#[derive(Debug, Serialize)]
pub struct StepTemplateResponse {
    pub id: String,
    pub name: String,
    pub description: String,
    pub steps_yaml: String,
    pub step_count: i64,
    pub created_at: i64,
    pub updated_at: i64,
}

/// Lightweight list row (no steps_yaml body — the insert modal list only needs these).
#[derive(Debug, Serialize)]
pub struct StepTemplateSummary {
    pub id: String,
    pub name: String,
    pub description: String,
    pub step_count: i64,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Serialize)]
pub struct StepTemplateListResponse {
    pub templates: Vec<StepTemplateSummary>,
}

fn to_response(r: step_templates::StepTemplateRow) -> StepTemplateResponse {
    StepTemplateResponse {
        id: r.id,
        name: r.name,
        description: r.description,
        steps_yaml: r.steps_yaml,
        step_count: r.step_count,
        created_at: r.created_at,
        updated_at: r.updated_at,
    }
}

const CONFLICT_MSG: &str = "같은 이름의 템플릿이 이미 있습니다";

/// 409 carrying the conflicting row's id so the UI overwrite flow can PUT it
/// (spec §4.3 — plain Conflict has no id, so the client wouldn't know the target).
fn conflict(id: &str) -> ApiError {
    ApiError::ConflictJson(json!({ "error": CONFLICT_MSG, "id": id }))
}

fn is_unique_violation(e: &sqlx::Error) -> bool {
    e.as_database_error()
        .map(|d| d.is_unique_violation())
        .unwrap_or(false)
}

fn validate_name(name: &str) -> Result<(), ApiError> {
    if name.trim().is_empty() {
        return Err(ApiError::BadRequest("이름은 비어 있을 수 없습니다".into()));
    }
    Ok(())
}

/// steps_yaml 최소 검증: 엔진 serde로 Vec<Step> 파싱 + 비어있지 않음 → step_count 반환.
/// 422 = test-run 선례(본문 구조 해석 불가). serde_yaml::Error는 ApiError From이 없으므로
/// 명시 map_err 필수 (`?`로 흘리면 다른 variant로 샌다). 스텝 id의 ULID 유효성·UI 중첩
/// 규칙은 의도적으로 안 본다 — 삽입 시 클라가 id를 전부 재발급, 엄격 검증은 UI Zod 게이트.
fn validate_steps_yaml(steps_yaml: &str) -> Result<i64, ApiError> {
    let steps: Vec<handicap_engine::Step> = serde_yaml::from_str(steps_yaml)
        .map_err(|e| ApiError::Unprocessable(format!("steps parse: {e}")))?;
    if steps.is_empty() {
        return Err(ApiError::Unprocessable(
            "스텝이 한 개 이상 필요합니다".into(),
        ));
    }
    Ok(steps.len() as i64)
}

pub async fn create(
    State(state): State<AppState>,
    Json(body): Json<StepTemplateBody>,
) -> Result<(StatusCode, Json<StepTemplateResponse>), ApiError> {
    validate_name(&body.name)?;
    let step_count = validate_steps_yaml(&body.steps_yaml)?;
    let name = body.name.trim();
    if let Some(existing) = step_templates::find_by_name(&state.db, name).await? {
        return Err(conflict(&existing.id));
    }
    let row = match step_templates::insert(&state.db, name, &body.description, &body.steps_yaml, step_count).await
    {
        Ok(r) => r,
        // pre-check와 INSERT 사이 race 백스톱 — id 재조회로 ConflictJson 유지.
        Err(e) if is_unique_violation(&e) => {
            return Err(match step_templates::find_by_name(&state.db, name).await? {
                Some(x) => conflict(&x.id),
                None => ApiError::Conflict(CONFLICT_MSG.into()),
            });
        }
        Err(e) => return Err(e.into()),
    };
    Ok((StatusCode::CREATED, Json(to_response(row))))
}

pub async fn list(
    State(state): State<AppState>,
) -> Result<Json<StepTemplateListResponse>, ApiError> {
    let rows = step_templates::list(&state.db).await?;
    let templates = rows
        .into_iter()
        .map(|r| StepTemplateSummary {
            id: r.id,
            name: r.name,
            description: r.description,
            step_count: r.step_count,
            created_at: r.created_at,
            updated_at: r.updated_at,
        })
        .collect();
    Ok(Json(StepTemplateListResponse { templates }))
}

pub async fn get(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<StepTemplateResponse>, ApiError> {
    let row = step_templates::get(&state.db, &id)
        .await?
        .ok_or(ApiError::NotFound)?;
    Ok(Json(to_response(row)))
}

pub async fn update(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(body): Json<StepTemplateBody>,
) -> Result<Json<StepTemplateResponse>, ApiError> {
    validate_name(&body.name)?;
    let step_count = validate_steps_yaml(&body.steps_yaml)?;
    let name = body.name.trim();
    if let Some(existing) = step_templates::find_by_name(&state.db, name).await? {
        if existing.id != id {
            return Err(conflict(&existing.id));
        }
    }
    let row = match step_templates::update(&state.db, &id, name, &body.description, &body.steps_yaml, step_count).await
    {
        Ok(r) => r,
        Err(e) if is_unique_violation(&e) => {
            return Err(match step_templates::find_by_name(&state.db, name).await? {
                Some(x) => conflict(&x.id),
                None => ApiError::Conflict(CONFLICT_MSG.into()),
            });
        }
        Err(e) => return Err(e.into()),
    };
    let row = row.ok_or(ApiError::NotFound)?;
    Ok(Json(to_response(row)))
}

pub async fn delete(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<StatusCode, ApiError> {
    step_templates::delete(&state.db, &id).await?;
    Ok(StatusCode::NO_CONTENT)
}
```

- [ ] **Step 4: 모듈/라우트 배선**

`crates/controller/src/api/mod.rs` — 알파벳 순 위치에:

```rust
pub mod step_templates;
```

`crates/controller/src/app.rs` — ① `use crate::api::{…}` 블록에 `step_templates as step_templates_api,` 추가, ② `/schedules` 라우트들 뒤(`/test-runs` 앞)에:

```rust
        .route(
            "/step-templates",
            post(step_templates_api::create).get(step_templates_api::list),
        )
        .route(
            "/step-templates/{id}",
            get(step_templates_api::get)
                .put(step_templates_api::update)
                .delete(step_templates_api::delete),
        )
```

- [ ] **Step 5: GREEN 확인 + warm build + commit**

```bash
cargo test -p handicap-controller --test step_templates_api_test
# Expected: 7 passed
cargo build -p handicap-worker && cargo build --workspace
git add crates/controller/tests/step_templates_api_test.rs \
        crates/controller/src/api/step_templates.rs \
        crates/controller/src/api/mod.rs \
        crates/controller/src/app.rs
git commit -m "feat(controller): /api/step-templates CRUD — 409 ConflictJson{error,id}·422 steps 검증 (ADR-0036)"
git log -1 --oneline
```

---

### Task 3: UI 순수 헬퍼 — fragment 파싱/추출/ULID 재발급 + `topAncestorIndex`

**Files:**
- Create: `ui/src/scenario/__tests__/stepTemplateHelpers.test.ts` (먼저)
- Modify: `ui/src/scenario/yamlDoc.ts` (export 4종 추가)
- Modify: `ui/src/scenario/model.ts` (`topAncestorIndex` 추가)

- [ ] **Step 1: 테스트 먼저 작성 (RED)**

`ui/src/scenario/__tests__/stepTemplateHelpers.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  extractStepsYaml,
  parseScenarioDoc,
  parseStepsFragment,
  prepareTemplateInsertion,
  reissueStepIdsInFragment,
} from "../yamlDoc";
import { parseDocument } from "yaml";
import { topAncestorIndex } from "../model";

// 26자 유효 ULID 생성기 (결정론): "01HX" + 0×19 + 3자리
let n = 0;
const genId = () => `01HX0000000000000000000${String(100 + n++)}`;

// ⚠ 주석 위치 주의(reviewer 실증, yaml 2.9): 시퀀스 *선두* 주석은 items[0]이 아니라
// seq.commentBefore에 붙어 노드 이동을 따라오지 않는다 — 주석-보존 단언은 item *사이*
// 주석(다음 item의 commentBefore)으로만 한다.
const SCENARIO = `version: 1
name: src
steps:
  - id: 01HX0000000000000000000001
    name: Login
    type: http
    request:
      method: POST
      url: /login
    assert:
      - status: 200
  - id: 01HX0000000000000000000002
    name: Me
    type: http
    request:
      method: GET
      url: /me
  # loop comment
  - id: 01HX0000000000000000000003
    name: Loop
    type: loop
    repeat: 2
    do:
      - id: 01HX0000000000000000000004
        name: Inner
        type: http
        request:
          method: GET
          url: /inner
`;

// 중첩 4타입 + 주석 + `id`라는 이름의 헤더 키(오염 가드)
const NESTED_FRAGMENT = `# tpl comment
- id: AAA
  name: L
  type: loop
  repeat: 2
  do:
    - id: BBB
      name: inner
      type: http
      request:
        method: GET
        url: /x
        headers:
          id: keep-me
- id: CCC
  name: P
  type: parallel
  branches:
    - name: b1
      steps:
        - id: DDD
          name: pb
          type: http
          request:
            method: GET
            url: /p
- id: EEE
  name: C
  type: if
  cond:
    left: "{{a}}"
    op: eq
    right: "1"
  then:
    - id: FFF
      name: t1
      type: http
      request:
        method: GET
        url: /t
  elif:
    - cond:
        left: "{{a}}"
        op: eq
        right: "2"
      then:
        - id: GGG
          name: e1
          type: http
          request:
            method: GET
            url: /e
  else:
    - id: HHH
      name: el
      type: http
      request:
        method: GET
        url: /el
`;

describe("parseStepsFragment", () => {
  it("normalize 경유로 assert/body 와이어 모양을 통과시킨다", () => {
    const yaml = `- id: 01HX0000000000000000000001
  name: Login
  type: http
  request:
    method: POST
    url: /login
    body:
      json:
        user: "{{u}}"
  assert:
    - status: 200
`;
    const r = parseStepsFragment(yaml);
    expect("steps" in r).toBe(true);
    if ("steps" in r) {
      expect(r.steps).toHaveLength(1);
      const s = r.steps[0];
      expect(s.type).toBe("http");
      if (s.type === "http") {
        expect(s.assert).toEqual([{ kind: "status", code: 200 }]);
        expect(s.request.body).toEqual({ kind: "json", value: { user: "{{u}}" } });
      }
    }
  });

  it("빈 배열·비배열·2단 중첩(loop-in-loop)을 거부한다", () => {
    expect("error" in parseStepsFragment("[]\n")).toBe(true);
    expect("error" in parseStepsFragment("not: steps\n")).toBe(true);
    const loopInLoop = `- id: 01HX0000000000000000000001
  name: L
  type: loop
  repeat: 1
  do:
    - id: 01HX0000000000000000000002
      name: L2
      type: loop
      repeat: 1
      do:
        - id: 01HX0000000000000000000003
          name: x
          type: http
          request:
            method: GET
            url: /x
`;
    expect("error" in parseStepsFragment(loopInLoop)).toBe(true);
  });
});

describe("extractStepsYaml", () => {
  it("선택 인덱스의 노드만 주석 보존하며 스텝 배열 YAML로 추출한다", () => {
    const parsed = parseScenarioDoc(SCENARIO);
    if (!("model" in parsed)) throw new Error("scenario must parse");
    const yaml = extractStepsYaml(parsed.doc, [0, 2]);
    // item-간 주석(`# loop comment`)은 Loop 노드의 commentBefore라 노드를 따라온다
    expect(yaml).toContain("# loop comment");
    expect(yaml).toContain("Login");
    expect(yaml).toContain("Loop");
    expect(yaml).not.toContain("Me");
    // round-trip: 추출 결과는 그대로 유효한 fragment
    expect("steps" in parseStepsFragment(yaml)).toBe(true);
  });
});

describe("reissueStepIdsInFragment", () => {
  it("중첩 4타입 전부 재발급·유일 + headers의 id 키 비오염 + 주석 보존", () => {
    n = 0;
    const doc = parseDocument(NESTED_FRAGMENT);
    const firstId = reissueStepIdsInFragment(doc, genId);
    const out = String(doc);
    // 원본 스텝 id 전부 소거
    for (const old of ["AAA", "BBB", "CCC", "DDD", "EEE", "FFF", "GGG", "HHH"]) {
      expect(out).not.toMatch(new RegExp(`id: ${old}\\b`));
    }
    // 8개 스텝 = 8개 신규 id, 첫 id는 첫 스텝 것
    expect(n).toBe(8);
    expect(firstId).toBe("01HX0000000000000000000100");
    // 헤더 키 id는 그대로 (구조-인지 walk)
    expect(out).toContain("id: keep-me");
    // 주석 보존
    expect(out).toContain("# tpl comment");
  });
});

describe("prepareTemplateInsertion", () => {
  it("야생 비-ULID id 템플릿이 재발급 경유로 게이트를 통과한다 (재발급-후-검증 순서)", () => {
    n = 0;
    const wild = `- id: login-1
  name: Login
  type: http
  request:
    method: GET
    url: /x
`;
    const r = prepareTemplateInsertion(wild, genId);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.firstId).toMatch(/^01HX/);
      expect(r.preparedYaml).not.toContain("login-1");
      expect(r.steps).toHaveLength(1);
    }
  });

  it("YAML 문법 오류·UI 게이트 불통은 ok:false", () => {
    expect(prepareTemplateInsertion("- id: [broken", genId).ok).toBe(false);
    // parallel-in-loop 류 UI 규칙 위반은 재발급 후에도 게이트가 거부
    const bad = `- id: x
  name: L
  type: loop
  repeat: 1
  do:
    - id: y
      name: P
      type: parallel
      branches:
        - name: b
          steps:
            - id: z
              name: s
              type: http
              request:
                method: GET
                url: /x
`;
    expect(prepareTemplateInsertion(bad, genId).ok).toBe(false);
  });
});

describe("topAncestorIndex", () => {
  it("중첩 스텝이면 최상위 조상 인덱스, 최상위면 자기 인덱스, 미발견/null이면 null", () => {
    const parsed = parseScenarioDoc(SCENARIO);
    if (!("model" in parsed)) throw new Error("scenario must parse");
    const steps = parsed.model.steps;
    expect(topAncestorIndex(steps, "01HX0000000000000000000002")).toBe(1); // 최상위
    expect(topAncestorIndex(steps, "01HX0000000000000000000004")).toBe(2); // loop 내부 → loop 인덱스
    expect(topAncestorIndex(steps, "01HX0000000000000000000999")).toBe(null);
    expect(topAncestorIndex(steps, null)).toBe(null);
  });
});
```

- [ ] **Step 2: RED 확인**

```bash
cd ui && pnpm test stepTemplateHelpers
# Expected: FAIL — parseStepsFragment 등 export 부재
```

- [ ] **Step 3: `yamlDoc.ts`에 헬퍼 4종 추가**

import 갱신 (파일 상단) — **기존 line 1의 yaml import(`parseDocument, Document, isMap, isSeq, Scalar, YAMLMap, YAMLSeq, Node`)는 그대로 유지**하고, `./model` import 줄을 아래로 교체 + zod 줄을 추가:

```ts
import { z } from "zod";
import { ScenarioModel, StepModel, type Scenario, type Step, type Condition } from "./model";
```

파일 하단(기존 normalize 함수들 *뒤*)에 추가 — `parseStepsFragment`가 module-private `normalizeStep`을 직접 쓰므로 별도 export 불필요(spec C2의 "normalize 파이프라인 export"는 이 동거 배치로 충족):

```ts
// ── 스텝 템플릿 (ADR-0036) ──────────────────────────────────────────────

export type StepsFragmentResult = { steps: Step[] } | { error: string };

/** 템플릿 steps_yaml(스텝 배열 YAML) → Zod 검증된 Step[] (strict-UI 게이트).
 *  와이어 모양 ≠ 모델 모양(assert/body) — normalizeStep 파이프라인 경유 필수:
 *  z.array(StepModel).parse(YAML.parse(...)) 직행은 assert/body 있는 모든 템플릿에서
 *  거짓 불통한다 (spec §5.2). */
export function parseStepsFragment(yamlText: string): StepsFragmentResult {
  let doc: Document.Parsed;
  try {
    doc = parseDocument(yamlText, { prettyErrors: true });
  } catch (e) {
    return { error: (e as Error).message };
  }
  if (doc.errors.length > 0) {
    return { error: doc.errors.map((e) => e.message).join("; ") };
  }
  const js = doc.toJS({ maxAliasCount: 100 });
  if (!Array.isArray(js)) return { error: "steps must be a YAML list" };
  const parsed = z.array(StepModel).min(1).safeParse(js.map(normalizeStep));
  if (!parsed.success) {
    return {
      error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
    };
  }
  return { steps: parsed.data };
}

/** 체크된 최상위 스텝 노드를 스텝 배열 YAML로 직렬화 (저장 흐름, spec §5.1).
 *  소스 doc의 노드를 새 Document에 공유시킨 뒤 즉시 직렬화-폐기하므로 안전하고,
 *  노드에 붙은 주석이 그대로 따라온다 (renameScenarioYaml과 같은 Document API 접근). */
export function extractStepsYaml(doc: Document, indices: ReadonlyArray<number>): string {
  const steps = doc.getIn(["steps"]);
  const seq = new YAMLSeq();
  if (isSeq(steps)) {
    for (const i of indices) {
      const item = steps.items[i];
      if (item !== undefined) seq.items.push(item);
    }
  }
  const frag = new Document(seq);
  return String(frag);
}

/** 삽입 직전 fragment의 모든 스텝 id를 구조-인지 walk로 재발급, 첫 스텝 id 반환.
 *  ⚠ "모든 id 키 일괄 교체" 금지 — request.headers에 `id`라는 헤더 키가 있으면
 *  오염된다. 스텝 맵의 top-level id만, 컨테이너는 do/then·elif[].then·else/
 *  branches[].steps로만 하강 (spec §5.2). 모델 객체가 아니라 노드 레벨인 이유 = 주석 보존. */
export function reissueStepIdsInFragment(doc: Document, genId: () => string): string | null {
  const root = doc.contents;
  if (!isSeq(root)) return null;
  let firstId: string | null = null;
  for (const item of root.items) {
    const id = reissueStepNode(item, genId);
    if (firstId === null) firstId = id;
  }
  return firstId;
}

function reissueStepNode(node: unknown, genId: () => string): string | null {
  if (!isMap(node)) return null;
  const id = genId();
  node.set("id", plainScalar(id));
  const type = node.get("type");
  if (type === "loop") {
    reissueSeq(node.get("do"), genId);
  } else if (type === "if") {
    reissueSeq(node.get("then"), genId);
    reissueSeq(node.get("else"), genId);
    const elif = node.get("elif");
    if (isSeq(elif)) {
      for (const eb of elif.items) {
        if (isMap(eb)) reissueSeq(eb.get("then"), genId);
      }
    }
  } else if (type === "parallel") {
    const branches = node.get("branches");
    if (isSeq(branches)) {
      for (const br of branches.items) {
        if (isMap(br)) reissueSeq(br.get("steps"), genId);
      }
    }
  }
  return id;
}

function reissueSeq(seq: unknown, genId: () => string): void {
  if (!isSeq(seq)) return;
  for (const item of seq.items) reissueStepNode(item, genId);
}

export type PreparedInsertion =
  | { ok: true; preparedYaml: string; firstId: string; steps: Step[] }
  | { ok: false; error: string };

/** 삽입 파이프라인 1–3 (spec §5.2): 문법 파싱 → id 재발급 → Zod 게이트.
 *  게이트가 재발급 *뒤*인 이유: StepModel.id는 ULID regex 강제라, 재발급으로
 *  무관해질 야생 id(curl 생성 비-ULID)를 먼저 거부하면 §4.3(서버 id 불검증)과 모순. */
export function prepareTemplateInsertion(
  stepsYaml: string,
  genId: () => string,
): PreparedInsertion {
  let doc: Document.Parsed;
  try {
    doc = parseDocument(stepsYaml, { prettyErrors: true });
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
  if (doc.errors.length > 0) {
    return { ok: false, error: doc.errors.map((e) => e.message).join("; ") };
  }
  const firstId = reissueStepIdsInFragment(doc, genId);
  if (firstId === null) return { ok: false, error: "empty template" };
  const preparedYaml = String(doc);
  const gate = parseStepsFragment(preparedYaml);
  if ("error" in gate) return { ok: false, error: gate.error };
  return { ok: true, preparedYaml, firstId, steps: gate.steps };
}
```

구현 노트: `new Document(seq)`가 tsc/런타임에서 노드를 그대로 안 받으면 `const frag = new Document(); frag.contents = seq;`(필요 시 캐스트)로 대체 — 위 round-trip 테스트가 동작을 락인하므로 어느 쪽이든 GREEN이 기준. `node.get(...)`/`node.set(...)`은 `YAMLMap` 메서드 — `isMap(node)` narrow 후 사용(타입은 `YAMLMap<unknown, unknown>`).

- [ ] **Step 4: `model.ts`에 `topAncestorIndex` 추가** (`findStepById` 바로 아래)

```ts
/** 스텝이 속한 최상위 조상의 인덱스 (중첩이면 그 컨테이너, 최상위면 자신).
 *  저장 다이얼로그 기본 체크와 삽입 위치("선택 스텝의 최상위 조상 바로 뒤")가 공유. */
export function topAncestorIndex(
  steps: ReadonlyArray<Step>,
  stepId: string | null,
): number | null {
  if (stepId === null) return null;
  for (let i = 0; i < steps.length; i++) {
    if (findStepById([steps[i]], stepId)) return i;
  }
  return null;
}
```

- [ ] **Step 5: GREEN + 게이트 + commit**

```bash
cd ui && pnpm test stepTemplateHelpers
# Expected: PASS (위 테스트 전부)
pnpm lint && pnpm test && pnpm build
# Expected: 0 warnings / 전체 green / tsc -b clean
cd ..
git add ui/src/scenario/__tests__/stepTemplateHelpers.test.ts ui/src/scenario/yamlDoc.ts ui/src/scenario/model.ts
git commit -m "feat(ui): 스텝 템플릿 순수 헬퍼 — parseStepsFragment·extractStepsYaml·reissueStepIdsInFragment·topAncestorIndex"
git log -1 --oneline
```

---

### Task 4: `insertSteps` Edit + store 액션 `insertTemplateSteps`

**Files:**
- Create: `ui/src/scenario/__tests__/insertSteps.test.ts` (먼저)
- Modify: `ui/src/scenario/yamlDoc.ts` (Edit variant + applyEdit case)
- Modify: `ui/src/scenario/store.ts` (인터페이스 + 액션 + **actions shim 항목**)

- [ ] **Step 1: 테스트 먼저 작성 (RED)**

`ui/src/scenario/__tests__/insertSteps.test.ts`:

```ts
import { beforeEach, describe, expect, it } from "vitest";
import { applyEdit, parseScenarioDoc, serializeDoc } from "../yamlDoc";
import { useScenarioEditor } from "../../scenario/store";

const SCENARIO = `version: 1
name: target
steps:
  - id: 01HX0000000000000000000001
    name: First
    type: http
    request:
      method: GET
      url: /1
  - id: 01HX0000000000000000000002
    name: Second
    type: http
    request:
      method: GET
      url: /2
`;

const EMPTY = `version: 1
name: empty
steps: []
`;

// 재발급 완료(준비된) fragment — 주석 포함
const PREPARED = `# from template
- id: 01HX0000000000000000000100
  name: TplA
  type: http
  request:
    method: GET
    url: /a
- id: 01HX0000000000000000000101
  name: TplB
  type: http
  request:
    method: GET
    url: /b
`;

function names(yaml: string): string[] {
  const parsed = parseScenarioDoc(yaml);
  if (!("model" in parsed)) throw new Error("must parse");
  return parsed.model.steps.map((s) => s.name);
}

describe("applyEdit insertSteps", () => {
  it("afterTopIndex 뒤에 끼워 넣고 주석을 보존한다", () => {
    const parsed = parseScenarioDoc(SCENARIO);
    if (!("model" in parsed)) throw new Error("must parse");
    applyEdit(parsed.doc, { type: "insertSteps", afterTopIndex: 0, stepsYaml: PREPARED });
    const out = serializeDoc(parsed.doc);
    expect(names(out)).toEqual(["First", "TplA", "TplB", "Second"]);
    expect(out).toContain("# from template");
  });

  it("afterTopIndex null = 맨 끝 append, 빈 시나리오(steps:[])에도 동작", () => {
    const p1 = parseScenarioDoc(SCENARIO);
    if (!("model" in p1)) throw new Error("must parse");
    applyEdit(p1.doc, { type: "insertSteps", afterTopIndex: null, stepsYaml: PREPARED });
    expect(names(serializeDoc(p1.doc))).toEqual(["First", "Second", "TplA", "TplB"]);

    const p2 = parseScenarioDoc(EMPTY);
    if (!("model" in p2)) throw new Error("must parse");
    applyEdit(p2.doc, { type: "insertSteps", afterTopIndex: null, stepsYaml: PREPARED });
    const out2 = serializeDoc(p2.doc);
    expect(names(out2)).toEqual(["TplA", "TplB"]);
    // 빈 `steps: []`(flow)에 삽입해도 block 스타일로 직렬화 (flow=false 전환)
    expect(out2).not.toContain("steps: [");
    expect(out2).toContain("- id:");
  });
});

describe("store insertTemplateSteps", () => {
  beforeEach(() => {
    useScenarioEditor.setState(useScenarioEditor.getInitialState());
  });

  it("선택 스텝의 최상위 조상 뒤에 삽입하고 firstId를 반환한다", () => {
    const s = useScenarioEditor.getState();
    s.loadFromString(SCENARIO);
    s.select("01HX0000000000000000000001");
    const id = useScenarioEditor
      .getState()
      .insertTemplateSteps({ preparedYaml: PREPARED, firstId: "01HX0000000000000000000100" });
    expect(id).toBe("01HX0000000000000000000100");
    const st = useScenarioEditor.getState();
    expect(st.model?.steps.map((x) => x.name)).toEqual(["First", "TplA", "TplB", "Second"]);
    expect(st.yamlError).toBe(null);
    expect(st.yamlText).toContain("TplA");
  });

  it("선택 없음 = 맨 끝 append", () => {
    const s = useScenarioEditor.getState();
    s.loadFromString(SCENARIO);
    useScenarioEditor
      .getState()
      .insertTemplateSteps({ preparedYaml: PREPARED, firstId: "01HX0000000000000000000100" });
    expect(useScenarioEditor.getState().model?.steps.map((x) => x.name)).toEqual([
      "First",
      "Second",
      "TplA",
      "TplB",
    ]);
  });
});
```

- [ ] **Step 2: RED 확인**

```bash
cd ui && pnpm test insertSteps
# Expected: FAIL — Edit variant/액션 부재 (tsc 에러 또는 런타임 실패)
```

- [ ] **Step 3: `yamlDoc.ts` Edit variant + applyEdit case 추가**

`Edit` 유니온 끝에 (기존 마지막 variant `setStepExtract`가 `};`로 끝남 — 그 `;`를 떼고 아래를 이어 붙인다):

```ts
  | { type: "insertSteps"; afterTopIndex: number | null; stepsYaml: string };
```

`applyEdit`의 `setStepExtract` case 뒤에 (결정론 — 난수 없음, id는 prepared yaml에 이미 재발급됨):

```ts
    case "insertSteps": {
      ensureSeq(doc, ["steps"]);
      const steps = doc.getIn(["steps"]) as YAMLSeq;
      const frag = parseDocument(edit.stepsYaml);
      if (!isSeq(frag.contents)) return;
      // 빈 시나리오의 `steps: []`는 flow seq — 그대로 splice하면 전체가 한 줄
      // flow 스타일(`steps: [{...}]`)로 직렬화돼 YAML 탭이 흉해진다. block으로 전환.
      if (steps.items.length === 0) steps.flow = false;
      const at = edit.afterTopIndex === null ? steps.items.length : edit.afterTopIndex + 1;
      steps.items.splice(at, 0, ...frag.contents.items);
      return;
    }
```

- [ ] **Step 4: `store.ts` 액션 추가** — **세 군데**: ① 인터페이스, ② 구현, ③ `actions` shim IIFE (빠뜨리면 테스트 reset 후 액션 소실)

① 인터페이스(`setStepExtract` 선언 뒤):

```ts
  /** 준비된(재발급 완료) 템플릿 fragment를 선택 스텝의 최상위 조상 뒤(없으면 끝)에
   *  삽입. add* 계열처럼 첫 삽입 스텝 id를 반환 — 호출부가 select(id)로 자동 선택. */
  insertTemplateSteps(prepared: { preparedYaml: string; firstId: string }): string;
```

② 구현(`setStepExtract` 구현 뒤) + import에 `topAncestorIndex` 추가(`./model`에서):

```ts
  insertTemplateSteps(prepared) {
    const afterTopIndex = topAncestorIndex(get().model?.steps ?? [], get().selectedStepId);
    dispatch(set, get, {
      type: "insertSteps",
      afterTopIndex,
      stepsYaml: prepared.preparedYaml,
    });
    return prepared.firstId;
  },
```

③ `actions` IIFE에 `insertTemplateSteps: s.insertTemplateSteps,` 추가.

- [ ] **Step 5: GREEN + 게이트 + commit**

```bash
cd ui && pnpm test insertSteps
# Expected: PASS
pnpm lint && pnpm test && pnpm build
cd ..
git add ui/src/scenario/__tests__/insertSteps.test.ts ui/src/scenario/yamlDoc.ts ui/src/scenario/store.ts
git commit -m "feat(ui): insertSteps Edit + insertTemplateSteps store 액션 — 최상위 조상 뒤 노드 이식·firstId 반환"
git log -1 --oneline
```

---

### Task 5: UI API 클라이언트 + React Query hooks

**Files:**
- Create: `ui/src/api/__tests__/stepTemplates.test.ts` (먼저)
- Create: `ui/src/api/stepTemplates.ts`
- Modify: `ui/src/api/hooks.ts` (queryKeys + hooks 4종)

- [ ] **Step 1: 테스트 먼저 작성 (RED)**

`ui/src/api/__tests__/stepTemplates.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  StepTemplateConflictError,
  createStepTemplate,
  listStepTemplates,
} from "../stepTemplates";

function mockFetch(status: number, body: unknown) {
  const fn = vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

afterEach(() => vi.unstubAllGlobals());

const SUMMARY = {
  id: "T1",
  name: "login",
  description: "",
  step_count: 2,
  created_at: 1,
  updated_at: 2,
};

describe("stepTemplates api", () => {
  it("list는 {templates} 래퍼를 언랩한다", async () => {
    mockFetch(200, { templates: [SUMMARY] });
    const out = await listStepTemplates();
    expect(out).toEqual([SUMMARY]);
  });

  it("409 {error,id}는 StepTemplateConflictError(conflictId)로 던진다", async () => {
    mockFetch(409, { error: "같은 이름의 템플릿이 이미 있습니다", id: "T9" });
    const err = await createStepTemplate({ name: "dup", description: "", steps_yaml: "- x" })
      .then(() => null)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StepTemplateConflictError);
    expect((err as StepTemplateConflictError).conflictId).toBe("T9");
  });

  it("409인데 id 없는 본문(race 백스톱)은 conflictId null", async () => {
    mockFetch(409, { error: "conflict" });
    const err = await createStepTemplate({ name: "dup", description: "", steps_yaml: "- x" })
      .then(() => null)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StepTemplateConflictError);
    expect((err as StepTemplateConflictError).conflictId).toBe(null);
  });

  it("비-409 에러는 서버 {error} 메시지로 일반 Error", async () => {
    mockFetch(422, { error: "steps parse: bad" });
    await expect(
      createStepTemplate({ name: "x", description: "", steps_yaml: "bad" }),
    ).rejects.toThrow("steps parse: bad");
  });
});
```

- [ ] **Step 2: RED 확인**

```bash
cd ui && pnpm test "api/__tests__/stepTemplates"
# Expected: FAIL — 모듈 부재
```

- [ ] **Step 3: `ui/src/api/stepTemplates.ts` 작성** (environments.ts 미러 + 409 분기)

```ts
import { z } from "zod";

const BASE = "/api";

export const StepTemplateSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  step_count: z.number().int(),
  created_at: z.number().int(),
  updated_at: z.number().int(),
});
export type StepTemplateSummary = z.infer<typeof StepTemplateSummarySchema>;

export const StepTemplateSchema = StepTemplateSummarySchema.extend({
  steps_yaml: z.string(),
});
export type StepTemplate = z.infer<typeof StepTemplateSchema>;

const StepTemplateListSchema = z.object({ templates: z.array(StepTemplateSummarySchema) });

export type StepTemplateInput = { name: string; description: string; steps_yaml: string };

/** 409 (같은 이름 존재). 서버 ConflictJson 본문 {error, id}의 id로 덮어쓰기 PUT 가능.
 *  conflictId null = pre-check race 백스톱의 plain Conflict(드묾) — 덮어쓰기 불가, 메시지만. */
export class StepTemplateConflictError extends Error {
  constructor(
    public readonly conflictId: string | null,
    message: string,
  ) {
    super(message);
    this.name = "StepTemplateConflictError";
  }
}

async function raise(res: Response): Promise<never> {
  let msg = `HTTP ${res.status}`;
  let conflictId: string | null = null;
  try {
    const body = (await res.json()) as Record<string, unknown>;
    if (typeof body.error === "string") msg = body.error;
    if (typeof body.id === "string") conflictId = body.id;
  } catch {
    // non-JSON body
  }
  if (res.status === 409) throw new StepTemplateConflictError(conflictId, msg);
  throw new Error(msg);
}

export async function listStepTemplates(): Promise<StepTemplateSummary[]> {
  const res = await fetch(`${BASE}/step-templates`);
  if (!res.ok) await raise(res);
  return StepTemplateListSchema.parse(await res.json()).templates;
}

export async function getStepTemplate(id: string): Promise<StepTemplate> {
  const res = await fetch(`${BASE}/step-templates/${encodeURIComponent(id)}`);
  if (!res.ok) await raise(res);
  return StepTemplateSchema.parse(await res.json());
}

export async function createStepTemplate(input: StepTemplateInput): Promise<StepTemplate> {
  const res = await fetch(`${BASE}/step-templates`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) await raise(res);
  return StepTemplateSchema.parse(await res.json());
}

export async function updateStepTemplate(
  id: string,
  input: StepTemplateInput,
): Promise<StepTemplate> {
  const res = await fetch(`${BASE}/step-templates/${encodeURIComponent(id)}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) await raise(res);
  return StepTemplateSchema.parse(await res.json());
}

export async function deleteStepTemplate(id: string): Promise<void> {
  const res = await fetch(`${BASE}/step-templates/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
  if (!res.ok) await raise(res);
}
```

- [ ] **Step 4: `hooks.ts`에 hooks 추가**

import 블록에:

```ts
import {
  createStepTemplate,
  deleteStepTemplate,
  listStepTemplates,
  updateStepTemplate,
  type StepTemplateInput,
} from "./stepTemplates";
```

`queryKeys`에 `stepTemplates: () => ["step-templates"] as const,` 추가. environments hooks 뒤에:

```ts
export function useStepTemplates() {
  return useQuery({ queryKey: queryKeys.stepTemplates(), queryFn: listStepTemplates });
}

export function useCreateStepTemplate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: StepTemplateInput) => createStepTemplate(input),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.stepTemplates() }),
  });
}

export function useUpdateStepTemplate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: StepTemplateInput }) =>
      updateStepTemplate(id, input),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.stepTemplates() }),
  });
}

export function useDeleteStepTemplate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deleteStepTemplate(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.stepTemplates() }),
  });
}
```

(단건 GET hook은 의도적으로 없음 — 삽입 시점 1회성 `getStepTemplate` 직접 호출, useTestRun ephemeral 패턴.)

- [ ] **Step 5: GREEN + 게이트 + commit**

```bash
cd ui && pnpm test "api/__tests__/stepTemplates"
# Expected: PASS
pnpm lint && pnpm test && pnpm build
cd ..
git add ui/src/api/__tests__/stepTemplates.test.ts ui/src/api/stepTemplates.ts ui/src/api/hooks.ts
git commit -m "feat(ui): step-templates api 클라이언트 + hooks — 409 ConflictJson{id} 전용 에러"
git log -1 --oneline
```

---

### Task 6: `SaveTemplateDialog` + 두 페이지 헤더 배선 + ko.ts

**Files:**
- Create: `ui/src/components/scenario/__tests__/SaveTemplateDialog.test.tsx` (먼저)
- Create: `ui/src/components/scenario/SaveTemplateDialog.tsx`
- Modify: `ui/src/i18n/ko.ts` (`stepTemplates` 네임스페이스 신설)
- Modify: `ui/src/pages/ScenarioEditPage.tsx`, `ui/src/pages/ScenarioNewPage.tsx` (헤더 버튼 + 마운트)

⚠ **순서 주의**: ko.ts도 `ui/src/*.ts`라 TDD guard 대상 — **테스트 파일(Step 1)을 먼저** 디스크에 쓰고 나서 ko.ts(Step 2)를 편집한다.

- [ ] **Step 1: 테스트 먼저 작성 (RED)** — 아래 "**Step 1의 테스트 코드**" 블록을 `ui/src/components/scenario/__tests__/SaveTemplateDialog.test.tsx`로 저장.

- [ ] **Step 2: ko.ts에 `stepTemplates` 네임스페이스 추가** (`templates:` 블록 뒤, 같은 들여쓰기 — U3 시나리오 갤러리 `templates`와 별개 네임스페이스로 혼동 방지)

```ts
  stepTemplates: {
    // ── 진입점 (에디터 헤더, 두 페이지) ──
    saveButton: "템플릿으로 저장",
    insertButton: "템플릿 삽입",
    gateTooltip: "시나리오 문제를 해결해야 템플릿 기능을 쓸 수 있습니다.",
    // ── 저장 다이얼로그 ──
    saveTitle: "스텝 템플릿으로 저장",
    nameLabel: "이름",
    descriptionLabel: "설명 (선택)",
    stepsLegend: "담을 스텝",
    saveAction: "저장",
    saving: "저장 중…",
    overwriteConfirm: (name: string) =>
      `"${name}" 이름의 템플릿이 이미 있습니다. 덮어쓸까요?`,
    overwriteAction: "덮어쓰기",
    cancel: "취소",
    // ── 삽입 모달 ──
    insertTitle: "스텝 템플릿 삽입",
    empty: "저장된 템플릿이 없습니다. 에디터 헤더의 \"템플릿으로 저장\"으로 만드세요.",
    insertAction: "삽입",
    deleteAction: "삭제",
    deleteConfirm: (name: string) => `템플릿 "${name}"을(를) 삭제할까요?`,
    incompatible: "이 템플릿은 에디터 규칙과 호환되지 않습니다",
    stepCount: (n: number) => `스텝 ${n}개`,
  },
```

**Step 1의 테스트 코드** (`ui/src/components/scenario/__tests__/SaveTemplateDialog.test.tsx`):

```tsx
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SaveTemplateDialog } from "../SaveTemplateDialog";
import { useScenarioEditor } from "../../../scenario/store";
import { StepTemplateConflictError } from "../../../api/stepTemplates";

vi.mock("../../../api/stepTemplates", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../../../api/stepTemplates")>();
  return {
    ...mod,
    createStepTemplate: vi.fn(),
    updateStepTemplate: vi.fn(),
  };
});
import { createStepTemplate, updateStepTemplate } from "../../../api/stepTemplates";

const SCENARIO = `version: 1
name: src
steps:
  - id: 01HX0000000000000000000001
    name: Login
    type: http
    request:
      method: POST
      url: /login
  - id: 01HX0000000000000000000002
    name: Loop
    type: loop
    repeat: 2
    do:
      - id: 01HX0000000000000000000003
        name: Inner
        type: http
        request:
          method: GET
          url: /inner
`;

function mount(onClose = vi.fn()) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <SaveTemplateDialog onClose={onClose} />
    </QueryClientProvider>,
  );
  return onClose;
}

describe("SaveTemplateDialog", () => {
  beforeEach(() => {
    vi.mocked(createStepTemplate).mockReset();
    vi.mocked(updateStepTemplate).mockReset();
    useScenarioEditor.setState(useScenarioEditor.getInitialState());
    useScenarioEditor.getState().loadFromString(SCENARIO);
  });

  it("선택 없음 = 전체 체크, 이름 비면 저장 비활성", () => {
    mount();
    const boxes = screen.getAllByRole("checkbox");
    expect(boxes).toHaveLength(2);
    for (const b of boxes) expect(b).toBeChecked();
    expect(screen.getByRole("button", { name: "저장" })).toBeDisabled();
  });

  it("중첩 스텝 선택 시 그 최상위 조상만 기본 체크", () => {
    useScenarioEditor.getState().select("01HX0000000000000000000003"); // loop 내부
    mount();
    const boxes = screen.getAllByRole("checkbox");
    expect(boxes[0]).not.toBeChecked(); // Login
    expect(boxes[1]).toBeChecked(); // Loop (최상위 조상)
  });

  it("체크 0개면 저장 비활성", async () => {
    const user = userEvent.setup();
    mount();
    await user.type(screen.getByLabelText("이름"), "t");
    for (const b of screen.getAllByRole("checkbox")) await user.click(b);
    expect(screen.getByRole("button", { name: "저장" })).toBeDisabled();
  });

  it("저장 성공 → steps_yaml에 체크된 스텝만 + onClose", async () => {
    const user = userEvent.setup();
    vi.mocked(createStepTemplate).mockResolvedValue({
      id: "T1",
      name: "login-flow",
      description: "",
      steps_yaml: "",
      step_count: 1,
      created_at: 0,
      updated_at: 0,
    });
    const onClose = mount();
    await user.type(screen.getByLabelText("이름"), "login-flow");
    await user.click(screen.getAllByRole("checkbox")[1]); // Loop 해제 → Login만
    await user.click(screen.getByRole("button", { name: "저장" }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    const input = vi.mocked(createStepTemplate).mock.calls[0][0];
    expect(input.name).toBe("login-flow");
    expect(input.steps_yaml).toContain("Login");
    expect(input.steps_yaml).not.toContain("Loop");
  });

  it("409 conflict → 덮어쓰기 확인 → PUT(conflictId)", async () => {
    const user = userEvent.setup();
    vi.mocked(createStepTemplate).mockRejectedValue(
      new StepTemplateConflictError("T9", "같은 이름의 템플릿이 이미 있습니다"),
    );
    vi.mocked(updateStepTemplate).mockResolvedValue({
      id: "T9",
      name: "dup",
      description: "",
      steps_yaml: "",
      step_count: 2,
      created_at: 0,
      updated_at: 0,
    });
    const onClose = mount();
    await user.type(screen.getByLabelText("이름"), "dup");
    await user.click(screen.getByRole("button", { name: "저장" }));
    // 덮어쓰기 확인 단계
    expect(await screen.findByText(/덮어쓸까요/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "덮어쓰기" }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(vi.mocked(updateStepTemplate).mock.calls[0][0]).toBe("T9");
  });
});
```

- [ ] **Step 3: RED 확인**

```bash
cd ui && pnpm test SaveTemplateDialog
# Expected: FAIL — 컴포넌트 부재
```

- [ ] **Step 4: `SaveTemplateDialog.tsx` 작성**

```tsx
import { useState } from "react";
import { Button } from "../Button";
import { Modal } from "../Modal";
import { ko } from "../../i18n/ko";
import { StepTemplateConflictError } from "../../api/stepTemplates";
import { useCreateStepTemplate, useUpdateStepTemplate } from "../../api/hooks";
import { topAncestorIndex } from "../../scenario/model";
import { useScenarioEditor } from "../../scenario/store";
import { extractStepsYaml } from "../../scenario/yamlDoc";

const TYPE_LABEL: Record<string, string> = {
  http: "HTTP",
  loop: "반복",
  if: "조건",
  parallel: "동시 실행",
};

/** 에디터 버퍼의 최상위 스텝을 골라 스텝 템플릿으로 저장 (spec §5.1).
 *  열 때마다 fresh state가 되도록 부모가 `{open && <SaveTemplateDialog/>}`로
 *  조건부 마운트한다(open prop 없음). 소스 = store의 커밋된 doc(라이브 버퍼). */
export function SaveTemplateDialog({ onClose }: { onClose: () => void }) {
  const doc = useScenarioEditor((s) => s.doc);
  const model = useScenarioEditor((s) => s.model);
  const selectedStepId = useScenarioEditor((s) => s.selectedStepId);
  const create = useCreateStepTemplate();
  const update = useUpdateStepTemplate();

  const steps = model?.steps ?? [];
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  // 기본 체크: 선택 스텝 있으면 그 최상위 조상만, 없으면 전체 (spec §5.1)
  const [checked, setChecked] = useState<boolean[]>(() => {
    const sel = topAncestorIndex(steps, selectedStepId);
    return steps.map((_, i) => (sel === null ? true : i === sel));
  });
  const [conflict, setConflict] = useState<{ id: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const indices = checked.flatMap((c, i) => (c ? [i] : []));
  const pending = create.isPending || update.isPending;
  const canSave = name.trim().length > 0 && indices.length > 0 && !pending;

  const save = async () => {
    if (!doc) return;
    setError(null);
    const input = {
      name: name.trim(),
      description: description.trim(),
      steps_yaml: extractStepsYaml(doc, indices),
    };
    try {
      if (conflict) {
        await update.mutateAsync({ id: conflict.id, input });
      } else {
        await create.mutateAsync(input);
      }
      onClose();
    } catch (e) {
      if (e instanceof StepTemplateConflictError && e.conflictId) {
        setConflict({ id: e.conflictId });
        return;
      }
      setConflict(null);
      setError((e as Error).message);
    }
  };

  return (
    <Modal open onClose={onClose} title={ko.stepTemplates.saveTitle}>
      <div className="flex flex-col gap-4">
        <label className="flex flex-col gap-1 text-sm">
          {ko.stepTemplates.nameLabel}
          <input
            className="rounded border border-slate-300 px-2 py-1"
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              setConflict(null); // 이름이 바뀌면 덮어쓰기 대상도 무효
            }}
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          {ko.stepTemplates.descriptionLabel}
          <input
            className="rounded border border-slate-300 px-2 py-1"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </label>
        <fieldset className="min-w-0 flex flex-col gap-1">
          <legend className="text-sm font-medium">{ko.stepTemplates.stepsLegend}</legend>
          {steps.map((s, i) => (
            <label key={s.id} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={checked[i] ?? false}
                onChange={() =>
                  setChecked((prev) => prev.map((c, j) => (j === i ? !c : c)))
                }
              />
              <span>
                {s.name}{" "}
                <span className="text-xs text-slate-500">({TYPE_LABEL[s.type] ?? s.type})</span>
              </span>
            </label>
          ))}
        </fieldset>
        {conflict && <p className="text-sm text-amber-700">{ko.stepTemplates.overwriteConfirm(name.trim())}</p>}
        {error && (
          <p role="alert" className="text-sm text-red-600">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            {ko.stepTemplates.cancel}
          </Button>
          <Button onClick={() => void save()} disabled={!canSave}>
            {pending
              ? ko.stepTemplates.saving
              : conflict
                ? ko.stepTemplates.overwriteAction
                : ko.stepTemplates.saveAction}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
```

- [ ] **Step 5: 두 페이지 헤더 배선** (U4 "미리 1회 실행" 두-페이지 패턴 미러)

`ScenarioEditPage.tsx` — ① import 추가:

```tsx
import { SaveTemplateDialog } from "../components/scenario/SaveTemplateDialog";
import { useScenarioEditor } from "../scenario/store";
```

② 컴포넌트 상단 state들 옆에 (**훅이므로 early-return `if (isLoading)` 위에 배치**):

```tsx
  const [saveTplOpen, setSaveTplOpen] = useState(false);
  const editorModel = useScenarioEditor((s) => s.model);
  const editorYamlError = useScenarioEditor((s) => s.yamlError);
  const tplReady = editorModel !== null && editorYamlError === null;
```

③ 헤더 버튼 — "미리 1회 실행"+HelpTip 뒤, Save 버튼 앞에 (게이트 = store 상태 핀, spec §5.1 — `parseScenarioDoc(yamlText)` 재호출 금지):

```tsx
          <Button
            variant="secondary"
            onClick={() => setSaveTplOpen(true)}
            disabled={!tplReady}
            title={tplReady ? undefined : ko.stepTemplates.gateTooltip}
          >
            {ko.stepTemplates.saveButton}
          </Button>
```

④ JSX 끝부분(기존 Modal들 옆)에 조건부 마운트:

```tsx
      {saveTplOpen && <SaveTemplateDialog onClose={() => setSaveTplOpen(false)} />}
```

`ScenarioNewPage.tsx` — 같은 4단계(이미 `useScenarioEditor` import 있음). 버튼은 "미리 1회 실행"+HelpTip 뒤·"만들기" 앞, 마운트는 `<TestRunSection>` 뒤. **주의**: 갤러리 단계(`seedYaml === null`) return에는 넣지 않는다(에디터 마운트 후에만 의미).

- [ ] **Step 6: GREEN + 게이트 + commit**

```bash
cd ui && pnpm test SaveTemplateDialog
# Expected: PASS (5 tests)
pnpm lint && pnpm test && pnpm build
cd ..
git add ui/src/components/scenario/__tests__/SaveTemplateDialog.test.tsx \
        ui/src/components/scenario/SaveTemplateDialog.tsx \
        ui/src/i18n/ko.ts ui/src/pages/ScenarioEditPage.tsx ui/src/pages/ScenarioNewPage.tsx
git commit -m "feat(ui): 템플릿으로 저장 다이얼로그 + 에디터 헤더 배선 2페이지 — store-게이트·409 덮어쓰기"
git log -1 --oneline
```

---

### Task 7: `InsertTemplateModal` + 두 페이지 헤더 배선

**Files:**
- Create: `ui/src/components/scenario/__tests__/InsertTemplateModal.test.tsx` (먼저)
- Create: `ui/src/components/scenario/InsertTemplateModal.tsx`
- Modify: `ui/src/pages/ScenarioEditPage.tsx`, `ui/src/pages/ScenarioNewPage.tsx` (삽입 버튼 + 마운트)

- [ ] **Step 1: 테스트 먼저 작성 (RED)**

`ui/src/components/scenario/__tests__/InsertTemplateModal.test.tsx`:

```tsx
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { InsertTemplateModal } from "../InsertTemplateModal";
import { useScenarioEditor } from "../../../scenario/store";

vi.mock("../../../api/stepTemplates", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../../../api/stepTemplates")>();
  return {
    ...mod,
    listStepTemplates: vi.fn(),
    getStepTemplate: vi.fn(),
    deleteStepTemplate: vi.fn(),
  };
});
import {
  deleteStepTemplate,
  getStepTemplate,
  listStepTemplates,
} from "../../../api/stepTemplates";

const SCENARIO = `version: 1
name: target
steps:
  - id: 01HX0000000000000000000001
    name: First
    type: http
    request:
      method: GET
      url: /1
`;

const TPL_SUMMARY = {
  id: "T1",
  name: "login-flow",
  description: "로그인",
  step_count: 1,
  created_at: 0,
  updated_at: 0,
};

// 야생 비-ULID id — 삽입 경로가 재발급하므로 그대로 통과해야 한다 (spec §5.2 순서 락인)
const TPL_FULL = {
  ...TPL_SUMMARY,
  steps_yaml: "- id: wild-1\n  name: TplStep\n  type: http\n  request:\n    method: GET\n    url: /tpl\n",
};

function mount(onClose = vi.fn()) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <InsertTemplateModal onClose={onClose} />
    </QueryClientProvider>,
  );
  return onClose;
}

describe("InsertTemplateModal", () => {
  beforeEach(() => {
    vi.mocked(listStepTemplates).mockReset().mockResolvedValue([TPL_SUMMARY]);
    vi.mocked(getStepTemplate).mockReset();
    vi.mocked(deleteStepTemplate).mockReset().mockResolvedValue(undefined);
    useScenarioEditor.setState(useScenarioEditor.getInitialState());
    useScenarioEditor.getState().loadFromString(SCENARIO);
  });

  it("목록을 렌더한다 (이름/설명/스텝 수)", async () => {
    mount();
    expect(await screen.findByText("login-flow")).toBeInTheDocument();
    // 설명/스텝 수는 한 <p>의 joined 텍스트("스텝 1개 · 로그인 · <날짜>") — 정규식 매처 필수
    expect(screen.getByText(/로그인/)).toBeInTheDocument();
    expect(screen.getByText(/스텝 1개/)).toBeInTheDocument();
  });

  it("삽입: 야생 id도 재발급 경유로 성공, 새 스텝 선택 + onClose", async () => {
    const user = userEvent.setup();
    vi.mocked(getStepTemplate).mockResolvedValue(TPL_FULL);
    const onClose = mount();
    await user.click(await screen.findByRole("button", { name: "삽입" }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    const st = useScenarioEditor.getState();
    expect(st.model?.steps.map((s) => s.name)).toEqual(["First", "TplStep"]);
    // 재발급: 야생 id는 사라지고, 새 스텝이 선택돼 있다
    expect(st.yamlText).not.toContain("wild-1");
    const inserted = st.model?.steps[1];
    expect(st.selectedStepId).toBe(inserted?.id);
  });

  it("호환 불가 템플릿(2단 중첩)은 에러 표시 + 미삽입", async () => {
    const user = userEvent.setup();
    vi.mocked(getStepTemplate).mockResolvedValue({
      ...TPL_SUMMARY,
      steps_yaml:
        "- id: a\n  name: L\n  type: loop\n  repeat: 1\n  do:\n    - id: b\n      name: L2\n      type: loop\n      repeat: 1\n      do:\n        - id: c\n          name: x\n          type: http\n          request:\n            method: GET\n            url: /x\n",
    });
    mount();
    await user.click(await screen.findByRole("button", { name: "삽입" }));
    expect(await screen.findByText(/호환되지 않습니다/)).toBeInTheDocument();
    expect(useScenarioEditor.getState().model?.steps).toHaveLength(1);
  });

  it("삭제: confirm 후 deleteStepTemplate 호출", async () => {
    const user = userEvent.setup();
    vi.spyOn(window, "confirm").mockReturnValue(true);
    mount();
    await user.click(await screen.findByRole("button", { name: "삭제" }));
    await waitFor(() => expect(deleteStepTemplate).toHaveBeenCalledWith("T1"));
  });

  it("삭제된 템플릿 삽입(GET 404)은 에러 표시 + 목록 갱신 + 미삽입 (spec §6)", async () => {
    const user = userEvent.setup();
    vi.mocked(getStepTemplate).mockRejectedValue(new Error("not found"));
    mount();
    await user.click(await screen.findByRole("button", { name: "삽입" }));
    expect(await screen.findByText(/not found/)).toBeInTheDocument();
    // 목록 갱신 — list.refetch() 경유 listStepTemplates 재호출
    await waitFor(() => expect(listStepTemplates).toHaveBeenCalledTimes(2));
    expect(useScenarioEditor.getState().model?.steps).toHaveLength(1);
  });

  it("빈 목록이면 빈 상태 문구", async () => {
    vi.mocked(listStepTemplates).mockResolvedValue([]);
    mount();
    expect(await screen.findByText(/저장된 템플릿이 없습니다/)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: RED 확인**

```bash
cd ui && pnpm test InsertTemplateModal
# Expected: FAIL — 컴포넌트 부재
```

- [ ] **Step 3: `InsertTemplateModal.tsx` 작성**

```tsx
import { useState } from "react";
import { Button } from "../Button";
import { Modal } from "../Modal";
import { ko } from "../../i18n/ko";
import { getStepTemplate } from "../../api/stepTemplates";
import { useDeleteStepTemplate, useStepTemplates } from "../../api/hooks";
import { newStepId } from "../../scenario/ulid";
import { useScenarioEditor } from "../../scenario/store";
import { prepareTemplateInsertion } from "../../scenario/yamlDoc";

/** 저장된 스텝 템플릿 목록 → 복사-삽입 (spec §5.2 파이프라인: GET → 문법 →
 *  재발급 → Zod 게이트 → insertTemplateSteps → 첫 스텝 선택) + 행별 삭제(최소 관리).
 *  부모가 조건부 마운트(`{open && …}`). */
export function InsertTemplateModal({ onClose }: { onClose: () => void }) {
  const list = useStepTemplates();
  const del = useDeleteStepTemplate();
  const insertTemplateSteps = useScenarioEditor((s) => s.insertTemplateSteps);
  const select = useScenarioEditor((s) => s.select);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const insert = async (id: string) => {
    setError(null);
    setBusyId(id);
    try {
      const tpl = await getStepTemplate(id);
      const prep = prepareTemplateInsertion(tpl.steps_yaml, newStepId);
      if (!prep.ok) {
        setError(`${ko.stepTemplates.incompatible}: ${prep.error}`);
        return;
      }
      const firstId = insertTemplateSteps({
        preparedYaml: prep.preparedYaml,
        firstId: prep.firstId,
      });
      select(firstId);
      onClose();
    } catch (e) {
      // 404(방금 삭제된 템플릿) 등 — 메시지 + 목록 갱신
      setError((e as Error).message);
      void list.refetch();
    } finally {
      setBusyId(null);
    }
  };

  const remove = (id: string, name: string) => {
    if (!window.confirm(ko.stepTemplates.deleteConfirm(name))) return;
    del.mutate(id);
  };

  const templates = list.data ?? [];

  return (
    <Modal open onClose={onClose} title={ko.stepTemplates.insertTitle}>
      <div className="flex flex-col gap-3">
        {list.isLoading && <p className="text-sm text-slate-500">Loading…</p>}
        {list.error && (
          <p role="alert" className="text-sm text-red-600">
            {(list.error as Error).message}
          </p>
        )}
        {error && (
          <p role="alert" className="text-sm text-red-600">
            {error}
          </p>
        )}
        {!list.isLoading && templates.length === 0 && (
          <p className="text-sm text-slate-500">{ko.stepTemplates.empty}</p>
        )}
        <ul className="flex flex-col gap-2">
          {templates.map((t) => (
            <li
              key={t.id}
              className="flex items-center justify-between gap-3 rounded border border-slate-200 p-2"
            >
              <div className="min-w-0">
                <p className="font-medium text-slate-900">{t.name}</p>
                <p className="truncate text-xs text-slate-500">
                  {ko.stepTemplates.stepCount(t.step_count)}
                  {t.description ? ` · ${t.description}` : ""} ·{" "}
                  {new Date(t.updated_at).toLocaleString()}
                </p>
              </div>
              <div className="flex shrink-0 gap-2">
                <Button onClick={() => void insert(t.id)} disabled={busyId !== null}>
                  {ko.stepTemplates.insertAction}
                </Button>
                <Button
                  variant="secondary"
                  onClick={() => remove(t.id, t.name)}
                  disabled={del.isPending}
                >
                  {ko.stepTemplates.deleteAction}
                </Button>
              </div>
            </li>
          ))}
        </ul>
        <div className="flex justify-end">
          <Button variant="secondary" onClick={onClose}>
            {ko.stepTemplates.cancel}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
```

- [ ] **Step 4: 두 페이지 배선** — `ScenarioEditPage.tsx`·`ScenarioNewPage.tsx` 각각:

① import 추가:

```tsx
import { InsertTemplateModal } from "../components/scenario/InsertTemplateModal";
```

② 컴포넌트 상단(early-return 위, Task 6의 `saveTplOpen` 옆)에:

```tsx
  const [insertTplOpen, setInsertTplOpen] = useState(false);
```

③ 헤더의 "템플릿으로 저장" 버튼 바로 뒤에 (같은 `tplReady` 게이트 — 게이트-에러 doc에 삽입하면 dispatch reparse가 yamlError를 덮어쓰므로 저장과 동일하게 막는다):

```tsx
          <Button
            variant="secondary"
            onClick={() => setInsertTplOpen(true)}
            disabled={!tplReady}
            title={tplReady ? undefined : ko.stepTemplates.gateTooltip}
          >
            {ko.stepTemplates.insertButton}
          </Button>
```

④ JSX 끝부분(Task 6의 SaveTemplateDialog 마운트 옆)에:

```tsx
      {insertTplOpen && <InsertTemplateModal onClose={() => setInsertTplOpen(false)} />}
```

(NewPage는 갤러리 단계(`seedYaml === null`) return에는 넣지 않는다 — Task 6과 동일.)

- [ ] **Step 5: GREEN + 게이트 + commit**

```bash
cd ui && pnpm test InsertTemplateModal
# Expected: PASS (6 tests)
pnpm lint && pnpm test && pnpm build
cd ..
git add ui/src/components/scenario/__tests__/InsertTemplateModal.test.tsx \
        ui/src/components/scenario/InsertTemplateModal.tsx \
        ui/src/pages/ScenarioEditPage.tsx ui/src/pages/ScenarioNewPage.tsx
git commit -m "feat(ui): 템플릿 삽입 모달 — 재발급→게이트→삽입 파이프라인·모달 내 삭제(최소 관리)"
git log -1 --oneline
```

---

### Task 8: ADR-0036 + 문서 갱신

**Files:**
- Create: `docs/adr/0036-step-templates-copy-on-insert.md`
- Modify: `CLAUDE.md` ("알아둘 결정들" 인덱스에 **한 줄만**)
- Modify: `docs/roadmap.md` (§B에 연기 항목 추가)

- [ ] **Step 1: ADR 작성** (MADR 포맷, 기존 ADR 톤 미러)

```markdown
# 0036 — 스텝 템플릿: 독립 top-level 리소스 + 복사-삽입 스냅샷

- Status: accepted
- Date: 2026-06-12

## Context

공통 플로우(로그인 = POST /login → GET /me 등)를 시나리오마다 손으로 재작성하는
통증. 원 아이디어는 "여러 시나리오를 순서대로 조합해 긴 시나리오처럼 run"(참조 기반
조합)이었으나, 참조 추종·변수/쿠키 핸드오프·run 시점 합성·step id 충돌 등 설계
부담이 커서 스텝 템플릿화로 단순화하기로 사용자가 결정.

## Decision

- **전용 top-level 리소스** `step_templates`(migration 0015, UNIQUE name) + CRUD
  REST(`/api/step-templates`) — environments(ADR-0025) 패턴 미러. 팀 공유.
- **복사-삽입 스냅샷**: 템플릿 = 최상위 스텝 시퀀스(Step[] — http/loop/if/parallel
  서브트리 포함)의 YAML 텍스트. 삽입 시 클라이언트가 모든 스텝 id를 새 ULID로
  재발급(노드-레벨 구조-인지 walk, 주석 보존). 원본 추종 없음.
- **검증 분담**: 서버는 엔진 serde `Vec<Step>` 파싱 + 비어있지 않음만(422; 스텝 id
  ULID 유효성 불검증 — 재발급으로 무관). 엄격 검증(UI 중첩 규칙)은 삽입 시
  UI Zod 게이트(재발급 *뒤*). 기존 lenient-engine / strict-UI 스탠스.
- **이름 충돌**: 409 `ConflictJson {error, id}` — UI가 그 id로 덮어쓰기 PUT.
- **DELETE 무가드**: 복사 시맨틱이라 참조가 없음(environments와 동일 논리).
- **엔진·워커·proto 무변경.**

## Consequences

- 참조 기반 시나리오 조합(원본 수정 전파)은 별도 미래 슬라이스 — 이 결정이 막지
  않음(템플릿은 그때도 유효한 보완 기능).
- 변수 파라미터화 없음(v1): `{{var}}`/`${ENV}` 토큰은 as-is 복사, 삽입 후 검증
  배너·치트시트가 안내.
- 관리 표면은 삽입 모달 내 최소(삭제)로 시작 — 라이브러리가 커지면 `/templates`
  페이지(EnvironmentsPage 미러)로 확장(roadmap §B 기록).
```

- [ ] **Step 2: CLAUDE.md 인덱스 한 줄 추가** ("알아둘 결정들" 끝):

```markdown
- **0036** 스텝 템플릿: top-level `step_templates` 리소스 + 복사-삽입 스냅샷(삽입 시 ULID 재발급), 참조 동기화 기각
```

- [ ] **Step 3: roadmap §B에 연기 항목 추가** (§B7 뒤, §B3 앞에 새 섹션):

```markdown
### B8. 스텝 템플릿 (2026-06-12, ADR-0036) 연기 항목
- **별도 관리 페이지 `/templates`**: v1은 삽입 모달 내 최소 관리(삭제)만. 팀 라이브러리가 커지면 EnvironmentsPage 미러(목록/이름변경/내용 미리보기/삭제)로 확장 — 사용자 결정(1안 진행, 불편 시 2안).
- **변수 파라미터화**: 삽입 시 `{{var}}`/`${ENV}` placeholder 치환 다이얼로그. v1은 as-is 복사(검증 배너·치트시트가 후속 안내).
- **컨테이너 내부 삽입**(loop/if/parallel 안으로) · **내장 스텝 템플릿** · **버전/히스토리** · **import/export** · **검색/태그**.
- **참조 기반 시나리오 조합**: 이 슬라이스로 대체된 원 아이디어 — 필요해지면 별도 spec(참조 추종·변수/쿠키 핸드오프·run 시점 합성).
```

- [ ] **Step 4: commit** (docs-only fast-path)

```bash
git add docs/adr/0036-step-templates-copy-on-insert.md CLAUDE.md docs/roadmap.md
git commit -m "docs: ADR-0036 스텝 템플릿 (복사-삽입 스냅샷) + roadmap §B8 연기 항목"
git log -1 --oneline
```

---

### Task 9: 최종 게이트 + 라이브 검증 (orchestrator 직접 수행 — subagent 아님)

- [ ] **Step 1: 전체 게이트**

```bash
cargo fmt --check && cargo clippy --workspace --all-targets -- -D warnings && cargo test --workspace
cd ui && pnpm lint && pnpm test && pnpm build && cd ..
# Expected: 전부 green
```

- [ ] **Step 2: handicap-reviewer 최종 whole-feature 리뷰** (wire 1:1: Rust DTO ↔ UI Zod — `step_count: i64`↔`z.number().int()`, `{templates}` 래퍼, ConflictJson `{error,id}`, ms 타임스탬프)

- [ ] **Step 3: 라이브 검증** (S-D 규칙 — RTL/tsc가 못 잡는 응답 파싱 갭)

```bash
cargo build -p handicap-worker --bin worker && cargo build -p handicap-controller --bin controller
cd ui && pnpm build && cd ..
./target/debug/controller --db /tmp/step-tpl-live.db --ui-dir ui/dist
```

Playwright(인라인 `browser_snapshot`/`browser_evaluate`, `filename` 저장 금지)로:
1. 시나리오 A 에디터에서 2스텝 체크 → "템플릿으로 저장"(이름 `login-flow`) → 성공.
2. 같은 이름으로 한 번 더 저장 → 덮어쓰기 확인 → PUT 성공.
3. 시나리오 B 에디터(또는 새 시나리오)에서 "템플릿 삽입" → 목록 → 삽입 → 캔버스에 새 스텝 + 자동 선택 확인, **id가 원본과 다른지**(YAML 탭) 확인.
4. 삽입된 시나리오 저장 → run 1회 발사 → completed + 리포트.
5. 콘솔 Zod 에러 0 확인.
6. curl 검증: `curl -s localhost:8080/api/step-templates | python3 -m json.tool` — summary에 steps_yaml 없음.

- [ ] **Step 4: 마무리는 `/finish-slice` 의식** (build-log append, 상태줄 교체, master ff-merge, ExitWorktree — plan 범위 밖)

---

## Self-review 체크 (spec 대비)

| spec | task |
|---|---|
| §4.1 migration 0015 (ms 타임스탬프) | T1 |
| §4.2 REST 5종 + §4.3 검증/409 ConflictJson/422/400/trim | T2 |
| §5.1 저장(체크박스 기본값·store 게이트·extractStepsYaml·409→PUT) | T3+T6 |
| §5.2 삽입 파이프라인(문법→재발급→게이트→insertTemplateSteps→선택) | T3+T4+T7 |
| §5.3 클라(api/hooks/헬퍼 3종/네이밍) | T3+T5 |
| §6 엣지(404·빈 시나리오·중복 삽입·dirty 저장) | T2/T4/T7 테스트 |
| §7 테스트 + 라이브 | 각 task + T9 |
| §8 migration 배선 함정·스코프 가이드 | T1 Step 4 / 9 task ≤ 가이드 |
| §9 연기 → roadmap, ADR-0036 | T8 |
