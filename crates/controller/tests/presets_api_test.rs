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
    let req = Request::builder()
        .method(Method::POST)
        .uri("/api/scenarios")
        .header("content-type", "application/json")
        .body(Body::from(json!({ "yaml": yaml }).to_string()))
        .unwrap();
    let resp = app.clone().oneshot(req).await.unwrap();
    let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX)
        .await
        .unwrap();
    let v: Value = serde_json::from_slice(&bytes).unwrap();
    v["id"].as_str().unwrap().to_string()
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

const YAML: &str = "version: 1\nname: presets\nsteps:\n  - id: a\n    name: a\n    type: http\n    request:\n      method: GET\n      url: http://x\n";

#[tokio::test]
async fn preset_create_list_get_roundtrip() {
    let db = store::connect("sqlite::memory:").await.unwrap();
    let app = make_app(db.clone());
    let sid = create_scenario(&app, YAML).await;

    let (status, created) = post(
        &app,
        &format!("/api/scenarios/{sid}/presets"),
        json!({
            "name": "baseline",
            "profile": { "vus": 4, "duration_seconds": 8, "ramp_up_seconds": 1 },
            "env": { "BASE_URL": "http://x" }
        }),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    let pid = created["id"].as_str().unwrap().to_string();
    assert_eq!(created["name"], "baseline");
    assert_eq!(created["profile"]["vus"], 4);
    assert_eq!(created["env"]["BASE_URL"], "http://x");

    let req = Request::builder()
        .method(Method::GET)
        .uri(format!("/api/scenarios/{sid}/presets"))
        .body(Body::empty())
        .unwrap();
    let resp = app.clone().oneshot(req).await.unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX)
        .await
        .unwrap();
    let list: Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(list["presets"].as_array().unwrap().len(), 1);
    assert_eq!(list["presets"][0]["vus"], 4);

    let req = Request::builder()
        .method(Method::GET)
        .uri(format!("/api/presets/{pid}"))
        .body(Body::empty())
        .unwrap();
    let resp = app.clone().oneshot(req).await.unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX)
        .await
        .unwrap();
    let full: Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(full["profile"]["ramp_up_seconds"], 1);
}

#[tokio::test]
async fn preset_duplicate_name_conflicts() {
    let db = store::connect("sqlite::memory:").await.unwrap();
    let app = make_app(db.clone());
    let sid = create_scenario(&app, YAML).await;
    let body = json!({ "name": "dup", "profile": { "vus": 1, "duration_seconds": 1 }, "env": {} });
    let (s1, _) = post(&app, &format!("/api/scenarios/{sid}/presets"), body.clone()).await;
    assert_eq!(s1, StatusCode::CREATED);
    let (s2, _) = post(&app, &format!("/api/scenarios/{sid}/presets"), body).await;
    assert_eq!(s2, StatusCode::CONFLICT);
}

#[tokio::test]
async fn preset_update_to_duplicate_name_conflicts() {
    let db = store::connect("sqlite::memory:").await.unwrap();
    let app = make_app(db.clone());
    let sid = create_scenario(&app, YAML).await;

    let (s1, _) = post(
        &app,
        &format!("/api/scenarios/{sid}/presets"),
        json!({ "name": "a", "profile": { "vus": 1, "duration_seconds": 1 }, "env": {} }),
    )
    .await;
    assert_eq!(s1, StatusCode::CREATED);

    let (_, created_b) = post(
        &app,
        &format!("/api/scenarios/{sid}/presets"),
        json!({ "name": "b", "profile": { "vus": 1, "duration_seconds": 1 }, "env": {} }),
    )
    .await;
    let id_b = created_b["id"].as_str().unwrap().to_string();

    let req = Request::builder()
        .method(Method::PUT)
        .uri(format!("/api/presets/{id_b}"))
        .header("content-type", "application/json")
        .body(Body::from(
            json!({ "name": "a", "profile": { "vus": 1, "duration_seconds": 1 }, "env": {} })
                .to_string(),
        ))
        .unwrap();
    let resp = app.clone().oneshot(req).await.unwrap();
    assert_eq!(resp.status(), StatusCode::CONFLICT);
}

