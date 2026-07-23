// Controller-side lock-in for the generator authoring gate (dynamic-vars T3).
//
// `Scenario::from_yaml` (crates/engine/src/genvars.rs, T1+T2) now validates
// `variables:` generator specs (4 kinds: date/random_int/uuid/random_string)
// via a wire-struct + TryFrom single serde mechanism (deny_unknown_fields +
// per-generator allow-list). The controller has **zero** new validation code
// for this — `api/scenarios.rs::create`/`update` already call
// `Scenario::from_yaml(&body.yaml)?`, which maps engine errors to 400 via
// `ApiError::Scenario` (see `error.rs`), and `api/test_runs.rs::create` maps
// them to 422 via an explicit `.map_err(ApiError::Unprocessable)`. This test
// file exists purely to lock the HTTP-surface behavior of that already-built
// engine gate — mirrors the app bootstrap/request helpers of
// `scenario_branch_validation_test.rs`.
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

async fn get_scenario(app: &axum::Router, id: &str) -> (StatusCode, Value) {
    let req = Request::builder()
        .method(Method::GET)
        .uri(format!("/api/scenarios/{id}"))
        .body(Body::empty())
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

async fn post_test_run(app: &axum::Router, scenario_yaml: &str) -> (StatusCode, Value) {
    let body = json!({ "scenario_yaml": scenario_yaml, "env": {} });
    let req = Request::builder()
        .method(Method::POST)
        .uri("/api/test-runs")
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

/// A minimal, otherwise-valid scenario (no steps) with a single `variables.x`
/// entry set to `var_spec` (a YAML flow-mapping literal, e.g. `{gen: date}`).
fn scenario_with_var(name: &str, var_spec: &str) -> String {
    format!("version: 1\nname: {name}\nvariables:\n  x: {var_spec}\nsteps: []\n")
}

const VALID_ALL_FOUR: &str = r#"
version: 1
name: gen-valid
variables:
  d: {gen: date, offset: "+7d", tz: Asia/Seoul}
  q: {gen: random_int, min: 1, max: 100, step: 5}
  u: {gen: uuid}
  s: {gen: random_string, length: 12}
steps: []
"#;

// ---- 400 5종 (POST /api/scenarios) ----

#[tokio::test]
async fn create_rejects_unknown_field_deny_unknown_fields_path() {
    let db = store::connect("sqlite::memory:").await.unwrap();
    let app = make_app(db);
    let yaml = scenario_with_var("bad1", "{gen: date, foo: 1}");
    let (status, body) = post_scenario(&app, &yaml).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "body: {body}");
    let msg = body["error"].as_str().unwrap();
    assert!(msg.contains("foo"), "got: {msg}");
}

#[tokio::test]
async fn create_rejects_cross_generator_key_allow_list_path() {
    let db = store::connect("sqlite::memory:").await.unwrap();
    let app = make_app(db);
    let yaml = scenario_with_var("bad2", "{gen: uuid, length: 5}");
    let (status, body) = post_scenario(&app, &yaml).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "body: {body}");
    let msg = body["error"].as_str().unwrap();
    assert!(msg.contains("파라미터"), "got: {msg}");
}

#[tokio::test]
async fn create_rejects_random_int_min_greater_than_max() {
    let db = store::connect("sqlite::memory:").await.unwrap();
    let app = make_app(db);
    let yaml = scenario_with_var("bad3", "{gen: random_int, min: 5, max: 1}");
    let (status, body) = post_scenario(&app, &yaml).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "body: {body}");
    let msg = body["error"].as_str().unwrap();
    assert!(
        msg.contains("min(5)") && msg.contains("max(1)"),
        "got: {msg}"
    );
}

#[tokio::test]
async fn create_rejects_date_unknown_timezone() {
    let db = store::connect("sqlite::memory:").await.unwrap();
    let app = make_app(db);
    let yaml = scenario_with_var("bad4", "{gen: date, tz: Mars/Olympus}");
    let (status, body) = post_scenario(&app, &yaml).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "body: {body}");
    let msg = body["error"].as_str().unwrap();
    assert!(msg.contains("타임존"), "got: {msg}");
}

#[tokio::test]
async fn create_rejects_date_offset_missing_sign() {
    let db = store::connect("sqlite::memory:").await.unwrap();
    let app = make_app(db);
    let yaml = scenario_with_var("bad5", "{gen: date, offset: \"7d\"}");
    let (status, body) = post_scenario(&app, &yaml).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "body: {body}");
    let msg = body["error"].as_str().unwrap();
    assert!(msg.contains("오프셋"), "got: {msg}");
}

// ---- 유효 생성기 4종: 201 + GET에서 gen: 보존 ----

#[tokio::test]
async fn create_accepts_all_four_generators_and_get_preserves_gen_key() {
    let db = store::connect("sqlite::memory:").await.unwrap();
    let app = make_app(db);
    let (status, created) = post_scenario(&app, VALID_ALL_FOUR).await;
    assert_eq!(status, StatusCode::CREATED, "body: {created}");
    let id = created["id"].as_str().unwrap();

    let (status, fetched) = get_scenario(&app, id).await;
    assert_eq!(status, StatusCode::OK, "body: {fetched}");
    let yaml = fetched["yaml"].as_str().unwrap();
    assert!(yaml.contains("gen:"), "got: {yaml}");
    assert!(yaml.contains("date"), "got: {yaml}");
    assert!(yaml.contains("random_int"), "got: {yaml}");
    assert!(yaml.contains("uuid"), "got: {yaml}");
    assert!(yaml.contains("random_string"), "got: {yaml}");
}

// ---- POST /api/test-runs: 422 ----

#[tokio::test]
async fn test_run_rejects_unknown_generator_with_422() {
    let db = store::connect("sqlite::memory:").await.unwrap();
    let app = make_app(db);
    let yaml = scenario_with_var("tr-bad", "{gen: nope}");
    let (status, body) = post_test_run(&app, &yaml).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "body: {body}");
}

// ---- PUT /api/scenarios/{id}: 400 (update 게이트 scenarios.rs:198) ----

#[tokio::test]
async fn update_rejects_invalid_generator() {
    let db = store::connect("sqlite::memory:").await.unwrap();
    let app = make_app(db);
    let (status, created) = post_scenario(&app, VALID_ALL_FOUR).await;
    assert_eq!(status, StatusCode::CREATED, "body: {created}");
    let id = created["id"].as_str().unwrap();
    let version = created["version"].as_i64().unwrap();

    let bad_yaml = scenario_with_var("gen-valid-updated", "{gen: random_int, min: 5, max: 1}");
    let (status, body) = put_scenario(&app, id, &bad_yaml, version).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "body: {body}");
    let msg = body["error"].as_str().unwrap();
    assert!(
        msg.contains("min(5)") && msg.contains("max(1)"),
        "got: {msg}"
    );
}
