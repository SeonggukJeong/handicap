use std::sync::Arc;

use axum::body::Body;
use axum::http::{Method, Request, StatusCode};
use handicap_controller::dispatcher::NoopDispatcher;
use handicap_controller::grpc::coordinator::CoordinatorState;
use handicap_controller::monitor::MonitorSupervisor;
use handicap_controller::monitor::board_file::parse_bundle_bytes;
use handicap_controller::monitor::config::BoardConfig;
use handicap_controller::{app, store};
use serde_json::{Value, json};
use tower::ServiceExt;

const STEP_ID: &str = "01J0000000000000000000000A";

fn make_app(db: store::Db) -> axum::Router {
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
        monitor: MonitorSupervisor::default(),
    })
}

async fn send_raw(
    app: &axum::Router,
    method: Method,
    uri: &str,
    body: Option<Value>,
) -> (StatusCode, Vec<u8>) {
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
    (status, bytes.to_vec())
}

async fn send(
    app: &axum::Router,
    method: Method,
    uri: &str,
    body: Option<Value>,
) -> (StatusCode, Value) {
    let (st, bytes) = send_raw(app, method, uri, body).await;
    (st, serde_json::from_slice(&bytes).unwrap_or(Value::Null))
}

async fn create_scenario(app: &axum::Router, name: &str) -> String {
    let yaml = format!(
        "version: 1\nname: {name}\nsteps:\n  - id: {STEP_ID}\n    name: ping\n    type: http\n    request:\n      method: GET\n      url: http://127.0.0.1:1/ping\n"
    );
    let (st, v) = send(
        app,
        Method::POST,
        "/api/scenarios",
        Some(json!({"yaml": yaml})),
    )
    .await;
    assert_eq!(st, StatusCode::CREATED, "{v}");
    v["id"].as_str().unwrap().to_string()
}

async fn create_env(app: &axum::Router, name: &str) -> String {
    let (st, v) = send(
        app,
        Method::POST,
        "/api/environments",
        Some(json!({"name": name, "vars": {"PASSWORD": "pw", "BASE": "http://x"}})),
    )
    .await;
    assert_eq!(st, StatusCode::CREATED, "{v}");
    v["id"].as_str().unwrap().to_string()
}

async fn create_board(app: &axum::Router, name: &str, config: Value) -> String {
    let (st, v) = send(
        app,
        Method::POST,
        "/api/monitor-boards",
        Some(json!({"name": name, "config": config})),
    )
    .await;
    assert_eq!(st, StatusCode::CREATED, "{v}");
    v["id"].as_str().unwrap().to_string()
}

fn simple_config(scenario_id: &str, env_id: Option<&str>) -> Value {
    json!({"panels": [{
        "title": "p1", "scenario_id": scenario_id, "environment_id": env_id
    }]})
}

const EXPORT: &str = "/api/monitor-boards/export";

#[tokio::test]
async fn export_two_boards_dedups_shared_scenario() {
    let db = store::connect("sqlite::memory:").await.unwrap();
    let app = make_app(db);
    let sid = create_scenario(&app, "공유").await;
    let eid = create_env(&app, "운영").await;
    let b1 = create_board(&app, "보드A", simple_config(&sid, Some(&eid))).await;
    let b2 = create_board(&app, "보드B", simple_config(&sid, None)).await;
    // 요청 순서 = b2, b1
    let (st, v) = send(
        &app,
        Method::POST,
        EXPORT,
        Some(json!({"board_ids": [b2, b1]})),
    )
    .await;
    assert_eq!(st, StatusCode::OK, "{v}");
    assert_eq!(v["format"], "handicap-bundle");
    assert_eq!(v["format_version"], 1);
    assert!(v["exported_at"].as_i64().unwrap() > 0);
    assert_eq!(v["app_version"], env!("CARGO_PKG_VERSION"));
    assert_eq!(v["scenarios"].as_array().unwrap().len(), 1);
    assert_eq!(v["scenarios"][0]["id"], sid);
    assert_eq!(v["boards"][0]["id"], b2);
    assert_eq!(v["boards"][1]["id"], b1);
    assert_eq!(v["environments"].as_array().unwrap().len(), 1);
    assert_eq!(v["environments"][0]["vars"]["PASSWORD"], "pw");
}

#[tokio::test]
async fn export_empty_is_400() {
    let db = store::connect("sqlite::memory:").await.unwrap();
    let app = make_app(db);
    let (st, v) = send(&app, Method::POST, EXPORT, Some(json!({"board_ids": []}))).await;
    assert_eq!(st, StatusCode::BAD_REQUEST);
    assert!(
        v["error"]
            .as_str()
            .unwrap()
            .contains("내보낼 보드를 고르세요")
    );
}

#[tokio::test]
async fn export_51_is_400() {
    let db = store::connect("sqlite::memory:").await.unwrap();
    let app = make_app(db);
    let ids: Vec<String> = (0..51).map(|_| ulid::Ulid::new().to_string()).collect();
    let (st, v) = send(&app, Method::POST, EXPORT, Some(json!({"board_ids": ids}))).await;
    assert_eq!(st, StatusCode::BAD_REQUEST);
    assert!(
        v["error"]
            .as_str()
            .unwrap()
            .contains("보드는 한 번에 50개까지 내보낼 수 있습니다")
    );
}

