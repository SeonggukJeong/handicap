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
        worker_bin: "/nonexistent".to_string(),
        grpc_addr: "127.0.0.1:0".parse().unwrap(),
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
        worker_bin: "/nonexistent".to_string(),
        grpc_addr: "127.0.0.1:0".parse().unwrap(),
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
        worker_bin: "/nonexistent".to_string(),
        grpc_addr: "127.0.0.1:0".parse().unwrap(),
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
        worker_bin: "/nonexistent".to_string(),
        grpc_addr: "127.0.0.1:0".parse().unwrap(),
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
async fn list_runs_by_scenario() {
    let db = store::connect("sqlite::memory:").await.unwrap();
    let coord = handicap_controller::grpc::coordinator::CoordinatorState::new(db.clone());
    let app = app::router(app::AppState {
        db,
        coord,
        worker_bin: "/nonexistent".to_string(),
        grpc_addr: "127.0.0.1:0".parse().unwrap(),
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
