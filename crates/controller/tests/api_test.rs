// Test: mark_aborted must set ended_at unconditionally (idempotent fix)
use std::sync::Arc;

use axum::body::Body;
use axum::http::{Method, Request, StatusCode};
use handicap_controller::dispatcher::NoopDispatcher;
use handicap_controller::grpc::coordinator::CoordinatorState;
use handicap_controller::{app, store};
use serde_json::{Value, json};
use tower::ServiceExt;

fn make_app(db: handicap_controller::store::Db) -> axum::Router {
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
        monitor: handicap_controller::monitor::MonitorSupervisor::default(),
    })
}

async fn create_scenario(app: &axum::Router, yaml: &str) -> String {
    let body = json!({ "yaml": yaml });
    let req = Request::builder()
        .method(Method::POST)
        .uri("/api/scenarios")
        .header("content-type", "application/json")
        .body(Body::from(body.to_string()))
        .unwrap();
    let resp = app.clone().oneshot(req).await.unwrap();
    let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX)
        .await
        .unwrap();
    let v: Value = serde_json::from_slice(&bytes).unwrap();
    v["id"].as_str().unwrap().to_string()
}

async fn create_run(app: &axum::Router, scenario_id: &str) -> String {
    let body = json!({
        "scenario_id": scenario_id,
        "profile": { "vus": 1, "duration_seconds": 30 },
        "env": {}
    });
    let req = Request::builder()
        .method(Method::POST)
        .uri("/api/runs")
        .header("content-type", "application/json")
        .body(Body::from(body.to_string()))
        .unwrap();
    let resp = app.clone().oneshot(req).await.unwrap();
    let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX)
        .await
        .unwrap();
    let v: Value = serde_json::from_slice(&bytes).unwrap();
    v["id"].as_str().unwrap().to_string()
}

async fn get_run_status(app: &axum::Router, run_id: &str) -> String {
    let req = Request::builder()
        .method(Method::GET)
        .uri(format!("/api/runs/{run_id}"))
        .body(Body::empty())
        .unwrap();
    let resp = app.clone().oneshot(req).await.unwrap();
    let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX)
        .await
        .unwrap();
    let v: Value = serde_json::from_slice(&bytes).unwrap();
    v["status"].as_str().unwrap().to_string()
}

#[tokio::test]
async fn create_run_with_label_trims_and_persists() {
    let db = store::connect("sqlite::memory:").await.unwrap();
    let app = make_app(db.clone());
    let single_step_yaml = "version: 1\nname: label-test\nsteps:\n  - id: a\n    name: a\n    type: http\n    request:\n      method: GET\n      url: http://x\n";
    let scenario_id = create_scenario(&app, single_step_yaml).await;

    let body = json!({
        "scenario_id": scenario_id,
        "profile": { "vus": 1, "duration_seconds": 30 },
        "env": {},
        "label": "  통합 라벨  "
    });
    let req = Request::builder()
        .method(Method::POST)
        .uri("/api/runs")
        .header("content-type", "application/json")
        .body(Body::from(body.to_string()))
        .unwrap();
    let resp = app.clone().oneshot(req).await.unwrap();
    assert_eq!(resp.status(), StatusCode::CREATED);
    let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX)
        .await
        .unwrap();
    let v: Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(v["label"], "통합 라벨", "create response trims label");
    let run_id = v["id"].as_str().unwrap().to_string();

    let req2 = Request::builder()
        .method(Method::GET)
        .uri(format!("/api/runs/{run_id}"))
        .body(Body::empty())
        .unwrap();
    let resp2 = app.clone().oneshot(req2).await.unwrap();
    let bytes2 = axum::body::to_bytes(resp2.into_body(), usize::MAX)
        .await
        .unwrap();
    let v2: Value = serde_json::from_slice(&bytes2).unwrap();
    assert_eq!(v2["label"], "통합 라벨", "re-fetched run keeps label");
}

