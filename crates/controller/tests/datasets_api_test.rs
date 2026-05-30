use std::sync::Arc;

use axum::body::Body;
use axum::http::{Method, Request, StatusCode};
use handicap_controller::dispatcher::subprocess::SubprocessDispatcher;
use handicap_controller::grpc::coordinator::CoordinatorState;
use handicap_controller::{app, store};
use serde_json::Value;
use tower::ServiceExt;

fn make_app(db: store::Db) -> axum::Router {
    let coord = CoordinatorState::new(db.clone());
    app::router(app::AppState {
        db,
        coord,
        dispatcher: Arc::new(SubprocessDispatcher::new(
            "/nonexistent".to_string(),
            "127.0.0.1:0".parse().unwrap(),
        )),
        ui_dir: None,
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
