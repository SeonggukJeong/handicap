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
async fn save_400_message_has_panel_prefix() {
    let db = store::connect("sqlite::memory:").await.unwrap();
    let (app, _) = make_app(db);
    let (st, v) = send(
        &app,
        Method::POST,
        "/api/monitor-boards",
        Some(board_body("x", "", 10)),
    )
    .await;
    assert_eq!(st, StatusCode::BAD_REQUEST);
    assert!(v["error"].as_str().unwrap().starts_with("칸 1: "));
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

#[tokio::test(flavor = "multi_thread")]
async fn resume_enabled_restarts_enabled_boards() {
    let db = store::connect("sqlite::memory:").await.unwrap();
    let (app, _) = make_app(db.clone());
    let on = new_board(&app, "on", "S1", 10).await;
    let off = new_board(&app, "off", "S1", 10).await;
    let on_id = on["id"].as_str().unwrap().to_string();
    let off_id = off["id"].as_str().unwrap().to_string();
    store::monitor_boards::set_enabled(&db, &on_id, true)
        .await
        .unwrap();

    // 새 감독자 = 컨트롤러 재시작 직후 상태(아무 루프도 안 돎).
    let monitor = MonitorSupervisor::default();
    let state = app::AppState {
        db: db.clone(),
        coord: CoordinatorState::new(db.clone()),
        dispatcher: Arc::new(NoopDispatcher),
        ui_dir: None,
        settings: handicap_controller::settings::SettingsState::build(
            &std::collections::HashMap::new(),
            &[],
        ),
        scheduler_tz: chrono_tz::UTC,
        monitor: monitor.clone(),
    };
    assert!(monitor.snapshot(&on_id).await.is_none());
    let n = handicap_controller::monitor::resume_enabled(&state)
        .await
        .unwrap();
    assert_eq!(n, 1);
    assert!(monitor.snapshot(&on_id).await.is_some());
    assert!(monitor.snapshot(&off_id).await.is_none());
    monitor.stop_all().await;
}

async fn json_mock(body: &str) -> MockServer {
    let s = MockServer::start().await;
    Mock::given(any())
        .respond_with(ResponseTemplate::new(200).set_body_raw(body.to_string(), "application/json"))
        .mount(&s)
        .await;
    s
}

fn cond(op: &str, value: &str) -> Value {
    json!({"step_id": STEP_ID, "source": "body", "path": "$.resultCode", "op": op, "value": value})
}

#[tokio::test]
async fn preview_check_condition_fail_reports_value_and_detail() {
    let db = store::connect("sqlite::memory:").await.unwrap();
    let (app, _) = make_app(db);
    let srv = json_mock(r#"{"resultCode":"E1023"}"#).await;
    let sid = create_scenario(&app, &srv.uri()).await;
    let (st, v) = send(
        &app,
        Method::POST,
        "/api/monitor-boards/preview-check",
        Some(json!({"title":"t","scenario_id":sid,"conditions":[cond("eq","0000")]})),
    )
    .await;
    assert_eq!(st, StatusCode::OK, "{v}");
    assert_eq!(v["result"]["verdict"], "fail");
    assert_eq!(v["result"]["reason"], "E1023");
    assert_eq!(v["result"]["detail"], "resultCode = 0000");
}

#[tokio::test]
async fn preview_check_400_on_invalid_condition() {
    let db = store::connect("sqlite::memory:").await.unwrap();
    let (app, _) = make_app(db);
    let (st, v) = send(
        &app,
        Method::POST,
        "/api/monitor-boards/preview-check",
        Some(json!({"title":"t","scenario_id":"S","conditions":[cond("gt","abc")]})),
    )
    .await;
    assert_eq!(st, StatusCode::BAD_REQUEST, "{v}");
    assert_eq!(
        v["error"],
        "크기 비교 조건(>, <, ≥, ≤)의 비교값은 숫자여야 합니다"
    );
}

#[tokio::test]
async fn board_roundtrip_keeps_conditions_and_display_style() {
    let db = store::connect("sqlite::memory:").await.unwrap();
    let (app, _) = make_app(db);
    let srv = mock(200).await;
    let sid = create_scenario(&app, &srv.uri()).await;
    let mut body = board_body("rt", &sid, 10);
    body["config"]["display_style"] = json!("focus");
    body["config"]["panels"][0]["conditions"] = json!([cond("eq", "0000")]);
    let (st, v) = send(&app, Method::POST, "/api/monitor-boards", Some(body)).await;
    assert_eq!(st, StatusCode::CREATED, "{v}");
    let id = v["id"].as_str().unwrap();
    let (st, g) = send(
        &app,
        Method::GET,
        &format!("/api/monitor-boards/{id}"),
        None,
    )
    .await;
    assert_eq!(st, StatusCode::OK, "{g}");
    assert_eq!(g["config"]["display_style"], "focus");
    let c = &g["config"]["panels"][0]["conditions"];
    assert_eq!(c.as_array().unwrap().len(), 1, "{g}");
    assert_eq!(c[0]["step_id"], STEP_ID);
    assert_eq!(c[0]["path"], "$.resultCode");
    assert_eq!(c[0]["op"], "eq");
    assert_eq!(c[0]["value"], "0000");
}

#[tokio::test]
async fn legacy_board_row_loads_with_defaults() {
    let db = store::connect("sqlite::memory:").await.unwrap();
    let (app, _) = make_app(db.clone());
    let srv = mock(200).await;
    let sid = create_scenario(&app, &srv.uri()).await;
    let b = new_board(&app, "legacy", &sid, 10).await;
    let id = b["id"].as_str().unwrap();
    let legacy = json!({"panels": [{
        "id": "P1", "title": "p1", "scenario_id": sid,
        "interval_seconds": 10, "timeout_seconds": 5
    }]})
    .to_string();
    sqlx::query("UPDATE monitor_boards SET config_json = ? WHERE id = ?")
        .bind(legacy)
        .bind(id)
        .execute(&db)
        .await
        .unwrap();
    let (st, g) = send(
        &app,
        Method::GET,
        &format!("/api/monitor-boards/{id}"),
        None,
    )
    .await;
    assert_eq!(st, StatusCode::OK, "{g}");
    assert_eq!(g["config"]["display_style"], "border");
    assert_eq!(g["config"]["panels"][0]["conditions"], json!([]));
}

#[tokio::test]
async fn status_detail_is_serialized_as_null() {
    let db = store::connect("sqlite::memory:").await.unwrap();
    let (app, _) = make_app(db);
    let srv = mock(200).await;
    let sid = create_scenario(&app, &srv.uri()).await;
    let b = new_board(&app, "d", &sid, 1).await;
    let id = b["id"].as_str().unwrap();
    send(&app, Method::POST, &url(id, "/start"), None).await;
    let st = wait_results(&app, id, 1).await;
    let r = st["panels"][0]["results"][0].as_object().unwrap();
    assert!(r.contains_key("detail"), "{r:?}");
    assert!(r["detail"].is_null());
    send(&app, Method::POST, &url(id, "/stop"), None).await;
}

fn ls_url(id: &str) -> String {
    format!("/api/monitor-boards/{id}/latency-stats")
}

#[tokio::test]
async fn latency_stats_toggle_does_not_restart_checks() {
    let db = store::connect("sqlite::memory:").await.unwrap();
    let (app, _) = make_app(db);
    let srv = mock(200).await;
    let sid = create_scenario(&app, &srv.uri()).await;
    let b = new_board(&app, "ls", &sid, 1).await;
    let id = b["id"].as_str().unwrap();
    assert_eq!(b["config"]["show_latency_stats"], true);
    let before_updated = b["updated_at"].as_i64().unwrap();

    let (s, _) = send(&app, Method::POST, &url(id, "/start"), None).await;
    assert_eq!(s, StatusCode::OK);
    let st = wait_results(&app, id, 1).await;
    let started = st["started_at_ms"].as_i64().unwrap();
    tokio::time::sleep(Duration::from_millis(10)).await;

    let (s, r) = send(&app, Method::PUT, &ls_url(id), Some(json!({"show": false}))).await;
    assert_eq!(s, StatusCode::OK, "{r}");
    assert_eq!(r["config"]["show_latency_stats"], false);
    assert!(r["updated_at"].as_i64().unwrap() > before_updated);

    let (_, st) = send(&app, Method::GET, &url(id, "/status"), None).await;
    assert_eq!(st["started_at_ms"].as_i64().unwrap(), started);
}

#[tokio::test]
async fn latency_stats_toggle_after_full_save_keeps_new_panels() {
    let db = store::connect("sqlite::memory:").await.unwrap();
    let (app, _) = make_app(db);
    let srv = mock(200).await;
    let sid = create_scenario(&app, &srv.uri()).await;
    let b = new_board(&app, "ls2", &sid, 10).await;
    let id = b["id"].as_str().unwrap();
    let mut body = board_body("ls2", &sid, 10);
    body["config"]["panels"][0]["title"] = json!("바뀐 제목");
    let (s, r) = send(&app, Method::PUT, &url(id, ""), Some(body)).await;
    assert_eq!(s, StatusCode::OK, "{r}");
    let (s, _) = send(&app, Method::PUT, &ls_url(id), Some(json!({"show": false}))).await;
    assert_eq!(s, StatusCode::OK);
    let (_, g) = send(&app, Method::GET, &url(id, ""), None).await;
    assert_eq!(g["config"]["panels"][0]["title"], "바뀐 제목");
    assert_eq!(g["config"]["show_latency_stats"], false);
}

#[tokio::test]
async fn latency_stats_toggle_preserves_unknown_config_keys() {
    let db = store::connect("sqlite::memory:").await.unwrap();
    let (app, _) = make_app(db.clone());
    let srv = mock(200).await;
    let sid = create_scenario(&app, &srv.uri()).await;
    let b = new_board(&app, "ls3", &sid, 10).await;
    let id = b["id"].as_str().unwrap();
    sqlx::query("UPDATE monitor_boards SET config_json = ? WHERE id = ?")
        .bind(json!({"panels": [], "zz_probe": 1}).to_string())
        .bind(id)
        .execute(&db)
        .await
        .unwrap();
    let (s, _) = send(&app, Method::PUT, &ls_url(id), Some(json!({"show": false}))).await;
    assert_eq!(s, StatusCode::OK);
    let raw: String = sqlx::query_scalar("SELECT config_json FROM monitor_boards WHERE id = ?")
        .bind(id)
        .fetch_one(&db)
        .await
        .unwrap();
    let v: Value = serde_json::from_str(&raw).unwrap();
    assert_eq!(v["zz_probe"], 1, "{raw}");
    assert_eq!(v["show_latency_stats"], false, "{raw}");
}

#[tokio::test]
async fn latency_stats_inserts_key_into_legacy_row() {
    let db = store::connect("sqlite::memory:").await.unwrap();
    let (app, _) = make_app(db.clone());
    let srv = mock(200).await;
    let sid = create_scenario(&app, &srv.uri()).await;
    let b = new_board(&app, "ls4", &sid, 10).await;
    let id = b["id"].as_str().unwrap();
    sqlx::query("UPDATE monitor_boards SET config_json = ? WHERE id = ?")
        .bind(json!({"panels": []}).to_string())
        .bind(id)
        .execute(&db)
        .await
        .unwrap();
    let (s, _) = send(&app, Method::PUT, &ls_url(id), Some(json!({"show": false}))).await;
    assert_eq!(s, StatusCode::OK);
    let (_, g) = send(&app, Method::GET, &url(id, ""), None).await;
    assert_eq!(g["config"]["show_latency_stats"], false);
}

#[tokio::test]
async fn latency_stats_unknown_board_404() {
    let db = store::connect("sqlite::memory:").await.unwrap();
    let (app, _) = make_app(db);
    let (s, r) = send(
        &app,
        Method::PUT,
        &ls_url("01J000000000000000000000ZZ"),
        Some(json!({"show": true})),
    )
    .await;
    assert_eq!(s, StatusCode::NOT_FOUND);
    // 라우트 부재의 맨 404(본문 없음)와 구별 — 핸들러의 NotFound 본문.
    assert_eq!(r["error"], "not found");
}

// ---- 점검 기록 조회 (spec §2.4) ----

/// `create_scenario`의 요청 헤더 변형 — 헤더 이름 대소문자는 엔진이 그대로 보존한다.
async fn create_scenario_with_headers(
    app: &axum::Router,
    url: &str,
    headers: &[(&str, &str)],
) -> String {
    let mut hs = String::from("      headers:\n");
    for (k, v) in headers {
        hs.push_str(&format!("        {k}: \"{v}\"\n"));
    }
    let yaml = format!(
        "version: 1\nname: mon-{}\nsteps:\n  - id: {STEP_ID}\n    name: ping\n    type: http\n    request:\n      method: GET\n      url: {url}\n{hs}    assert:\n      - status: 200\n",
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

fn record_url(id: &str, panel_id: &str, at_ms: i64) -> String {
    url(id, &format!("/panels/{panel_id}/records/{at_ms}"))
}

/// 보드를 시작하고 첫 결과의 (칸 id, at_ms)를 돌려준다.
async fn start_and_first_at(app: &axum::Router, id: &str) -> (String, i64) {
    let (s, _) = send(app, Method::POST, &url(id, "/start"), None).await;
    assert_eq!(s, StatusCode::OK);
    let st = wait_results(app, id, 1).await;
    let pid = st["panels"][0]["panel_id"].as_str().unwrap().to_string();
    let at = st["panels"][0]["results"][0]["at_ms"].as_i64().unwrap();
    (pid, at)
}

/// 핸들러의 NotFound(본문 `{"error":"not found"}`) — 라우트 부재의 맨 404와 구별.
async fn assert_record_404(app: &axum::Router, uri: &str) {
    let (s, r) = send(app, Method::GET, uri, None).await;
    assert_eq!(s, StatusCode::NOT_FOUND, "{uri}");
    assert_eq!(r["error"], "not found", "{uri}");
}

#[tokio::test]
async fn record_endpoint_returns_masked_record() {
    let db = store::connect("sqlite::memory:").await.unwrap();
    let (app, monitor) = make_app(db);
    let srv = json_mock(r#"{"ok":true}"#).await;
    let sid =
        create_scenario_with_headers(&app, &srv.uri(), &[("Authorization", "Bearer s3cret")]).await;
    let b = new_board(&app, "b", &sid, 60).await;
    let id = b["id"].as_str().unwrap();
    let (pid, at) = start_and_first_at(&app, id).await;

    let req = Request::builder()
        .uri(record_url(id, &pid, at))
        .body(Body::empty())
        .unwrap();
    let resp = app.clone().oneshot(req).await.unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    assert_eq!(
        resp.headers()["content-type"].to_str().unwrap(),
        "application/json"
    );
    // 응답 본문이 담긴 기록 — 브라우저/프록시 캐시에 남기지 않는다.
    assert_eq!(
        resp.headers()
            .get("cache-control")
            .map(|v| v.to_str().unwrap()),
        Some("no-store")
    );
    let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX)
        .await
        .unwrap();
    let rec: Value = serde_json::from_slice(&bytes).unwrap();
    let step = &rec["trace"]["steps"][0];
    assert_eq!(step["request"]["headers"]["Authorization"], "Bearer ••••");
    assert_eq!(step["response"]["body"], "{\"ok\":true}");
    assert_eq!(rec["clipped"], json!([]));
    assert_eq!(rec["limit_kb"], 128);
    assert_eq!(rec["at_ms"], at);
    assert_eq!(rec["result"]["at_ms"], at);
    assert_eq!(rec["result"]["verdict"], "ok");
    assert!(!String::from_utf8_lossy(&bytes).contains("s3cret"));
    monitor.stop_all().await;
}

#[tokio::test]
async fn record_endpoint_404s() {
    let db = store::connect("sqlite::memory:").await.unwrap();
    let (app, _) = make_app(db);
    let srv = mock(200).await;
    let sid = create_scenario(&app, &srv.uri()).await;
    let b = new_board(&app, "b", &sid, 60).await;
    let id = b["id"].as_str().unwrap();
    let (pid, at) = start_and_first_at(&app, id).await;

    let (s, _) = send(&app, Method::GET, &record_url(id, &pid, at), None).await;
    assert_eq!(s, StatusCode::OK, "sanity: the record exists");
    // 없는 at_ms · 없는 칸 · 없는 보드
    assert_record_404(&app, &record_url(id, &pid, at - 1)).await;
    assert_record_404(&app, &record_url(id, "nope", at)).await;
    assert_record_404(&app, &record_url("01J000000000000000000000ZZ", &pid, at)).await;
    // 꺼진 보드
    let (s, _) = send(&app, Method::POST, &url(id, "/stop"), None).await;
    assert_eq!(s, StatusCode::OK);
    assert_record_404(&app, &record_url(id, &pid, at)).await;
}

#[tokio::test]
async fn record_uses_board_limit() {
    let db = store::connect("sqlite::memory:").await.unwrap();
    let (app, monitor) = make_app(db);
    let srv = mock(200).await;
    let sid = create_scenario(&app, &srv.uri()).await;
    let mut body = board_body("b", &sid, 60);
    body["config"]["record_limit_kb"] = json!(512);
    let (st, b) = send(&app, Method::POST, "/api/monitor-boards", Some(body)).await;
    assert_eq!(st, StatusCode::CREATED, "{b}");
    assert_eq!(b["config"]["record_limit_kb"], 512);
    let id = b["id"].as_str().unwrap();
    let (pid, at) = start_and_first_at(&app, id).await;

    let (s, rec) = send(&app, Method::GET, &record_url(id, &pid, at), None).await;
    assert_eq!(s, StatusCode::OK, "{rec}");
    assert_eq!(rec["limit_kb"], 512);
    monitor.stop_all().await;
}

// ---- 스텝 칸 미리 실행 (점검 묶음 spec §8.3) ----

const L1_ID: &str = "01J0000000000000000000000B";
const L2_ID: &str = "01J0000000000000000000000C";

/// L1(`l1_url`, status 200 단언) → L2(`l2_url`) 2스텝 시나리오.
async fn create_two_step_scenario(app: &axum::Router, l1_url: &str, l2_url: &str) -> String {
    let yaml = format!(
        "version: 1\nname: mon2-{}\nsteps:\n  - id: {L1_ID}\n    name: L1\n    type: http\n    request:\n      method: GET\n      url: {l1_url}\n    assert:\n      - status: 200\n  - id: {L2_ID}\n    name: L2\n    type: http\n    request:\n      method: GET\n      url: {l2_url}\n    assert:\n      - status: 200\n",
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

#[tokio::test]
async fn preview_step_panel_uses_unit_path() {
    let db = store::connect("sqlite::memory:").await.unwrap();
    let (app, _) = make_app(db);
    let bad = mock(503).await;
    let good = mock(200).await;
    let sid = create_two_step_scenario(&app, &bad.uri(), &good.uri()).await;
    // 칸은 L2만 본다(L1 칸 없음) — 묶음 경로면 L2 칸이 L1의 대리 원인 칸이 된다.
    // 옛 경로(흐름 전체 판정)로는 L1 이름이 붙은 이 문구가 나올 수 없다.
    let (st, v) = send(
        &app,
        Method::POST,
        "/api/monitor-boards/preview-check",
        Some(json!({"title":"t","scenario_id":sid,"step_id":L2_ID})),
    )
    .await;
    assert_eq!(st, StatusCode::OK, "{v}");
    assert_eq!(v["result"]["verdict"], "fail", "{v}");
    assert_eq!(v["result"]["reason"], "앞 단계 실패", "{v}");
    let detail = v["result"]["detail"].as_str().unwrap_or_default();
    assert!(detail.starts_with("L1 · "), "{v}");
    assert!(v["trace"].is_object());
}

#[tokio::test]
async fn preview_step_panel_with_condition_ok() {
    let db = store::connect("sqlite::memory:").await.unwrap();
    let (app, _) = make_app(db);
    let srv = json_mock(r#"{"resultCode":"0000"}"#).await;
    let sid = create_scenario(&app, &srv.uri()).await;
    // 조건의 step_id가 빈 문자열 — 정규화가 검증보다 앞이면 칸 스텝으로 채워져 통과한다.
    let c = json!({"step_id": "", "source": "body", "path": "$.resultCode", "op": "eq", "value": "0000"});
    let (st, v) = send(
        &app,
        Method::POST,
        "/api/monitor-boards/preview-check",
        Some(json!({"title":"t","scenario_id":sid,"step_id":STEP_ID,"conditions":[c]})),
    )
    .await;
    assert_eq!(st, StatusCode::OK, "{v}");
    assert_ne!(v["result"]["verdict"], "config_error", "{v}");
}

#[tokio::test]
async fn preview_bad_step_id_reports_step_error() {
    let db = store::connect("sqlite::memory:").await.unwrap();
    let (app, _) = make_app(db);
    let c = json!({"step_id": "", "source": "body", "path": "$.resultCode", "op": "eq", "value": "0000"});
    for body in [
        // 조건이 있으면 정규화가 잘못된 id를 조건에 복사해 조건 문구가 나오면 안 된다.
        json!({"title":"t","scenario_id":"S","step_id":"x","conditions":[c]}),
        // 조건이 없어도 조용히 통과하면 안 된다.
        json!({"title":"t","scenario_id":"S","step_id":"x"}),
    ] {
        let (st, v) = send(
            &app,
            Method::POST,
            "/api/monitor-boards/preview-check",
            Some(body),
        )
        .await;
        assert_eq!(st, StatusCode::BAD_REQUEST, "{v}");
        assert_eq!(v["error"], "스텝 id가 올바른 ULID 형식이 아닙니다");
    }
}

#[tokio::test]
async fn check_now_404_409_200() {
    let db = store::connect("sqlite::memory:").await.unwrap();
    let (app, _) = make_app(db);
    let srv = mock(200).await;
    let sid = create_scenario(&app, &srv.uri()).await;
    let b = new_board(&app, "b", &sid, 3600).await;
    let id = b["id"].as_str().unwrap();
    let pid = b["config"]["panels"][0]["id"].as_str().unwrap();
    let path =
        |board: &str, panel: &str| format!("/api/monitor-boards/{board}/panels/{panel}/check-now");

    // 없는 보드 → 404.
    let (st, _) = send(
        &app,
        Method::POST,
        &path("01J00000000000000000000000", pid),
        None,
    )
    .await;
    assert_eq!(st, StatusCode::NOT_FOUND);
    // 꺼진 보드 → 409 + 문구.
    let (st, v) = send(&app, Method::POST, &path(id, pid), None).await;
    assert_eq!(st, StatusCode::CONFLICT);
    assert_eq!(v["error"], "점검이 꺼져 있습니다");

    let (st, _) = send(&app, Method::POST, &url(id, "/start"), None).await;
    assert_eq!(st, StatusCode::OK);
    // 순서 전제: 첫 결과 뒤에 요청.
    let first = wait_results(&app, id, 1).await;
    let last = first["panels"][0]["results"][0]["at_ms"].as_i64().unwrap();
    // 켜진 보드의 없는 칸 → 404.
    let (st, _) = send(
        &app,
        Method::POST,
        &path(id, "01J00000000000000000000000"),
        None,
    )
    .await;
    assert_eq!(st, StatusCode::NOT_FOUND);
    // 200: 키가 항상 있다(값은 그 칸의 마지막 결과 시각).
    let (st, v) = send(&app, Method::POST, &path(id, pid), None).await;
    assert_eq!(st, StatusCode::OK, "{v}");
    assert!(v.as_object().unwrap().contains_key("last_at_ms"), "{v}");
    assert_eq!(v["last_at_ms"].as_i64(), Some(last));
    // 주기 3600초인데 3초 안에 결과 1 → 2.
    let st2 = tokio::time::timeout(Duration::from_secs(3), wait_results(&app, id, 2))
        .await
        .expect("지금 점검 회차가 3초 안에 와야 한다");
    assert!(st2["panels"][0]["results"][1]["at_ms"].as_i64().unwrap() > last);
}
