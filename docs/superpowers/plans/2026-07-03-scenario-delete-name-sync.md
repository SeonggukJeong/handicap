# 시나리오 삭제 + 이름 라이브/인라인 편집 + false-dirty 수정 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `DELETE /api/scenarios/{id}`(2층 가드 + 단일 트랜잭션 cascade) + 목록 행 삭제 UI, 에디터 헤더 이름 라이브 표시/연필 인라인 편집, 로드-직후 false-dirty 제거.

**Architecture:** 백엔드는 datasets 삭제의 2층 가드 패턴을 시나리오에 이식하되 권위 hard 가드를 cascade 트랜잭션 *안*으로(레이스 봉쇄, spec §3-5), 핸들러는 advisory fast-fail + soft 카운트 409만. UI는 `deleteDatasetImpl`/`useDeleteDataset`/`DatasetsPage` 관용구 미러. 에디터는 `ScenarioNewPage.chooseTemplate` 선적재 패턴을 edit 페이지에 이식(`seeded` 게이트)하고 그 게이트 위에 `liveName`/연필 편집(기존 `setName` 재사용)을 올린다.

**Tech Stack:** axum + sqlx(SQLite, `foreign_keys=ON`) / React + React Query + Zustand + RTL.

**Spec:** `docs/superpowers/specs/2026-07-03-scenario-delete-name-sync-design.md` (r3, clean APPROVE). R-id는 그 spec §2를 가리킨다.

## Global Constraints

- **불변식(R11)**: 엔진·worker·proto 무변경, 신규 migration 0건(단 `0005_run_presets.sql` **주석-only** 갱신 1건은 포함), `schemas.ts`·`scenario/model.ts`·`ui/src/scenario/store.ts`·`yamlDoc.ts` 무변경, 시나리오 YAML 와이어 byte-identical.
- **한국어(R10)**: 클라이언트 발신 신규 문구는 전부 `ui/src/i18n/ko.ts` 경유. 서버 발신 에러(hard 409 본문)는 배너 passthrough. 백엔드 에러 문구는 핸들러 내 한국어 리터럴(datasets 관용구).
- **tdd-guard**: `ui/src`/`crates/*/src` 편집 전에 그 task의 테스트 파일을 **먼저** 편집해 pending test diff를 만든다(테스트 경로는 항상 허용). 각 task의 Step 순서가 이미 test-first다 — 순서를 바꾸지 말 것.
- **커밋**: task마다 독립 green 커밋. implementer는 `git commit`을 **단일 foreground 호출(run_in_background:false, timeout 600000ms)**로, 파이프(`| tail` 등)·`--no-verify` 금지. cargo-영향 커밋(Task 1·2·7)은 pre-commit이 전체 workspace 게이트를 돌아 수 분 걸린다.
- **UI 게이트**: `pnpm lint`(`--max-warnings=0`)·`pnpm test`(전체)·`pnpm build`(`tsc -b` — esbuild가 못 잡는 타입 에러의 최종 게이트).
- **task 그룹 독립성**(spec 헤더): Task 1–4(삭제)와 Task 5–6(에디터)은 서로 독립 — 어느 그룹이 reject돼도 다른 그룹은 그대로 merge 가능해야 한다.

---

### Task 1: 백엔드 store — `delete_cascade` + 카운트 헬퍼 + 0005 주석 갱신

**Files:**
- Create: `crates/controller/tests/scenario_delete_api_test.rs`
- Modify: `crates/controller/src/store/scenarios.rs` (파일 끝에 추가)
- Modify: `crates/controller/src/store/runs.rs` (파일 끝에 추가)
- Modify: `crates/controller/src/store/presets.rs` (파일 끝에 추가)
- Modify: `crates/controller/src/store/schedules.rs` (파일 끝에 추가)
- Modify: `crates/controller/src/store/migrations/0005_run_presets.sql:4-6` (주석만)

**Interfaces:**
- Consumes: `store::connect`, 기존 테이블 스키마(0001/0003/0005/0006/0010/0011/0013/0016+0018).
- Produces (Task 2가 사용):
  - `store::scenarios::DeleteOutcome` — `pub enum DeleteOutcome { Deleted, ActiveRuns }` (`#[derive(Debug, PartialEq)]`)
  - `store::scenarios::delete_cascade(db: &Db, id: &str) -> sqlx::Result<DeleteOutcome>`
  - `store::runs::count_by_scenario(db: &Db, scenario_id: &str) -> sqlx::Result<(i64, i64)>` — `(전체, 활성)`
  - `store::presets::count_by_scenario(db: &Db, scenario_id: &str) -> sqlx::Result<i64>`
  - `store::schedules::count_by_scenario(db: &Db, scenario_id: &str) -> sqlx::Result<i64>`

- [ ] **Step 1: 실패하는 store 테스트 작성** — `crates/controller/tests/scenario_delete_api_test.rs` 신규:

