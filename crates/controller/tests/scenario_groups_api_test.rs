use std::sync::Arc;

use axum::body::Body;
use axum::http::{Method, Request, StatusCode};
use handicap_controller::dispatcher::NoopDispatcher;
use handicap_controller::grpc::coordinator::CoordinatorState;
use handicap_controller::{app, store};
use serde_json::{Value, json};
use tower::ServiceExt;

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
        monitor: handicap_controller::monitor::MonitorSupervisor::default(),
    })
}

async fn call(
    app: &axum::Router,
    method: Method,
    uri: &str,
    body: Option<Value>,
) -> (StatusCode, Value) {
    let mut b = Request::builder().method(method).uri(uri);
    let body = match body {
        Some(v) => {
            b = b.header("content-type", "application/json");
            Body::from(serde_json::to_vec(&v).unwrap())
        }
        None => Body::empty(),
    };
    let resp = app.clone().oneshot(b.body(body).unwrap()).await.unwrap();
    let status = resp.status();
    let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX)
        .await
        .unwrap();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}

fn yaml(name: &str) -> String {
    format!(
        "version: 1\nname: {name}\nsteps:\n  - id: 01ARZ3NDEKTSV4RRFFQ69G5FAV\n    type: http\n    name: ping\n    request:\n      method: GET\n      url: http://localhost:1/x\n",
    )
}

async fn create(app: &axum::Router, name: &str, group: Option<Value>) -> (StatusCode, Value) {
    let mut body = json!({ "yaml": yaml(name) });
    if let Some(g) = group {
        body["group"] = g;
    }
    call(app, Method::POST, "/api/scenarios", Some(body)).await
}

async fn create_id(app: &axum::Router, name: &str, group: Option<Value>) -> String {
    let (s, v) = create(app, name, group).await;
    assert_eq!(s, StatusCode::CREATED, "{v:?}");
    v["id"].as_str().unwrap().to_string()
}

async fn get_one(app: &axum::Router, id: &str) -> Value {
    let (s, v) = call(app, Method::GET, &format!("/api/scenarios/{id}"), None).await;
    assert_eq!(s, StatusCode::OK);
    v
}

async fn assign(app: &axum::Router, body: Value) -> (StatusCode, Value) {
    call(app, Method::POST, "/api/scenario-groups/assign", Some(body)).await
}

async fn rename(app: &axum::Router, from: &str, to: &str) -> (StatusCode, Value) {
    call(
        app,
        Method::POST,
        "/api/scenario-groups/rename",
        Some(json!({ "from": from, "to": to })),
    )
    .await
}

async fn new_app() -> axum::Router {
    make_app(store::connect("sqlite::memory:").await.unwrap())
}

#[tokio::test]
async fn create_without_group_returns_null_group_key() {
    let app = new_app().await;
    let (s, v) = create(&app, "a", None).await;
    assert_eq!(s, StatusCode::CREATED);
    let obj = v.as_object().unwrap();
    assert!(obj.contains_key("group"));
    assert!(obj["group"].is_null());
}

#[tokio::test]
async fn create_with_group_stores_trimmed() {
    let app = new_app().await;
    let (s, v) = create(&app, "a", Some(json!("  서비스A "))).await;
    assert_eq!(s, StatusCode::CREATED);
    assert_eq!(v["group"], "서비스A");
    let got = get_one(&app, v["id"].as_str().unwrap()).await;
    assert_eq!(got["group"], "서비스A");
}

#[tokio::test]
async fn create_with_bad_group_is_400() {
    let app = new_app().await;
    let (s, v) = create(&app, "a", Some(json!("가".repeat(41)))).await;
    assert_eq!(s, StatusCode::BAD_REQUEST);
    assert!(
        v.to_string()
            .contains("그룹 이름은 40자까지 쓸 수 있습니다")
    );
    let (_, list) = call(&app, Method::GET, "/api/scenarios", None).await;
    assert!(list["scenarios"].as_array().unwrap().is_empty());
}