#[tokio::test]
async fn create_run_without_label_is_null() {
    let db = store::connect("sqlite::memory:").await.unwrap();
    let app = make_app(db.clone());
    let single_step_yaml = "version: 1\nname: no-label-test\nsteps:\n  - id: a\n    name: a\n    type: http\n    request:\n      method: GET\n      url: http://x\n";
    let scenario_id = create_scenario(&app, single_step_yaml).await;

    let body = json!({
        "scenario_id": scenario_id,
        "profile": { "vus": 1, "duration_seconds": 30 },
        "env": {}
    });
    let req = Request::builder()
        .method(Method::POST)
        .uri("/api/runs")
        .header("content-type", "application/json")
        .body(Body::from(body.to_string()))
        .unwrap();
    let resp = app.clone().oneshot(req).await.unwrap();
    assert_eq!(resp.status(), StatusCode::CREATED);
    let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX)
        .await
        .unwrap();
    let v: Value = serde_json::from_slice(&bytes).unwrap();
    // serde_json's Index impl returns `&Value::Null` for an ABSENT key too, so
    // `v["label"] == Value::Null` alone would pass even if `label` were dropped
    // by `skip_serializing_if` (the exact regression Global Constraints' "Zod
    // 2종 분기 혼동 금지" warns about — RunResponse.label must stay plain
    // Option, unlike ReportRun.label). Assert key presence explicitly first.
    let obj = v.as_object().expect("run response is an object");
    assert!(
        obj.contains_key("label"),
        "label key must be present (plain Option, no skip_serializing_if)"
    );
    assert!(obj["label"].is_null(), "no-label run response has null");
}

#[tokio::test]
async fn abort_run_marks_run_aborted() {
    let db = store::connect("sqlite::memory:").await.unwrap();
    let app = make_app(db.clone());
    let single_step_yaml = "version: 1\nname: abort-test\nsteps:\n  - id: a\n    name: a\n    type: http\n    request:\n      method: GET\n      url: http://x\n";

    // 1. create scenario
    let scenario_id = create_scenario(&app, single_step_yaml).await;

    // 2. create a run (NoopDispatcher starts no worker, so the run stays pending)
    let run_id = create_run(&app, &scenario_id).await;

    // 3. Status is pending (no real worker)
    let status = get_run_status(&app, &run_id).await;
    assert_eq!(status, "pending");

    // 4. Abort it — should work even in pending state
    let req = Request::builder()
        .method(Method::POST)
        .uri(format!("/api/runs/{run_id}/abort"))
        .body(Body::empty())
        .unwrap();
    let resp = app.clone().oneshot(req).await.unwrap();
    assert_eq!(resp.status(), StatusCode::OK);

    // 5. Status is now aborted
    let status = get_run_status(&app, &run_id).await;
    assert_eq!(status, "aborted");
}

#[tokio::test]
async fn pool_run_with_empty_pool_fails_fast() {
    // Pool mode with zero idle workers → POST /api/runs must return 400
    // with a body containing "연결된 LAN 워커" (빈풀 fail-fast, R7).
    let db = store::connect("sqlite::memory:").await.unwrap();
    let coord = CoordinatorState::new(db.clone());
    coord.set_pool_mode(true); // activate pool mode BEFORE moving into AppState
    let app = app::router(app::AppState {
        db,
        coord,
        dispatcher: Arc::new(NoopDispatcher),
        ui_dir: None,
        settings: handicap_controller::settings::SettingsState::build(
            &std::collections::HashMap::new(),
            &[],
        ),
        scheduler_tz: chrono_tz::UTC,
        monitor: handicap_controller::monitor::MonitorSupervisor::default(),
    });

    let yaml = "version: 1\nname: pool-test\nsteps:\n  - id: a\n    name: a\n    type: http\n    request:\n      method: GET\n      url: http://x\n";
    let scenario_id = create_scenario(&app, yaml).await;

    let body = serde_json::json!({
        "scenario_id": scenario_id,
        "profile": { "vus": 1, "duration_seconds": 30 },
        "env": {}
    });
    let req = axum::http::Request::builder()
        .method(Method::POST)
        .uri("/api/runs")
        .header("content-type", "application/json")
        .body(Body::from(body.to_string()))
        .unwrap();
    let resp = app.clone().oneshot(req).await.unwrap();
    assert_eq!(
        resp.status(),
        StatusCode::BAD_REQUEST,
        "empty pool must return 400"
    );
    let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX)
        .await
        .unwrap();
    let text = String::from_utf8_lossy(&bytes);
    assert!(
        text.contains("연결된 LAN 워커"),
        "body must contain '연결된 LAN 워커', got: {text}"
    );
}

#[tokio::test]
async fn create_and_get_scenario() {
    let db = store::connect("sqlite::memory:").await.unwrap();
    let coord = CoordinatorState::new(db.clone());
    let app = app::router(app::AppState {
        db,
        coord,
        dispatcher: Arc::new(NoopDispatcher),
        ui_dir: None,
        settings: handicap_controller::settings::SettingsState::build(
            &std::collections::HashMap::new(),
            &[],
        ),
        scheduler_tz: chrono_tz::UTC,
        monitor: handicap_controller::monitor::MonitorSupervisor::default(),
    });

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
    let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX)
        .await
        .unwrap();
    let v: Value = serde_json::from_slice(&bytes).unwrap();
    let id = v["id"].as_str().unwrap().to_string();

    let req = Request::builder()
        .method(Method::GET)
        .uri(format!("/api/scenarios/{id}"))
        .body(Body::empty())
        .unwrap();
    let resp = app.oneshot(req).await.unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
}