```rust
use std::sync::Arc;

use axum::body::Body;
use axum::http::{Method, Request, StatusCode};
use handicap_controller::dispatcher::NoopDispatcher;
use handicap_controller::grpc::coordinator::CoordinatorState;
use handicap_controller::{app, store};
use serde_json::{Value, json};
use tower::ServiceExt;

fn make_app(db: store::Db) -> axum::Router {
    let coord = CoordinatorState::new(db.clone());
    app::router(app::AppState {
        db,
        coord,
        dispatcher: Arc::new(NoopDispatcher),
        ui_dir: None,
        settings: handicap_controller::settings::SettingsState::build(
            &std::collections::HashMap::new(),
            &[],
        ),
        scheduler_tz: chrono_tz::UTC,
    })
}

async fn body_json(resp: axum::response::Response) -> (StatusCode, Value) {
    let status = resp.status();
    let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX)
        .await
        .unwrap();
    let v = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
    (status, v)
}

/// POST /api/scenarios로 시나리오 생성, id 반환. (엔진 파서가 유효 ULID·필수
/// 필드를 요구하므로 http 스텝 1개를 포함 — I/L/O/U 없는 고정 ULID.)
async fn create_scenario(app: &axum::Router, name: &str) -> String {
    let yaml = format!(
        "version: 1\nname: {name}\nsteps:\n  - id: 01ARZ3NDEKTSV4RRFFQ69G5FAV\n    type: http\n    name: ping\n    request:\n      method: GET\n      url: http://localhost:1/x\n",
    );
    let req = Request::builder()
        .method(Method::POST)
        .uri("/api/scenarios")
        .header("content-type", "application/json")
        .body(Body::from(serde_json::to_vec(&json!({ "yaml": yaml })).unwrap()))
        .unwrap();
    let (status, v) = body_json(app.clone().oneshot(req).await.unwrap()).await;
    assert!(status.is_success(), "create scenario: {status} {v:?}");
    v["id"].as_str().unwrap().to_string()
}

/// 삭제 정책 테스트는 참조 그래프 형태만 필요하므로 raw SQL로 시드한다
/// (Profile/Trigger 구조체 구성 불요 — 삭제 경로는 profile_json을 파싱하지 않음).
async fn seed_run(db: &store::Db, scenario_id: &str, run_id: &str, status: &str) {
    sqlx::query(
        "INSERT INTO runs(id,scenario_id,scenario_yaml,profile_json,env_json,status,created_at) \
         VALUES(?,?,?,?,?,?,0)",
    )
    .bind(run_id)
    .bind(scenario_id)
    .bind("version: 1\nname: x\nsteps: []\n")
    .bind("{\"vus\":1,\"duration_seconds\":1}")
    .bind("{}")
    .bind(status)
    .execute(db)
    .await
    .unwrap();
}

/// run 산하 메트릭 6테이블에 각 1행 시드 (cascade 전수 삭제 검증용).
async fn seed_metric_rows(db: &store::Db, run_id: &str) {
    for sql in [
        "INSERT INTO run_metrics(run_id,ts_second,step_id,worker_id,count,error_count,hdr_histogram,status_counts) VALUES(?,0,'S','',1,0,x'00','{}')",
        "INSERT INTO run_loop_metrics(run_id,step_id,loop_index,count,error_count) VALUES(?,'S',0,1,0)",
        "INSERT INTO run_if_metrics(run_id,step_id,branch,count) VALUES(?,'S','then',1)",
        "INSERT INTO run_group_metrics(run_id,step_id,hdr_histogram,count) VALUES(?,'S',x'00',1)",
        "INSERT INTO run_phase_metrics(run_id,step_id,phase,hdr_histogram,count) VALUES(?,'S','wait',x'00',1)",
        "INSERT INTO run_active_vu_metrics(run_id,ts_second,worker_id,desired,actual) VALUES(?,0,'',1,1)",
    ] {
        sqlx::query(sql).bind(run_id).execute(db).await.unwrap();
    }
}

async fn seed_preset(db: &store::Db, scenario_id: &str, id: &str) {
    sqlx::query(
        "INSERT INTO run_presets(id,scenario_id,name,profile_json,env_json,created_at,updated_at) \
         VALUES(?,?,?,'{\"vus\":1,\"duration_seconds\":1}','{}',0,0)",
    )
    .bind(id)
    .bind(scenario_id)
    .bind(id) // name — 스코프 내 유니크면 충분
    .execute(db)
    .await
    .unwrap();
}

async fn seed_schedule(db: &store::Db, scenario_id: &str, id: &str) {
    sqlx::query(
        "INSERT INTO schedules(id,name,scenario_id,profile_json,env_json,trigger_kind,cron_expr,run_at,enabled,next_run_at,created_at,updated_at) \
         VALUES(?,?,?,'{\"vus\":1,\"duration_seconds\":1}','{}','once',NULL,0,1,NULL,0,0)",
    )
    .bind(id)
    .bind(id) // name — UNIQUE 인덱스라 id 재사용
    .bind(scenario_id)
    .execute(db)
    .await
    .unwrap();
}

async fn seed_schedule_event(db: &store::Db, schedule_id: &str, id: &str) {
    sqlx::query(
        "INSERT INTO schedule_events(id,schedule_id,at,kind,run_id,detail) \
         VALUES(?,?,0,'fired','R-gone',NULL)",
    )
    .bind(id)
    .bind(schedule_id)
    .execute(db)
    .await
    .unwrap();
}

async fn count(db: &store::Db, table: &str, col: &str, id: &str) -> i64 {
    sqlx::query_scalar(&format!("SELECT COUNT(*) FROM {table} WHERE {col} = ?"))
        .bind(id)
        .fetch_one(db)
        .await
        .unwrap()
}

// ── Task 1: store 레벨 ─────────────────────────────────────────────

#[tokio::test]
async fn delete_cascade_removes_full_graph_and_spares_other_scenarios() {
    let db = store::connect("sqlite::memory:").await.unwrap();
    let app = make_app(db.clone());
    let sid = create_scenario(&app, "victim").await;
    let other = create_scenario(&app, "bystander").await;

    seed_run(&db, &sid, "R1", "completed").await;
    seed_metric_rows(&db, "R1").await;
    seed_preset(&db, &sid, "P1").await;
    seed_schedule(&db, &sid, "SC1").await;
    seed_schedule_event(&db, "SC1", "EV1").await;

    seed_run(&db, &other, "R2", "completed").await;
    seed_metric_rows(&db, "R2").await;
    seed_preset(&db, &other, "P2").await;
    seed_schedule(&db, &other, "SC2").await;

    let outcome = store::scenarios::delete_cascade(&db, &sid).await.unwrap();
    assert_eq!(outcome, store::scenarios::DeleteOutcome::Deleted);

    // victim 스코프 전 테이블 0행
    assert_eq!(count(&db, "scenarios", "id", &sid).await, 0);
    assert_eq!(count(&db, "runs", "scenario_id", &sid).await, 0);
    for t in [
        "run_metrics",
        "run_loop_metrics",
        "run_if_metrics",
        "run_group_metrics",
        "run_phase_metrics",
        "run_active_vu_metrics",
    ] {
        assert_eq!(count(&db, t, "run_id", "R1").await, 0, "{t} orphan");
    }
    assert_eq!(count(&db, "run_presets", "scenario_id", &sid).await, 0);
    assert_eq!(count(&db, "schedules", "scenario_id", &sid).await, 0);
    assert_eq!(count(&db, "schedule_events", "schedule_id", "SC1").await, 0);

    // bystander 무손상
    assert_eq!(count(&db, "scenarios", "id", &other).await, 1);
    assert_eq!(count(&db, "runs", "scenario_id", &other).await, 1);
    assert_eq!(count(&db, "run_metrics", "run_id", "R2").await, 1);
    assert_eq!(count(&db, "run_presets", "scenario_id", &other).await, 1);
    assert_eq!(count(&db, "schedules", "scenario_id", &other).await, 1);
}

#[tokio::test]
async fn delete_cascade_refuses_active_run_without_mutation() {
    let db = store::connect("sqlite::memory:").await.unwrap();
    let app = make_app(db.clone());
    let sid = create_scenario(&app, "busy").await;
    seed_run(&db, &sid, "R1", "running").await;
    seed_preset(&db, &sid, "P1").await;

    let outcome = store::scenarios::delete_cascade(&db, &sid).await.unwrap();
    assert_eq!(outcome, store::scenarios::DeleteOutcome::ActiveRuns);

    assert_eq!(count(&db, "scenarios", "id", &sid).await, 1);
    assert_eq!(count(&db, "runs", "scenario_id", &sid).await, 1);
    assert_eq!(count(&db, "run_presets", "scenario_id", &sid).await, 1);
}

#[tokio::test]
async fn count_helpers_report_totals_and_active() {
    let db = store::connect("sqlite::memory:").await.unwrap();
    let app = make_app(db.clone());
    let sid = create_scenario(&app, "counted").await;
    seed_run(&db, &sid, "R1", "completed").await;
    seed_run(&db, &sid, "R2", "running").await;
    seed_preset(&db, &sid, "P1").await;
    seed_schedule(&db, &sid, "SC1").await;

    assert_eq!(
        store::runs::count_by_scenario(&db, &sid).await.unwrap(),
        (2, 1)
    );
    assert_eq!(
        store::presets::count_by_scenario(&db, &sid).await.unwrap(),
        1
    );
    assert_eq!(
        store::schedules::count_by_scenario(&db, &sid).await.unwrap(),
        1
    );
}
```

- [ ] **Step 2: 컴파일 실패 확인**

Run: `cargo test -p handicap-controller --test scenario_delete_api_test --no-run`
Expected: FAIL — `delete_cascade`/`DeleteOutcome`/`count_by_scenario` 미정의(E0425/E0433).

- [ ] **Step 3: store 구현** — `crates/controller/src/store/scenarios.rs` 파일 끝에 추가:

```rust
#[derive(Debug, PartialEq)]
pub enum DeleteOutcome {
    Deleted,
    ActiveRuns,
}

/// 시나리오와 참조 그래프 전체(run 이력+메트릭 6테이블·프리셋·스케줄)를 단일
/// 트랜잭션으로 삭제한다 (ADR-0045). 권위 hard 가드는 트랜잭션 *안*의 재확인 —
/// 핸들러의 advisory 체크와 이 트랜잭션 사이에 커밋된 run도 여기서 잡힌다.
/// EXISTS와 첫 DELETE 사이에 끼어드는 동시 쓰기는 WAL busy/snapshot으로 tx가
/// 시끄럽게 실패한다(silent 경로 없음 — spec §3-5).
pub async fn delete_cascade(db: &Db, id: &str) -> sqlx::Result<DeleteOutcome> {
    let mut tx = db.begin().await?;
    let active: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM runs WHERE scenario_id = ? AND status IN ('pending','running'))",
    )
    .bind(id)
    .fetch_one(&mut *tx)
    .await?;
    if active {
        tx.rollback().await?;
        return Ok(DeleteOutcome::ActiveRuns);
    }
    // 자식 → 부모 순서 (foreign_keys=ON이 순서 오류를 즉시 거부).
    // 메트릭 테이블 일부는 FK 없이 run_id만 가지므로 6테이블 전수 명시 삭제.
    for table in [
        "run_metrics",
        "run_loop_metrics",
        "run_if_metrics",
        "run_group_metrics",
        "run_phase_metrics",
        "run_active_vu_metrics",
    ] {
        sqlx::query(&format!(
            "DELETE FROM {table} WHERE run_id IN (SELECT id FROM runs WHERE scenario_id = ?)"
        ))
        .bind(id)
        .execute(&mut *tx)
        .await?;
    }
    sqlx::query("DELETE FROM runs WHERE scenario_id = ?")
        .bind(id)
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM run_presets WHERE scenario_id = ?")
        .bind(id)
        .execute(&mut *tx)
        .await?;
    // schedule_events는 schedules FK의 ON DELETE CASCADE로 함께 삭제된다(0011).
    sqlx::query("DELETE FROM schedules WHERE scenario_id = ?")
        .bind(id)
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM scenarios WHERE id = ?")
        .bind(id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(DeleteOutcome::Deleted)
}
```

`crates/controller/src/store/runs.rs` 파일 끝에 추가:

```rust
/// (전체 run 수, 활성[pending/running] run 수) — 시나리오 삭제의 soft 409
/// 카운트·advisory hard fast-fail 판정용 (권위 판정은 delete_cascade in-tx).
pub async fn count_by_scenario(db: &Db, scenario_id: &str) -> sqlx::Result<(i64, i64)> {
    let row = sqlx::query(
        "SELECT COUNT(*) AS total, \
                COALESCE(SUM(CASE WHEN status IN ('pending','running') THEN 1 ELSE 0 END), 0) AS active \
         FROM runs WHERE scenario_id = ?",
    )
    .bind(scenario_id)
    .fetch_one(db)
    .await?;
    Ok((row.get("total"), row.get("active")))
}
```

`crates/controller/src/store/presets.rs` 파일 끝에 추가:

