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
        db,
        coord,
        dispatcher: Arc::new(NoopDispatcher),
        ui_dir: None,
        dataset_max_rows: 1_000_000,
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

/// 시나리오를 만들고 id 반환(schedule.scenario_id FK).
async fn seed_scenario(app: &axum::Router) -> String {
    let yaml = "version: 1\nname: s\nsteps: []\n";
    let (status, v) = send(
        app,
        Method::POST,
        "/api/scenarios",
        Some(json!({ "yaml": yaml })),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "scenario seed: {v:?}");
    v["id"].as_str().unwrap().to_string()
}

fn profile() -> Value {
    json!({ "vus": 1, "duration_seconds": 1 })
}

#[tokio::test]
async fn create_list_get_update_delete_roundtrip() {
    let db = store::connect("sqlite::memory:").await.unwrap();
    let app = make_app(db);
    let sid = seed_scenario(&app).await;

    // create (cron)
    let (status, created) = send(
        &app,
        Method::POST,
        "/api/schedules",
        Some(json!({
            "name": "nightly",
            "scenario_id": sid,
            "profile": profile(),
            "env": { "BASE_URL": "http://x" },
            "trigger": { "kind": "cron", "cron_expr": "0 2 * * *" },
            "enabled": true,
        })),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{created:?}");
    let id = created["id"].as_str().unwrap().to_string();
    assert_eq!(created["trigger"]["kind"], "cron");
    assert_eq!(created["trigger"]["cron_expr"], "0 2 * * *");
    assert!(
        created["next_run_at"].is_number(),
        "next_run_at computed on create"
    );

    // list
    let (status, list) = send(&app, Method::GET, "/api/schedules", None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(list["schedules"].as_array().unwrap().len(), 1);

    // get
    let (status, got) = send(&app, Method::GET, &format!("/api/schedules/{id}"), None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(got["name"], "nightly");

    // update → once
    let future = store::now_ms() + 3_600_000;
    let (status, updated) = send(
        &app,
        Method::PUT,
        &format!("/api/schedules/{id}"),
        Some(json!({
            "name": "oneshot",
            "scenario_id": sid,
            "profile": profile(),
            "env": {},
            "trigger": { "kind": "once", "run_at": future },
            "enabled": true,
        })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{updated:?}");
    assert_eq!(updated["trigger"]["kind"], "once");
    assert_eq!(updated["trigger"]["run_at"], future);

    // delete
    let (status, _) = send(&app, Method::DELETE, &format!("/api/schedules/{id}"), None).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let (status, _) = send(&app, Method::GET, &format!("/api/schedules/{id}"), None).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn create_rejects_bad_inputs() {
    let db = store::connect("sqlite::memory:").await.unwrap();
    let app = make_app(db);
    let sid = seed_scenario(&app).await;

    // 잘못된 cron → 400
    let (status, _) = send(
        &app,
        Method::POST,
        "/api/schedules",
        Some(json!({
            "name": "a", "scenario_id": sid, "profile": profile(), "env": {},
            "trigger": { "kind": "cron", "cron_expr": "not a cron" },
        })),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    // 6-field cron → 400 (5-field 강제)
    let (status, _) = send(
        &app,
        Method::POST,
        "/api/schedules",
        Some(json!({
            "name": "b", "scenario_id": sid, "profile": profile(), "env": {},
            "trigger": { "kind": "cron", "cron_expr": "0 0 2 * * *" },
        })),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    // 과거 once → 400
    let (status, _) = send(
        &app,
        Method::POST,
        "/api/schedules",
        Some(json!({
            "name": "c", "scenario_id": sid, "profile": profile(), "env": {},
            "trigger": { "kind": "once", "run_at": 1_000 },
        })),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    // 없는 시나리오 → 404
    let (status, _) = send(
        &app,
        Method::POST,
        "/api/schedules",
        Some(json!({
            "name": "d", "scenario_id": "NOPE", "profile": profile(), "env": {},
            "trigger": { "kind": "cron", "cron_expr": "0 2 * * *" },
        })),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn duplicate_name_conflicts() {
    let db = store::connect("sqlite::memory:").await.unwrap();
    let app = make_app(db);
    let sid = seed_scenario(&app).await;
    let body = json!({
        "name": "dup", "scenario_id": sid, "profile": profile(), "env": {},
        "trigger": { "kind": "cron", "cron_expr": "0 2 * * *" },
    });
    let (s1, _) = send(&app, Method::POST, "/api/schedules", Some(body.clone())).await;
    assert_eq!(s1, StatusCode::CREATED);
    let (s2, _) = send(&app, Method::POST, "/api/schedules", Some(body)).await;
    assert_eq!(s2, StatusCode::CONFLICT);
}

#[tokio::test]
async fn preview_next_returns_increasing_times_and_does_not_shadow_id_route() {
    let db = store::connect("sqlite::memory:").await.unwrap();
    let app = make_app(db);

    let (status, v) = send(
        &app,
        Method::POST,
        "/api/schedules/preview-next",
        Some(json!({
            "trigger": { "kind": "cron", "cron_expr": "0 2 * * *" },
            "count": 3,
        })),
    )
    .await;
    // preview-next가 /schedules/{id}의 {id}로 새지 않고 핸들러에 도달(POST + 200).
    assert_eq!(status, StatusCode::OK, "{v:?}");
    let next = v["next"].as_array().unwrap();
    assert_eq!(next.len(), 3);
    let a = next[0].as_i64().unwrap();
    let b = next[1].as_i64().unwrap();
    assert!(b > a, "strictly increasing");
}

#[tokio::test]
async fn events_history_is_listed() {
    let db = store::connect("sqlite::memory:").await.unwrap();
    let app = make_app(db.clone());
    let sid = seed_scenario(&app).await;
    let (_, created) = send(
        &app,
        Method::POST,
        "/api/schedules",
        Some(json!({
            "name": "e", "scenario_id": sid, "profile": profile(), "env": {},
            "trigger": { "kind": "cron", "cron_expr": "0 2 * * *" },
        })),
    )
    .await;
    let id = created["id"].as_str().unwrap().to_string();
    // 이벤트 직접 시드(루프 없이 API 검증).
    handicap_controller::store::schedules::insert_event(&db, &id, 100, "fired", Some("RUN1"), None)
        .await
        .unwrap();

    let (status, v) = send(
        &app,
        Method::GET,
        &format!("/api/schedules/{id}/events"),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let evs = v["events"].as_array().unwrap();
    assert_eq!(evs.len(), 1);
    assert_eq!(evs[0]["kind"], "fired");
    assert_eq!(evs[0]["run_id"], "RUN1");
}