#[tokio::test]
async fn rejects_invalid_yaml() {
    let db = store::connect("sqlite::memory:").await.unwrap();
    let coord = CoordinatorState::new(db.clone());
    let app = app::router(app::AppState {
        db,
        coord,
        dispatcher: Arc::new(NoopDispatcher),
        ui_dir: None,
        settings: handicap_controller::settings::SettingsState::build(
            &std::collections::HashMap::new(),
            &[],
        ),
        scheduler_tz: chrono_tz::UTC,
        monitor: handicap_controller::monitor::MonitorSupervisor::default(),
    });
    let body = json!({ "yaml": "not: valid: yaml: -" });
    let req = Request::builder()
        .method(Method::POST)
        .uri("/api/scenarios")
        .header("content-type", "application/json")
        .body(Body::from(body.to_string()))
        .unwrap();
    let resp = app.oneshot(req).await.unwrap();
    assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn create_run_for_scenario() {
    let db = store::connect("sqlite::memory:").await.unwrap();
    let coord = CoordinatorState::new(db.clone());
    let app = app::router(app::AppState {
        db,
        coord,
        dispatcher: Arc::new(NoopDispatcher),
        ui_dir: None,
        settings: handicap_controller::settings::SettingsState::build(
            &std::collections::HashMap::new(),
            &[],
        ),
        scheduler_tz: chrono_tz::UTC,
        monitor: handicap_controller::monitor::MonitorSupervisor::default(),
    });

    // 1. create scenario
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
    let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX)
        .await
        .unwrap();
    let v: Value = serde_json::from_slice(&bytes).unwrap();
    let scenario_id = v["id"].as_str().unwrap().to_string();

    // 2. create run
    let run_body = json!({
        "scenario_id": scenario_id,
        "profile": { "vus": 5, "duration_seconds": 2 },
        "env": {}
    });
    let req = Request::builder()
        .method(Method::POST)
        .uri("/api/runs")
        .header("content-type", "application/json")
        .body(Body::from(run_body.to_string()))
        .unwrap();
    let resp = app.clone().oneshot(req).await.unwrap();
    assert_eq!(resp.status(), StatusCode::CREATED);
    let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX)
        .await
        .unwrap();
    let v: Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(v["status"], "pending");
}

#[tokio::test]
async fn list_scenarios_returns_what_was_created() {
    let db = store::connect("sqlite::memory:").await.unwrap();
    let coord = handicap_controller::grpc::coordinator::CoordinatorState::new(db.clone());
    let app = app::router(app::AppState {
        db,
        coord,
        dispatcher: Arc::new(NoopDispatcher),
        ui_dir: None,
        settings: handicap_controller::settings::SettingsState::build(
            &std::collections::HashMap::new(),
            &[],
        ),
        scheduler_tz: chrono_tz::UTC,
        monitor: handicap_controller::monitor::MonitorSupervisor::default(),
    });

    // empty initially
    let req = Request::builder()
        .method(Method::GET)
        .uri("/api/scenarios")
        .body(Body::empty())
        .unwrap();
    let resp = app.clone().oneshot(req).await.unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX)
        .await
        .unwrap();
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
    let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX)
        .await
        .unwrap();
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
        dispatcher: Arc::new(NoopDispatcher),
        ui_dir: None,
        settings: handicap_controller::settings::SettingsState::build(
            &std::collections::HashMap::new(),
            &[],
        ),
        scheduler_tz: chrono_tz::UTC,
        monitor: handicap_controller::monitor::MonitorSupervisor::default(),
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
    let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX)
        .await
        .unwrap();
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
    let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX)
        .await
        .unwrap();
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
async fn worker_aborted_phase_lands_as_aborted_status() {
    // F3 regression: when the worker sends PHASE_ABORTED (new proto value),
    // the controller must map it to RunStatus::Aborted — not silently ignore it.
    use handicap_controller::store::runs::{RunStatus, set_status};

    let db = store::connect("sqlite::memory:").await.unwrap();
    let app = make_app(db.clone());

    let yaml = "version: 1\nname: phase-aborted-guard\nsteps:\n  - id: a\n    name: a\n    type: http\n    request:\n      method: GET\n      url: http://x\n";
    let scenario_id = create_scenario(&app, yaml).await;
    let run_id = create_run(&app, &scenario_id).await;

    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);

    // Simulate the coordinator handling a worker's PHASE_ABORTED RunStatus.
    set_status(&db, &run_id, RunStatus::Aborted, None, Some(now_ms))
        .await
        .unwrap();

    let status_final = get_run_status(&app, &run_id).await;
    assert_eq!(
        status_final, "aborted",
        "PHASE_ABORTED must land as aborted status in DB"
    );
}