```rust
/// 시나리오 삭제 soft 409 카운트용.
pub async fn count_by_scenario(db: &Db, scenario_id: &str) -> sqlx::Result<i64> {
    sqlx::query_scalar("SELECT COUNT(*) FROM run_presets WHERE scenario_id = ?")
        .bind(scenario_id)
        .fetch_one(db)
        .await
}
```

`crates/controller/src/store/schedules.rs` 파일 끝에 추가:

```rust
/// 시나리오 삭제 soft 409 카운트용.
pub async fn count_by_scenario(db: &Db, scenario_id: &str) -> sqlx::Result<i64> {
    sqlx::query_scalar("SELECT COUNT(*) FROM schedules WHERE scenario_id = ?")
        .bind(scenario_id)
        .fetch_one(db)
        .await
}
```

- [ ] **Step 4: 0005 주석 갱신** — `crates/controller/src/store/migrations/0005_run_presets.sql`의 4–6행 주석을 다음으로 교체 (주석-only — 러너는 `include_str!`+멱등 재실행이라 checksum 원장이 없어 안전):

기존:
```sql
-- NOTE: scenario_id has no ON DELETE CASCADE — there is no scenario-delete endpoint
-- today (spec §1). A future scenario-delete spec MUST add ON DELETE CASCADE here,
-- because the pool runs with foreign_keys=ON (store/mod.rs).
```

교체:
```sql
-- NOTE: scenario_id has no ON DELETE CASCADE — intentional. Scenario delete is an
-- app-level transactional cascade (store/scenarios.rs::delete_cascade, ADR-0045):
-- SQLite can't add FK actions to an existing table without a rebuild, and the
-- explicit child->parent delete order is verified by foreign_keys=ON (store/mod.rs).
```

- [ ] **Step 5: 테스트 green 확인**

Run: `cargo test -p handicap-controller --test scenario_delete_api_test`
Expected: PASS (3 tests).

- [ ] **Step 6: 커밋**

```bash
git add crates/controller/tests/scenario_delete_api_test.rs crates/controller/src/store/scenarios.rs crates/controller/src/store/runs.rs crates/controller/src/store/presets.rs crates/controller/src/store/schedules.rs crates/controller/src/store/migrations/0005_run_presets.sql
git commit -m "feat(controller): 시나리오 delete_cascade store 코어 — in-tx 활성 run 가드 + 참조 그래프 전수 삭제 (R2/R4)"
```
(cargo 게이트 — 수 분 소요. foreground 단일 호출.)

---

### Task 2: 백엔드 API — `DELETE /api/scenarios/{id}` 핸들러 + 라우트

**Files:**
- Modify: `crates/controller/tests/scenario_delete_api_test.rs` (테스트 추가)
- Modify: `crates/controller/src/api/scenarios.rs` (파일 끝에 핸들러 추가)
- Modify: `crates/controller/src/app.rs:44-47` (라우트 체인)

**Interfaces:**
- Consumes: Task 1의 `delete_cascade`/`DeleteOutcome`/`count_by_scenario` 3종, `ApiError::{NotFound, Conflict, ConflictJson}` (`error.rs`).
- Produces: `DELETE /api/scenarios/{id}?force=<bool>` — 404 / hard 409 `{"error": string}` / soft 409 `{"error", "runs", "presets", "schedules"}` / 204. (Task 3 UI 클라이언트의 와이어 계약.)

- [ ] **Step 1: 실패하는 API 테스트 추가** — `scenario_delete_api_test.rs` 끝에 append:

```rust
// ── Task 2: API 레벨 ─────────────────────────────────────────────

async fn send_delete(app: &axum::Router, sid: &str, force: bool) -> (StatusCode, Value) {
    let uri = if force {
        format!("/api/scenarios/{sid}?force=true")
    } else {
        format!("/api/scenarios/{sid}")
    };
    let req = Request::builder()
        .method(Method::DELETE)
        .uri(uri)
        .body(Body::empty())
        .unwrap();
    body_json(app.clone().oneshot(req).await.unwrap()).await
}

#[tokio::test]
async fn delete_nonexistent_scenario_404() {
    let db = store::connect("sqlite::memory:").await.unwrap();
    let app = make_app(db);
    let (status, _) = send_delete(&app, "NOPE", false).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn delete_unreferenced_scenario_immediate_204() {
    let db = store::connect("sqlite::memory:").await.unwrap();
    let app = make_app(db.clone());
    let sid = create_scenario(&app, "fresh").await;

    let (status, _) = send_delete(&app, &sid, false).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    assert_eq!(count(&db, "scenarios", "id", &sid).await, 0);

    // 재요청(더블클릭/stale 목록) → 404
    let (status, _) = send_delete(&app, &sid, false).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn active_run_hard_409_for_both_force_values() {
    let db = store::connect("sqlite::memory:").await.unwrap();
    let app = make_app(db.clone());
    let sid = create_scenario(&app, "busy").await;
    seed_run(&db, &sid, "R1", "running").await;

    for force in [false, true] {
        let (status, v) = send_delete(&app, &sid, force).await;
        assert_eq!(status, StatusCode::CONFLICT, "force={force}");
        // hard shape: 문자열 error만, 숫자 카운트 키 없음 (soft와 구분 — R5 판별자)
        assert!(v["error"].is_string(), "force={force}: {v:?}");
        assert!(v.get("runs").is_none(), "force={force}: {v:?}");
    }
    assert_eq!(count(&db, "scenarios", "id", &sid).await, 1);
}

#[tokio::test]
async fn soft_409_counts_then_force_cascades() {
    let db = store::connect("sqlite::memory:").await.unwrap();
    let app = make_app(db.clone());
    let sid = create_scenario(&app, "referenced").await;
    seed_run(&db, &sid, "R1", "completed").await;
    seed_run(&db, &sid, "R2", "failed").await;
    seed_preset(&db, &sid, "P1").await;
    seed_schedule(&db, &sid, "SC1").await;

    let (status, v) = send_delete(&app, &sid, false).await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert!(v["error"].is_string());
    assert_eq!(v["runs"], 2);
    assert_eq!(v["presets"], 1);
    assert_eq!(v["schedules"], 1);
    assert_eq!(count(&db, "scenarios", "id", &sid).await, 1); // 무변이

    let (status, _) = send_delete(&app, &sid, true).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    assert_eq!(count(&db, "scenarios", "id", &sid).await, 0);
    assert_eq!(count(&db, "runs", "scenario_id", &sid).await, 0);
}

#[tokio::test]
async fn soft_409_fires_for_presets_only() {
    let db = store::connect("sqlite::memory:").await.unwrap();
    let app = make_app(db.clone());
    let sid = create_scenario(&app, "preset-only").await;
    seed_preset(&db, &sid, "P1").await;

    let (status, v) = send_delete(&app, &sid, false).await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(v["runs"], 0);
    assert_eq!(v["presets"], 1);
    assert_eq!(v["schedules"], 0);
}

#[tokio::test]
async fn soft_409_fires_for_runs_only() {
    let db = store::connect("sqlite::memory:").await.unwrap();
    let app = make_app(db.clone());
    let sid = create_scenario(&app, "runs-only").await;
    seed_run(&db, &sid, "R1", "completed").await;

    let (status, v) = send_delete(&app, &sid, false).await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(v["runs"], 1);
    assert_eq!(v["presets"], 0);
    assert_eq!(v["schedules"], 0);
}

#[tokio::test]
async fn soft_409_fires_for_schedules_only() {
    let db = store::connect("sqlite::memory:").await.unwrap();
    let app = make_app(db.clone());
    let sid = create_scenario(&app, "sched-only").await;
    seed_schedule(&db, &sid, "SC1").await;

    let (status, v) = send_delete(&app, &sid, false).await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(v["runs"], 0);
    assert_eq!(v["presets"], 0);
    assert_eq!(v["schedules"], 1);
}
```

- [ ] **Step 2: 컴파일은 되지만 라우트 부재로 실패 확인**

Run: `cargo test -p handicap-controller --test scenario_delete_api_test delete_nonexistent`
Expected: FAIL — DELETE 라우트 미등록이라 405 Method Not Allowed (404 기대와 불일치).

- [ ] **Step 3: 핸들러 구현** — `crates/controller/src/api/scenarios.rs`: 상단 import에 `Query` 추가(`use axum::extract::{Path, Query, State};`), 파일 끝에 추가:

