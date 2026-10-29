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
    let _ = create_board(&app, "보드", simple_config(&sid, None)).await;
    let ghost = ulid::Ulid::new().to_string();
    let (st, v) = send(
        &app,
        Method::POST,
        EXPORT,
        Some(json!({"board_ids": [ghost, ghost]})),
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
    assert_eq!(
        v["error"].as_str().unwrap(),
        "보드 '나쁜보드' 칸 1: 본문 경로(JSONPath)가 올바르지 않습니다",
        "{v}"
    );
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
    assert_eq!(original.record_limit_kb, 512);
    assert!(matches!(
        original.panels[0].latency_source,
        handicap_controller::monitor::config::LatencySource::Step { .. }
    ));
    assert_eq!(original.panels[0].display_items.len(), 1);
    let (st, bytes) = send_raw(&app, Method::POST, EXPORT, Some(json!({"board_ids": [b]}))).await;
    assert_eq!(st, StatusCode::OK);
    let parsed = parse_bundle_bytes(&bytes).expect("export must parse back");
    assert_eq!(parsed.boards[0].config, original);
    assert_eq!(parsed.boards[0].id, b);
}
// ---------------- import ----------------

const ANALYZE: &str = "/api/monitor-boards/import/analyze";
const IMPORT: &str = "/api/monitor-boards/import";

struct Pc {
    app: axum::Router,
    db: store::Db,
}

async fn new_pc() -> Pc {
    let db = store::connect("sqlite::memory:").await.unwrap();
    Pc {
        app: make_app(db.clone()),
        db,
    }
}

/// A PC에 보드 2개(시나리오 공유·환경 1개)를 만들고 export 바이트와 [b1,b2,sid,eid]를 돌려준다.
async fn make_export(a: &Pc) -> (Vec<u8>, Vec<String>) {
    let sid = create_scenario(&a.app, "s").await;
    let eid = create_env(&a.app, "운영").await;
    let b1 = create_board(&a.app, "보드1", simple_config(&sid, Some(&eid))).await;
    let b2 = create_board(&a.app, "보드2", simple_config(&sid, None)).await;
    let (st, bytes) = send_raw(
        &a.app,
        Method::POST,
        EXPORT,
        Some(json!({"board_ids": [b1, b2]})),
    )
    .await;
    assert_eq!(st, StatusCode::OK);
    (bytes, vec![b1, b2, sid, eid])
}

async fn post_bytes(app: &axum::Router, uri: &str, body: Vec<u8>) -> (StatusCode, Vec<u8>) {
    let req = Request::builder()
        .method(Method::POST)
        .uri(uri)
        .header("content-type", "application/json")
        .body(Body::from(body))
        .unwrap();
    let resp = app.clone().oneshot(req).await.unwrap();
    let st = resp.status();
    let b = axum::body::to_bytes(resp.into_body(), usize::MAX)
        .await
        .unwrap();
    (st, b.to_vec())
}

fn as_json(b: &[u8]) -> Value {
    serde_json::from_slice(b).unwrap_or(Value::Null)
}

async fn import_file(app: &axum::Router, file: &[u8]) -> (StatusCode, Value) {
    let bundle: Value = serde_json::from_slice(file).unwrap();
    send(app, Method::POST, IMPORT, Some(json!({"bundle": bundle}))).await
}

async fn count(db: &store::Db, t: &str) -> i64 {
    sqlx::query_scalar::<_, i64>(&format!("SELECT COUNT(*) FROM {t}"))
        .fetch_one(db)
        .await
        .unwrap()
}

async fn counts(db: &store::Db) -> (i64, i64, i64) {
    (
        count(db, "scenarios").await,
        count(db, "environments").await,
        count(db, "monitor_boards").await,
    )
}

#[tokio::test]
async fn analyze_on_empty_pc_has_no_conflicts() {
    let a = new_pc().await;
    let (file, _) = make_export(&a).await;
    let b = new_pc().await;
    let (st, body) = post_bytes(&b.app, ANALYZE, file).await;
    assert_eq!(st, StatusCode::OK);
    let v = as_json(&body);
    assert_eq!(v["summary"]["boards"], 2);
    assert_eq!(v["summary"]["conflicts"], 0);
    assert_eq!(v["boards"][0]["conflict"], false);
}

