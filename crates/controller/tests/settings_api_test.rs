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
        db: db.clone(),
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

/// GET /api/settings returns items including worker_capacity_vus (mutable) and
/// trace_body_cap_bytes (mutable:false).
#[tokio::test]
async fn get_returns_registry_rows() {
    let db = store::connect("sqlite::memory:").await.unwrap();
    let app = make_app(db);

    let (status, body) = send(&app, Method::GET, "/api/settings", None).await;
    assert_eq!(status, StatusCode::OK);

    let items = body["settings"].as_array().expect("settings array");
    // worker_capacity_vus is mutable
    let wc = items
        .iter()
        .find(|i| i["key"] == "worker_capacity_vus")
        .expect("worker_capacity_vus present");
    assert_eq!(wc["mutable"], true);
    assert!(wc["value"].is_number());
    assert_eq!(wc["source"], "default");

    // trace_body_cap_bytes is read-only
    let tb = items
        .iter()
        .find(|i| i["key"] == "trace_body_cap_bytes")
        .expect("trace_body_cap_bytes present");
    assert_eq!(tb["mutable"], false);
    assert_eq!(tb["source"], "readonly");
}

/// PUT /api/settings/max_data_bindings {value:20} → 200 + updated DTO in body; GET reflects.
#[tokio::test]
async fn put_valid_then_get_reflects() {
    let db = store::connect("sqlite::memory:").await.unwrap();
    let app = make_app(db);

    let (status, put_body) = send(
        &app,
        Method::PUT,
        "/api/settings/max_data_bindings",
        Some(json!({ "value": 20 })),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    // R2: PUT response body must be the updated DTO.
    assert_eq!(
        put_body["value"], 20,
        "PUT response body must contain updated value"
    );
    assert_eq!(
        put_body["source"], "override",
        "PUT response body must show source=override"
    );
    assert_eq!(put_body["key"], "max_data_bindings");

    let (status, body) = send(&app, Method::GET, "/api/settings", None).await;
    assert_eq!(status, StatusCode::OK);

    let items = body["settings"].as_array().expect("settings array");
    let mdb = items
        .iter()
        .find(|i| i["key"] == "max_data_bindings")
        .expect("max_data_bindings present");
    assert_eq!(mdb["value"], 20);
    assert_eq!(mdb["source"], "override");
}

/// PUT max_data_bindings {value:999} (max 64) → 400.
#[tokio::test]
async fn put_out_of_range_400() {
    let db = store::connect("sqlite::memory:").await.unwrap();
    let app = make_app(db);

    let (status, _) = send(
        &app,
        Method::PUT,
        "/api/settings/max_data_bindings",
        Some(json!({ "value": 999 })),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
}

/// PUT trace_body_cap_bytes {value:5} → 400 (immutable setting).
#[tokio::test]
async fn put_immutable_400() {
    let db = store::connect("sqlite::memory:").await.unwrap();
    let app = make_app(db);

    let (status, _) = send(
        &app,
        Method::PUT,
        "/api/settings/trace_body_cap_bytes",
        Some(json!({ "value": 5 })),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
}

/// PUT /api/settings/nope {value:5} → 400 (unknown key).
#[tokio::test]
async fn put_unknown_key_400() {
    let db = store::connect("sqlite::memory:").await.unwrap();
    let app = make_app(db);

    let (status, _) = send(
        &app,
        Method::PUT,
        "/api/settings/nope",
        Some(json!({ "value": 5 })),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
}

/// PUT max_data_bindings=20 then DELETE → 204; GET shows value=8 (default), source="default".
#[tokio::test]
async fn delete_reverts_default() {
    let db = store::connect("sqlite::memory:").await.unwrap();
    let app = make_app(db);

    // set override
    let (status, _) = send(
        &app,
        Method::PUT,
        "/api/settings/max_data_bindings",
        Some(json!({ "value": 20 })),
    )
    .await;
    assert_eq!(status, StatusCode::OK);

    // delete override
    let (status, _) = send(
        &app,
        Method::DELETE,
        "/api/settings/max_data_bindings",
        None,
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT);

    // GET shows default
    let (status, body) = send(&app, Method::GET, "/api/settings", None).await;
    assert_eq!(status, StatusCode::OK);

    let items = body["settings"].as_array().expect("settings array");
    let mdb = items
        .iter()
        .find(|i| i["key"] == "max_data_bindings")
        .expect("max_data_bindings present");
    assert_eq!(mdb["value"], 8);
    assert_eq!(mdb["source"], "default");
}

/// PUT max_open_loop_worker_count {value:2} → 200; POST open-loop run with worker_count:3 → 400.
#[tokio::test]
async fn lowered_worker_count_cap_enforced_on_run() {
    let db = store::connect("sqlite::memory:").await.unwrap();
    let app = make_app(db);

    // Lower the cap to 2
    let (status, _) = send(
        &app,
        Method::PUT,
        "/api/settings/max_open_loop_worker_count",
        Some(json!({ "value": 2 })),
    )
    .await;
    assert_eq!(status, StatusCode::OK);

    // Create a scenario first
    let scenario_yaml = r#"version: 1
name: open-loop test
steps:
  - id: 01JVXXXXXXXXXXXXXXXXXTEST01
    type: http
    name: ping
    request:
      method: GET
      url: http://127.0.0.1:19999/ping
"#;
    let (s, created) = send(
        &app,
        Method::POST,
        "/api/scenarios",
        Some(json!({ "yaml": scenario_yaml })),
    )
    .await;
    assert_eq!(s, StatusCode::CREATED, "scenario create: {created}");
    let sid = created["id"].as_str().unwrap().to_string();

    // POST run with worker_count:3 (exceeds cap of 2) → 400
    let (status, _body) = send(
        &app,
        Method::POST,
        "/api/runs",
        Some(json!({
            "scenario_id": sid,
            "profile": {
                "target_rps": 10,
                "max_in_flight": 20,
                "duration_seconds": 5,
                "worker_count": 3
            },
            "env": {}
        })),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
}

/// DELETE /api/settings/nope → 400 (unknown key).
#[tokio::test]
async fn delete_unknown_key_400() {
    let db = store::connect("sqlite::memory:").await.unwrap();
    let app = make_app(db);

    let (status, _) = send(&app, Method::DELETE, "/api/settings/nope", None).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
}

/// A/B grace는 mutable + pair 제약 없음 — PUT 후 형제 키 불변, 범위밖 400, DELETE 복원.
#[tokio::test]
async fn put_delete_run_grace_roundtrip_sibling_unchanged() {
    let db = store::connect("sqlite::memory:").await.unwrap();
    let app = make_app(db);

    // PUT in-range → 200 override
    let (status, body) = send(
        &app,
        Method::PUT,
        "/api/settings/run_startup_grace_seconds",
        Some(json!({ "value": 45 })),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["value"], 45);
    assert_eq!(body["source"], "override");

    // 형제 키(run_backstop_grace_seconds) 불변 — pair 제약 없음
    let (status, body) = send(&app, Method::GET, "/api/settings", None).await;
    assert_eq!(status, StatusCode::OK);
    let items = body["settings"].as_array().unwrap();
    let backstop = items
        .iter()
        .find(|s| s["key"] == "run_backstop_grace_seconds")
        .expect("backstop row");
    assert_eq!(backstop["value"], 120, "형제 키 불변");
    assert_eq!(backstop["source"], "default");

    // 범위 밖(max 3600 초과) → 400
    let (status, _) = send(
        &app,
        Method::PUT,
        "/api/settings/run_startup_grace_seconds",
        Some(json!({ "value": 99999 })),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    // DELETE → 204, 값이 시드(default 90)로 복원
    let (status, _) = send(
        &app,
        Method::DELETE,
        "/api/settings/run_startup_grace_seconds",
        None,
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let (_, body) = send(&app, Method::GET, "/api/settings", None).await;
    let startup = body["settings"]
        .as_array()
        .unwrap()
        .iter()
        .find(|s| s["key"] == "run_startup_grace_seconds")
        .expect("startup row");
    assert_eq!(startup["value"], 90);
    assert_eq!(startup["source"], "default");
}

/// DELETE /api/settings/trace_body_cap_bytes → 400 (immutable setting).
#[tokio::test]
async fn delete_immutable_key_400() {
    let db = store::connect("sqlite::memory:").await.unwrap();
    let app = make_app(db);

    let (status, _) = send(
        &app,
        Method::DELETE,
        "/api/settings/trace_body_cap_bytes",
        None,
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
}

/// PUT interval ≥ 현재 stale → 400 (R5a).
#[tokio::test]
async fn put_interval_ge_stale_400() {
    let db = store::connect("sqlite::memory:").await.unwrap();
    let app = make_app(db);
    // default interval=10, stale=30 → interval=40 violates (40 >= 30)
    let (status, _) = send(
        &app,
        Method::PUT,
        "/api/settings/pool_heartbeat_interval_seconds",
        Some(json!({ "value": 40 })),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
}

/// PUT stale ≤ 현재 interval → 400 (R5a).
#[tokio::test]
async fn put_stale_le_interval_400() {
    let db = store::connect("sqlite::memory:").await.unwrap();
    let app = make_app(db);
    let (status, _) = send(
        &app,
        Method::PUT,
        "/api/settings/pool_stale_timeout_seconds",
        Some(json!({ "value": 5 })), // 5 <= interval 10
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
}

/// 유효 순서(stale 먼저↑ 후 interval↑) → 둘 다 200 (R5a edit-ordering).
#[tokio::test]
async fn put_valid_order_200() {
    let db = store::connect("sqlite::memory:").await.unwrap();
    let app = make_app(db);
    let (s1, _) = send(
        &app,
        Method::PUT,
        "/api/settings/pool_stale_timeout_seconds",
        Some(json!({ "value": 100 })),
    )
    .await;
    assert_eq!(s1, StatusCode::OK);
    let (s2, _) = send(
        &app,
        Method::PUT,
        "/api/settings/pool_heartbeat_interval_seconds",
        Some(json!({ "value": 40 })),
    )
    .await;
    assert_eq!(s2, StatusCode::OK); // 40 < 100 ok
}

/// 부분 revert로 stale ≤ interval 재현 → DELETE 400 (R5b).
#[tokio::test]
async fn delete_revert_creating_violation_400() {
    let db = store::connect("sqlite::memory:").await.unwrap();
    let app = make_app(db);
    // interval override 5 (5 < 30 ok)
    let (s1, _) = send(
        &app,
        Method::PUT,
        "/api/settings/pool_heartbeat_interval_seconds",
        Some(json!({ "value": 5 })),
    )
    .await;
    assert_eq!(s1, StatusCode::OK);
    // stale override 8 (8 > 5 ok)
    let (s2, _) = send(
        &app,
        Method::PUT,
        "/api/settings/pool_stale_timeout_seconds",
        Some(json!({ "value": 8 })),
    )
    .await;
    assert_eq!(s2, StatusCode::OK);
    // DELETE interval → reverts to seed 10; pair (10, current stale 8) → 8 <= 10 → reject
    let (s3, _) = send(
        &app,
        Method::DELETE,
        "/api/settings/pool_heartbeat_interval_seconds",
        None,
    )
    .await;
    assert_eq!(s3, StatusCode::BAD_REQUEST);
}