```rust
const ACTIVE_RUN_DELETE_MSG: &str =
    "이 시나리오의 실행 중(pending/running) run이 있어 삭제할 수 없습니다";

#[derive(Debug, Deserialize)]
pub struct DeleteQuery {
    #[serde(default)]
    pub force: bool,
}

/// DELETE /api/scenarios/{id}?force=
/// - 활성(pending/running) run 참조 → hard 409 (force로도 못 지움). 핸들러 체크는
///   advisory fast-fail — 권위 판정은 delete_cascade 트랜잭션 안(spec §3-5).
/// - 그 외 참조(run 이력·프리셋·스케줄) + force=false → soft 409 + 카운트 JSON.
/// - force=true → 참조 그래프 전체 cascade 삭제(ADR-0045) 후 204.
pub async fn delete(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Query(q): Query<DeleteQuery>,
) -> Result<StatusCode, ApiError> {
    if scenarios::get(&state.db, &id).await?.is_none() {
        return Err(ApiError::NotFound);
    }
    let (run_total, run_active) = crate::store::runs::count_by_scenario(&state.db, &id).await?;
    if run_active > 0 {
        return Err(ApiError::Conflict(ACTIVE_RUN_DELETE_MSG.into()));
    }
    let presets = crate::store::presets::count_by_scenario(&state.db, &id).await?;
    let schedules = crate::store::schedules::count_by_scenario(&state.db, &id).await?;
    if !q.force && (run_total + presets + schedules) > 0 {
        return Err(ApiError::ConflictJson(serde_json::json!({
            "error": "이 시나리오를 참조하는 데이터가 있습니다 — force=true로 함께 삭제할 수 있습니다",
            "runs": run_total,
            "presets": presets,
            "schedules": schedules,
        })));
    }
    match scenarios::delete_cascade(&state.db, &id).await? {
        scenarios::DeleteOutcome::Deleted => Ok(StatusCode::NO_CONTENT),
        scenarios::DeleteOutcome::ActiveRuns => {
            Err(ApiError::Conflict(ACTIVE_RUN_DELETE_MSG.into()))
        }
    }
}
```

`crates/controller/src/app.rs`의 `/scenarios/{id}` 라우트를 다음으로 교체:

```rust
        .route(
            "/scenarios/{id}",
            get(scenarios_api::get)
                .put(scenarios_api::update)
                .delete(scenarios_api::delete),
        )
```

- [ ] **Step 4: 테스트 green 확인**

Run: `cargo test -p handicap-controller --test scenario_delete_api_test`
Expected: PASS (10 tests — Task 1의 3 + Task 2의 7; soft 409 콤보 = runs만/presets만/schedules만/셋 다, spec R3 acceptance 전수).

- [ ] **Step 5: 커밋**

```bash
git add crates/controller/tests/scenario_delete_api_test.rs crates/controller/src/api/scenarios.rs crates/controller/src/app.rs
git commit -m "feat(controller): DELETE /api/scenarios/{id} — advisory hard 409·soft 카운트 409·force cascade (R1–R3)"
```

---

### Task 3: UI client — `deleteScenario` + `useDeleteScenario`

**Files:**
- Create: `ui/src/api/__tests__/deleteScenario.test.ts`
- Modify: `ui/src/api/client.ts` (`deleteDatasetImpl` 아래에 미러 추가 + `api` 객체 항목)
- Modify: `ui/src/api/hooks.ts` (`useDeleteDataset` 아래에 미러 추가)

**Interfaces:**
- Consumes: 서버 와이어 계약(Task 2) — 204 / soft 409 `{runs,presets,schedules}: number` / hard 409 `{error}: string`.
- Produces (Task 4가 사용):
  - `export type ScenarioDeleteRefs = { runs: number; presets: number; schedules: number }`
  - `export type DeleteScenarioResult = { deleted: true } | { deleted: false; refs: ScenarioDeleteRefs }`
  - `api.deleteScenario(id: string, force = false): Promise<DeleteScenarioResult>` — hard 409/기타 비-2xx는 `ApiError` throw
  - `useDeleteScenario()` — mutation `{id: string; force?: boolean}`; `deleted===true`일 때만 `queryKeys.scenarios()` invalidate

- [ ] **Step 1: 실패하는 클라이언트 테스트 작성** — `ui/src/api/__tests__/deleteScenario.test.ts` 신규:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, api } from "../client";

const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("api.deleteScenario", () => {
  it("204 → {deleted:true}, force 시 쿼리 포함", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
    const result = await api.deleteScenario("S1", true);
    expect(result).toEqual({ deleted: true });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/api/scenarios/S1?force=true");
    expect(init.method).toBe("DELETE");
  });

  it("force 미지정이면 쿼리 없음", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
    await api.deleteScenario("S1");
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toContain("/api/scenarios/S1");
    expect(url).not.toContain("force");
  });

  it("soft 409(숫자 카운트) → {deleted:false, refs}", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ error: "참조", runs: 2, presets: 1, schedules: 0 }, 409),
    );
    const result = await api.deleteScenario("S1");
    expect(result).toEqual({
      deleted: false,
      refs: { runs: 2, presets: 1, schedules: 0 },
    });
  });

  it("hard 409(문자열 error만) → ApiError throw", async () => {
    // 호출마다 fresh Response — 한 Response 재사용은 두 번째 res.json()이
    // consumed body로 떨어져 단언이 약해진다
    fetchMock.mockImplementation(() =>
      Promise.resolve(jsonResponse({ error: "실행 중 run" }, 409)),
    );
    await expect(api.deleteScenario("S1")).rejects.toThrowError(
      expect.objectContaining({ message: "실행 중 run" }) as Error,
    );
    await expect(
      api.deleteScenario("S1").catch((e) => Promise.reject(e instanceof ApiError)),
    ).rejects.toBe(true);
  });

  it("기타 비-2xx → ApiError throw", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: "nf" }, 404));
    await expect(api.deleteScenario("S1")).rejects.toBeInstanceOf(ApiError);
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `cd ui && pnpm test deleteScenario`
Expected: FAIL — `api.deleteScenario`가 존재하지 않음.

- [ ] **Step 3: 구현** — `ui/src/api/client.ts`의 `deleteDatasetImpl` 함수 아래에 추가:

```ts
export type ScenarioDeleteRefs = { runs: number; presets: number; schedules: number };
export type DeleteScenarioResult = { deleted: true } | { deleted: false; refs: ScenarioDeleteRefs };

/** DELETE a scenario. 204 → deleted. Soft 409 (참조 카운트 포함) →
 *  {deleted:false, refs}. Hard 409 (활성 run — 문자열 error만)·기타 비-2xx → throws.
 *  판별자: soft 409 본문에만 숫자 runs/presets/schedules 키가 있다 (deleteDatasetImpl 미러). */
async function deleteScenarioImpl(id: string, force: boolean): Promise<DeleteScenarioResult> {
  const res = await fetch(
    `${BASE}/scenarios/${encodeURIComponent(id)}${force ? "?force=true" : ""}`,
    { method: "DELETE" },
  );
  if (res.status === 204) return { deleted: true };
  if (res.status === 409) {
    const body = await res.json().catch(() => ({}) as Record<string, unknown>);
    const b = body as { runs?: unknown; presets?: unknown; schedules?: unknown; error?: unknown };
    if (
      typeof b.runs === "number" &&
      typeof b.presets === "number" &&
      typeof b.schedules === "number"
    ) {
      return {
        deleted: false,
        refs: { runs: b.runs, presets: b.presets, schedules: b.schedules },
      };
    }
    throw new ApiError(409, typeof b.error === "string" ? b.error : "conflict");
  }
  const body = await res.json().catch(() => ({}) as Record<string, unknown>);
  const msg = (body as { error?: unknown }).error;
  throw new ApiError(res.status, typeof msg === "string" ? msg : `${res.status} ${res.statusText}`);
}
```

`api` 객체의 `deleteDataset` 항목 아래에 추가:

```ts
  deleteScenario: (id: string, force = false): Promise<DeleteScenarioResult> =>
    deleteScenarioImpl(id, force),
```

`ui/src/api/hooks.ts`의 `useDeleteDataset` 아래에 추가:

```ts
export function useDeleteScenario() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, force }: { id: string; force?: boolean }) => api.deleteScenario(id, force),
    onSuccess: (result) => {
      if (result.deleted) qc.invalidateQueries({ queryKey: queryKeys.scenarios() });
    },
  });
}
```

- [ ] **Step 4: green 확인**

Run: `cd ui && pnpm test deleteScenario`
Expected: PASS (5 tests).

- [ ] **Step 5: 커밋**

```bash
git add ui/src/api/__tests__/deleteScenario.test.ts ui/src/api/client.ts ui/src/api/hooks.ts
git commit -m "feat(ui): deleteScenario 클라이언트 + useDeleteScenario — soft/hard 409 판별 (R5)"
```

---

### Task 4: UI — `ScenarioListPage` 삭제 흐름 + ko 키

**Files:**
- Create: `ui/src/pages/__tests__/ScenarioListPage.delete.test.tsx`
- Modify: `ui/src/pages/ScenarioListPage.tsx`
- Modify: `ui/src/i18n/ko.ts` (`pages` 섹션)

**Interfaces:**
- Consumes: Task 3의 `useDeleteScenario`, `ko.pages.delete*` 신규 키.
- Produces: 사용자 노출 삭제 흐름(2단 confirm + 실패 배너). 후속 task 의존 없음.

- [ ] **Step 1: 실패하는 RTL 테스트 작성** — `ui/src/pages/__tests__/ScenarioListPage.delete.test.tsx` 신규 (`ScenarioListPage.clone.test.tsx`의 fetch 목/렌더 헬퍼 미러):

