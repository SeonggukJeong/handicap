use std::sync::Arc;

use axum::body::Body;
use axum::http::{Method, Request, StatusCode};
use handicap_controller::dispatcher::subprocess::SubprocessDispatcher;
use handicap_controller::grpc::coordinator::CoordinatorState;
use handicap_controller::{app, store};
use handicap_proto::v1::ServerMessage;
use serde_json::Value;
use tonic::Status;
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
        settings: handicap_controller::settings::SettingsState::build(
            &std::collections::HashMap::new(),
            &[],
        ),
        scheduler_tz: chrono_tz::UTC,
    })
}

async fn send(
    app: &axum::Router,
    method: Method,
    uri: &str,
    body: Option<Value>,
) -> (StatusCode, Value) {
    let builder = Request::builder().method(method).uri(uri);
    let req = match body {
        Some(b) => builder
            .header("content-type", "application/json")
            .body(Body::from(b.to_string()))
            .unwrap(),
        None => builder.body(Body::empty()).unwrap(),
    };
    let resp = app.clone().oneshot(req).await.unwrap();
    let status = resp.status();
    let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX)
        .await
        .unwrap();
    let v: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
    (status, v)
}

/// make_app variant: pool_mode=true + shared coord handle returned.
async fn make_app_with_coord_pool() -> (axum::Router, CoordinatorState) {
    let db = store::connect("sqlite::memory:").await.unwrap();
    let coord = CoordinatorState::new(db.clone());
    coord.set_pool_mode(true);
    let app = app::router(app::AppState {
        db: db.clone(),
        coord: coord.clone(),
        dispatcher: Arc::new(SubprocessDispatcher::new(
            "/nonexistent".to_string(),
            "127.0.0.1:0".parse().unwrap(),
            db,
        )),
        ui_dir: None,
        settings: handicap_controller::settings::SettingsState::build(
            &std::collections::HashMap::new(),
            &[],
        ),
        scheduler_tz: chrono_tz::UTC,
    });
    (app, coord)
}

#[tokio::test]
async fn pool_workers_endpoint_off_returns_empty() {
    let db = store::connect("sqlite::memory:").await.unwrap();
    let app = make_app(db); // pool_mode not set (default false)
    let (status, body) = send(&app, Method::GET, "/api/pool/workers", None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["pool_mode"], false);
    assert_eq!(body["workers"].as_array().unwrap().len(), 0);
}

#[tokio::test]
async fn pool_workers_endpoint_lists() {
    let (app, coord) = make_app_with_coord_pool().await;
    let (tx, _rx) = tokio::sync::mpsc::channel::<Result<ServerMessage, Status>>(8);
    coord
        .pool_register_idle("w1", tx, 100, "host-a".into())
        .await;
    let _ = coord.reserve_idle_pool("run-1", 1).await; // marks w1 busy
    let (status, body) = send(&app, Method::GET, "/api/pool/workers", None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["pool_mode"], true);
    let w = &body["workers"][0];
    assert_eq!(w["hostname"], "host-a");
    assert_eq!(w["busy"], true);
    assert_eq!(w["run_id"], "run-1");
    assert!(w.get("token").is_none()); // security (R12): token/env/dataset keys absent
}