#[tokio::test]
async fn aborted_status_not_overwritten_by_completed() {
    // Regression: the worker sends RunStatus::Completed after observing cancel,
    // but set_status must not clobber a terminal 'aborted' written by the REST abort path.
    use handicap_controller::store::runs::{RunStatus, mark_aborted, set_status};

    let db = store::connect("sqlite::memory:").await.unwrap();
    let app = make_app(db.clone());

    // 1. Create a scenario and a run.
    let yaml = "version: 1\nname: abort-overwrite-guard\nsteps:\n  - id: a\n    name: a\n    type: http\n    request:\n      method: GET\n      url: http://x\n";
    let scenario_id = create_scenario(&app, yaml).await;
    let run_id = create_run(&app, &scenario_id).await;

    // 2. REST abort path marks it aborted.
    mark_aborted(&db, &run_id).await.unwrap();
    let status_after_abort = get_run_status(&app, &run_id).await;
    assert_eq!(status_after_abort, "aborted");

    // 3. Worker's late Completed message arrives — must NOT overwrite 'aborted'.
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    set_status(&db, &run_id, RunStatus::Completed, None, Some(now_ms))
        .await
        .unwrap();

    // 4. Verify 'aborted' survived.
    let status_final = get_run_status(&app, &run_id).await;
    assert_eq!(
        status_final, "aborted",
        "aborted status must survive a late Completed update from the worker"
    );
}

#[tokio::test]
async fn list_runs_by_scenario() {
    let db = store::connect("sqlite::memory:").await.unwrap();
    let coord = handicap_controller::grpc::coordinator::CoordinatorState::new(db.clone());
    let app = app::router(app::AppState {
        db,
        coord,
        dispatcher: Arc::new(NoopDispatcher),
        ui_dir: None,
        settings: handicap_controller::settings::SettingsState::build(
            &std::collections::HashMap::new(),
            &[],
        ),
        scheduler_tz: chrono_tz::UTC,
        monitor: handicap_controller::monitor::MonitorSupervisor::default(),
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
    let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX)
        .await
        .unwrap();
    let v: Value = serde_json::from_slice(&bytes).unwrap();
    let scenario_id = v["id"].as_str().unwrap().to_string();

    // 0 runs initially
    let req = Request::builder()
        .method(Method::GET)
        .uri(format!("/api/scenarios/{scenario_id}/runs"))
        .body(Body::empty())
        .unwrap();
    let resp = app.clone().oneshot(req).await.unwrap();
    let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX)
        .await
        .unwrap();
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
    let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX)
        .await
        .unwrap();
    let v: Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(v["runs"].as_array().unwrap().len(), 1);
}

#[tokio::test]
async fn get_run_includes_scenario_yaml() {
    let db = store::connect("sqlite::memory:").await.unwrap();
    let app = make_app(db.clone());
    let yaml = "version: 1\nname: snap-test\nsteps:\n  - id: a\n    name: a\n    type: http\n    request:\n      method: GET\n      url: http://x\n";

    let scenario_id = create_scenario(&app, yaml).await;
    let run_id = create_run(&app, &scenario_id).await;

    let req = Request::builder()
        .method(Method::GET)
        .uri(format!("/api/runs/{run_id}"))
        .body(Body::empty())
        .unwrap();
    let resp = app.clone().oneshot(req).await.unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX)
        .await
        .unwrap();
    let v: Value = serde_json::from_slice(&bytes).unwrap();
    // The run carries the exact scenario snapshot it ran against (retry warning source).
    assert_eq!(v["scenario_yaml"].as_str().unwrap(), yaml);
}

