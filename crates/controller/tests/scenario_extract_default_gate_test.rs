// Controller-side lock-in for the extract `default` authoring gate (extract-default T3).
//
// `Scenario::from_yaml` validates `extract[].default` (engine, T1); the controller adds no
// validation code — `POST /api/scenarios` maps the engine error to 400. These are pinning tests
// that pass from Task 1 onward.
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

fn scenario_with_default(name: &str, default_yaml: &str) -> String {
    format!(
        "version: 1\nname: {name}\nsteps:\n  - id: \"01J00000000000000000000A01\"\n    name: a\n    type: http\n    request: {{ method: GET, url: \"http://h/a\" }}\n    extract:\n      - {{ var: orderId, from: body, path: \"$.id\", default: {default_yaml} }}\n"
    )
}

#[tokio::test]
async fn extract_default_with_template_is_rejected_400() {
    let db = store::connect("sqlite::memory:").await.unwrap();
    let app = make_app(db);
    let yaml = scenario_with_default("ed-bad", "\"{{x}}\"");
    let (status, body) = post_scenario(&app, &yaml).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "body: {body}");
    let msg = body["error"].as_str().unwrap();
    assert!(
        msg.contains("extract default must not contain"),
        "got: {msg}"
    );
}

#[tokio::test]
async fn extract_default_plain_text_is_created_201() {
    let db = store::connect("sqlite::memory:").await.unwrap();
    let app = make_app(db);
    let yaml = scenario_with_default("ed-ok", "none");
    let (status, body) = post_scenario(&app, &yaml).await;
    assert_eq!(status, StatusCode::CREATED, "body: {body}");
}
