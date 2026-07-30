use std::sync::Arc;

use axum::body::Body;
use axum::http::{Method, Request, StatusCode};
use handicap_controller::dispatcher::subprocess::SubprocessDispatcher;
use handicap_controller::{app, store};
use tower::ServiceExt;

async fn build_state() -> app::AppState {
    let db = store::connect("sqlite::memory:").await.unwrap();
    let coord = handicap_controller::grpc::coordinator::CoordinatorState::new(db.clone());
    let dispatcher = Arc::new(SubprocessDispatcher::new(
        "/nonexistent".to_string(),
        "127.0.0.1:0".parse().unwrap(),
        db.clone(),
    ));
    app::AppState {
        db,
        coord,
        dispatcher,
        ui_dir: None,
        settings: handicap_controller::settings::SettingsState::build(
            &std::collections::HashMap::new(),
            &[],
        ),
        scheduler_tz: chrono_tz::UTC,
    }
}

#[tokio::test]
async fn version_endpoint_reports_crate_version() {
    let app = app::router(build_state().await);
    let req = Request::builder()
        .method(Method::GET)
        .uri("/api/version")
        .body(Body::empty())
        .unwrap();
    let resp = app.oneshot(req).await.unwrap();
    assert_eq!(resp.status(), StatusCode::OK);

    let body = axum::body::to_bytes(resp.into_body(), usize::MAX)
        .await
        .unwrap();
    let parsed: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(
        parsed,
        serde_json::json!({ "version": env!("CARGO_PKG_VERSION") }),
        "응답은 version 한 필드만 담아야 한다(경로·호스트명 등 추가 금지)"
    );
}
