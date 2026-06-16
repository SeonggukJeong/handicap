use std::path::PathBuf;
use std::sync::Arc;

use axum::body::Body;
use axum::http::{Method, Request, StatusCode};
use handicap_controller::dispatcher::subprocess::SubprocessDispatcher;
use handicap_controller::{app, store};
use tower::ServiceExt;

fn write_fixture(tmp: &std::path::Path) {
    std::fs::create_dir_all(tmp.join("assets")).unwrap();
    std::fs::write(
        tmp.join("index.html"),
        "<!doctype html><html><head><title>Handicap</title></head><body><div id=\"root\"></div></body></html>",
    )
    .unwrap();
    std::fs::write(tmp.join("assets/main.js"), "console.log('ok')").unwrap();
}

async fn build_state(ui_dir: Option<PathBuf>) -> app::AppState {
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
        ui_dir,
        settings: handicap_controller::settings::SettingsState::build(
            &std::collections::HashMap::new(),
            &[],
        ),
        scheduler_tz: chrono_tz::UTC,
    }
}

#[tokio::test]
async fn serves_index_at_root() {
    let tmp = tempfile::tempdir().unwrap();
    write_fixture(tmp.path());
    let state = build_state(Some(tmp.path().to_path_buf())).await;
    let app = app::router(state);

    let req = Request::builder()
        .method(Method::GET)
        .uri("/")
        .body(Body::empty())
        .unwrap();
    let resp = app.oneshot(req).await.unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let body = axum::body::to_bytes(resp.into_body(), usize::MAX)
        .await
        .unwrap();
    assert!(
        String::from_utf8_lossy(&body).contains("Handicap"),
        "index.html should be served at /"
    );
}

#[tokio::test]
async fn serves_static_asset() {
    let tmp = tempfile::tempdir().unwrap();
    write_fixture(tmp.path());
    let state = build_state(Some(tmp.path().to_path_buf())).await;
    let app = app::router(state);

    let req = Request::builder()
        .method(Method::GET)
        .uri("/assets/main.js")
        .body(Body::empty())
        .unwrap();
    let resp = app.oneshot(req).await.unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let body = axum::body::to_bytes(resp.into_body(), usize::MAX)
        .await
        .unwrap();
    assert_eq!(&body[..], b"console.log('ok')");
}

#[tokio::test]
async fn unknown_path_falls_back_to_index() {
    let tmp = tempfile::tempdir().unwrap();
    write_fixture(tmp.path());
    let state = build_state(Some(tmp.path().to_path_buf())).await;
    let app = app::router(state);

    let req = Request::builder()
        .method(Method::GET)
        .uri("/scenarios/01ABC")
        .body(Body::empty())
        .unwrap();
    let resp = app.oneshot(req).await.unwrap();
    assert_eq!(
        resp.status(),
        StatusCode::OK,
        "SPA fallback should serve index.html"
    );
    let body = axum::body::to_bytes(resp.into_body(), usize::MAX)
        .await
        .unwrap();
    assert!(String::from_utf8_lossy(&body).contains("<div id=\"root\">"));
}

#[tokio::test]
async fn api_still_works_with_ui_dir_set() {
    let tmp = tempfile::tempdir().unwrap();
    write_fixture(tmp.path());
    let state = build_state(Some(tmp.path().to_path_buf())).await;
    let app = app::router(state);

    let req = Request::builder()
        .method(Method::GET)
        .uri("/api/health")
        .body(Body::empty())
        .unwrap();
    let resp = app.oneshot(req).await.unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
}

#[tokio::test]
async fn without_ui_dir_returns_404_on_unknown_path() {
    let state = build_state(None).await;
    let app = app::router(state);

    let req = Request::builder()
        .method(Method::GET)
        .uri("/scenarios/01ABC")
        .body(Body::empty())
        .unwrap();
    let resp = app.oneshot(req).await.unwrap();
    assert_eq!(resp.status(), StatusCode::NOT_FOUND);
}
