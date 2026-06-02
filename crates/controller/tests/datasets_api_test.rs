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
        dataset_max_rows: 1_000_000,
    })
}

/// multipart/form-data 본문 + content-type 헤더값 생성.
/// fields: (name, filename(Option), bytes). filename 있으면 파일 파트.
fn multipart(fields: &[(&str, Option<&str>, &[u8])]) -> (String, Vec<u8>) {
    let boundary = "X-HANDICAP-BOUNDARY-8b";
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

#[tokio::test]
async fn dataset_upload_list_get_delete_flow() {
    let db = store::connect("sqlite::memory:").await.unwrap();
    let app = make_app(db.clone());

    // 1) 업로드(save)
    let (ct, body) = multipart(&[(
        "file",
        Some("users.csv"),
        b"email,pw\na@ex.com,p1\nb@ex.com,p2\n",
    )]);
    let req = Request::builder()
        .method(Method::POST)
        .uri("/api/datasets")
        .header("content-type", ct)
        .body(Body::from(body))
        .unwrap();
    let (status, v) = body_json(app.clone().oneshot(req).await.unwrap()).await;
    assert_eq!(status, StatusCode::OK, "upload: {v:?}");
    let id = v["id"].as_str().unwrap().to_string();
    assert_eq!(v["name"], "users"); // 확장자 제거된 파일명 기본
    assert_eq!(v["columns"], serde_json::json!(["email", "pw"]));
    assert_eq!(v["row_count"], 2);
    assert_eq!(v["sample"][0]["email"], "a@ex.com");

    // 2) 목록
    let req = Request::builder()
        .method(Method::GET)
        .uri("/api/datasets")
        .body(Body::empty())
        .unwrap();
    let (status, v) = body_json(app.clone().oneshot(req).await.unwrap()).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(v["datasets"].as_array().unwrap().len(), 1);

    // 3) get(메타 + 샘플)
    let req = Request::builder()
        .method(Method::GET)
        .uri(format!("/api/datasets/{id}"))
        .body(Body::empty())
        .unwrap();
    let (status, v) = body_json(app.clone().oneshot(req).await.unwrap()).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(v["row_count"], 2);
    assert_eq!(v["sample"].as_array().unwrap().len(), 2);

    // 4) delete
    let req = Request::builder()
        .method(Method::DELETE)
        .uri(format!("/api/datasets/{id}"))
        .body(Body::empty())
        .unwrap();
    let resp = app.clone().oneshot(req).await.unwrap();
    assert_eq!(resp.status(), StatusCode::NO_CONTENT);

    // 5) get → 404
    let req = Request::builder()
        .method(Method::GET)
        .uri(format!("/api/datasets/{id}"))
        .body(Body::empty())
        .unwrap();
    let resp = app.clone().oneshot(req).await.unwrap();
    assert_eq!(resp.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn dataset_preview_does_not_persist() {
    let db = store::connect("sqlite::memory:").await.unwrap();
    let app = make_app(db.clone());

    let (ct, body) = multipart(&[("file", Some("x.csv"), b"a,b\n1,2\n")]);
    let req = Request::builder()
        .method(Method::POST)
        .uri("/api/datasets/preview")
        .header("content-type", ct)
        .body(Body::from(body))
        .unwrap();
    let (status, v) = body_json(app.clone().oneshot(req).await.unwrap()).await;
    assert_eq!(status, StatusCode::OK, "preview: {v:?}");
    assert_eq!(v["columns"], serde_json::json!(["a", "b"]));
    assert!(v.get("id").is_none(), "preview는 저장 안 함 → id 없음");

    let req = Request::builder()
        .method(Method::GET)
        .uri("/api/datasets")
        .body(Body::empty())
        .unwrap();
    let (_s, v) = body_json(app.clone().oneshot(req).await.unwrap()).await;
    assert_eq!(v["datasets"].as_array().unwrap().len(), 0);
}

#[tokio::test]
async fn dataset_upload_allows_files_over_2mb() {
    let db = store::connect("sqlite::memory:").await.unwrap();
    let app = make_app(db.clone());

    // header "a" + one row whose cell is ~3 MiB → total body > 2 MiB default limit
    let big_cell = "x".repeat(3 * 1024 * 1024);
    let csv = format!("a\n{big_cell}\n");
    let (ct, body) = multipart(&[("file", Some("big.csv"), csv.as_bytes())]);
    let req = Request::builder()
        .method(Method::POST)
        .uri("/api/datasets")
        .header("content-type", ct)
        .body(Body::from(body))
        .unwrap();
    let resp = app.clone().oneshot(req).await.unwrap();
    assert_eq!(
        resp.status(),
        StatusCode::OK,
        "upload >2MB must not be rejected by the default body limit"
    );
}

#[tokio::test]
async fn dataset_upload_rejects_no_file() {
    let db = store::connect("sqlite::memory:").await.unwrap();
    let app = make_app(db.clone());
    let (ct, body) = multipart(&[("delimiter", None, b",")]); // 파일 파트 없음
    let req = Request::builder()
        .method(Method::POST)
        .uri("/api/datasets")
        .header("content-type", ct)
        .body(Body::from(body))
        .unwrap();
    let resp = app.clone().oneshot(req).await.unwrap();
    assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
}

// ─── Task 13: DELETE 409 guard (spec §10) ────────────────────────────────────

/// Upload a dataset CSV and return its id.
async fn upload_ds(app: &axum::Router, csv: &str) -> String {
    let (ct, body) = multipart(&[("file", Some("data.csv"), csv.as_bytes())]);
    let req = Request::builder()
        .method(Method::POST)
        .uri("/api/datasets")
        .header("content-type", ct)
        .body(Body::from(body))
        .unwrap();
    let (status, v) = body_json(app.clone().oneshot(req).await.unwrap()).await;
    assert_eq!(status, StatusCode::OK, "upload failed: {v:?}");
    v["id"].as_str().unwrap().to_string()
}

/// POST /api/runs with a data_binding referencing `dataset_id`.
/// No worker connects → run stays pending (non-terminal).
async fn create_run_with_binding(
    app: &axum::Router,
    scenario_id: &str,
    dataset_id: &str,
) -> String {
    let body = json!({
        "scenario_id": scenario_id,
        "profile": {
            "vus": 1,
            "duration_seconds": 1,
            "data_binding": {
                "dataset_id": dataset_id,
                "policy": "per_vu",
                "mappings": [{"kind": "column", "var": "user", "column": "name"}]
            }
        },
        "env": {}
    });
    let req = Request::builder()
        .method(Method::POST)
        .uri("/api/runs")
        .header("content-type", "application/json")
        .body(Body::from(body.to_string()))
        .unwrap();
    let (status, v) = body_json(app.clone().oneshot(req).await.unwrap()).await;
    assert_eq!(status, StatusCode::CREATED, "create run failed: {v:?}");
    v["id"].as_str().unwrap().to_string()
}

/// DELETE while a pending run references the dataset → 409.
/// The dataset must still be retrievable afterwards (not deleted).
#[tokio::test]
async fn delete_rejects_dataset_referenced_by_active_run() {
    let db = store::connect("sqlite::memory:").await.unwrap();
    let app = make_app(db.clone());

    // Dataset with column "name"
    let dataset_id = upload_ds(&app, "name\nalice\nbob\n").await;
    let scenario_id = create_scenario(
        &app,
        "version: 1\nname: guard-test\nsteps:\n  - id: 01JBGRD00000000000000000001\n    type: http\n    name: s1\n    request:\n      method: GET\n      url: http://example.com/{{user}}\n",
    )
    .await;

    // Create a run with a binding to this dataset; no worker → stays pending.
    let _run_id = create_run_with_binding(&app, &scenario_id, &dataset_id).await;

    // DELETE the dataset → must be 409.
    let req = Request::builder()
        .method(Method::DELETE)
        .uri(format!("/api/datasets/{dataset_id}"))
        .body(Body::empty())
        .unwrap();
    let (status, v) = body_json(app.clone().oneshot(req).await.unwrap()).await;
    assert_eq!(
        status,
        StatusCode::CONFLICT,
        "expected 409 when dataset referenced by pending run, got: {v:?}"
    );
    let msg = v["error"].as_str().unwrap_or("");
    assert!(
        msg.contains("pending") || msg.contains("running") || msg.contains("참조"),
        "error message should mention the conflict: {msg}"
    );

    // Dataset must still exist (not deleted).
    let req = Request::builder()
        .method(Method::GET)
        .uri(format!("/api/datasets/{dataset_id}"))
        .body(Body::empty())
        .unwrap();
    let resp = app.clone().oneshot(req).await.unwrap();
    assert_eq!(
        resp.status(),
        StatusCode::OK,
        "dataset should still exist after rejected DELETE"
    );
}

// ─── Task 4: Soft guard — preset references ──────────────────────────────────

/// Create a scenario with the given YAML and return its id.
async fn create_scenario(app: &axum::Router, yaml: &str) -> String {
    let req = Request::builder()
        .method(Method::POST)
        .uri("/api/scenarios")
        .header("content-type", "application/json")
        .body(Body::from(json!({ "yaml": yaml }).to_string()))
        .unwrap();
    let resp = app.clone().oneshot(req).await.unwrap();
    let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX)
        .await
        .unwrap();
    let v: Value = serde_json::from_slice(&bytes).unwrap();
    v["id"].as_str().unwrap().to_string()
}

const PRESET_YAML: &str = "version: 1\nname: ds-preset\nsteps:\n  - id: a\n    name: a\n    type: http\n    request:\n      method: GET\n      url: http://x/{{u}}\n";

#[tokio::test]
async fn delete_dataset_soft_blocks_when_referenced_by_preset() {
    let db = store::connect("sqlite::memory:").await.unwrap();
    let app = make_app(db.clone());
    let sid = create_scenario(&app, PRESET_YAML).await;
    let dataset_id = upload_ds(&app, "user\nalice\nbob\n").await;

    let req = Request::builder()
        .method(Method::POST)
        .uri(format!("/api/scenarios/{sid}/presets"))
        .header("content-type", "application/json")
        .body(Body::from(
            json!({
                "name": "bound",
                "profile": {
                    "vus": 1, "duration_seconds": 1,
                    "data_binding": {
                        "dataset_id": dataset_id,
                        "policy": "per_vu",
                        "mappings": [{ "kind": "column", "var": "u", "column": "user" }]
                    }
                },
                "env": {}
            })
            .to_string(),
        ))
        .unwrap();
    let resp = app.clone().oneshot(req).await.unwrap();
    assert_eq!(resp.status(), StatusCode::CREATED);

    // DELETE without force → soft 409 listing the preset
    let req = Request::builder()
        .method(Method::DELETE)
        .uri(format!("/api/datasets/{dataset_id}"))
        .body(Body::empty())
        .unwrap();
    let resp = app.clone().oneshot(req).await.unwrap();
    assert_eq!(resp.status(), StatusCode::CONFLICT);
    let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX)
        .await
        .unwrap();
    let v: Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(v["presets"].as_array().unwrap().len(), 1);
    assert_eq!(v["presets"][0]["name"], "bound");

    // DELETE with ?force=true → 204
    let req = Request::builder()
        .method(Method::DELETE)
        .uri(format!("/api/datasets/{dataset_id}?force=true"))
        .body(Body::empty())
        .unwrap();
    let resp = app.clone().oneshot(req).await.unwrap();
    assert_eq!(resp.status(), StatusCode::NO_CONTENT);
}

/// DELETE a dataset not referenced by any run → 204 (normal delete).
#[tokio::test]
async fn delete_allows_unreferenced_dataset() {
    let db = store::connect("sqlite::memory:").await.unwrap();
    let app = make_app(db.clone());

    // Upload a dataset but create NO runs referencing it.
    let dataset_id = upload_ds(&app, "name\nalice\n").await;

    let req = Request::builder()
        .method(Method::DELETE)
        .uri(format!("/api/datasets/{dataset_id}"))
        .body(Body::empty())
        .unwrap();
    let resp = app.clone().oneshot(req).await.unwrap();
    assert_eq!(
        resp.status(),
        StatusCode::NO_CONTENT,
        "unreferenced dataset should delete successfully"
    );

    // Confirm it's gone.
    let req = Request::builder()
        .method(Method::GET)
        .uri(format!("/api/datasets/{dataset_id}"))
        .body(Body::empty())
        .unwrap();
    let resp = app.clone().oneshot(req).await.unwrap();
    assert_eq!(resp.status(), StatusCode::NOT_FOUND);
}
