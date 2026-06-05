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
    })
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
    let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX)
        .await
        .unwrap();
    let v: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
    (status, v)
}

#[tokio::test]
async fn test_run_rejects_unparseable_yaml_with_422() {
    let db = store::connect("sqlite::memory:").await.unwrap();
    let app = make_app(db);
    let (status, _b) = post(
        &app,
        "/api/test-runs",
        json!({ "scenario_yaml": "this: is: not: a: scenario", "env": {} }),
    )
    .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
}

#[tokio::test]
async fn test_run_rejects_out_of_range_max_requests_with_422() {
    let db = store::connect("sqlite::memory:").await.unwrap();
    let app = make_app(db);
    let yaml = "version: 1\nname: s\nsteps: []\n";
    for bad in [0u32, 10_001] {
        let (status, _b) = post(
            &app,
            "/api/test-runs",
            json!({ "scenario_yaml": yaml, "env": {}, "max_requests": bad }),
        )
        .await;
        assert_eq!(
            status,
            StatusCode::UNPROCESSABLE_ENTITY,
            "max_requests={bad}"
        );
    }
}

#[tokio::test]
async fn test_run_returns_200_trace_with_step_error_for_unreachable_target() {
    let db = store::connect("sqlite::memory:").await.unwrap();
    let app = make_app(db);
    let yaml = "version: 1\nname: s\nsteps:\n  - type: http\n    id: 01HX0000000000000000000099\n    name: down\n    request:\n      method: GET\n      url: http://127.0.0.1:1/nope\n";
    let (status, body) = post(
        &app,
        "/api/test-runs",
        json!({ "scenario_yaml": yaml, "env": {}, "max_requests": 5 }),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["ok"], json!(false));
    assert_eq!(body["steps"].as_array().unwrap().len(), 1);
    assert!(body["steps"][0]["error"].is_string());
}

#[tokio::test]
async fn test_run_ignores_unknown_runner_field() {
    let db = store::connect("sqlite::memory:").await.unwrap();
    let app = make_app(db);
    let yaml = "version: 1\nname: s\nsteps: []\n";
    let (status, body) = post(
        &app,
        "/api/test-runs",
        json!({ "scenario_yaml": yaml, "env": {}, "runner": "mars" }),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["steps"].as_array().unwrap().len(), 0);
}
