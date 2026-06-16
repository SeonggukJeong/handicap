use std::sync::Arc;

use axum::body::Body;
use axum::http::{Method, Request, StatusCode};
use handicap_controller::dispatcher::subprocess::SubprocessDispatcher;
use handicap_controller::grpc::coordinator::CoordinatorState;
use handicap_controller::{app, store};
use serde_json::{Value, json};
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
    // `Builder` methods take `self` by value, so `builder` is moved into exactly
    // one match arm — no `mut`, no clippy unused_mut warning under -D warnings.
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

#[tokio::test]
async fn environment_create_list_get_update_delete() {
    let db = store::connect("sqlite::memory:").await.unwrap();
    let app = make_app(db);

    // create
    let (status, created) = send(
        &app,
        Method::POST,
        "/api/environments",
        Some(json!({ "name": "staging", "vars": { "BASE_URL": "http://s", "API_KEY": "k" } })),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    let id = created["id"].as_str().unwrap().to_string();
    assert_eq!(created["name"], "staging");
    assert_eq!(created["vars"]["BASE_URL"], "http://s");

    // list (summary: var_count, no vars)
    let (status, list) = send(&app, Method::GET, "/api/environments", None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(list["environments"].as_array().unwrap().len(), 1);
    assert_eq!(list["environments"][0]["var_count"], 2);
    assert!(list["environments"][0].get("vars").is_none());

    // get (full: vars present)
    let (status, full) = send(&app, Method::GET, &format!("/api/environments/{id}"), None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(full["vars"]["API_KEY"], "k");

    // update (rename + replace vars)
    let (status, updated) = send(
        &app,
        Method::PUT,
        &format!("/api/environments/{id}"),
        Some(json!({ "name": "prod", "vars": { "BASE_URL": "http://p" } })),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(updated["name"], "prod");
    assert!(updated["vars"].get("API_KEY").is_none());

    // delete (204, unguarded)
    let (status, _) = send(
        &app,
        Method::DELETE,
        &format!("/api/environments/{id}"),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let (status, _) = send(&app, Method::GET, &format!("/api/environments/{id}"), None).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn duplicate_name_is_409() {
    let db = store::connect("sqlite::memory:").await.unwrap();
    let app = make_app(db);
    let (s1, _) = send(
        &app,
        Method::POST,
        "/api/environments",
        Some(json!({ "name": "x", "vars": {} })),
    )
    .await;
    assert_eq!(s1, StatusCode::CREATED);
    let (s2, _) = send(
        &app,
        Method::POST,
        "/api/environments",
        Some(json!({ "name": "x", "vars": {} })),
    )
    .await;
    assert_eq!(s2, StatusCode::CONFLICT);
}

#[tokio::test]
async fn empty_name_is_400() {
    let db = store::connect("sqlite::memory:").await.unwrap();
    let app = make_app(db);
    let (s, _) = send(
        &app,
        Method::POST,
        "/api/environments",
        Some(json!({ "name": "  ", "vars": {} })),
    )
    .await;
    assert_eq!(s, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn invalid_var_key_is_400() {
    let db = store::connect("sqlite::memory:").await.unwrap();
    let app = make_app(db);
    // key contains ':' (conservative reject for the ${NAME:-default} separator).
    let (s, _) = send(
        &app,
        Method::POST,
        "/api/environments",
        Some(json!({ "name": "x", "vars": { "BAD:KEY": "v" } })),
    )
    .await;
    assert_eq!(s, StatusCode::BAD_REQUEST);
}
