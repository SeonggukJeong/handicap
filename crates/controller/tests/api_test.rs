use axum::body::Body;
use axum::http::{Method, Request, StatusCode};
use handicap_controller::grpc::coordinator::CoordinatorState;
use handicap_controller::{app, store};
use serde_json::{Value, json};
use tower::ServiceExt;

#[tokio::test]
async fn create_and_get_scenario() {
    let db = store::connect("sqlite::memory:").await.unwrap();
    let coord = CoordinatorState::new(db.clone());
    let app = app::router(app::AppState {
        db,
        coord,
        worker_bin: "/nonexistent".to_string(),
        grpc_addr: "127.0.0.1:0".parse().unwrap(),
    });

    let body = json!({
        "yaml": "version: 1\nname: t\nsteps:\n  - id: a\n    name: a\n    type: http\n    request:\n      method: GET\n      url: http://x\n"
    });
    let req = Request::builder()
        .method(Method::POST)
        .uri("/scenarios")
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
        .uri(format!("/scenarios/{id}"))
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
        worker_bin: "/nonexistent".to_string(),
        grpc_addr: "127.0.0.1:0".parse().unwrap(),
    });
    let body = json!({ "yaml": "not: valid: yaml: -" });
    let req = Request::builder()
        .method(Method::POST)
        .uri("/scenarios")
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
        worker_bin: "/nonexistent".to_string(),
        grpc_addr: "127.0.0.1:0".parse().unwrap(),
    });

    // 1. create scenario
    let body = json!({
        "yaml": "version: 1\nname: t\nsteps:\n  - id: a\n    name: a\n    type: http\n    request:\n      method: GET\n      url: http://x\n"
    });
    let req = Request::builder()
        .method(Method::POST)
        .uri("/scenarios")
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
        .uri("/runs")
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