#[tokio::test]
async fn list_and_get_carry_group_key() {
    let app = new_app().await;
    let id = create_id(&app, "a", Some(json!("G"))).await;
    create_id(&app, "b", None).await;
    let got = get_one(&app, &id).await;
    assert!(got.as_object().unwrap().contains_key("group"));
    assert_eq!(got["group"], "G");
    let (_, list) = call(&app, Method::GET, "/api/scenarios", None).await;
    let items = list["scenarios"].as_array().unwrap();
    assert_eq!(items.len(), 2);
    for it in items {
        assert!(it.as_object().unwrap().contains_key("group"));
    }
    assert_eq!(items.iter().filter(|i| i["group"].is_null()).count(), 1);
}

#[tokio::test]
async fn put_response_carries_stored_group() {
    let app = new_app().await;
    let id = create_id(&app, "a", Some(json!("G"))).await;
    let (s, v) = call(
        &app,
        Method::PUT,
        &format!("/api/scenarios/{id}"),
        Some(json!({ "yaml": yaml("a2"), "version": 1 })),
    )
    .await;
    assert_eq!(s, StatusCode::OK, "{v:?}");
    assert_eq!(v["group"], "G");
}

#[tokio::test]
async fn assign_many_and_clear() {
    let app = new_app().await;
    let a = create_id(&app, "a", None).await;
    let b = create_id(&app, "b", None).await;
    let c = create_id(&app, "c", None).await;
    let (s, v) = assign(
        &app,
        json!({ "scenario_ids": [a, b, "없는ID"], "group": "G" }),
    )
    .await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(v, json!({ "updated": 2 }));
    assert_eq!(get_one(&app, &a).await["group"], "G");
    assert_eq!(get_one(&app, &b).await["group"], "G");
    assert!(get_one(&app, &c).await["group"].is_null());
    let (s, v) = assign(&app, json!({ "scenario_ids": [a, b], "group": null })).await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(v, json!({ "updated": 2 }));
    assert!(get_one(&app, &a).await["group"].is_null());
}

#[tokio::test]
async fn assign_keeps_version_and_updated_at() {
    let app = new_app().await;
    let a = create_id(&app, "a", None).await;
    let before = get_one(&app, &a).await;
    tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    let (s, _) = assign(&app, json!({ "scenario_ids": [a], "group": "G" })).await;
    assert_eq!(s, StatusCode::OK);
    let after = get_one(&app, &a).await;
    assert_eq!(after["group"], "G");
    assert_eq!(before["version"], after["version"]);
    assert_eq!(before["updated_at"], after["updated_at"]);
}

#[tokio::test]
async fn rename_keeps_version_and_updated_at() {
    let app = new_app().await;
    let a = create_id(&app, "a", Some(json!("A"))).await;
    let before = get_one(&app, &a).await;
    tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    let (s, v) = rename(&app, "A", "B").await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(v, json!({ "updated": 1 }));
    let after = get_one(&app, &a).await;
    assert_eq!(after["group"], "B");
    assert_eq!(before["version"], after["version"]);
    assert_eq!(before["updated_at"], after["updated_at"]);
}