#[tokio::test]
async fn import_round_trip_creates_rows_with_original_ids() {
    let a = new_pc().await;
    let (file, ids) = make_export(&a).await;
    let b = new_pc().await;
    let (st, v) = import_file(&b.app, &file).await;
    assert_eq!(st, StatusCode::OK, "{v}");
    let boards = v["boards"].as_array().unwrap();
    assert_eq!(boards.len(), 2);
    assert!(boards.iter().all(|x| x["action"] == "added"));
    assert_eq!(counts(&b.db).await, (1, 1, 2));
    let enabled: Vec<i64> = sqlx::query_scalar("SELECT enabled FROM monitor_boards")
        .fetch_all(&b.db)
        .await
        .unwrap();
    assert!(enabled.iter().all(|e| *e == 0));
    for (t, id) in [
        ("monitor_boards", &ids[0]),
        ("monitor_boards", &ids[1]),
        ("scenarios", &ids[2]),
        ("environments", &ids[3]),
    ] {
        let n: i64 = sqlx::query_scalar(&format!("SELECT COUNT(*) FROM {t} WHERE id = ?"))
            .bind(id)
            .fetch_one(&b.db)
            .await
            .unwrap();
        assert_eq!(n, 1, "{t} {id}");
    }
}

#[tokio::test]
async fn imported_board_config_equals_exported() {
    let a = new_pc().await;
    let (file, ids) = make_export(&a).await;
    let b = new_pc().await;
    import_file(&b.app, &file).await;
    let uri = format!("/api/monitor-boards/{}", ids[0]);
    let (_, va) = send(&a.app, Method::GET, &uri, None).await;
    let (st, vb) = send(&b.app, Method::GET, &uri, None).await;
    assert_eq!(st, StatusCode::OK);
    assert_eq!(va["config"], vb["config"]);
}

#[tokio::test]
async fn second_import_of_same_file_is_rejected_unchanged() {
    let a = new_pc().await;
    let (file, _) = make_export(&a).await;
    let b = new_pc().await;
    let (st, _) = import_file(&b.app, &file).await;
    assert_eq!(st, StatusCode::OK);
    let before = counts(&b.db).await;
    let (st, v) = import_file(&b.app, &file).await;
    assert_eq!(st, StatusCode::CONFLICT, "{v}");
    assert_eq!(v["error"], "conflicts");
    assert_eq!(v["boards"][0]["exists"], true);
    assert_eq!(counts(&b.db).await, before);
}

#[tokio::test]
async fn analyze_reports_scenario_different() {
    let a = new_pc().await;
    let (file, ids) = make_export(&a).await;
    let b = new_pc().await;
    import_file(&b.app, &file).await;
    sqlx::query("DELETE FROM monitor_boards")
        .execute(&b.db)
        .await
        .unwrap();
    sqlx::query("UPDATE scenarios SET yaml = yaml || '# changed\n' WHERE id = ?")
        .bind(&ids[2])
        .execute(&b.db)
        .await
        .unwrap();
    let (st, body) = post_bytes(&b.app, ANALYZE, file).await;
    assert_eq!(st, StatusCode::OK);
    let v = as_json(&body);
    assert_eq!(v["boards"][0]["conflict"], true);
    assert_eq!(v["boards"][0]["scenarios"][0]["state"], "different");
}

#[tokio::test]
async fn import_rejects_when_conflict_appears_after_analyze() {
    let a = new_pc().await;
    let (file, ids) = make_export(&a).await;
    let b = new_pc().await;
    let (st, body) = post_bytes(&b.app, ANALYZE, file.clone()).await;
    assert_eq!(st, StatusCode::OK);
    assert_eq!(as_json(&body)["summary"]["conflicts"], 0);
    let sid = create_scenario(&b.app, "other").await;
    sqlx::query(
        "INSERT INTO monitor_boards(id,name,config_json,enabled,created_at,updated_at) VALUES(?,?,?,0,0,0)",
    )
    .bind(&ids[0])
    .bind("선점")
    .bind(simple_config(&sid, None).to_string())
    .execute(&b.db)
    .await
    .unwrap();
    let (st, v) = import_file(&b.app, &file).await;
    assert_eq!(st, StatusCode::CONFLICT, "{v}");
}