```tsx
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ko } from "../../i18n/ko";
import { ScenarioListPage } from "../ScenarioListPage";

const fetchMock = vi.fn();
let confirmSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  confirmSpy = vi.spyOn(window, "confirm");
});
afterEach(() => {
  confirmSpy.mockRestore();
  vi.unstubAllGlobals();
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const DEMO = {
  id: "S1",
  name: "demo",
  yaml: "version: 1\nname: demo\nsteps: []\n",
  version: 1,
  created_at: 0,
  updated_at: 0,
};

/** DELETE 응답 시퀀스를 주입하는 fetch 라우터. */
function routeFetch(deleteResponses: Response[]) {
  return (url: string, init?: RequestInit): Response => {
    const method = init?.method ?? "GET";
    if (method === "DELETE" && url.includes("/api/scenarios/S1")) {
      const next = deleteResponses.shift();
      if (!next) throw new Error("unexpected extra DELETE");
      return next;
    }
    if (url.endsWith("/api/scenarios") && method === "GET")
      return jsonResponse({ scenarios: [DEMO] });
    return jsonResponse({ error: "unexpected" }, 500);
  };
}

function renderPage(deleteResponses: Response[]) {
  fetchMock.mockImplementation((url: string | URL, init?: RequestInit) =>
    Promise.resolve(routeFetch(deleteResponses)(String(url), init)),
  );
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <ScenarioListPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const deleteCalls = () =>
  fetchMock.mock.calls.filter(
    (c) => (c[1] as RequestInit | undefined)?.method === "DELETE",
  );

const listCalls = () =>
  fetchMock.mock.calls.filter(
    (c) =>
      String(c[0]).endsWith("/api/scenarios") &&
      ((c[1] as RequestInit | undefined)?.method ?? "GET") === "GET",
  );

describe("ScenarioListPage delete", () => {
  it("참조 0: 1차 confirm 후 즉시 삭제 (force 없이 1회 호출)", async () => {
    const user = userEvent.setup();
    confirmSpy.mockReturnValue(true);
    renderPage([new Response(null, { status: 204 })]);
    await screen.findByRole("link", { name: "demo" });

    await user.click(screen.getByRole("button", { name: ko.pages.deleteBtn }));

    await waitFor(() => expect(deleteCalls()).toHaveLength(1));
    expect(String(deleteCalls()[0][0])).not.toContain("force");
    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(confirmSpy).toHaveBeenCalledWith(ko.pages.deleteConfirm("demo"));
    // deleted:true → ["scenarios"] invalidate → 목록 재페치 (R5 invalidate 조건)
    await waitFor(() => expect(listCalls().length).toBeGreaterThanOrEqual(2));
  });

  it("1차 confirm 거절 시 호출 0", async () => {
    const user = userEvent.setup();
    confirmSpy.mockReturnValue(false);
    renderPage([]);
    await screen.findByRole("link", { name: "demo" });

    await user.click(screen.getByRole("button", { name: ko.pages.deleteBtn }));

    expect(deleteCalls()).toHaveLength(0);
  });

  it("soft 409 → 참조 요약 2차 confirm → force 재요청", async () => {
    const user = userEvent.setup();
    confirmSpy.mockReturnValue(true);
    renderPage([
      jsonResponse({ error: "참조", runs: 3, presets: 1, schedules: 0 }, 409),
      new Response(null, { status: 204 }),
    ]);
    await screen.findByRole("link", { name: "demo" });

    await user.click(screen.getByRole("button", { name: ko.pages.deleteBtn }));

    await waitFor(() => expect(deleteCalls()).toHaveLength(2));
    expect(String(deleteCalls()[1][0])).toContain("force=true");
    expect(confirmSpy).toHaveBeenCalledTimes(2);
    // 0인 항목(schedules)은 요약에서 생략 (spec 엣지 #4)
    const summary = confirmSpy.mock.calls[1][0] as string;
    expect(summary).toContain("run 이력 3건");
    expect(summary).toContain("프리셋 1건");
    expect(summary).not.toContain("스케줄");
  });

  it("2차 confirm 거절 시 force 미호출", async () => {
    const user = userEvent.setup();
    confirmSpy.mockReturnValueOnce(true).mockReturnValueOnce(false);
    renderPage([
      jsonResponse({ error: "참조", runs: 1, presets: 0, schedules: 0 }, 409),
    ]);
    await screen.findByRole("link", { name: "demo" });

    await user.click(screen.getByRole("button", { name: ko.pages.deleteBtn }));

    await waitFor(() => expect(deleteCalls()).toHaveLength(1));
    expect(confirmSpy).toHaveBeenCalledTimes(2);
    // deleted:false(force 거절) → invalidate 없음 — 초기 목록 GET 1회뿐 (R5)
    expect(listCalls()).toHaveLength(1);
  });

  it("삭제 진행 중엔 행 삭제 버튼 disabled (R6 pending)", async () => {
    const user = userEvent.setup();
    confirmSpy.mockReturnValue(true);
    // 영영 안 끝나는 DELETE — pending 상태 고정
    fetchMock.mockImplementation((url: string | URL, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method === "DELETE") return new Promise<Response>(() => {});
      return Promise.resolve(routeFetch([])(String(url), init));
    });
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter>
          <ScenarioListPage />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    await screen.findByRole("link", { name: "demo" });

    const btn = screen.getByRole("button", { name: ko.pages.deleteBtn });
    await user.click(btn);
    await waitFor(() => expect(btn).toBeDisabled());
  });

  it("hard 409 → role=alert 배너에 서버 문구 passthrough", async () => {
    const user = userEvent.setup();
    confirmSpy.mockReturnValue(true);
    renderPage([jsonResponse({ error: "실행 중 run이 있어 삭제할 수 없습니다" }, 409)]);
    await screen.findByRole("link", { name: "demo" });

    await user.click(screen.getByRole("button", { name: ko.pages.deleteBtn }));

    const banner = await screen.findByRole("alert");
    expect(banner).toHaveTextContent("실행 중 run이 있어 삭제할 수 없습니다");
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `cd ui && pnpm test ScenarioListPage.delete`
Expected: FAIL — `ko.pages.deleteBtn` 미정의 / 삭제 버튼 부재.

- [ ] **Step 3: ko 키 추가** — `ui/src/i18n/ko.ts`의 `pages` 섹션(`duplicatingBtn` 아래)에 추가:

```ts
    deleteBtn: "삭제",
    deleteConfirm: (name: string) => `'${name}' 시나리오를 삭제할까요?`,
    deleteCascadeConfirm: (name: string, runs: number, presets: number, schedules: number) => {
      const parts = [
        runs > 0 ? `run 이력 ${runs}건` : null,
        presets > 0 ? `프리셋 ${presets}건` : null,
        schedules > 0 ? `스케줄 ${schedules}건` : null,
      ].filter((p): p is string => p !== null);
      return `'${name}' 시나리오를 참조하는 ${parts.join("·")}이(가) 함께 삭제됩니다. 계속할까요?`;
    },
    deleteFailed: (msg: string) => `삭제 실패: ${msg}`,
```

- [ ] **Step 4: 페이지 구현** — `ui/src/pages/ScenarioListPage.tsx`:

import에 `useState`(react)·`useDeleteScenario`(hooks) 추가, 컴포넌트 본문 상단에:

```tsx
  const del = useDeleteScenario();
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const onDelete = async (s: { id: string; name: string }) => {
    setDeleteError(null);
    if (!window.confirm(ko.pages.deleteConfirm(s.name))) return;
    try {
      const result = await del.mutateAsync({ id: s.id, force: false });
      if (result.deleted) return;
      const { runs, presets, schedules } = result.refs;
      if (!window.confirm(ko.pages.deleteCascadeConfirm(s.name, runs, presets, schedules)))
        return;
      await del.mutateAsync({ id: s.id, force: true });
    } catch (e) {
      setDeleteError((e as Error).message);
    }
  };
```

clone 에러 Callout 아래에 삭제-실패 배너(동일 관용구):

```tsx
      {deleteError && (
        <Callout variant="error" role="alert" className="mb-3">
          {ko.pages.deleteFailed(deleteError)}
        </Callout>
      )}
```

행 액션 `<div className="flex justify-end gap-3">` 안, 복제 버튼과 실행 링크 사이에:

```tsx
                    <button
                      type="button"
                      onClick={() => void onDelete(s)}
                      disabled={del.isPending}
                      className="text-red-600 hover:underline disabled:text-slate-400"
                    >
                      {ko.pages.deleteBtn}
                    </button>