#[tokio::test]
async fn preset_empty_name_rejected() {
    let db = store::connect("sqlite::memory:").await.unwrap();
    let app = make_app(db.clone());
    let sid = create_scenario(&app, YAML).await;
    let (s, _) = post(
        &app,
        &format!("/api/scenarios/{sid}/presets"),
        json!({ "name": "   ", "profile": { "vus": 1, "duration_seconds": 1 }, "env": {} }),
    )
    .await;
    assert_eq!(s, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn preset_create_validates_profile() {
    let db = store::connect("sqlite::memory:").await.unwrap();
    let app = make_app(db.clone());
    let sid = create_scenario(&app, YAML).await;
    let (s, _) = post(
        &app,
        &format!("/api/scenarios/{sid}/presets"),
        json!({ "name": "bad", "profile": { "vus": 0, "duration_seconds": 1 }, "env": {} }),
    )
    .await;
    assert_eq!(s, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn preset_update_and_delete() {
    let db = store::connect("sqlite::memory:").await.unwrap();
    let app = make_app(db.clone());
    let sid = create_scenario(&app, YAML).await;
    let (_, created) = post(
        &app,
        &format!("/api/scenarios/{sid}/presets"),
        json!({ "name": "p", "profile": { "vus": 1, "duration_seconds": 1 }, "env": {} }),
    )
    .await;
    let pid = created["id"].as_str().unwrap().to_string();

    let req = Request::builder()
        .method(Method::PUT)
        .uri(format!("/api/presets/{pid}"))
        .header("content-type", "application/json")
        .body(Body::from(
            json!({ "name": "p2", "profile": { "vus": 5, "duration_seconds": 1 }, "env": {} })
                .to_string(),
        ))
        .unwrap();
    let resp = app.clone().oneshot(req).await.unwrap();
    assert_eq!(resp.status(), StatusCode::OK);

    let req = Request::builder()
        .method(Method::DELETE)
        .uri(format!("/api/presets/{pid}"))
        .body(Body::empty())
        .unwrap();
    let resp = app.clone().oneshot(req).await.unwrap();
    assert_eq!(resp.status(), StatusCode::NO_CONTENT);
    let req = Request::builder()
        .method(Method::GET)
        .uri(format!("/api/presets/{pid}"))
        .body(Body::empty())
        .unwrap();
    let resp = app.clone().oneshot(req).await.unwrap();
    assert_eq!(resp.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn preset_put_nonexistent_is_404() {
    let db = store::connect("sqlite::memory:").await.unwrap();
    let app = make_app(db.clone());
    let _sid = create_scenario(&app, YAML).await;
    let req = Request::builder()
        .method(Method::PUT)
        .uri("/api/presets/BOGUS_PRESET_ID")
        .header("content-type", "application/json")
        .body(Body::from(
            json!({ "name": "x", "profile": { "vus": 1, "duration_seconds": 1 }, "env": {} })
                .to_string(),
        ))
        .unwrap();
    let resp = app.clone().oneshot(req).await.unwrap();
    assert_eq!(resp.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn run_can_be_created_from_a_preset_profile() {
    let db = store::connect("sqlite::memory:").await.unwrap();
    let app = make_app(db.clone());
    let sid = create_scenario(&app, YAML).await;
    let (_, created) = post(
        &app,
        &format!("/api/scenarios/{sid}/presets"),
        json!({ "name": "p", "profile": { "vus": 2, "duration_seconds": 3 }, "env": { "K": "v" } }),
    )
    .await;
    let (s, run) = post(
        &app,
        "/api/runs",
        json!({ "scenario_id": sid, "profile": created["profile"], "env": created["env"] }),
    )
    .await;
    assert_eq!(s, StatusCode::CREATED);
    assert_eq!(run["profile"]["vus"], 2);
}