#[tokio::test]
async fn create_run_rejects_non_string_env() {
    let db = store::connect("sqlite::memory:").await.unwrap();
    let app = make_app(db.clone());
    let yaml = "version: 1\nname: env-test\nsteps:\n  - id: a\n    name: a\n    type: http\n    request:\n      method: GET\n      url: http://x\n";
    let scenario_id = create_scenario(&app, yaml).await;

    // env with a non-string value must be rejected at the API boundary
    // (env is map<string,string>; ADR-0014 — env vars are always strings).
    let body = json!({
        "scenario_id": scenario_id,
        "profile": { "vus": 1, "duration_seconds": 1 },
        "env": { "PORT": 8080 }
    });
    let req = Request::builder()
        .method(Method::POST)
        .uri("/api/runs")
        .header("content-type", "application/json")
        .body(Body::from(body.to_string()))
        .unwrap();
    let resp = app.clone().oneshot(req).await.unwrap();
    // axum's Json extractor returns 422 (UNPROCESSABLE_ENTITY) for a type mismatch
    // in otherwise-valid JSON. Pin the exact code so a future change to the
    // extractor's rejection mapping can't silently loosen the API contract.
    assert_eq!(
        resp.status(),
        StatusCode::UNPROCESSABLE_ENTITY,
        "non-string env must be rejected as 422, got {}",
        resp.status()
    );
}

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

#[tokio::test]
async fn create_open_loop_run_with_worker_count_fanout() {
    // Task 2: the run-create path accepts a valid open-loop run with worker_count>1
    // (fan-out un-pin) and rejects one whose max_in_flight can't give every worker
    // a slot (validation #3, HTTP-layer wiring). NoopDispatcher leaves the run
    // pending so the 201 is assertable.
    let db = store::connect("sqlite::memory:").await.unwrap();
    let app = make_app(db.clone());
    let yaml = "version: 1\nname: ol-fanout\nsteps:\n  - id: a\n    name: a\n    type: http\n    request:\n      method: GET\n      url: http://x\n";
    let scenario_id = create_scenario(&app, yaml).await;

    // 201: valid open-loop run with worker_count=2 (omit vus → serde default 0).
    let ok_body = json!({
        "scenario_id": scenario_id,
        "profile": { "target_rps": 200, "max_in_flight": 20, "worker_count": 2, "duration_seconds": 3 },
        "env": {}
    });
    let req = Request::builder()
        .method(Method::POST)
        .uri("/api/runs")
        .header("content-type", "application/json")
        .body(Body::from(ok_body.to_string()))
        .unwrap();
    let resp = app.clone().oneshot(req).await.unwrap();
    assert_eq!(
        resp.status(),
        StatusCode::CREATED,
        "valid open-loop worker_count=2 run must be accepted (fan-out un-pin)"
    );

    // 400: max_in_flight < worker_count → not enough slots (validation #3).
    let bad_body = json!({
        "scenario_id": scenario_id,
        "profile": { "target_rps": 200, "max_in_flight": 1, "worker_count": 2, "duration_seconds": 3 },
        "env": {}
    });
    let req = Request::builder()
        .method(Method::POST)
        .uri("/api/runs")
        .header("content-type", "application/json")
        .body(Body::from(bad_body.to_string()))
        .unwrap();
    let resp = app.clone().oneshot(req).await.unwrap();
    assert_eq!(
        resp.status(),
        StatusCode::BAD_REQUEST,
        "worker_count=2 with max_in_flight=1 must be rejected (worker gets 0 slots)"
    );
}

