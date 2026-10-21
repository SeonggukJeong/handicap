use std::sync::Arc;
use std::time::Duration;

use axum::body::Body;
use axum::http::{Method, Request, StatusCode};
use handicap_controller::dispatcher::NoopDispatcher;
use handicap_controller::grpc::coordinator::CoordinatorState;
use handicap_controller::monitor::MonitorSupervisor;
use handicap_controller::{app, store};
use serde_json::{Value, json};
use tower::ServiceExt;
use wiremock::matchers::any;
use wiremock::{Mock, MockServer, ResponseTemplate};

const STEP_ID: &str = "01J0000000000000000000000A";

fn make_app(db: store::Db) -> (axum::Router, MonitorSupervisor) {
    let monitor = MonitorSupervisor::default();
    let coord = CoordinatorState::new(db.clone());
    let router = app::router(app::AppState {
        db,
        coord,
        dispatcher: Arc::new(NoopDispatcher),
        ui_dir: None,
        settings: handicap_controller::settings::SettingsState::build(
            &std::collections::HashMap::new(),
            &[],
        ),
        scheduler_tz: chrono_tz::UTC,
        monitor: monitor.clone(),
    });
    (router, monitor)
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

async fn create_scenario(app: &axum::Router, url: &str) -> String {
    let yaml = format!(
        "version: 1\nname: mon-{}\nsteps:\n  - id: {STEP_ID}\n    name: ping\n    type: http\n    request:\n      method: GET\n      url: {url}\n    assert:\n      - status: 200\n",
        ulid::Ulid::new()
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

fn board_body(name: &str, scenario_id: &str, interval: u32) -> Value {
    json!({
        "name": name,
        "config": { "panels": [{
            "title": "p1", "scenario_id": scenario_id,
            "interval_seconds": interval, "timeout_seconds": 5
        }] }
    })
}

async fn mock(status: u16) -> MockServer {
    let s = MockServer::start().await;
    Mock::given(any())
        .respond_with(ResponseTemplate::new(status))
        .mount(&s)
        .await;
    s
}

fn url(id: &str, suffix: &str) -> String {
    format!("/api/monitor-boards/{id}{suffix}")
}

async fn wait_results(app: &axum::Router, id: &str, min: usize) -> Value {
    for _ in 0..80 {
        let (_, st) = send(app, Method::GET, &url(id, "/status"), None).await;
        if st["panels"][0]["results"]
            .as_array()
            .is_some_and(|r| r.len() >= min)
        {
            return st;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    panic!("no results in time");
}

async fn new_board(app: &axum::Router, name: &str, sid: &str, interval: u32) -> Value {
    let (st, v) = send(
        app,
        Method::POST,
        "/api/monitor-boards",
        Some(board_body(name, sid, interval)),
    )
    .await;
    assert_eq!(st, StatusCode::CREATED, "{v}");
    v
}

#[tokio::test]
async fn create_list_get_update_delete() {
    let db = store::connect("sqlite::memory:").await.unwrap();
    let (app, _) = make_app(db);
    let created = new_board(&app, "  보드  ", "S1", 10).await;
    let id = created["id"].as_str().unwrap().to_string();
    assert_eq!(created["name"], "보드");
    assert_eq!(created["enabled"], false);
    assert_eq!(
        created["config"]["panels"][0]["id"].as_str().unwrap().len(),
        26
    );

    let (st, list) = send(&app, Method::GET, "/api/monitor-boards", None).await;
    assert_eq!(st, StatusCode::OK);
    assert_eq!(list["boards"].as_array().unwrap().len(), 1);

    let (st, got) = send(&app, Method::GET, &url(&id, ""), None).await;
    assert_eq!(st, StatusCode::OK);
    assert_eq!(got["id"], id.as_str());

    let (st, upd) = send(
        &app,
        Method::PUT,
        &url(&id, ""),
        Some(board_body("renamed", "S1", 10)),
    )
    .await;
    assert_eq!(st, StatusCode::OK);
    assert_eq!(upd["name"], "renamed");

    let (st, _) = send(&app, Method::DELETE, &url(&id, ""), None).await;
    assert_eq!(st, StatusCode::NO_CONTENT);
    let (st, _) = send(&app, Method::GET, &url(&id, ""), None).await;
    assert_eq!(st, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn create_400_on_invalid_config() {
    let db = store::connect("sqlite::memory:").await.unwrap();
    let (app, _) = make_app(db);
    let (st, v) = send(
        &app,
        Method::POST,
        "/api/monitor-boards",
        Some(json!({"name":"x","config":{"panels":[]}})),
    )
    .await;
    assert_eq!(st, StatusCode::BAD_REQUEST);
    assert!(v["error"].as_str().unwrap().contains("칸"));
}

#[tokio::test]
async fn duplicate_name_409() {
    let db = store::connect("sqlite::memory:").await.unwrap();
    let (app, _) = make_app(db);
    new_board(&app, "dup", "S1", 10).await;
    let (st, _) = send(
        &app,
        Method::POST,
        "/api/monitor-boards",
        Some(board_body("dup", "S1", 10)),
    )
    .await;
    assert_eq!(st, StatusCode::CONFLICT);
    let other = new_board(&app, "other", "S1", 10).await;
    let (st, _) = send(
        &app,
        Method::PUT,
        &url(other["id"].as_str().unwrap(), ""),
        Some(board_body("dup", "S1", 10)),
    )
    .await;
    assert_eq!(st, StatusCode::CONFLICT);
}

#[tokio::test]
async fn unknown_id_404() {
    let db = store::connect("sqlite::memory:").await.unwrap();
    let (app, _) = make_app(db);
    let nid = "01J000000000000000000000ZZ";
    for (m, suffix, body) in [
        (Method::GET, "", None),
        (Method::PUT, "", Some(board_body("x", "S1", 10))),
        (Method::DELETE, "", None),
        (Method::POST, "/start", None),
        (Method::POST, "/stop", None),
        (Method::GET, "/status", None),
    ] {
        let (st, _) = send(&app, m.clone(), &url(nid, suffix), body).await;
        assert_eq!(st, StatusCode::NOT_FOUND, "{m} {suffix}");
    }
}

#[tokio::test]
async fn start_status_stop() {
    let db = store::connect("sqlite::memory:").await.unwrap();
    let (app, _) = make_app(db);
    let srv = mock(200).await;
    let sid = create_scenario(&app, &srv.uri()).await;
    let b = new_board(&app, "b", &sid, 1).await;
    let id = b["id"].as_str().unwrap();

    let (_, st) = send(&app, Method::GET, &url(id, "/status"), None).await;
    assert_eq!(st["enabled"], false);
    assert!(st["started_at_ms"].is_null());
    assert!(st["panels"][0]["results"].as_array().unwrap().is_empty());
    assert_eq!(st["panels"][0]["consecutive_fail"], 0);
    assert!(st["panels"][0]["fail_since_ms"].is_null());
    assert_eq!(st["panels"][0]["running"], false);

    let (s, started) = send(&app, Method::POST, &url(id, "/start"), None).await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(started["enabled"], true);
    let st = wait_results(&app, id, 1).await;
    assert_eq!(st["enabled"], true);
    assert!(st["started_at_ms"].is_i64());
    assert_eq!(st["panels"][0]["results"][0]["verdict"], "ok");

    let (s, stopped) = send(&app, Method::POST, &url(id, "/stop"), None).await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(stopped["enabled"], false);
    let (_, st) = send(&app, Method::GET, &url(id, "/status"), None).await;
    assert_eq!(st["enabled"], false);
    assert!(st["started_at_ms"].is_null());
    assert!(st["panels"][0]["results"].as_array().unwrap().is_empty());
}

#[tokio::test]
async fn put_bumps_board_updated_at_and_reconfigures() {
    let db = store::connect("sqlite::memory:").await.unwrap();
    let (app, _) = make_app(db);
    let b = new_board(&app, "b", "S1", 10).await;
    let id = b["id"].as_str().unwrap();
    tokio::time::sleep(Duration::from_millis(10)).await;
    let (_, u) = send(
        &app,
        Method::PUT,
        &url(id, ""),
        Some(board_body("b", "S1", 20)),
    )
    .await;
    assert!(u["updated_at"].as_i64() > b["updated_at"].as_i64());
    let (_, st) = send(&app, Method::GET, &url(id, "/status"), None).await;
    assert_eq!(st["board_updated_at"], u["updated_at"]);
    assert_eq!(u["config"]["panels"][0]["interval_seconds"], 20);
}

#[tokio::test]
async fn start_stop_do_not_bump_updated_at() {
    let db = store::connect("sqlite::memory:").await.unwrap();
    let (app, _) = make_app(db);
    let b = new_board(&app, "b", "S1", 10).await;
    let id = b["id"].as_str().unwrap();
    tokio::time::sleep(Duration::from_millis(10)).await;
    let (_, a) = send(&app, Method::POST, &url(id, "/start"), None).await;
    let (_, z) = send(&app, Method::POST, &url(id, "/stop"), None).await;
    assert_eq!(a["updated_at"], b["updated_at"]);
    assert_eq!(z["updated_at"], b["updated_at"]);
}

#[tokio::test]
async fn status_consecutive_fail_wired() {
    let db = store::connect("sqlite::memory:").await.unwrap();
    let (app, _) = make_app(db);
    let srv = mock(503).await;
    let sid = create_scenario(&app, &srv.uri()).await;
    let b = new_board(&app, "b", &sid, 1).await;
    let id = b["id"].as_str().unwrap();
    send(&app, Method::POST, &url(id, "/start"), None).await;
    let st = wait_results(&app, id, 3).await;
    let p = &st["panels"][0];
    let n = p["results"].as_array().unwrap().len() as u64;
    assert!(p["consecutive_fail"].as_u64().unwrap() >= n);
    assert_eq!(p["fail_since_ms"], p["results"][0]["at_ms"]);
    assert_eq!(p["results"][0]["verdict"], "fail");
    send(&app, Method::POST, &url(id, "/stop"), None).await;
}

#[tokio::test]
async fn preview_check_returns_trace_and_result() {
    let db = store::connect("sqlite::memory:").await.unwrap();
    let (app, _) = make_app(db);
    let srv = mock(200).await;
    let sid = create_scenario(&app, &srv.uri()).await;
    let (st, v) = send(
        &app,
        Method::POST,
        "/api/monitor-boards/preview-check",
        Some(json!({"title":"t","scenario_id":sid})),
    )
    .await;
    assert_eq!(st, StatusCode::OK, "{v}");
    assert_eq!(v["result"]["verdict"], "ok");
    assert!(v["trace"].is_object());
}

#[tokio::test]
async fn preview_check_400_on_invalid_panel() {
    let db = store::connect("sqlite::memory:").await.unwrap();
    let (app, _) = make_app(db);
    let (st, _) = send(
        &app,
        Method::POST,
        "/api/monitor-boards/preview-check",
        Some(json!({"title":"","scenario_id":"S"})),
    )
    .await;
    assert_eq!(st, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn delete_stops_running_board() {
    let db = store::connect("sqlite::memory:").await.unwrap();
    let (app, monitor) = make_app(db);
    let srv = mock(200).await;
    let sid = create_scenario(&app, &srv.uri()).await;
    let b = new_board(&app, "b", &sid, 1).await;
    let id = b["id"].as_str().unwrap();
    send(&app, Method::POST, &url(id, "/start"), None).await;
    wait_results(&app, id, 1).await;
    assert!(monitor.snapshot(id).await.is_some());
    let (st, _) = send(&app, Method::DELETE, &url(id, ""), None).await;
    assert_eq!(st, StatusCode::NO_CONTENT);
    assert!(monitor.snapshot(id).await.is_none());
}

#[tokio::test(flavor = "multi_thread")]
async fn concurrent_stop_and_put_end_consistent() {
    let db = store::connect("sqlite::memory:").await.unwrap();
    let (app, monitor) = make_app(db.clone());
    let b = new_board(&app, "b", "S1", 10).await;
    let id = b["id"].as_str().unwrap().to_string();
    for i in 0..20u32 {
        send(&app, Method::POST, &url(&id, "/start"), None).await;
        let (stop_url, put_url) = (url(&id, "/stop"), url(&id, ""));
        let (a, b2) = tokio::join!(
            send(&app, Method::POST, &stop_url, None),
            send(
                &app,
                Method::PUT,
                &put_url,
                Some(board_body("b", "S1", 10 + (i % 5))),
            )
        );
        assert_eq!(a.0, StatusCode::OK);
        assert_eq!(b2.0, StatusCode::OK);
        let row = store::monitor_boards::get(&db, &id).await.unwrap().unwrap();
        assert_eq!(
            row.enabled,
            monitor.snapshot(&id).await.is_some(),
            "iter {i}"
        );
    }
    send(&app, Method::POST, &url(&id, "/stop"), None).await;
}
