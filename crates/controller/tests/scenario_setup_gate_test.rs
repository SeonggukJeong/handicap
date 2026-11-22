// 준비 스텝(`setup.steps`)이 시나리오 입구 검증(생성·수정·test-run)에 걸리는지.
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
        monitor: handicap_controller::monitor::MonitorSupervisor::default(),
    })
}

async fn send(app: &axum::Router, method: Method, uri: &str, body: Value) -> (StatusCode, Value) {
    let req = Request::builder()
        .method(method)
        .uri(uri)
        .header("content-type", "application/json")
        .body(Body::from(body.to_string()))
        .unwrap();
    let resp = app.clone().oneshot(req).await.unwrap();
    let status = resp.status();
    let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX)
        .await
        .unwrap();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}

const MAIN_STEP: &str = r#"  - id: "01HX0000000000000000000M01"
    type: http
    name: main
    request: { method: GET, url: "http://x/" }
"#;

fn loop_in_setup() -> String {
    format!(
        r#"version: 1
name: s
setup:
  steps:
    - id: "01HX0000000000000000000L01"
      type: loop
      name: bad
      repeat: 2
      do:
        - id: "01HX0000000000000000000L02"
          type: http
          name: inner
          request: {{ method: GET, url: "http://x/" }}
steps:
{MAIN_STEP}"#
    )
}

fn setup_think(max_ms: u64) -> String {
    format!(
        r#"version: 1
name: s
setup:
  steps:
    - id: "01HX0000000000000000000S01"
      type: http
      name: login
      request: {{ method: POST, url: "http://x/login" }}
      think_time: {{ min_ms: {max_ms}, max_ms: {max_ms} }}
steps:
{MAIN_STEP}"#
    )
}

#[tokio::test]
async fn create_scenario_rejects_non_http_setup() {
    let app = make_app(store::connect("sqlite::memory:").await.unwrap());
    let (st, v) = send(
        &app,
        Method::POST,
        "/api/scenarios",
        json!({ "yaml": loop_in_setup() }),
    )
    .await;
    assert_eq!(st, StatusCode::BAD_REQUEST, "{v}");

    let ok = setup_think(100);
    let (st, v) = send(&app, Method::POST, "/api/scenarios", json!({ "yaml": ok })).await;
    assert_eq!(st, StatusCode::CREATED, "{v}");
    let id = v["id"].as_str().unwrap().to_string();
    let (st, v) = send(
        &app,
        Method::PUT,
        &format!("/api/scenarios/{id}"),
        json!({ "yaml": loop_in_setup(), "version": v["version"] }),
    )
    .await;
    assert_eq!(st, StatusCode::BAD_REQUEST, "{v}");
}

#[tokio::test]
async fn create_scenario_validates_setup_think_time() {
    let app = make_app(store::connect("sqlite::memory:").await.unwrap());
    let (st, v) = send(
        &app,
        Method::POST,
        "/api/scenarios",
        json!({ "yaml": setup_think(900_000) }),
    )
    .await;
    assert_eq!(st, StatusCode::BAD_REQUEST, "{v}");
    assert!(v["error"].as_str().unwrap().contains("login"), "{v}");
}

#[tokio::test]
async fn test_run_rejects_non_http_setup() {
    let app = make_app(store::connect("sqlite::memory:").await.unwrap());
    let (st, v) = send(
        &app,
        Method::POST,
        "/api/test-runs",
        json!({ "scenario_yaml": loop_in_setup(), "env": {} }),
    )
    .await;
    assert_eq!(st, StatusCode::UNPROCESSABLE_ENTITY, "{v}");
}
