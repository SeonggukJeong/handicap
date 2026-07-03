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
        .body(Body::from(
            serde_json::to_vec(&json!({ "yaml": yaml })).unwrap(),
        ))
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
        store::schedules::count_by_scenario(&db, &sid)
            .await
            .unwrap(),
        1
    );
}

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