```

- [ ] **Step 5: green 확인 + 기존 목록 테스트 회귀 확인**

Run: `cd ui && pnpm test ScenarioListPage`
Expected: PASS — delete 6(2단 confirm 3종 + invalidate 조건 양분기 + hard 배너 + pending disabled) + 기존 clone/home 테스트 전부.

- [ ] **Step 6: 커밋**

```bash
git add ui/src/pages/__tests__/ScenarioListPage.delete.test.tsx ui/src/pages/ScenarioListPage.tsx ui/src/i18n/ko.ts
git commit -m "feat(ui): 시나리오 목록 행 삭제 — 2단 confirm(참조 요약)·hard 409 배너 (R6/R10)"
```

---

### Task 5: UI — `ScenarioEditPage` false-dirty 제거 (선적재 시드 + `seeded` 게이트)

**Files:**
- Create: `ui/src/pages/__tests__/ScenarioEditPage.dirty.test.tsx`
- Modify: `ui/src/pages/ScenarioEditPage.tsx`
- (필요 시) Modify: `ui/src/pages/__tests__/ScenarioEditPage.save.test.tsx` · `ScenarioEditPage.clone.test.tsx` (Step 5 참고)

**Interfaces:**
- Consumes: `useScenarioEditor.getState().loadFromString / .yamlText`(기존 store), `ScenarioNewPage.chooseTemplate` 패턴.
- Produces (Task 6이 사용): 페이지 로컬 `seeded: boolean`(= `seededId === data.id`) 상태 — Task 6의 `liveName`/연필 게이트가 이 값을 읽는다. `baselineSeededRef`는 삭제됨.

- [ ] **Step 1: 실패하는 RTL 테스트 작성** — `ui/src/pages/__tests__/ScenarioEditPage.dirty.test.tsx` 신규. **EditorShell을 모킹하지 않는다**(실물 첫-onChange 타이밍이 버그의 본체 — U3 B1). `TestRunSection`만 모킹(무관 네트워크 차단):

```tsx
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ko } from "../../i18n/ko";
import { useScenarioEditor } from "../../scenario/store";
import { ScenarioEditPage } from "../ScenarioEditPage";

vi.mock("../../components/scenario/TestRunSection", () => ({
  TestRunSection: () => null,
}));

const fetchMock = vi.fn();
beforeEach(() => {
  useScenarioEditor.setState(useScenarioEditor.getInitialState());
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const DEMO_YAML =
  "version: 1\nname: demo\nsteps:\n  - id: 01ARZ3NDEKTSV4RRFFQ69G5FAV\n    type: http\n    name: ping\n    request:\n      method: GET\n      url: http://localhost:1/x\n";
const DEMO = {
  id: "S1",
  name: "demo",
  yaml: DEMO_YAML,
  version: 1,
  created_at: 0,
  updated_at: 0,
};

function routeFetch(url: string, init?: RequestInit): Response {
  const method = init?.method ?? "GET";
  if (url.endsWith("/api/scenarios/S1") && method === "PUT") {
    const sent = JSON.parse(String(init?.body)) as { yaml: string };
    return jsonResponse({ ...DEMO, yaml: sent.yaml, version: 2 });
  }
  if (url.endsWith("/api/scenarios/S1")) return jsonResponse(DEMO);
  if (url.endsWith("/api/scenarios") && method === "GET")
    return jsonResponse({ scenarios: [DEMO] });
  return jsonResponse({ error: "unexpected" }, 500);
}

function renderPage() {
  fetchMock.mockImplementation((url: string | URL, init?: RequestInit) =>
    Promise.resolve(routeFetch(String(url), init)),
  );
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={["/scenarios/S1"]}>
        <Routes>
          <Route path="/scenarios/:id" element={<ScenarioEditPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("ScenarioEditPage dirty baseline (false-dirty 회귀, R9)", () => {
  it("로드 직후 무편집이면 저장 버튼 disabled", async () => {
    renderPage();
    await screen.findByRole("heading", { name: "demo" });
    expect(screen.getByRole("button", { name: ko.common.save })).toBeDisabled();
  });

  it("store 편집 후 저장 버튼 enabled, 저장하면 다시 disabled", async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole("heading", { name: "demo" });

    act(() => {
      useScenarioEditor.getState().addStep("새 스텝");
    });
    const save = screen.getByRole("button", { name: ko.common.save });
    await waitFor(() => expect(save).toBeEnabled());

    await user.click(save);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: ko.common.save })).toBeDisabled(),
    );
  });

  it("시드 전 프레임에 stale store 모델 이름이 보이지 않는다 (R7 stale-model)", async () => {
    // 싱글톤 store 잔존물 재현: 다른 시나리오 모델 선주입
    useScenarioEditor
      .getState()
      .loadFromString("version: 1\nname: other\nsteps: []\n");
    const observer = new MutationObserver(() => {});
    observer.observe(document.body, {
      subtree: true,
      childList: true,
      characterData: true,
      characterDataOldValue: true,
    });
    renderPage();
    await screen.findByRole("heading", { name: "demo" });
    const records = observer.takeRecords();
    observer.disconnect();
    const sawOther = records.some(
      (r) =>
        r.oldValue === "other" ||
        Array.from(r.removedNodes).some((n) => n.textContent?.includes("other")),
    );
    expect(sawOther).toBe(false);
  });
});
```

- [ ] **Step 2: RED 확인** (현재 코드의 실버그이므로 1번째 테스트가 반드시 실패해야 한다)

Run: `cd ui && pnpm test ScenarioEditPage.dirty`
Expected: FAIL — "로드 직후" 테스트에서 저장 버튼이 enabled (false-dirty 버그 재현). stale-model 테스트는 현 코드(`data.name` 렌더)에선 PASS일 수 있음 — 정상.

- [ ] **Step 3: 페이지 수정** — `ui/src/pages/ScenarioEditPage.tsx`:

① `baselineSeededRef` 선언(:29)·기존 `[data]` effect(:37-42)·`handleEditorChange`의 시드 분기(:47-53)를 제거하고 다음으로 교체. **react import(:1)에서 `useRef`도 제거** — `baselineSeededRef`가 유일 소비처였고, `noUnusedLocals`(tsconfig)+`no-unused-vars`(eslint error)라 남기면 이 task의 lint/build 게이트가 깨진다(Task 6이 다시 추가한다):

```tsx
  const [seededId, setSeededId] = useState<string | null>(null);
  const seeded = data !== undefined && seededId === data.id;

  // ScenarioNewPage.chooseTemplate 선적재 패턴(U3 B1): EditorShell 마운트 전에
  // store를 로드 텍스트로 적재하고 그 시점 canonical을 yamlText/originalYaml
  // 양쪽에 시드 — 첫 onChange가 무엇을 캡처하든 baseline과 일치한다.
  // 재시드는 시나리오 id 변경 시만 — loadedVersion도 id-키드(같은 id의
  // 백그라운드 refetch가 낡은 편집 위에 새 버전을 silent 채택하지 않게, R9).
  useEffect(() => {
    if (!data || seededId === data.id) return;
    useScenarioEditor.getState().loadFromString(data.yaml);
    const canonical = useScenarioEditor.getState().yamlText;
    setYamlText(canonical);
    setOriginalYaml(canonical);
    setLoadedVersion(data.version);
    setSeededId(data.id);
  }, [data, seededId]);

  const handleEditorChange = useCallback((next: string) => {
    setYamlText(next);
  }, []);
```

② 저장 버튼 `onSuccess`(:126-130)와 `saveThenClone`(:84-86)에서 `baselineSeededRef.current = true;` 줄만 제거(나머지 `setLoadedVersion`/`setOriginalYaml` 유지).

③ `<EditorShell …>` 렌더(:158 부근)를 시드 게이트로 감싼다:

```tsx
      {seeded && <EditorShell initialYaml={data.yaml} onChange={handleEditorChange} />}
```

(EditorShell 마운트 effect의 `loadFromString(initialRef.current)`는 같은 텍스트 재적재라 멱등 — canonical 불변, onChange가 originalYaml과 같은 값을 전달해 dirty=false 유지.)

- [ ] **Step 4: green 확인 + teeth**

Run: `cd ui && pnpm test ScenarioEditPage.dirty`
Expected: PASS (3 tests).

teeth(stale-model): `seeded` 게이트는 Task 6에서 `liveName`에 연결된다 — 이 시점엔 h2가 여전히 `data.name`이라 stale 테스트는 구조적으로 green. Task 6 Step 4에서 게이트 제거 teeth-check를 수행한다(여기서는 생략).

- [ ] **Step 5: 기존 EditPage 테스트 회귀 확인·조정**

Run: `cd ui && pnpm test ScenarioEditPage`
Expected: dirty/save/clone/testrun 전부 PASS.

만약 save/clone 테스트(모킹된 EditorShell의 "seed" 버튼이 raw `DEMO.yaml`을 onChange로 쏘는 구조)가 canonical≠raw 불일치로 깨지면, 목의 seed 버튼을 store canonical을 쏘도록 교체한다:

```tsx
      <button
        type="button"
        onClick={() => onChange(useScenarioEditor.getState().yamlText)}
      >
        seed
      </button>
