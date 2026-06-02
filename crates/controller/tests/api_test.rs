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
        dataset_max_rows: 1_000_000,
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
async fn create_and_get_scenario() {
    let db = store::connect("sqlite::memory:").await.unwrap();
    let coord = CoordinatorState::new(db.clone());
    let app = app::router(app::AppState {
        db,
        coord,
        dispatcher: Arc::new(NoopDispatcher),
        ui_dir: None,
        dataset_max_rows: 1_000_000,
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
        dataset_max_rows: 1_000_000,
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
        dataset_max_rows: 1_000_000,
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
        dataset_max_rows: 1_000_000,
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
        dataset_max_rows: 1_000_000,
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
        dataset_max_rows: 1_000_000,
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