#[tokio::test]
async fn assign_without_group_key_is_422_and_changes_nothing() {
    let app = new_app().await;
    let a = create_id(&app, "a", Some(json!("G"))).await;
    let (s, _) = assign(&app, json!({ "scenario_ids": [a] })).await;
    assert_eq!(s, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(get_one(&app, &a).await["group"], "G");
}

const COUNT_MSG: &str = "한 번에 1개에서 500개까지 옮길 수 있습니다";

#[tokio::test]
async fn assign_zero_ids_is_400() {
    let app = new_app().await;
    let (s, v) = assign(&app, json!({ "scenario_ids": [], "group": "G" })).await;
    assert_eq!(s, StatusCode::BAD_REQUEST);
    assert_eq!(v["error"], COUNT_MSG, "{v:?}");
}

#[tokio::test]
async fn assign_501_ids_is_400() {
    let app = new_app().await;
    let ids: Vec<String> = (0..501).map(|i| format!("id{i}")).collect();
    let (s, v) = assign(&app, json!({ "scenario_ids": ids, "group": "G" })).await;
    assert_eq!(s, StatusCode::BAD_REQUEST);
    assert_eq!(v["error"], COUNT_MSG, "{v:?}");
}

#[tokio::test]
async fn assign_exactly_500_ids_is_accepted() {
    let app = new_app().await;
    let a = create_id(&app, "a", None).await;
    let mut ids: Vec<String> = (0..499).map(|i| format!("id{i}")).collect();
    ids.push(a.clone());
    assert_eq!(ids.len(), 500);
    let (s, v) = assign(&app, json!({ "scenario_ids": ids, "group": "G" })).await;
    assert_eq!(s, StatusCode::OK, "{v:?}");
    assert_eq!(v, json!({ "updated": 1 }));
    assert_eq!(get_one(&app, &a).await["group"], "G");
}

#[tokio::test]
async fn assign_bad_group_is_400() {
    let app = new_app().await;
    let a = create_id(&app, "a", None).await;
    let (s, v) = assign(&app, json!({ "scenario_ids": [a], "group": "a\u{202E}b" })).await;
    assert_eq!(s, StatusCode::BAD_REQUEST);
    assert!(
        v.to_string()
            .contains("그룹 이름에 쓸 수 없는 글자가 들어 있습니다")
    );
    assert!(get_one(&app, &a).await["group"].is_null());
}

#[tokio::test]
async fn rename_moves_and_merges() {
    let app = new_app().await;
    let a = create_id(&app, "a", Some(json!("A"))).await;
    let b = create_id(&app, "b", Some(json!("A"))).await;
    let c = create_id(&app, "c", Some(json!("B"))).await;
    let (s, v) = rename(&app, " A ", "B").await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(v, json!({ "updated": 2 }));
    for id in [&a, &b, &c] {
        assert_eq!(get_one(&app, id).await["group"], "B");
    }
}

#[tokio::test]
async fn rename_missing_group_is_zero() {
    let app = new_app().await;
    let (s, v) = rename(&app, "없음", "X").await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(v, json!({ "updated": 0 }));
}

#[tokio::test]
async fn rename_same_name_is_400() {
    let app = new_app().await;
    let (s, v) = rename(&app, "A", " A").await;
    assert_eq!(s, StatusCode::BAD_REQUEST);
    assert_eq!(v["error"], "새 이름이 현재 이름과 같습니다", "{v:?}");
}

#[tokio::test]
async fn rename_blank_from_or_to_is_400() {
    let app = new_app().await;
    let blank = "바꿀 그룹 이름과 새 이름을 모두 입력해야 합니다";
    let (s, v) = rename(&app, "  ", "B").await;
    assert_eq!(s, StatusCode::BAD_REQUEST);
    assert_eq!(v["error"], blank, "{v:?}");
    let (s, v) = rename(&app, "A", "\u{FEFF}").await;
    assert_eq!(s, StatusCode::BAD_REQUEST);
    assert_eq!(v["error"], blank, "{v:?}");
}

#[tokio::test]
async fn rename_to_too_long_or_forbidden_is_400_and_changes_nothing() {
    let app = new_app().await;
    let a = create_id(&app, "a", Some(json!("A"))).await;
    let (s, v) = rename(&app, "A", &"가".repeat(41)).await;
    assert_eq!(s, StatusCode::BAD_REQUEST);
    assert_eq!(v["error"], "그룹 이름은 40자까지 쓸 수 있습니다", "{v:?}");
    let (s, v) = rename(&app, "A", "a\u{202E}b").await;
    assert_eq!(s, StatusCode::BAD_REQUEST);
    assert_eq!(
        v["error"], "그룹 이름에 쓸 수 없는 글자가 들어 있습니다",
        "{v:?}"
    );
    assert_eq!(get_one(&app, &a).await["group"], "A");
}