```

(페이지 시드 effect가 실물 store를 이미 적재했으므로 `getState().yamlText`가 canonical이다. import 추가: `import { useScenarioEditor } from "../../scenario/store";`)

- [ ] **Step 6: 커밋**

```bash
git add ui/src/pages/__tests__/ScenarioEditPage.dirty.test.tsx ui/src/pages/ScenarioEditPage.tsx
git commit -m "fix(ui): 에디터 로드 직후 false-dirty 제거 — 선적재 시드 + EditorShell 마운트 게이트 (R9)"
```
(save/clone 테스트를 조정했으면 함께 add.)

---

### Task 6: UI — 이름 라이브 표시 + 연필 인라인 편집

**Files:**
- Create: `ui/src/pages/__tests__/ScenarioEditPage.name.test.tsx`
- Modify: `ui/src/pages/ScenarioEditPage.tsx`
- Modify: `ui/src/i18n/ko.ts` (`editor` 섹션)

**Interfaces:**
- Consumes: Task 5의 `seeded`, 기존 `useScenarioEditor` `model`(페이지가 이미 `editorModel`로 구독, :33)·`setName`(store.ts:125, 기존 미사용 액션).
- Produces: 사용자 노출 표면만 — 후속 task 의존 없음.

- [ ] **Step 1: 실패하는 RTL 테스트 작성** — `ui/src/pages/__tests__/ScenarioEditPage.name.test.tsx` 신규 (Task 5 dirty 테스트와 동일한 실물-EditorShell 셋업 — `jsonResponse`/`DEMO`/`routeFetch`/`renderPage`를 그대로 복제한다; 파일 간 공유 헬퍼 추출은 하지 않는다[두 파일뿐 — YAGNI]):

```tsx
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ko } from "../../i18n/ko";
import { useScenarioEditor } from "../../scenario/store";
import { ScenarioEditPage } from "../ScenarioEditPage";

vi.mock("../../components/scenario/TestRunSection", () => ({
  TestRunSection: () => null,
}));

const fetchMock = vi.fn();
beforeEach(() => {
  useScenarioEditor.setState(useScenarioEditor.getInitialState());
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const DEMO_YAML =
  "version: 1\nname: demo\nsteps:\n  - id: 01ARZ3NDEKTSV4RRFFQ69G5FAV\n    type: http\n    name: ping\n    request:\n      method: GET\n      url: http://localhost:1/x\n";
const DEMO = {
  id: "S1",
  name: "demo",
  yaml: DEMO_YAML,
  version: 1,
  created_at: 0,
  updated_at: 0,
};

function routeFetch(url: string, init?: RequestInit): Response {
  const method = init?.method ?? "GET";
  if (url.endsWith("/api/scenarios/S1")) return jsonResponse(DEMO);
  if (url.endsWith("/api/scenarios") && method === "GET")
    return jsonResponse({ scenarios: [DEMO] });
  return jsonResponse({ error: "unexpected" }, 500);
}

function renderPage() {
  fetchMock.mockImplementation((url: string | URL, init?: RequestInit) =>
    Promise.resolve(routeFetch(String(url), init)),
  );
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={["/scenarios/S1"]}>
        <Routes>
          <Route path="/scenarios/:id" element={<ScenarioEditPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("ScenarioEditPage 이름 라이브 표시 + 인라인 편집 (R7/R8)", () => {
  it("store에서 name이 바뀌면 h2·브레드크럼이 즉시 갱신", async () => {
    renderPage();
    await screen.findByRole("heading", { name: "demo" });

    act(() => {
      useScenarioEditor.getState().setName("renamed");
    });
    await screen.findByRole("heading", { name: "renamed" });
    // h2 + 브레드크럼 둘 다
    expect(screen.getAllByText("renamed").length).toBeGreaterThanOrEqual(2);
  });

  it("연필 → 입력 → Enter 커밋: h2 갱신 + dirty(저장 버튼 enabled)", async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole("heading", { name: "demo" });
    expect(screen.getByRole("button", { name: ko.common.save })).toBeDisabled();

    await user.click(screen.getByRole("button", { name: ko.editor.renameAria }));
    const input = screen.getByRole("textbox", { name: ko.editor.nameInputAria });
    await user.clear(input);
    await user.type(input, "새이름{Enter}");

    await screen.findByRole("heading", { name: "새이름" });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: ko.common.save })).toBeEnabled(),
    );
  });

  it("빈 이름 커밋은 revert — 이름·dirty 무변화", async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole("heading", { name: "demo" });

    await user.click(screen.getByRole("button", { name: ko.editor.renameAria }));
    const input = screen.getByRole("textbox", { name: ko.editor.nameInputAria });
    await user.clear(input);
    await user.type(input, "   {Enter}");

    await screen.findByRole("heading", { name: "demo" });
    expect(screen.getByRole("button", { name: ko.common.save })).toBeDisabled();
  });

  it("Escape는 취소 — 입력 닫히고 이름 무변화", async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole("heading", { name: "demo" });

    await user.click(screen.getByRole("button", { name: ko.editor.renameAria }));
    const input = screen.getByRole("textbox", { name: ko.editor.nameInputAria });
    await user.clear(input);
    await user.type(input, "버릴이름{Escape}");

    await screen.findByRole("heading", { name: "demo" });
    expect(
      screen.queryByRole("textbox", { name: ko.editor.nameInputAria }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: ko.common.save })).toBeDisabled();
  });

  it("깨진 YAML(model=null)이면 연필 disabled + 서버명 폴백", async () => {
    renderPage();
    await screen.findByRole("heading", { name: "demo" });

    act(() => {
      useScenarioEditor.getState().loadFromString(":: broken [[[");
    });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: ko.editor.renameAria })).toBeDisabled(),
    );
    expect(screen.getByRole("heading", { name: "demo" })).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `cd ui && pnpm test ScenarioEditPage.name`
Expected: FAIL — `ko.editor.renameAria` 미정의 / 연필 버튼 부재.

- [ ] **Step 3: ko 키 추가** — `ui/src/i18n/ko.ts`의 `editor` 섹션(기존 키들 뒤)에 추가:

```ts
    // ── 시나리오 이름 인라인 편집 (scenario-delete-name-sync R8) ──
    renameAria: "시나리오 이름 편집",
    renameTitle: "이름을 클릭해 바로 수정합니다 (Enter 저장, Esc 취소)",
    renameDisabledTitle: "YAML 파싱 오류를 먼저 해결해야 이름을 편집할 수 있습니다",
    nameInputAria: "시나리오 이름",
```

- [ ] **Step 4: 페이지 구현** — `ui/src/pages/ScenarioEditPage.tsx`:

① **react import에 `useRef` 재추가**(Task 5가 제거했음 — `nameEscapedRef`가 새 소비처) 후, 컴포넌트 본문(Task 5의 seed effect 아래)에 추가:

```tsx
  const [nameEditing, setNameEditing] = useState(false);
  const [nameDraft, setNameDraft] = useState("");
  const nameEscapedRef = useRef(false);
```

early-return 가드들(:55-58) *아래*(=`data` non-null 영역)에 추가:

```tsx
  // R7: 싱글톤 store의 stale 모델(이전 페이지 잔존물)이 시드 전 프레임에 새지
  // 않도록 seeded로 게이트 — 시드 전·깨진-YAML(model=null)은 서버명 폴백.
  const liveName = seeded ? (editorModel?.name ?? data.name) : data.name;
  const nameEditable = seeded && editorModel !== null;

  const startNameEdit = () => {
    setNameDraft(liveName);
    setNameEditing(true);
  };
  // 커밋: trim 후 빈 문자열이면 revert(ScenarioModel.name min(1) — 빈 커밋은
  // doc/model 갈라짐), 동일 이름도 no-op. Enter 커밋 직후 unmount-blur가 한 번
  // 더 불러도 liveName 동등성 가드로 멱등.
  const commitName = () => {
    if (nameEscapedRef.current) {
      nameEscapedRef.current = false;
      setNameEditing(false);
      return;
    }
    setNameEditing(false);
    const trimmed = nameDraft.trim();
    if (trimmed.length === 0 || trimmed === liveName) return;
    useScenarioEditor.getState().setName(trimmed);
  };
```

② 헤더의 `<h2 className="text-xl font-semibold">{data.name}</h2>`(:98)를 다음으로 교체:

```tsx
          {nameEditing ? (
            <input
              autoFocus
              aria-label={ko.editor.nameInputAria}
              className="rounded border border-slate-300 px-2 py-1 text-xl font-semibold"
              value={nameDraft}
              onChange={(e) => setNameDraft(e.target.value)}
              onBlur={commitName}
              onKeyDown={(e) => {
                if (e.key === "Enter") commitName();
                if (e.key === "Escape") {
                  nameEscapedRef.current = true;
                  setNameEditing(false);
                }
              }}
            />
          ) : (
            <div className="flex items-center gap-2">
              <h2 className="text-xl font-semibold">{liveName}</h2>
              <button
                type="button"
                aria-label={ko.editor.renameAria}
                title={nameEditable ? ko.editor.renameTitle : ko.editor.renameDisabledTitle}
                disabled={!nameEditable}
                onClick={startNameEdit}
                className="text-slate-500 hover:text-slate-700 disabled:text-slate-300"
              >
                <span aria-hidden="true">✎</span>
              </button>
            </div>
          )}
```

③ Breadcrumb(:95)의 `{ label: data.name }`을 `{ label: liveName }`으로 교체.

(주의: `useScenarioEditor` import는 이미 있음(:12).)

- [ ] **Step 5: green 확인 + stale-model teeth-check**

