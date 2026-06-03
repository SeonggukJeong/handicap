use std::sync::Arc;

use axum::body::Body;
use axum::http::{Method, Request, StatusCode};
use handicap_controller::dispatcher::subprocess::SubprocessDispatcher;
use handicap_controller::grpc::coordinator::CoordinatorState;
use handicap_controller::store::metrics::{MetricRow, insert_batch};
use handicap_controller::store::runs::{Profile, RunStatus};
use handicap_controller::{app, store};
use hdrhistogram::Histogram;
use hdrhistogram::serialization::{Serializer, V2Serializer};
use tower::ServiceExt;

fn make_app(db: handicap_controller::store::Db) -> axum::Router {
    let coord = CoordinatorState::new(db.clone());
    app::router(app::AppState {
        db,
        coord,
        dispatcher: Arc::new(SubprocessDispatcher::new(
            "/nonexistent".to_string(),
            "127.0.0.1:0".parse().unwrap(),
        )),
        ui_dir: None,
        dataset_max_rows: 1_000_000,
    })
}

fn make_hdr_bytes(samples_us: &[u64]) -> Vec<u8> {
    let mut h = Histogram::<u64>::new_with_bounds(1, 60_000_000, 3).unwrap();
    for &v in samples_us {
        h.record(v).unwrap();
    }
    let mut buf = Vec::new();
    V2Serializer::new().serialize(&h, &mut buf).unwrap();
    buf
}

async fn seed_run_with_metrics(db: &handicap_controller::store::Db) -> (String, String) {
    let yaml = concat!(
        "version: 1\n",
        "name: export-test\n",
        "steps:\n",
        "  - id: stepA\n",
        "    name: ping\n",
        "    type: http\n",
        "    request:\n",
        "      method: GET\n",
        "      url: http://x/ping\n",
    );

    sqlx::query(
        "INSERT INTO scenarios(id, name, yaml, created_at, updated_at, version) \
         VALUES(?,?,?,?,?,?)",
    )
    .bind("S-export-test")
    .bind("export-test")
    .bind(yaml)
    .bind(1_i64)
    .bind(1_i64)
    .bind(1_i64)
    .execute(db)
    .await
    .unwrap();

    let env = serde_json::json!({});
    let profile = Profile {
        vus: 1,
        ramp_up_seconds: 0,
        duration_seconds: 2,
        loop_breakdown_cap: 256,
        data_binding: None,
        criteria: None,
    };
    let row = store::runs::insert(db, "S-export-test", yaml, &profile, &env)
        .await
        .unwrap();
    store::runs::set_status(db, &row.id, RunStatus::Completed, Some(100), Some(102))
        .await
        .unwrap();

    let metric_rows = vec![
        MetricRow {
            run_id: row.id.clone(),
            ts_second: 100,
            step_id: "stepA".to_string(),
            worker_id: "".to_string(),
            count: 5,
            error_count: 0,
            hdr_histogram: make_hdr_bytes(&[10_000, 20_000, 30_000]),
            status_counts: r#"{"200":5}"#.to_string(),
        },
        MetricRow {
            run_id: row.id.clone(),
            ts_second: 101,
            step_id: "stepA".to_string(),
            worker_id: "".to_string(),
            count: 2,
            error_count: 1,
            hdr_histogram: make_hdr_bytes(&[15_000, 25_000]),
            status_counts: r#"{"200":1,"500":1}"#.to_string(),
        },
    ];
    insert_batch(db, &metric_rows).await.unwrap();

    (row.id, yaml.to_string())
}

#[tokio::test]
async fn single_run_csv_export_returns_csv() {
    let db = store::connect("sqlite::memory:").await.unwrap();
    let (run_id, _) = seed_run_with_metrics(&db).await;
    let app = make_app(db);

    let resp = app
        .oneshot(
            Request::builder()
                .method(Method::GET)
                .uri(format!("/api/runs/{run_id}/report.csv"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(resp.status(), StatusCode::OK);

    let content_type = resp
        .headers()
        .get("content-type")
        .expect("content-type header must be present")
        .to_str()
        .unwrap();
    assert!(
        content_type.starts_with("text/csv"),
        "expected text/csv, got: {content_type}"
    );

    let content_disposition = resp
        .headers()
        .get("content-disposition")
        .expect("content-disposition header must be present")
        .to_str()
        .unwrap();
    assert!(
        content_disposition.contains("attachment"),
        "expected attachment in content-disposition, got: {content_disposition}"
    );

    let body = axum::body::to_bytes(resp.into_body(), 1024 * 1024)
        .await
        .unwrap();
    let text = String::from_utf8(body.to_vec()).unwrap();
    let first_line = text
        .lines()
        .next()
        .expect("CSV must have at least one line");
    assert_eq!(
        first_line, "step_id,count,error_count,p50_ms,p95_ms,p99_ms",
        "CSV header mismatch: {first_line}"
    );
}

#[tokio::test]
async fn export_of_nonterminal_run_is_rejected() {
    let db = store::connect("sqlite::memory:").await.unwrap();

    let yaml = concat!(
        "version: 1\n",
        "name: pending-test\n",
        "steps:\n",
        "  - id: stepB\n",
        "    name: nop\n",
        "    type: http\n",
        "    request:\n",
        "      method: GET\n",
        "      url: http://x/nop\n",
    );

    sqlx::query(
        "INSERT INTO scenarios(id, name, yaml, created_at, updated_at, version) \
         VALUES(?,?,?,?,?,?)",
    )
    .bind("S-pending-test")
    .bind("pending-test")
    .bind(yaml)
    .bind(1_i64)
    .bind(1_i64)
    .bind(1_i64)
    .execute(&db)
    .await
    .unwrap();

    let profile = Profile {
        vus: 1,
        ramp_up_seconds: 0,
        duration_seconds: 2,
        loop_breakdown_cap: 256,
        data_binding: None,
        criteria: None,
    };
    let row = store::runs::insert(
        &db,
        "S-pending-test",
        yaml,
        &profile,
        &serde_json::json!({}),
    )
    .await
    .unwrap();
    // Do NOT call set_status — leave run in Pending (the default initial status).

    let app = make_app(db);

    let resp = app
        .oneshot(
            Request::builder()
                .method(Method::GET)
                .uri(format!("/api/runs/{}/report.csv", row.id))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(
        resp.status(),
        StatusCode::BAD_REQUEST,
        "non-terminal run export must return 400"
    );
}
