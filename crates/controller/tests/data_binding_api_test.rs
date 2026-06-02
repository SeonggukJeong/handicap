//! Run-create data-binding validation gate — API tests (Task 4, Slice 8c).
//! Five tests each exercising one rejection/acceptance branch of the gate
//! added to `api/runs.rs::create`.
use std::sync::Arc;

use axum::body::Body;
use axum::http::{Method, Request, StatusCode};
use handicap_controller::dispatcher::NoopDispatcher;
use handicap_controller::grpc::coordinator::CoordinatorState;
use handicap_controller::{app, store};
use serde_json::{Value, json};
use tower::ServiceExt;

// ─── helpers ────────────────────────────────────────────────────────────────

fn make_app(db: store::Db) -> axum::Router {
    let coord = CoordinatorState::new(db.clone());
    app::router(app::AppState {
        db,
        coord,
        dispatcher: Arc::new(NoopDispatcher),
        ui_dir: None,
        dataset_max_rows: 5, // small cap so the over-max case is cheap
    })
}

/// multipart/form-data 본문 + content-type 헤더값 생성.
/// fields: (name, filename(Option), bytes). filename 있으면 파일 파트.
fn multipart(fields: &[(&str, Option<&str>, &[u8])]) -> (String, Vec<u8>) {
    let boundary = "X-HANDICAP-BOUNDARY-8c";
    let mut body = Vec::new();
    for (name, filename, data) in fields {
        body.extend_from_slice(format!("--{boundary}\r\n").as_bytes());
        match filename {
            Some(fname) => body.extend_from_slice(
                format!(
                    "Content-Disposition: form-data; name=\"{name}\"; filename=\"{fname}\"\r\nContent-Type: application/octet-stream\r\n\r\n"
                )
                .as_bytes(),
            ),
            None => body.extend_from_slice(
                format!("Content-Disposition: form-data; name=\"{name}\"\r\n\r\n").as_bytes(),
            ),
        }
        body.extend_from_slice(data);
        body.extend_from_slice(b"\r\n");
    }
    body.extend_from_slice(format!("--{boundary}--\r\n").as_bytes());
    (format!("multipart/form-data; boundary={boundary}"), body)
}

async fn body_json(resp: axum::response::Response) -> (StatusCode, Value) {
    let status = resp.status();
    let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX)
        .await
        .unwrap();
    let v = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
    (status, v)
}

/// Upload a CSV dataset and return its `id`.
async fn upload_dataset(app: &axum::Router, csv: &str, filename: &str) -> String {
    let (ct, body) = multipart(&[("file", Some(filename), csv.as_bytes())]);
    let req = Request::builder()
        .method(Method::POST)
        .uri("/api/datasets")
        .header("content-type", ct)
        .body(Body::from(body))
        .unwrap();
    let (status, v) = body_json(app.clone().oneshot(req).await.unwrap()).await;
    assert_eq!(status, StatusCode::OK, "upload dataset failed: {v:?}");
    v["id"].as_str().unwrap().to_string()
}

/// Create a scenario and return its `id`.
async fn create_scenario(app: &axum::Router) -> String {
    let yaml = "version: 1\nname: binding-test\nsteps:\n  - id: 01JBINDING0000000000000001\n    type: http\n    name: step1\n    request:\n      method: GET\n      url: http://example.com/{{username}}\n";
    let req = Request::builder()
        .method(Method::POST)
        .uri("/api/scenarios")
        .header("content-type", "application/json")
        .body(Body::from(json!({ "yaml": yaml }).to_string()))
        .unwrap();
    let (status, v) = body_json(app.clone().oneshot(req).await.unwrap()).await;
    assert_eq!(status, StatusCode::CREATED, "create scenario failed: {v:?}");
    v["id"].as_str().unwrap().to_string()
}

/// POST /api/runs with a data_binding profile field.
async fn post_run(
    app: &axum::Router,
    scenario_id: &str,
    data_binding: Value,
) -> (StatusCode, Value) {
    let body = json!({
        "scenario_id": scenario_id,
        "profile": {
            "vus": 2,
            "duration_seconds": 1,
            "data_binding": data_binding
        },
        "env": {}
    });
    let req = Request::builder()
        .method(Method::POST)
        .uri("/api/runs")
        .header("content-type", "application/json")
        .body(Body::from(body.to_string()))
        .unwrap();
    body_json(app.clone().oneshot(req).await.unwrap()).await
}