Run: `cd ui && pnpm test ScenarioEditPage.name ScenarioEditPage.dirty` (두 파일 각각)
Expected: PASS.

teeth: `liveName`을 일시적으로 `editorModel?.name ?? data.name`(게이트 제거)으로 바꾸고 `pnpm test ScenarioEditPage.dirty` 실행 → **stale-model 테스트가 FAIL해야 한다**(characterData oldValue "other" 검출). 확인 후 원복, 다시 PASS 확인. (production diff가 남지 않게 `git diff ui/src/pages/ScenarioEditPage.tsx`로 원복 검증.)

- [ ] **Step 6: 커밋**

```bash
git add ui/src/pages/__tests__/ScenarioEditPage.name.test.tsx ui/src/pages/ScenarioEditPage.tsx ui/src/i18n/ko.ts
git commit -m "feat(ui): 에디터 헤더 이름 라이브 표시(seeded 게이트) + 연필 인라인 편집 (R7/R8)"
```

---

### Task 7: ADR-0045 + 루트 인덱스는 finish-slice로

**Files:**
- Create: `docs/adr/0045-scenario-delete-policy.md`

**Interfaces:** 없음 (docs-only — 코드 task와 독립).

- [ ] **Step 1: ADR 작성** — `docs/adr/0045-scenario-delete-policy.md` 신규 (MADR·ADR-0044 관례):

```markdown
# 0045. 시나리오 삭제 정책 — 2층 가드 + 앱-레벨 전체 cascade

- 상태: 채택됨 (2026-07-03)
- 관련: [ADR-0022](0022-datasets.md)(데이터셋 삭제 2층 가드 — 이 결정이 미러한 패턴), [ADR-0024](0024-run-presets.md)(프리셋 — cascade 대상), [ADR-0034](0034-run-scheduler.md)(스케줄 — cascade 대상), [ADR-0011](0011-sqlite.md)(SQLite). 설계: `docs/superpowers/specs/2026-07-03-scenario-delete-name-sync-design.md`. 주요 파일: `crates/controller/src/store/scenarios.rs::delete_cascade`, `crates/controller/src/api/scenarios.rs::delete`.

## 맥락

시나리오는 최상위 리소스인데 삭제 수단이 없었다(사용자 보고 2026-07-03). `scenarios(id)`는 `runs`(그 아래 run 메트릭 6테이블)·`run_presets`·`schedules`(+`schedule_events`)가 참조하고 커넥션이 `foreign_keys=ON`이라, 참조를 남긴 삭제는 FK가 거부한다 — 삭제 정책이 선결이다. run 이력은 리포트의 원천이라 무경고 소실은 안 되고, 반대로 "이력 있으면 삭제 불가"는 쓰던 시나리오를 사실상 영구 불멸로 만든다.

## 결정

**데이터셋 삭제(ADR-0022)의 2층 가드를 시나리오로 확장하되, cascade는 앱-레벨 단일 트랜잭션으로 구현한다.**

- **hard 가드**: 활성(pending/running) run이 참조하면 `force`와 무관하게 409 — 실행 중 부하의 발밑 삭제 금지. 권위 판정은 **cascade 트랜잭션 안의 재확인**(핸들러 체크는 advisory fast-fail — 가드↔트랜잭션 사이에 커밋된 run의 silent 좀비-부하 윈도 봉쇄), 잔여 인터리빙은 WAL busy/snapshot(fail-loud 500)과 커밋-후 FK 거부가 막는다.
- **soft 가드**: run 이력·프리셋·스케줄 카운트를 409 JSON으로 반환, UI가 요약 confirm 후 `?force=true`로 전체 cascade(run 이력·리포트 포함).
- **cascade는 앱-레벨**: `DELETE` 순서 = run 메트릭 6테이블 → runs → run_presets → schedules(events는 기존 FK CASCADE) → scenarios. `ON DELETE CASCADE` 마이그레이션은 기각 — SQLite는 기존 테이블 FK 변경이 불가(테이블 재생성 필요)하고, 메트릭 테이블 일부는 FK 자체가 없어 어차피 명시 삭제가 필요하다. migration 0005의 "FK CASCADE를 추가해야" 주석은 이 결정으로 대체(주석 갱신).
- **soft-delete/아카이브 기각**: 목록/조회/run 생성/스케줄러 전 경로 필터가 필요한 과설계 — 사내 도구 규모에 안 맞음(사용자 결정).

## 결과

- 시나리오 CRUD 완결. 참조 카운트가 사용자 확인의 재료가 되고, 활성 run 안전이 서버에서 강제된다.
- run 이력 삭제는 되돌릴 수 없다 — soft 409 confirm이 유일한 방어(감사 로그·undo는 §B1 트랙).
- 드문 spurious 409/500(advisory와 in-tx 판정 사이·EXISTS와 DELETE 사이 동시 쓰기)은 재시도 가능·무손상으로 수용.
```

(ADR 파일명·관련 ADR 링크는 작성 시점에 `ls docs/adr/`로 실제 파일명을 확인해 맞출 것 — 링크 대상 파일명이 추정과 다르면 실명으로 교체.)

- [ ] **Step 2: 커밋** (docs-only fast-path)

```bash
git add docs/adr/0045-scenario-delete-policy.md
git commit -m "docs(adr): 0045 시나리오 삭제 정책 — 2층 가드 + 앱-레벨 cascade"
```

루트 CLAUDE.md "알아둘 결정들" 인덱스 한 줄 추가는 **finish-slice 단계**에서(상태줄 교체와 함께 — 이 task에서 하지 않는다).

---

### Task 8: 전체 게이트 + 라이브 검증 (orchestrator 수행)

**Files:** 없음 (검증-only).

- [ ] **Step 1: UI 전체 게이트**

Run: `cd ui && pnpm lint && pnpm test && pnpm build`
Expected: lint 경고 0, 전체 스위트 green, `tsc -b` 통과.

- [ ] **Step 2: 신규/변경 UI 파일 한국어 하드코딩 스윕**

Run: `git diff master --name-only -- 'ui/src/**' | grep -v __tests__` 로 변경 파일 나열 후, 각 파일에 `grep -nE '"[^"]*[가-힣]'` — ko.ts 자신 외 매치 0 확인 (삼항 속성 sweep `(aria-label|title)=\{[^}]*"[A-Za-z]` 포함).
Expected: ko.ts 외 하드코딩 문구 0 (R10).

- [ ] **Step 3: cargo 전체 확인** (각 커밋의 pre-commit이 이미 돌렸지만 최종 1회)

Run: `cargo clippy --workspace -- -D warnings && cargo nextest run --workspace`
Expected: green.

- [ ] **Step 4: 라이브 검증** — orchestrator가 `/live-verify` 스킬로 spec §6 체크리스트 수행:

1. 삭제 왕복: 시나리오 생성 → run 1회 완주 + 프리셋 1 + 스케줄 1 부착 → UI 삭제 → 1차 confirm → soft 409 요약 confirm(카운트 문구 실측) → force → 목록 소멸 + `sqlite3`로 6메트릭+runs+presets+schedules 잔존 0행.
2. hard 409: 장시간 run(duration 60s) 실행 중 삭제 시도 → 배너 문구 실측 → run abort로 정리.
3. 이름: YAML 모달에서 `name:` 변경 → 헤더/브레드크럼 즉시 갱신 → 연필 편집(커밋·Escape·빈값 revert) → 저장 → 목록/헤더 서버 반영.
4. false-dirty: 에디터 진입 직후 저장 버튼 비활성 → 편집 시 활성 → 저장 후 비활성.

Expected: 전 항목 PASS (실패 시 해당 task로 회귀).

---

## Self-Review 결과 (plan 작성자 수행)

- **Spec coverage**: R1–R4(Task 1·2 — soft 409 콤보 4종 전수) R5(Task 3 클라 분기 + Task 4 invalidate 조건 양분기) R6(Task 4 — pending disabled 포함) R7·R8(Task 6) R9(Task 5) R10(Task 4·6 ko + Task 8 sweep) R11(구조적 — Task 1의 0005 주석 포함, `store.ts`/`yamlDoc.ts`/`model.ts`/`schemas.ts` 어느 task도 안 건드림) R12(Task 8) §4.8 ADR(Task 7). 갭 없음.
- **plan-review round 1 반영**: useRef import 시퀀싱(T5 제거→T6 재추가 — T5 단독 green 담보), R5 invalidate 테스트(T4), soft 409 콤보 2건 추가(T2), pending disabled(T4), hard-409 fresh Response(T3).
- **Type consistency**: `DeleteOutcome`/`count_by_scenario` 시그니처 Task 1 정의 = Task 2 소비 일치; `DeleteScenarioResult.refs` Task 3 정의 = Task 4 소비 일치; `seeded` Task 5 도입 = Task 6 소비 일치.
- **주의**: Task 5/6은 같은 파일(`ScenarioEditPage.tsx`)을 순차 수정 — Task 6 구현 전 Task 5 커밋 필수(순서 고정). Task 1–4(삭제 그룹)와 5–6(에디터 그룹)은 상호 독립.