#[tokio::test]
async fn import_failure_rolls_back_all_tables() {
    let a = new_pc().await;
    let (file, _) = make_export(&a).await;
    let b = new_pc().await;
    sqlx::query(
        "CREATE TRIGGER t BEFORE INSERT ON monitor_boards BEGIN SELECT RAISE(ABORT,'x'); END",
    )
    .execute(&b.db)
    .await
    .unwrap();
    let before = counts(&b.db).await;
    let (st, _) = import_file(&b.app, &file).await;
    assert!(st.is_server_error(), "{st}");
    assert_eq!(counts(&b.db).await, before);
}

#[tokio::test]
async fn analyze_400_has_reason() {
    let a = new_pc().await;
    let (file, _) = make_export(&a).await;
    let mut v: Value = serde_json::from_slice(&file).unwrap();
    v["format_version"] = json!(2);
    let (st, body) = post_bytes(&a.app, ANALYZE, serde_json::to_vec(&v).unwrap()).await;
    assert_eq!(st, StatusCode::BAD_REQUEST);
    assert!(
        as_json(&body)["error"]
            .as_str()
            .unwrap()
            .contains("더 새 버전의 핸디캡에서 만든 파일입니다(파일 형식 2")
    );
}

#[tokio::test]
async fn import_body_with_extra_key_is_400() {
    let a = new_pc().await;
    let (file, _) = make_export(&a).await;
    let bundle: Value = serde_json::from_slice(&file).unwrap();
    let (st, v) = send(
        &a.app,
        Method::POST,
        IMPORT,
        Some(json!({"bundle": bundle, "extra": 1})),
    )
    .await;
    assert_eq!(st, StatusCode::BAD_REQUEST);
    assert!(
        v["error"].as_str().unwrap().contains("모르는 항목(extra)"),
        "{v}"
    );
}

#[tokio::test]
async fn analyze_over_32mib_is_413() {
    let a = new_pc().await;
    let (st, _) = post_bytes(&a.app, ANALYZE, vec![b' '; 33 * 1024 * 1024]).await;
    assert_eq!(st, StatusCode::PAYLOAD_TOO_LARGE);
}

#[tokio::test]
async fn analyze_3mib_is_not_413() {
    let a = new_pc().await;
    let (mut file, _) = make_export(&a).await;
    file.extend(vec![b' '; 3 * 1024 * 1024]);
    let b = new_pc().await;
    let (st, _) = post_bytes(&b.app, ANALYZE, file).await;
    assert_eq!(st, StatusCode::OK);
}

#[tokio::test]
async fn import_routes_do_not_hit_board_id_route() {
    let a = new_pc().await;
    let (st, _) = post_bytes(&a.app, ANALYZE, b"{}".to_vec()).await;
    assert_ne!(st, StatusCode::NOT_FOUND);
    assert_ne!(st, StatusCode::METHOD_NOT_ALLOWED);
}

async fn post_with_ct(
    app: &axum::Router,
    uri: &str,
    ct: &str,
    body: Vec<u8>,
) -> (StatusCode, Vec<u8>) {
    let req = Request::builder()
        .method(Method::POST)
        .uri(uri)
        .header("content-type", ct)
        .body(Body::from(body))
        .unwrap();
    let resp = app.clone().oneshot(req).await.unwrap();
    let st = resp.status();
    let b = axum::body::to_bytes(resp.into_body(), usize::MAX)
        .await
        .unwrap();
    (st, b.to_vec())
}

fn splice(file: &[u8]) -> Vec<u8> {
    [&b"{\"bundle\":"[..], file, &b"}"[..]].concat()
}