#[tokio::test]
async fn put_run_label_sets_updates_and_clears() {
    // Task 3: PUT /api/runs/{id}/label sets/updates/clears a run's label after
    // the fact (US4). ① set → 200, response label matches, re-fetch matches.
    // ② set null → 200, label removed (null). ③ over-length → 400. ④ missing
    // id → 404. (oneshot PUT mirrors the existing abort POST idiom, method swapped.)
    let db = store::connect("sqlite::memory:").await.unwrap();
    let app = make_app(db.clone());
    let single_step_yaml = "version: 1\nname: label-put-test\nsteps:\n  - id: a\n    name: a\n    type: http\n    request:\n      method: GET\n      url: http://x\n";
    let scenario_id = create_scenario(&app, single_step_yaml).await;
    let run_id = create_run(&app, &scenario_id).await;

    // ① PUT {"label":"사후"} → 200, response label == "사후", GET re-fetch matches.
    let req = Request::builder()
        .method(Method::PUT)
        .uri(format!("/api/runs/{run_id}/label"))
        .header("content-type", "application/json")
        .body(Body::from(json!({ "label": "사후" }).to_string()))
        .unwrap();
    let resp = app.clone().oneshot(req).await.unwrap();
    assert_eq!(
        resp.status(),
        StatusCode::OK,
        "setting a label must return 200"
    );
    let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX)
        .await
        .unwrap();
    let v: Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(v["label"], "사후", "PUT response reflects the new label");

    let req = Request::builder()
        .method(Method::GET)
        .uri(format!("/api/runs/{run_id}"))
        .body(Body::empty())
        .unwrap();
    let resp = app.clone().oneshot(req).await.unwrap();
    let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX)
        .await
        .unwrap();
    let v: Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(v["label"], "사후", "re-fetched run keeps the PUT label");

    // ② PUT {"label":null} → 200, label removed (null).
    let req = Request::builder()
        .method(Method::PUT)
        .uri(format!("/api/runs/{run_id}/label"))
        .header("content-type", "application/json")
        .body(Body::from(json!({ "label": null }).to_string()))
        .unwrap();
    let resp = app.clone().oneshot(req).await.unwrap();
    assert_eq!(
        resp.status(),
        StatusCode::OK,
        "clearing a label must return 200"
    );
    let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX)
        .await
        .unwrap();
    let v: Value = serde_json::from_slice(&bytes).unwrap();
    assert!(v["label"].is_null(), "null label must clear it");

    // ③ over-length label ("가" x 201, chars().count() > 200) → 400.
    let too_long = "가".repeat(201);
    let req = Request::builder()
        .method(Method::PUT)
        .uri(format!("/api/runs/{run_id}/label"))
        .header("content-type", "application/json")
        .body(Body::from(json!({ "label": too_long }).to_string()))
        .unwrap();
    let resp = app.clone().oneshot(req).await.unwrap();
    assert_eq!(
        resp.status(),
        StatusCode::BAD_REQUEST,
        "label over 200 chars must be rejected"
    );

    // ④ missing run id → 404.
    let req = Request::builder()
        .method(Method::PUT)
        .uri("/api/runs/nonexistent-run-id/label")
        .header("content-type", "application/json")
        .body(Body::from(json!({ "label": "x" }).to_string()))
        .unwrap();
    let resp = app.clone().oneshot(req).await.unwrap();
    assert_eq!(
        resp.status(),
        StatusCode::NOT_FOUND,
        "PUT label on a missing run id must 404"
    );
}

#[tokio::test]
async fn create_stair_run_stores_stair_and_expanded_stages() {
    let db = store::connect("sqlite::memory:").await.unwrap();
    let app = make_app(db.clone());
    let yaml = "version: 1\nname: stair\nsteps:\n  - id: a\n    name: a\n    type: http\n    request:\n      method: GET\n      url: http://x\n";
    let scenario_id = create_scenario(&app, yaml).await;
    let post_run = |profile: Value| {
        Request::builder()
            .method(Method::POST)
            .uri("/api/runs")
            .header("content-type", "application/json")
            .body(Body::from(
                json!({ "scenario_id": scenario_id, "profile": profile, "env": {} }).to_string(),
            ))
            .unwrap()
    };
    let stair = json!({ "targets": [100, 200], "hold_seconds": 60, "ramp_seconds": 5, "discard_seconds": 10 });

    let resp = app
        .clone()
        .oneshot(post_run(
            json!({ "max_in_flight": 50, "duration_seconds": 0, "stair": stair }),
        ))
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::CREATED);
    let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX)
        .await
        .unwrap();
    let v: Value = serde_json::from_slice(&bytes).unwrap();
    let id = v["id"].as_str().unwrap();
    let row = handicap_controller::store::runs::get(&db, id)
        .await
        .unwrap()
        .unwrap();
    assert!(row.profile.stair.is_some());
    assert_eq!(row.profile.stages.unwrap().len(), 4);

    // max_in_flight 없음 → 기존 open-loop 규칙으로 400
    let resp = app
        .clone()
        .oneshot(post_run(json!({ "duration_seconds": 0, "stair": stair })))
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::BAD_REQUEST);

    // 잘못된 stair → 400
    let resp = app
        .clone()
        .oneshot(post_run(json!({
            "max_in_flight": 50, "duration_seconds": 0,
            "stair": { "targets": [100], "hold_seconds": 60, "ramp_seconds": 5, "discard_seconds": 10 }
        })))
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
    let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX)
        .await
        .unwrap();
    let body = String::from_utf8_lossy(&bytes);
    assert!(
        body.contains("계단 목표는 2개 이상 50개 이하여야 합니다"),
        "계단 검증이 거절해야 한다(다른 400 아님): {body}"
    );
}

