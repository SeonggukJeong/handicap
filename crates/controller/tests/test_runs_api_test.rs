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

async fn post(app: &axum::Router, uri: &str, body: Value) -> (StatusCode, Value) {
    let req = Request::builder()
        .method(Method::POST)
        .uri(uri)
        .header("content-type", "application/json")
        .body(Body::from(body.to_string()))
        .unwrap();
    let resp = app.clone().oneshot(req).await.unwrap();
    let status = resp.status();
    let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX)
        .await
        .unwrap();
    let v: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
    (status, v)
}

#[tokio::test]
async fn test_run_rejects_unparseable_yaml_with_422() {
    let db = store::connect("sqlite::memory:").await.unwrap();
    let app = make_app(db);
    let (status, _b) = post(
        &app,
        "/api/test-runs",
        json!({ "scenario_yaml": "this: is: not: a: scenario", "env": {} }),
    )
    .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
}

#[tokio::test]
async fn test_run_rejects_out_of_range_max_requests_with_422() {
    let db = store::connect("sqlite::memory:").await.unwrap();
    let app = make_app(db);
    let yaml = "version: 1\nname: s\nsteps: []\n";
    for bad in [0u32, 10_001] {
        let (status, _b) = post(
            &app,
            "/api/test-runs",
            json!({ "scenario_yaml": yaml, "env": {}, "max_requests": bad }),
        )
        .await;
        assert_eq!(
            status,
            StatusCode::UNPROCESSABLE_ENTITY,
            "max_requests={bad}"
        );
    }
}

#[tokio::test]
async fn test_run_rejects_out_of_range_step_think_time_with_422() {
    let db = store::connect("sqlite::memory:").await.unwrap();
    let app = make_app(db);
    let yaml = "version: 1\nname: s\nsteps:\n  - type: http\n    id: 01HX0000000000000000000099\n    name: s1\n    request:\n      method: GET\n      url: http://x/\n    think_time: { min_ms: 5000, max_ms: 100 }\n";
    let (status, _b) = post(
        &app,
        "/api/test-runs",
        json!({ "scenario_yaml": yaml, "env": {} }),
    )
    .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
}

#[tokio::test]
async fn test_run_rejects_out_of_range_default_think_time_with_422() {
    let db = store::connect("sqlite::memory:").await.unwrap();
    let app = make_app(db);
    let yaml =
        "version: 1\nname: s\ndefault_think_time: { min_ms: 0, max_ms: 700000 }\nsteps: []\n";
    let (status, _b) = post(
        &app,
        "/api/test-runs",
        json!({ "scenario_yaml": yaml, "env": {} }),
    )
    .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
}

#[tokio::test]
async fn test_run_returns_200_trace_with_step_error_for_unreachable_target() {
    let db = store::connect("sqlite::memory:").await.unwrap();
    let app = make_app(db);
    let yaml = "version: 1\nname: s\nsteps:\n  - type: http\n    id: 01HX0000000000000000000099\n    name: down\n    request:\n      method: GET\n      url: http://127.0.0.1:1/nope\n";
    let (status, body) = post(
        &app,
        "/api/test-runs",
        json!({ "scenario_yaml": yaml, "env": {}, "max_requests": 5 }),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["ok"], json!(false));
    assert_eq!(body["steps"].as_array().unwrap().len(), 1);
    assert!(body["steps"][0]["error"].is_string());
}

#[tokio::test]
async fn test_run_ignores_unknown_runner_field() {
    let db = store::connect("sqlite::memory:").await.unwrap();
    let app = make_app(db);
    let yaml = "version: 1\nname: s\nsteps: []\n";
    let (status, body) = post(
        &app,
        "/api/test-runs",
        json!({ "scenario_yaml": yaml, "env": {}, "runner": "mars" }),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["steps"].as_array().unwrap().len(), 0);
}

/// 데이터셋 직접 시드 (store 경유 — datasets_api_test의 multipart 대신 간결).
async fn seed_dataset(
    db: &handicap_controller::store::Db,
    name: &str,
    columns: &[&str],
    rows: &[&[&str]],
) -> String {
    let cols: Vec<String> = columns.iter().map(|s| s.to_string()).collect();
    let row_vecs: Vec<Vec<String>> = rows
        .iter()
        .map(|r| r.iter().map(|s| s.to_string()).collect())
        .collect();
    store::datasets::insert(db, name, &cols, &row_vecs, 0)
        .await
        .unwrap()
}

