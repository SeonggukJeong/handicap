use std::sync::Arc;

use axum::body::Body;
use axum::http::{Method, Request, StatusCode};
use handicap_controller::dispatcher::subprocess::SubprocessDispatcher;
use handicap_controller::grpc::coordinator::CoordinatorState;
use handicap_controller::report::ReportJson;
use handicap_controller::store::metrics::{MetricRow, insert_batch};
use handicap_controller::store::runs::{Profile, RunStatus};
use handicap_controller::{app, store};
use hdrhistogram::Histogram;
use hdrhistogram::serialization::{Serializer, V2Serializer};
use serde_json::Value;
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
        "name: report-test\n",
        "steps:\n",
        "  - id: stepA\n",
        "    name: ping\n",
        "    type: http\n",
        "    request:\n",
        "      method: GET\n",
        "      url: http://x/ping\n",
    );

    // Insert a scenario row first (FK: runs.scenario_id REFERENCES scenarios(id)).
    // SQLite doesn't enforce FKs by default in this pool, but insert anyway to be safe.
    sqlx::query(
        "INSERT INTO scenarios(id, name, yaml, created_at, updated_at, version) \
         VALUES(?,?,?,?,?,?)",
    )
    .bind("S-report-test")
    .bind("report-test")
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
        http_timeout_seconds: 30,
        data_binding: None,
        criteria: None,
    };
    let row = store::runs::insert(db, "S-report-test", yaml, &profile, &env)
        .await
        .unwrap();
    // Move to completed so the report endpoint can answer for a terminal run.
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
async fn report_endpoint_returns_404_on_unknown_run() {
    let db = store::connect("sqlite::memory:").await.unwrap();
    let app = make_app(db);

    let resp = app
        .oneshot(
            Request::builder()
                .method(Method::GET)
                .uri("/api/runs/NOPE/report")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn report_endpoint_returns_bundle_for_seeded_run() {
    let db = store::connect("sqlite::memory:").await.unwrap();
    let (run_id, scenario_yaml) = seed_run_with_metrics(&db).await;
    let app = make_app(db);

    let resp = app
        .oneshot(
            Request::builder()
                .method(Method::GET)
                .uri(format!("/api/runs/{run_id}/report"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let body = axum::body::to_bytes(resp.into_body(), 1024 * 1024)
        .await
        .unwrap();
    let json: Value = serde_json::from_slice(&body).unwrap();

    assert_eq!(json["run"]["id"].as_str().unwrap(), run_id);
    assert_eq!(json["scenario_yaml"].as_str().unwrap(), scenario_yaml);
    assert!(json["summary"]["count"].as_u64().unwrap() > 0);
    let steps = json["steps"].as_array().unwrap();
    assert!(!steps.is_empty());

    // Also typed-decode it to catch shape regressions
    let _typed: ReportJson = serde_json::from_value(json).unwrap();
}