/// §B57 (1): 곡선 run은 "duration_seconds를 비워야 합니다"라고 안내하므로, 필드를
/// 아예 빼도 받아야 한다(예전엔 422 `missing field duration_seconds`). 곡선이 아닌
/// run에서 빼면 serde가 아니라 검증이 400으로 거절한다.
#[tokio::test]
async fn create_run_accepts_omitted_duration_for_curves() {
    let db = store::connect("sqlite::memory:").await.unwrap();
    let app = make_app(db.clone());
    let yaml = "version: 1\nname: curve\nsteps:\n  - id: a\n    name: a\n    type: http\n    request:\n      method: GET\n      url: http://x\n";
    let scenario_id = create_scenario(&app, yaml).await;
    let post_run = |profile: Value| {
        Request::builder()
            .method(Method::POST)
            .uri("/api/runs")
            .header("content-type", "application/json")
            .body(Body::from(
                json!({ "scenario_id": scenario_id, "profile": profile, "env": {} }).to_string(),
            ))
            .unwrap()
    };

    // open-loop stages, duration_seconds 생략
    let resp = app
        .clone()
        .oneshot(post_run(json!({
            "max_in_flight": 10,
            "stages": [{ "target": 5, "duration_seconds": 3 }]
        })))
        .await
        .unwrap();
    assert_eq!(
        resp.status(),
        StatusCode::CREATED,
        "stages without duration"
    );
    let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX)
        .await
        .unwrap();
    let v: Value = serde_json::from_slice(&bytes).unwrap();
    let row = handicap_controller::store::runs::get(&db, v["id"].as_str().unwrap())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(row.profile.duration_seconds, 0);

    // closed-loop vu_stages, duration_seconds 생략
    let resp = app
        .clone()
        .oneshot(post_run(json!({
            "vu_stages": [{ "target": 2, "duration_seconds": 3 }]
        })))
        .await
        .unwrap();
    assert_eq!(
        resp.status(),
        StatusCode::CREATED,
        "vu_stages without duration"
    );

    // 고정 closed-loop에서 생략 → 검증 400(serde 422 아님)
    let resp = app
        .clone()
        .oneshot(post_run(json!({ "vus": 2 })))
        .await
        .unwrap();
    assert_eq!(
        resp.status(),
        StatusCode::BAD_REQUEST,
        "closed-loop without duration"
    );
}

#[tokio::test]
async fn create_stair_run_roundtrips_auto_stop_and_rejects_bad_range() {
    let db = store::connect("sqlite::memory:").await.unwrap();
    let app = make_app(db.clone());
    let yaml = "version: 1\nname: stair\nsteps:\n  - id: a\n    name: a\n    type: http\n    request:\n      method: GET\n      url: http://x\n";
    let scenario_id = create_scenario(&app, yaml).await;
    let post_run = |auto_stop: Value| {
        Request::builder()
            .method(Method::POST)
            .uri("/api/runs")
            .header("content-type", "application/json")
            .body(Body::from(
                json!({ "scenario_id": scenario_id, "env": {}, "profile": {
                    "max_in_flight": 50, "duration_seconds": 0,
                    "stair": { "targets": [100, 200], "hold_seconds": 60, "ramp_seconds": 5,
                               "discard_seconds": 10, "auto_stop": auto_stop }
                } })
                .to_string(),
            ))
            .unwrap()
    };
    let sent = json!({
        "saturation": "first_fail",
        "emergency": { "error_rate_pct": 7.5, "p99_ms": 1500, "consecutive_seconds": 4, "min_requests": 30 }
    });
    let resp = app.clone().oneshot(post_run(sent.clone())).await.unwrap();
    assert_eq!(resp.status(), StatusCode::CREATED);
    let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX)
        .await
        .unwrap();
    let v: Value = serde_json::from_slice(&bytes).unwrap();
    let id = v["id"].as_str().unwrap();
    let row = handicap_controller::store::runs::get(&db, id)
        .await
        .unwrap()
        .unwrap();
    let stored = serde_json::to_value(row.profile.stair.unwrap()).unwrap();
    assert_eq!(stored["auto_stop"], sent);

    let bad = json!({ "saturation": null,
        "emergency": { "error_rate_pct": 0, "p99_ms": 1500, "consecutive_seconds": 4, "min_requests": 30 } });
    let resp = app.clone().oneshot(post_run(bad)).await.unwrap();
    assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
    let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX)
        .await
        .unwrap();
    let body = String::from_utf8_lossy(&bytes);
    assert!(
        body.contains("즉시 정지 오류율은 0 초과 100 이하여야 합니다"),
        "auto_stop 검증이 거절해야 한다: {body}"
    );

    // 오타 키는 조용히 무시(=감시 꺼짐)되지 않고 거절된다.
    let typo = json!({ "emergancy": { "error_rate_pct": 5, "p99_ms": 1500,
        "consecutive_seconds": 4, "min_requests": 30 } });
    let resp = app.clone().oneshot(post_run(typo)).await.unwrap();
    let code = resp.status();
    assert!(
        code == StatusCode::BAD_REQUEST || code == StatusCode::UNPROCESSABLE_ENTITY,
        "typo key must be rejected, got {code}"
    );
}