/// 한 스텝 시나리오 YAML. url엔 `{{col}}` 토큰 — 연결 거부(포트 9)여도
/// trace가 렌더된 request.url을 캡처하므로 주입 검증에 서버가 필요 없다.
fn ds_scenario(url: &str) -> String {
    format!(
        r#"
version: 1
name: ds-test
steps:
  - type: http
    id: 01HX0000000000000000000010
    name: step-a
    request: {{ method: GET, url: "{url}" }}
"#
    )
}

#[tokio::test]
async fn single_row_injects_selected_row_and_keeps_trace_shape() {
    let db = store::connect("sqlite::memory:").await.unwrap();
    let app = make_app(db.clone());
    let ds = seed_dataset(&db, "users", &["u"], &[&["alice"], &["bob"], &["carol"]]).await;
    let (status, v) = post(
        &app,
        "/api/test-runs",
        json!({
            "scenario_yaml": ds_scenario("http://127.0.0.1:9/u/{{u}}"),
            "env": {},
            "dataset": {"mode": "single_row", "bindings": [{"dataset_id": ds, "row_index": 1}]}
        }),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    // R7: 기존 ScenarioTrace 형태 그대로 — rows 키 없음, steps/final_vars 있음
    assert!(v.get("rows").is_none());
    assert!(v.get("steps").is_some());
    assert_eq!(v["final_vars"]["u"], json!("bob"));
    let url = v["steps"][0]["request"]["url"].as_str().unwrap();
    assert!(url.ends_with("/u/bob"), "{url}");
}

#[tokio::test]
async fn single_row_explicit_mappings_column_and_literal() {
    let db = store::connect("sqlite::memory:").await.unwrap();
    let app = make_app(db.clone());
    let ds = seed_dataset(&db, "users", &["u"], &[&["alice"], &["bob"]]).await;
    let (status, v) = post(
        &app,
        "/api/test-runs",
        json!({
            "scenario_yaml": ds_scenario("http://127.0.0.1:9/m/{{user}}/{{role}}"),
            "env": {},
            "dataset": {"mode": "single_row", "bindings": [{
                "dataset_id": ds, "row_index": 1,
                "mappings": [
                    {"kind": "column", "var": "user", "column": "u"},
                    {"kind": "literal", "var": "role", "value": "admin"}
                ]
            }]}
        }),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let url = v["steps"][0]["request"]["url"].as_str().unwrap();
    assert!(url.ends_with("/m/bob/admin"), "{url}");
}

#[tokio::test]
async fn sequential_anchors_row_index_and_wraps_non_first_binding() {
    // R17: 첫 바인딩 wrap 없음·row_index=start_row+i, 비-첫 바인딩 % len wrap.
    let db = store::connect("sqlite::memory:").await.unwrap();
    let app = make_app(db.clone());
    let a = seed_dataset(&db, "A", &["a"], &[&["x0"], &["x1"], &["x2"], &["x3"]]).await;
    let b = seed_dataset(&db, "B", &["b"], &[&["y0"], &["y1"]]).await;
    let (status, v) = post(
        &app,
        "/api/test-runs",
        json!({
            "scenario_yaml": ds_scenario("http://127.0.0.1:9/w/{{a}}/{{b}}"),
            "env": {},
            "dataset": {"mode": "sequential", "bindings": [
                {"dataset_id": a}, {"dataset_id": b}
            ]}
        }),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let rows = v["rows"].as_array().unwrap();
    assert_eq!(rows.len(), 4);
    for (i, r) in rows.iter().enumerate() {
        assert_eq!(r["row_index"], json!(i as u64));
        let url = r["trace"]["steps"][0]["request"]["url"].as_str().unwrap();
        assert!(url.ends_with(&format!("/w/x{i}/y{}", i % 2)), "{url}");
    }
}

#[tokio::test]
async fn sequential_start_row_offsets_first_binding_without_wrap() {
    let db = store::connect("sqlite::memory:").await.unwrap();
    let app = make_app(db.clone());
    let ds = seed_dataset(&db, "A", &["u"], &[&["r0"], &["r1"], &["r2"]]).await;
    let (status, v) = post(
        &app,
        "/api/test-runs",
        json!({
            "scenario_yaml": ds_scenario("http://127.0.0.1:9/u/{{u}}"),
            "env": {},
            "dataset": {"mode": "sequential", "start_row": 1,
                        "bindings": [{"dataset_id": ds}]}
        }),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let rows = v["rows"].as_array().unwrap();
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0]["row_index"], json!(1));
    assert_eq!(rows[1]["row_index"], json!(2));
    assert!(
        rows[1]["trace"]["steps"][0]["request"]["url"]
            .as_str()
            .unwrap()
            .ends_with("/u/r2")
    );
}

#[tokio::test]
async fn sequential_clamped_all_green_is_truncated_and_not_ok() {
    // R18 clamp(max_requests) + R6: all-green이어도 요청 구간 미완주 → truncated·ok=false.
    let db = store::connect("sqlite::memory:").await.unwrap();
    let app = make_app(db.clone());
    let server = wiremock::MockServer::start().await;
    wiremock::Mock::given(wiremock::matchers::method("GET"))
        .respond_with(wiremock::ResponseTemplate::new(200))
        .mount(&server)
        .await;
    let ds = seed_dataset(
        &db,
        "big",
        &["u"],
        &[&["a"], &["b"], &["c"], &["d"], &["e"]],
    )
    .await;
    let (status, v) = post(
        &app,
        "/api/test-runs",
        json!({
            "scenario_yaml": ds_scenario(&format!("{}/x/{{{{u}}}}", server.uri())),
            "env": {},
            "max_requests": 2,
            "dataset": {"mode": "sequential", "bindings": [{"dataset_id": ds}]}
        }),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(v["rows"].as_array().unwrap().len(), 2);
    assert_eq!(v["rows"][0]["trace"]["ok"], json!(true));
    assert_eq!(v["truncated"], json!(true));
    assert_eq!(v["ok"], json!(false));
}

#[tokio::test]
async fn sequential_row_limit_within_budget_is_clean() {
    let db = store::connect("sqlite::memory:").await.unwrap();
    let app = make_app(db.clone());
    let server = wiremock::MockServer::start().await;
    wiremock::Mock::given(wiremock::matchers::method("GET"))
        .respond_with(wiremock::ResponseTemplate::new(200))
        .mount(&server)
        .await;
    let ds = seed_dataset(
        &db,
        "big",
        &["u"],
        &[&["a"], &["b"], &["c"], &["d"], &["e"]],
    )
    .await;
    let (status, v) = post(
        &app,
        "/api/test-runs",
        json!({
            "scenario_yaml": ds_scenario(&format!("{}/x/{{{{u}}}}", server.uri())),
            "env": {},
            "dataset": {"mode": "sequential", "row_limit": 2,
                        "bindings": [{"dataset_id": ds}]}
        }),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(v["rows"].as_array().unwrap().len(), 2);
    assert_eq!(v["truncated"], json!(false));
    assert_eq!(v["ok"], json!(true));
}

/// R9 검증 10케이스 — 전부 422 + 한국어 메시지 조각.
async fn expect_422(app: &axum::Router, dataset: Value, yaml_url: &str, frag: &str) {
    let (status, v) = post(
        app,
        "/api/test-runs",
        json!({ "scenario_yaml": ds_scenario(yaml_url), "env": {}, "dataset": dataset }),
    )
    .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{v:?}");
    assert!(
        v["error"].as_str().unwrap_or("").contains(frag),
        "expected '{frag}' in {v:?}"
    );
}

#[tokio::test]
async fn dataset_validation_rejects_with_422_korean() {
    let db = store::connect("sqlite::memory:").await.unwrap();
    let app = make_app(db.clone());
    let ds = seed_dataset(&db, "users", &["u"], &[&["alice"], &["bob"]]).await;
    let url = "http://127.0.0.1:9/u/{{u}}";

    // ① dataset_id 미존재
    expect_422(
        &app,
        json!({"mode":"single_row","bindings":[{"dataset_id":"01JNOPE","row_index":0}]}),
        url,
        "존재하지 않습니다",
    )
    .await;
    // ② 명시 매핑 컬럼 미존재
    expect_422(&app, json!({"mode":"single_row","bindings":[{"dataset_id":ds,"row_index":0,"mappings":[{"kind":"column","var":"u","column":"nope"}]}]}), url, "데이터셋에 없습니다").await;
    // ③-a row_index 범위 밖
    expect_422(
        &app,
        json!({"mode":"single_row","bindings":[{"dataset_id":ds,"row_index":2}]}),
        url,
        "row_index",
    )
    .await;
    // ③-b start_row 범위 밖 (첫 바인딩 앵커)
    expect_422(
        &app,
        json!({"mode":"sequential","start_row":2,"bindings":[{"dataset_id":ds}]}),
        url,
        "start_row",
    )
    .await;
    // ④ row_limit < 1
    expect_422(
        &app,
        json!({"mode":"sequential","row_limit":0,"bindings":[{"dataset_id":ds}]}),
        url,
        "row_limit",
    )
    .await;
    // ⑤ 바인딩 간 변수명 중복 (auto-auto — 같은 데이터셋 2회 = 전 컬럼 충돌)
    expect_422(
        &app,
        json!({"mode":"sequential","bindings":[{"dataset_id":ds},{"dataset_id":ds}]}),
        url,
        "중복",
    )
    .await;
    // ⑥ bindings 빈 배열
    expect_422(
        &app,
        json!({"mode":"single_row","bindings":[]}),
        url,
        "바인딩",
    )
    .await;
    // ⑦ mappings 빈 배열 명시 (R3 — 자동은 생략만)
    expect_422(
        &app,
        json!({"mode":"single_row","bindings":[{"dataset_id":ds,"row_index":0,"mappings":[]}]}),
        url,
        "빈 배열",
    )
    .await;
    // ⑨-a single_row에 start_row
    expect_422(
        &app,
        json!({"mode":"single_row","start_row":0,"bindings":[{"dataset_id":ds,"row_index":0}]}),
        url,
        "single_row",
    )
    .await;
    // ⑨-b sequential에 row_index
    expect_422(
        &app,
        json!({"mode":"sequential","bindings":[{"dataset_id":ds,"row_index":0}]}),
        url,
        "sequential",
    )
    .await;
    // ⑩ single_row인데 row_index 누락
    expect_422(
        &app,
        json!({"mode":"single_row","bindings":[{"dataset_id":ds}]}),
        url,
        "row_index",
    )
    .await;
}

#[tokio::test]
async fn dataset_bindings_over_limit_rejected() {
    // ⑧ bindings.len() > max_data_bindings (시드 8)
    let db = store::connect("sqlite::memory:").await.unwrap();
    let app = make_app(db.clone());
    let ds = seed_dataset(&db, "users", &["u"], &[&["alice"]]).await;
    let bindings: Vec<Value> = (0..9)
        .map(|_| json!({"dataset_id": ds, "row_index": 0}))
        .collect();
    expect_422(
        &app,
        json!({"mode":"single_row","bindings":bindings}),
        "http://127.0.0.1:9/u/{{u}}",
        "최대",
    )
    .await;
}

#[tokio::test]
async fn empty_dataset_rejected() {
    // R9 목록 외 방어(⑪): 0행 데이터셋 — 비-첫 바인딩 wrap `% 0` 차단 (run 게이트 미러).
    let db = store::connect("sqlite::memory:").await.unwrap();
    let app = make_app(db.clone());
    let empty = seed_dataset(&db, "empty", &["u"], &[]).await;
    expect_422(
        &app,
        json!({"mode":"sequential","bindings":[{"dataset_id":empty}]}),
        "http://127.0.0.1:9/u/{{u}}",
        "빈 데이터셋",
    )
    .await;
}

#[tokio::test]
async fn sequential_zero_leaf_scenario_is_bounded_by_clamp() {
    // R18 acceptance: 0-http-leaf 시나리오는 요청 예산을 전혀 안 쓰므로
    // clamp(N ≤ max_requests)만이 행 수·응답 크기를 유계로 만든다.
    let db = store::connect("sqlite::memory:").await.unwrap();
    let app = make_app(db.clone());
    let ds = seed_dataset(
        &db,
        "big",
        &["u"],
        &[&["a"], &["b"], &["c"], &["d"], &["e"]],
    )
    .await;
    let (status, v) = post(
        &app,
        "/api/test-runs",
        json!({
            "scenario_yaml": "version: 1\nname: empty\nsteps: []\n",
            "env": {},
            "max_requests": 2,
            "dataset": {"mode": "sequential", "bindings": [{"dataset_id": ds}]}
        }),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(v["rows"].as_array().unwrap().len(), 2); // N = min(잔여 5, 5, max_requests 2)
    assert_eq!(v["truncated"], json!(true)); // 요청 구간 5 중 2행만 (clamp)
    assert_eq!(v["ok"], json!(false));
}

#[tokio::test]
async fn dataset_omitted_stays_byte_identical() {
    // R1: dataset 없는 요청 — 기존 형태(steps 有·rows 無). 기존 테스트 무수정 green이 주 증거.
    let db = store::connect("sqlite::memory:").await.unwrap();
    let app = make_app(db);
    let (status, v) = post(
        &app,
        "/api/test-runs",
        json!({ "scenario_yaml": ds_scenario("http://127.0.0.1:9/plain"), "env": {} }),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert!(v.get("steps").is_some());
    assert!(v.get("rows").is_none());
}
