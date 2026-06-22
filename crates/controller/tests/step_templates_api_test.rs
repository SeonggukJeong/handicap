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
        heartbeat_interval_seconds: 10,
        stale_timeout_seconds: 30,
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

const VALID_STEPS: &str = "- id: 01HX0000000000000000000001\n  name: Login\n  type: http\n  request:\n    method: POST\n    url: /login\n  assert:\n    - status: 200\n";

fn body(name: &str, steps_yaml: &str) -> Value {
    json!({ "name": name, "description": "d", "steps_yaml": steps_yaml })
}

#[tokio::test]
async fn template_crud_roundtrip() {
    let db = store::connect("sqlite::memory:").await.unwrap();
    let app = make_app(db);

    // create → 201 full (steps_yaml 포함)
    let (status, created) = send(
        &app,
        Method::POST,
        "/api/step-templates",
        Some(body("login-flow", VALID_STEPS)),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    assert_eq!(created["name"], "login-flow");
    assert_eq!(created["step_count"], 1);
    assert_eq!(created["steps_yaml"], VALID_STEPS);
    let id = created["id"].as_str().unwrap().to_string();

    // list → {templates: [Summary…]} (steps_yaml 없음)
    let (status, listed) = send(&app, Method::GET, "/api/step-templates", None).await;
    assert_eq!(status, StatusCode::OK);
    let templates = listed["templates"].as_array().unwrap();
    assert_eq!(templates.len(), 1);
    assert_eq!(templates[0]["id"], id.as_str());
    assert!(
        templates[0].get("steps_yaml").is_none(),
        "summary must omit steps_yaml"
    );

    // get → full
    let (status, got) = send(
        &app,
        Method::GET,
        &format!("/api/step-templates/{id}"),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(got["steps_yaml"], VALID_STEPS);

    // put → 전체 교체 (이름변경)
    let (status, updated) = send(
        &app,
        Method::PUT,
        &format!("/api/step-templates/{id}"),
        Some(body("login-v2", VALID_STEPS)),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(updated["name"], "login-v2");

    // delete → 204, get → 404
    let (status, _) = send(
        &app,
        Method::DELETE,
        &format!("/api/step-templates/{id}"),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let (status, _) = send(
        &app,
        Method::GET,
        &format!("/api/step-templates/{id}"),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn duplicate_name_is_409_conflictjson_with_id() {
    let db = store::connect("sqlite::memory:").await.unwrap();
    let app = make_app(db);
    let (_, first) = send(
        &app,
        Method::POST,
        "/api/step-templates",
        Some(body("dup", VALID_STEPS)),
    )
    .await;
    let (status, conflict) = send(
        &app,
        Method::POST,
        "/api/step-templates",
        Some(body("dup", VALID_STEPS)),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT);
    // ConflictJson 본문 = {error, id} — UI 덮어쓰기 PUT이 이 id를 쓴다 (spec §4.3)
    assert_eq!(conflict["id"], first["id"]);
    assert!(conflict["error"].as_str().unwrap().contains("이미"));
}

#[tokio::test]
async fn rename_onto_other_template_is_409_with_that_id() {
    let db = store::connect("sqlite::memory:").await.unwrap();
    let app = make_app(db);
    let (_, a) = send(
        &app,
        Method::POST,
        "/api/step-templates",
        Some(body("a", VALID_STEPS)),
    )
    .await;
    let (_, b) = send(
        &app,
        Method::POST,
        "/api/step-templates",
        Some(body("b", VALID_STEPS)),
    )
    .await;
    let b_id = b["id"].as_str().unwrap();
    let (status, conflict) = send(
        &app,
        Method::PUT,
        &format!("/api/step-templates/{b_id}"),
        Some(body("a", VALID_STEPS)),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(conflict["id"], a["id"]);
    // 자기 자신 이름 유지 PUT은 409가 아니다
    let (status, _) = send(
        &app,
        Method::PUT,
        &format!("/api/step-templates/{b_id}"),
        Some(body("b", VALID_STEPS)),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
}

#[tokio::test]
async fn invalid_steps_yaml_is_422_and_empty_is_422() {
    let db = store::connect("sqlite::memory:").await.unwrap();
    let app = make_app(db);
    // 엔진 serde 파싱 불가 (스텝이 아닌 맵)
    let (status, _) = send(
        &app,
        Method::POST,
        "/api/step-templates",
        Some(body("bad", "not: steps\n")),
    )
    .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    // 빈 배열
    let (status, _) = send(
        &app,
        Method::POST,
        "/api/step-templates",
        Some(body("empty", "[]\n")),
    )
    .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
}

#[tokio::test]
async fn empty_name_is_400_and_name_is_trimmed() {
    let db = store::connect("sqlite::memory:").await.unwrap();
    let app = make_app(db);
    let (status, _) = send(
        &app,
        Method::POST,
        "/api/step-templates",
        Some(body("   ", VALID_STEPS)),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let (_, created) = send(
        &app,
        Method::POST,
        "/api/step-templates",
        Some(body("  trimmed  ", VALID_STEPS)),
    )
    .await;
    assert_eq!(created["name"], "trimmed");
}

#[tokio::test]
async fn wild_non_ulid_step_id_is_accepted() {
    // §4.3: 서버는 스텝 id의 ULID 유효성을 안 본다 — 삽입 시 클라가 전부 재발급.
    let db = store::connect("sqlite::memory:").await.unwrap();
    let app = make_app(db);
    let wild =
        "- id: login-1\n  name: Login\n  type: http\n  request:\n    method: GET\n    url: /x\n";
    let (status, created) = send(
        &app,
        Method::POST,
        "/api/step-templates",
        Some(body("wild", wild)),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    assert_eq!(created["step_count"], 1);
}

#[tokio::test]
async fn missing_id_is_404() {
    let db = store::connect("sqlite::memory:").await.unwrap();
    let app = make_app(db);
    let (status, _) = send(&app, Method::GET, "/api/step-templates/nope", None).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let (status, _) = send(
        &app,
        Method::PUT,
        "/api/step-templates/nope",
        Some(body("x", VALID_STEPS)),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}
