// Parallel branch-name validation at the scenario create/update gate.
//
// Empty branch names alias into the page row of `run_group_metrics`
// (branch="" is the page key — silent report contamination), and duplicate
// names silently merge into one BranchLatency row. The UI Zod gate already
// rejects both; this is the controller-side gate for hand-authored YAML
// (`POST /api/scenarios` via curl). 400 BadRequest per the legacy-endpoint
// convention (422 is test-runs only).
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
        heartbeat_interval_seconds: 10,
        stale_timeout_seconds: 30,
    })
}

async fn post_scenario(app: &axum::Router, yaml: &str) -> (StatusCode, Value) {
    let body = json!({ "yaml": yaml });
    let req = Request::builder()
        .method(Method::POST)
        .uri("/api/scenarios")
        .header("content-type", "application/json")
        .body(Body::from(body.to_string()))
        .unwrap();
    let resp = app.clone().oneshot(req).await.unwrap();
    let status = resp.status();
    let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX)
        .await
        .unwrap();
    let v: Value = serde_json::from_slice(&bytes).unwrap();
    (status, v)
}

async fn put_scenario(
    app: &axum::Router,
    id: &str,
    yaml: &str,
    version: i64,
) -> (StatusCode, Value) {
    let body = json!({ "yaml": yaml, "version": version });
    let req = Request::builder()
        .method(Method::PUT)
        .uri(format!("/api/scenarios/{id}"))
        .header("content-type", "application/json")
        .body(Body::from(body.to_string()))
        .unwrap();
    let resp = app.clone().oneshot(req).await.unwrap();
    let status = resp.status();
    let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX)
        .await
        .unwrap();
    let v: Value = serde_json::from_slice(&bytes).unwrap();
    (status, v)
}

fn parallel_yaml(branch_a: &str, branch_b: &str) -> String {
    format!(
        r#"
version: 1
name: par
steps:
  - id: "01HX0000000000000000000010"
    name: fanout
    type: parallel
    branches:
      - name: {branch_a}
        steps:
          - id: "01HX0000000000000000000011"
            name: get-user
            type: http
            request: {{ method: GET, url: "http://x/api/user" }}
            assert: []
      - name: {branch_b}
        steps:
          - id: "01HX0000000000000000000012"
            name: get-feed
            type: http
            request: {{ method: GET, url: "http://x/api/feed" }}
            assert: []
"#
    )
}

#[tokio::test]
async fn create_rejects_empty_parallel_branch_name() {
    let db = store::connect("sqlite::memory:").await.unwrap();
    let app = make_app(db);
    let (status, body) = post_scenario(&app, &parallel_yaml("\"\"", "feed")).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "body: {body}");
    let msg = body["error"].as_str().unwrap();
    assert!(msg.contains("branch name"), "got: {msg}");
}

#[tokio::test]
async fn create_rejects_duplicate_parallel_branch_names() {
    let db = store::connect("sqlite::memory:").await.unwrap();
    let app = make_app(db);
    let (status, body) = post_scenario(&app, &parallel_yaml("user", "user")).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "body: {body}");
    let msg = body["error"].as_str().unwrap();
    assert!(msg.contains("duplicate branch name"), "got: {msg}");
}

#[tokio::test]
async fn create_accepts_distinct_nonempty_branch_names() {
    let db = store::connect("sqlite::memory:").await.unwrap();
    let app = make_app(db);
    let (status, body) = post_scenario(&app, &parallel_yaml("user", "feed")).await;
    assert_eq!(status, StatusCode::CREATED, "body: {body}");
}

#[tokio::test]
async fn update_rejects_empty_parallel_branch_name() {
    let db = store::connect("sqlite::memory:").await.unwrap();
    let app = make_app(db);
    let (status, created) = post_scenario(&app, &parallel_yaml("user", "feed")).await;
    assert_eq!(status, StatusCode::CREATED);
    let id = created["id"].as_str().unwrap();
    let version = created["version"].as_i64().unwrap();

    let (status, body) = put_scenario(&app, id, &parallel_yaml("\"\"", "feed"), version).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "body: {body}");
    let msg = body["error"].as_str().unwrap();
    assert!(msg.contains("branch name"), "got: {msg}");
}

// The engine model allows free nesting (`Vec<Step>` everywhere); the UI gate
// forbids parallel inside containers, but hand-authored YAML can still nest it,
// so the walk must recurse into loop/if bodies.
#[tokio::test]
async fn create_rejects_empty_branch_name_nested_in_loop() {
    let db = store::connect("sqlite::memory:").await.unwrap();
    let app = make_app(db);
    let yaml = r#"
version: 1
name: par-in-loop
steps:
  - id: "01HX0000000000000000000020"
    name: outer-loop
    type: loop
    repeat: 2
    do:
      - id: "01HX0000000000000000000010"
        name: fanout
        type: parallel
        branches:
          - name: ""
            steps:
              - id: "01HX0000000000000000000011"
                name: get-user
                type: http
                request: { method: GET, url: "http://x/api/user" }
                assert: []
"#;
    let (status, body) = post_scenario(&app, yaml).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "body: {body}");
    let msg = body["error"].as_str().unwrap();
    assert!(msg.contains("branch name"), "got: {msg}");
}