// ─── tests ──────────────────────────────────────────────────────────────────

/// A mapping that references a column not present in the dataset → 400.
#[tokio::test]
async fn rejects_mapping_to_missing_column() {
    let db = store::connect("sqlite::memory:").await.unwrap();
    let app = make_app(db.clone());

    // dataset columns: [email, pw]
    let dataset_id = upload_dataset(&app, "email,pw\na@ex.com,p1\n", "users.csv").await;
    let scenario_id = create_scenario(&app).await;

    let binding = json!({
        "dataset_id": dataset_id,
        "policy": "per_vu",
        "mappings": [{"kind": "column", "var": "username", "column": "nope"}]
    });
    let (status, v) = post_run(&app, &scenario_id, binding).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "expected 400 got: {v:?}");
    let msg = v["error"].as_str().unwrap_or("");
    assert!(
        msg.contains("nope"),
        "error should mention missing column 'nope': {msg}"
    );
}

/// A dataset with 0 rows (header-only) → per_vu bind → 400.
#[tokio::test]
async fn rejects_empty_dataset() {
    let db = store::connect("sqlite::memory:").await.unwrap();
    let app = make_app(db.clone());

    // Upload a header-only CSV: `parse_upload` stores 0 rows.
    let dataset_id = upload_dataset(&app, "email,pw\n", "empty.csv").await;
    let scenario_id = create_scenario(&app).await;

    let binding = json!({
        "dataset_id": dataset_id,
        "policy": "per_vu",
        "mappings": [{"kind": "column", "var": "username", "column": "email"}]
    });
    let (status, v) = post_run(&app, &scenario_id, binding).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "expected 400 got: {v:?}");
    let msg = v["error"].as_str().unwrap_or("");
    assert!(
        msg.contains("빈"),
        "error should mention empty dataset: {msg}"
    );
}

/// `policy: "unique"` with rows >= N workers → 201 accepted.
/// `policy: "unique"` with rows < N workers → 400 (N-floor gate).
/// make_app uses capacity=2000 VUs, post_run uses vus=2 → N=ceil(2/2000)=1.
/// So: 1-row dataset → rows(1) >= N(1) → accepted.
/// For the rejection case we need rows < N: use a 1-row dataset but a custom
/// app with capacity=1 so N=ceil(2/1)=2, making rows(1) < workers(2) → 400.
#[tokio::test]
async fn unique_policy_accepted_when_rows_meet_worker_count() {
    let db = store::connect("sqlite::memory:").await.unwrap();
    let app = make_app(db.clone()); // capacity=2000, vus=2 → N=1

    // 1 row; rows(1) >= N(1) → 201.
    let dataset_id = upload_dataset(&app, "email,pw\na@ex.com,p1\n", "users.csv").await;
    let scenario_id = create_scenario(&app).await;

    let binding = json!({
        "dataset_id": dataset_id,
        "policy": "unique",
        "mappings": [{"kind": "column", "var": "username", "column": "email"}]
    });
    let (status, _v) = post_run(&app, &scenario_id, binding).await;
    assert_eq!(
        status,
        StatusCode::CREATED,
        "unique with rows>=N must be accepted"
    );
}

#[tokio::test]
async fn unique_policy_rejected_when_rows_below_worker_count() {
    let db = store::connect("sqlite::memory:").await.unwrap();
    // capacity=1 VU per worker + vus=2 → N=ceil(2/1)=2; dataset has 1 row → rows < N → 400.
    let coord = CoordinatorState::with_capacity(db.clone(), 1);
    let app = app::router(app::AppState {
        db: db.clone(),
        coord,
        dispatcher: Arc::new(NoopDispatcher),
        ui_dir: None,
        dataset_max_rows: 5,
    });

    let dataset_id = upload_dataset(&app, "email,pw\na@ex.com,p1\n", "users.csv").await;
    let scenario_id = create_scenario(&app).await;

    let binding = json!({
        "dataset_id": dataset_id,
        "policy": "unique",
        "mappings": [{"kind": "column", "var": "username", "column": "email"}]
    });
    let (status, v) = post_run(&app, &scenario_id, binding).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "expected 400 got: {v:?}");
    let msg = v["error"].as_str().unwrap_or("");
    assert!(
        msg.contains("워커"),
        "error should mention worker count: {msg}"
    );
}