#[tokio::test]
async fn analyze_text_plain_is_415() {
    let a = new_pc().await;
    let (file, _) = make_export(&a).await;
    let b = new_pc().await;
    let (st, body) = post_with_ct(&b.app, ANALYZE, "text/plain", file.clone()).await;
    assert_eq!(st, StatusCode::UNSUPPORTED_MEDIA_TYPE);
    assert_eq!(
        as_json(&body)["error"],
        "요청 형식이 올바르지 않습니다(Content-Type: application/json 필요)"
    );
    let (st, _) = post_with_ct(&b.app, ANALYZE, "Application/JSON; charset=utf-8", file).await;
    assert_eq!(st, StatusCode::OK);
}

#[tokio::test]
async fn import_text_plain_is_415_and_no_rows() {
    let a = new_pc().await;
    let (file, _) = make_export(&a).await;
    let b = new_pc().await;
    let before = counts(&b.db).await;
    let (st, _) = post_with_ct(&b.app, IMPORT, "text/plain", splice(&file)).await;
    assert_eq!(st, StatusCode::UNSUPPORTED_MEDIA_TYPE);
    assert_eq!(counts(&b.db).await, before);
}

#[tokio::test]
async fn import_accepts_raw_spliced_body() {
    let a = new_pc().await;
    let (file, _) = make_export(&a).await;
    let b = new_pc().await;
    let (st, resp) = post_bytes(&b.app, IMPORT, splice(&file)).await;
    assert_eq!(st, StatusCode::OK, "{}", String::from_utf8_lossy(&resp));
    assert_eq!(counts(&b.db).await, (1, 1, 2));
}

#[tokio::test]
async fn import_3mib_is_not_413() {
    let a = new_pc().await;
    let (file, _) = make_export(&a).await;
    let b = new_pc().await;
    let mut body = splice(&file);
    body.extend(vec![b' '; 3 * 1024 * 1024]);
    let (st, _) = post_bytes(&b.app, IMPORT, body).await;
    assert_eq!(st, StatusCode::OK);
}

#[tokio::test]
async fn rich_board_config_survives_import_round_trip() {
    let a = new_pc().await;
    let sid = create_scenario(&a.app, "s").await;
    let eid = create_env(&a.app, "운영").await;
    let cfg = json!({
        "show_latency_stats": false, "record_limit_kb": 512,
        "font_scale": "large", "blink": "fail", "display_style": "border",
        "panels": [{
            "title": "p1", "scenario_id": sid, "environment_id": eid,
            "latency_source": {"kind": "step", "step_id": STEP_ID},
            "thresholds": [{"ms": 100, "color": "#00ff00"}],
            "conditions": [{"step_id": STEP_ID, "source": "body", "path": "$.ok", "op": "eq", "value": "true"}],
            "display_items": [{"step_id": STEP_ID, "source": "status"}]
        }]
    });
    let bid = create_board(&a.app, "리치", cfg).await;
    let (st, file) = send_raw(
        &a.app,
        Method::POST,
        EXPORT,
        Some(json!({"board_ids": [bid]})),
    )
    .await;
    assert_eq!(st, StatusCode::OK);
    let uri = format!("/api/monitor-boards/{bid}");
    let (_, va) = send(&a.app, Method::GET, &uri, None).await;
    let c = &va["config"];
    assert_eq!(c["show_latency_stats"], false);
    assert_eq!(c["record_limit_kb"], 512);
    assert_eq!(c["font_scale"], "large");
    assert_eq!(c["blink"], "fail");
    assert_eq!(c["display_style"], "border");
    assert_eq!(c["panels"][0]["latency_source"]["kind"], "step");
    assert_eq!(c["panels"][0]["thresholds"].as_array().unwrap().len(), 1);
    assert_eq!(c["panels"][0]["conditions"].as_array().unwrap().len(), 1);
    assert_eq!(c["panels"][0]["conditions"][0]["source"], "body");
    assert_eq!(c["panels"][0]["display_items"].as_array().unwrap().len(), 1);
    let b = new_pc().await;
    let (st, v) = import_file(&b.app, &file).await;
    assert_eq!(st, StatusCode::OK, "{v}");
    let (st, vb) = send(&b.app, Method::GET, &uri, None).await;
    assert_eq!(st, StatusCode::OK);
    assert_eq!(va["config"], vb["config"]);
}