#[tokio::test]
async fn export_duplicate_ids_is_400() {
    let db = store::connect("sqlite::memory:").await.unwrap();
    let app = make_app(db);
    let sid = create_scenario(&app, "s").await;
    let b = create_board(&app, "보드", simple_config(&sid, None)).await;
    let (st, v) = send(
        &app,
        Method::POST,
        EXPORT,
        Some(json!({"board_ids": [b, b]})),
    )
    .await;
    assert_eq!(st, StatusCode::BAD_REQUEST);
    assert!(
        v["error"]
            .as_str()
            .unwrap()
            .contains("보드가 중복되었습니다")
    );
}

#[tokio::test]
async fn export_unknown_board_is_404() {
    let db = store::connect("sqlite::memory:").await.unwrap();
    let app = make_app(db);
    let (st, _) = send(
        &app,
        Method::POST,
        EXPORT,
        Some(json!({"board_ids": [ulid::Ulid::new().to_string()]})),
    )
    .await;
    assert_eq!(st, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn export_missing_scenario_is_400() {
    let db = store::connect("sqlite::memory:").await.unwrap();
    let app = make_app(db.clone());
    let sid = create_scenario(&app, "s").await;
    let b = create_board(&app, "점검판", simple_config(&sid, None)).await;
    sqlx::query("DELETE FROM scenarios WHERE id = ?")
        .bind(&sid)
        .execute(&db)
        .await
        .unwrap();
    let (st, v) = send(&app, Method::POST, EXPORT, Some(json!({"board_ids": [b]}))).await;
    assert_eq!(st, StatusCode::BAD_REQUEST);
    assert_eq!(v["error"], "보드 '점검판' 칸 1: 시나리오가 없습니다");
}

#[tokio::test]
async fn export_missing_environment_is_400() {
    let db = store::connect("sqlite::memory:").await.unwrap();
    let app = make_app(db.clone());
    let sid = create_scenario(&app, "s").await;
    let eid = create_env(&app, "운영").await;
    let b = create_board(&app, "점검판", simple_config(&sid, Some(&eid))).await;
    sqlx::query("DELETE FROM environments WHERE id = ?")
        .bind(&eid)
        .execute(&db)
        .await
        .unwrap();
    let (st, v) = send(&app, Method::POST, EXPORT, Some(json!({"board_ids": [b]}))).await;
    assert_eq!(st, StatusCode::BAD_REQUEST);
    assert_eq!(v["error"], "보드 '점검판' 칸 1: 환경이 없습니다");
}

#[tokio::test]
async fn export_self_validation_rejects_bad_saved_board() {
    let db = store::connect("sqlite::memory:").await.unwrap();
    let app = make_app(db.clone());
    let sid = create_scenario(&app, "s").await;
    let cfg = json!({"panels": [{
        "title": "p1", "scenario_id": sid,
        "conditions": [{"step_id": STEP_ID, "source": "body", "path": "$.a", "op": "exists"}]
    }]});
    let b = create_board(&app, "나쁜보드", cfg).await;
    let n = sqlx::query(
        "UPDATE monitor_boards SET config_json = replace(config_json, '\"$.a\"', '\"$..a..b\"') WHERE id = ?",
    )
    .bind(&b)
    .execute(&db)
    .await
    .unwrap()
    .rows_affected();
    assert_eq!(n, 1);
    let (st, v) = send(&app, Method::POST, EXPORT, Some(json!({"board_ids": [b]}))).await;
    assert_eq!(st, StatusCode::BAD_REQUEST, "{v}");
    assert!(v["error"].as_str().unwrap().starts_with("보드 '"), "{v}");
}

#[tokio::test]
async fn export_output_parses_back() {
    let db = store::connect("sqlite::memory:").await.unwrap();
    let app = make_app(db);
    let sid = create_scenario(&app, "s").await;
    let eid = create_env(&app, "운영").await;
    let cfg = json!({
        "show_latency_stats": false, "record_limit_kb": 512,
        "panels": [{
            "title": "p1", "scenario_id": sid, "environment_id": eid,
            "latency_source": {"kind": "step", "step_id": STEP_ID},
            "display_items": [{"step_id": STEP_ID, "source": "status"}]
        }]
    });
    let b = create_board(&app, "보드", cfg).await;
    let (_, saved) = send(&app, Method::GET, &format!("/api/monitor-boards/{b}"), None).await;
    let original: BoardConfig = serde_json::from_value(saved["config"].clone()).unwrap();
    assert!(!original.show_latency_stats);
    let (st, bytes) = send_raw(&app, Method::POST, EXPORT, Some(json!({"board_ids": [b]}))).await;
    assert_eq!(st, StatusCode::OK);
    let parsed = parse_bundle_bytes(&bytes).expect("export must parse back");
    assert_eq!(parsed.boards[0].config, original);
    assert_eq!(parsed.boards[0].id, b);
}