/// iter_sequential with > dataset_max_rows rows → 400.
/// per_vu with the same dataset → 201 (not capped).
#[tokio::test]
async fn rejects_iter_policy_over_max_rows_but_accepts_per_vu() {
    let db = store::connect("sqlite::memory:").await.unwrap();
    let app = make_app(db.clone());

    // 6 rows > dataset_max_rows=5
    let csv = "email\na@ex.com\nb@ex.com\nc@ex.com\nd@ex.com\ne@ex.com\nf@ex.com\n";
    let dataset_id = upload_dataset(&app, csv, "big.csv").await;
    let scenario_id = create_scenario(&app).await;

    // iter_sequential → 400 (over cap)
    let binding_iter = json!({
        "dataset_id": dataset_id,
        "policy": "iter_sequential",
        "mappings": [{"kind": "column", "var": "username", "column": "email"}]
    });
    let (status, v) = post_run(&app, &scenario_id, binding_iter).await;
    assert_eq!(
        status,
        StatusCode::BAD_REQUEST,
        "iter_sequential over max should be 400: {v:?}"
    );
    let msg = v["error"].as_str().unwrap_or("");
    assert!(
        msg.contains("6") || msg.contains("상한") || msg.contains("초과"),
        "error should mention row count or cap: {msg}"
    );

    // per_vu with the SAME 6-row dataset → 201 (per_vu is not capped)
    let binding_per_vu = json!({
        "dataset_id": dataset_id,
        "policy": "per_vu",
        "mappings": [{"kind": "column", "var": "username", "column": "email"}]
    });
    let (status2, v2) = post_run(&app, &scenario_id, binding_per_vu).await;
    assert_eq!(
        status2,
        StatusCode::CREATED,
        "per_vu with same dataset should succeed: {v2:?}"
    );
}

/// Valid per_vu binding with a 2-row dataset → 201; response includes
/// the data_binding round-tripped (policy + mapping present).
#[tokio::test]
async fn accepts_valid_per_vu_binding() {
    let db = store::connect("sqlite::memory:").await.unwrap();
    let app = make_app(db.clone());

    let dataset_id =
        upload_dataset(&app, "email,pw\na@ex.com,p1\nb@ex.com,p2\n", "users.csv").await;
    let scenario_id = create_scenario(&app).await;

    let binding = json!({
        "dataset_id": dataset_id,
        "policy": "per_vu",
        "mappings": [{"kind": "column", "var": "username", "column": "email"}]
    });
    let (status, v) = post_run(&app, &scenario_id, binding).await;
    assert_eq!(status, StatusCode::CREATED, "expected 201 got: {v:?}");

    // data_binding round-tripped in the response
    let db_resp = &v["profile"]["data_binding"];
    assert_eq!(
        db_resp["policy"].as_str().unwrap_or(""),
        "per_vu",
        "policy round-tripped: {db_resp}"
    );
    assert_eq!(
        db_resp["dataset_id"].as_str().unwrap_or(""),
        dataset_id,
        "dataset_id round-tripped: {db_resp}"
    );
    let mappings = db_resp["mappings"].as_array().unwrap();
    assert_eq!(mappings.len(), 1);
    assert_eq!(mappings[0]["column"].as_str().unwrap_or(""), "email");
    assert_eq!(mappings[0]["var"].as_str().unwrap_or(""), "username");

    // Also verify via GET /api/runs/{id}
    let run_id = v["id"].as_str().unwrap();
    let req = Request::builder()
        .method(Method::GET)
        .uri(format!("/api/runs/{run_id}"))
        .body(Body::empty())
        .unwrap();
    let (get_status, get_v) = body_json(app.clone().oneshot(req).await.unwrap()).await;
    assert_eq!(get_status, StatusCode::OK);
    assert_eq!(
        get_v["profile"]["data_binding"]["policy"]
            .as_str()
            .unwrap_or(""),
        "per_vu"
    );
}