fn sample_auto_stop_record(with_stop: bool) -> handicap_controller::auto_stop::AutoStopRecord {
    let v = if with_stop {
        json!({"stop": {"kind": "emergency", "mode": null, "failed_steps": [],
            "decided_step": 2, "judged_through": 1, "phase": "measure",
            "decided_at_ms": 10, "stopped_at_ms": 20,
            "emergency": {"max_error_rate": 0.12, "max_p99_us": 3100000, "seconds": 3,
                          "error_hit": true, "p99_hit": false},
            "slot_limited": false}, "suspended_seconds": 0})
    } else {
        json!({"stop": null, "suspended_seconds": 4})
    };
    serde_json::from_value(v).expect("record")
}

async fn get_run_json(app: &axum::Router, run_id: &str) -> Value {
    let req = Request::builder()
        .method(Method::GET)
        .uri(format!("/api/runs/{run_id}"))
        .body(Body::empty())
        .unwrap();
    let resp = app.clone().oneshot(req).await.unwrap();
    let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX)
        .await
        .unwrap();
    serde_json::from_slice(&bytes).unwrap()
}

const AUTO_STOP_YAML: &str = "version: 1\nname: as\nsteps:\n  - id: a\n    name: a\n    type: http\n    request:\n      method: GET\n      url: http://x\n";

#[tokio::test]
async fn run_response_auto_stop_only_when_completed() {
    let db = store::connect("sqlite::memory:").await.unwrap();
    let app = make_app(db.clone());
    let sid = create_scenario(&app, AUTO_STOP_YAML).await;

    // completed + record -> key present
    let r1 = create_run(&app, &sid).await;
    let rec = sample_auto_stop_record(true);
    assert!(
        store::runs::complete_with_auto_stop(&db, &r1, 5, &rec)
            .await
            .unwrap()
    );
    let v1 = get_run_json(&app, &r1).await;
    assert_eq!(v1["status"], "completed");
    let obj1 = v1.as_object().unwrap();
    assert!(obj1.contains_key("auto_stop"), "completed+record -> key");
    assert_eq!(obj1["auto_stop"]["stop"]["kind"], "emergency");
    assert_eq!(obj1["auto_stop"]["suspended_seconds"], 0);

    // aborted + record (race) -> key absent
    let r2 = create_run(&app, &sid).await;
    assert!(
        store::runs::complete_with_auto_stop(&db, &r2, 5, &rec)
            .await
            .unwrap()
    );
    store::runs::mark_aborted(&db, &r2).await.unwrap();
    // mark_aborted가 기록을 비우므로, 경합으로 남은 행을 직접 SQL로 재현해 API 필터를 시험한다.
    sqlx::query("UPDATE runs SET auto_stop_json = ? WHERE id = ?")
        .bind(serde_json::to_string(&rec).unwrap())
        .bind(&r2)
        .execute(&db)
        .await
        .unwrap();
    let v2 = get_run_json(&app, &r2).await;
    assert_eq!(v2["status"], "aborted");
    assert!(!v2.as_object().unwrap().contains_key("auto_stop"));

    // no record -> key absent
    let r3 = create_run(&app, &sid).await;
    store::runs::set_status(&db, &r3, store::runs::RunStatus::Completed, None, Some(9))
        .await
        .unwrap();
    let v3 = get_run_json(&app, &r3).await;
    assert_eq!(v3["status"], "completed");
    assert!(!v3.as_object().unwrap().contains_key("auto_stop"));
}

#[tokio::test]
async fn non_stair_run_response_bytes_unchanged() {
    let db = store::connect("sqlite::memory:").await.unwrap();
    let app = make_app(db.clone());
    let sid = create_scenario(&app, AUTO_STOP_YAML).await;
    let r = create_run(&app, &sid).await;
    let v = get_run_json(&app, &r).await;
    let mut keys: Vec<&str> = v.as_object().unwrap().keys().map(|k| k.as_str()).collect();
    keys.sort_unstable();
    // Literal list captured from the response BEFORE auto_stop was added.
    let mut expected = vec![
        "created_at",
        "ended_at",
        "env",
        "id",
        "label",
        "last_metric_ts",
        "message",
        "profile",
        "scenario_id",
        "scenario_yaml",
        "started_at",
        "status",
        "verdict",
    ];
    expected.sort_unstable();
    assert_eq!(keys, expected);
}
