//! P0 (codex evaluation, item 2): worker dispatch failure at run-create must be
//! authoritative — the run is marked `failed` with a useful message and the API
//! returns a 5xx, instead of silently returning 201 and leaving a pending run
//! for the registration watchdog to fail 60s later.
use std::sync::Arc;

use async_trait::async_trait;
use axum::body::Body;
use axum::http::{Method, Request, StatusCode};
use handicap_controller::dispatcher::WorkerDispatcher;
use handicap_controller::grpc::coordinator::CoordinatorState;
use handicap_controller::{app, store};
use serde_json::{Value, json};
use tower::ServiceExt;

/// A dispatcher whose `dispatch` always fails — models a missing worker binary,
/// a failed K8s Job creation, RBAC denial, or an unreachable cluster.
struct FailingDispatcher;

#[async_trait]
impl WorkerDispatcher for FailingDispatcher {
    async fn dispatch(&self, _run_id: &str, _worker_count: u32) -> anyhow::Result<()> {
        Err(anyhow::anyhow!("simulated dispatch failure"))
    }
    async fn cleanup(&self, _run_id: &str) -> anyhow::Result<()> {
        Ok(())
    }
}

fn make_app(db: store::Db) -> axum::Router {
    let coord = CoordinatorState::new(db.clone());
    app::router(app::AppState {
        db,
        coord,
        dispatcher: Arc::new(FailingDispatcher),
        ui_dir: None,
        settings: handicap_controller::settings::SettingsState::build(
            &std::collections::HashMap::new(),
            &[],
        ),
        scheduler_tz: chrono_tz::UTC,
    })
}

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

async fn list_runs(app: &axum::Router, scenario_id: &str) -> Vec<Value> {
    let req = Request::builder()
        .method(Method::GET)
        .uri(format!("/api/scenarios/{scenario_id}/runs"))
        .body(Body::empty())
        .unwrap();
    let resp = app.clone().oneshot(req).await.unwrap();
    let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX)
        .await
        .unwrap();
    let v: Value = serde_json::from_slice(&bytes).unwrap();
    v["runs"].as_array().cloned().unwrap_or_default()
}

const YAML: &str = "version: 1\nname: dispatch-fail\nsteps:\n  - id: a\n    name: a\n    type: http\n    request:\n      method: GET\n      url: http://x\n";

#[tokio::test]
async fn dispatch_failure_marks_run_failed_and_returns_5xx() {
    let db = store::connect("sqlite::memory:").await.unwrap();
    let app = make_app(db.clone());
    let scenario_id = create_scenario(&app, YAML).await;

    // POST /api/runs — dispatch will fail.
    let req = Request::builder()
        .method(Method::POST)
        .uri("/api/runs")
        .header("content-type", "application/json")
        .body(Body::from(
            json!({
                "scenario_id": scenario_id,
                "profile": { "vus": 1, "duration_seconds": 30 },
                "env": {}
            })
            .to_string(),
        ))
        .unwrap();
    let resp = app.clone().oneshot(req).await.unwrap();

    // The API must surface the failure (not 201).
    assert_eq!(
        resp.status(),
        StatusCode::INTERNAL_SERVER_ERROR,
        "dispatch failure must return 5xx"
    );

    // The run is recorded as `failed` with a message naming the dispatch error,
    // not left pending for the 60s registration watchdog.
    let runs = list_runs(&app, &scenario_id).await;
    assert_eq!(runs.len(), 1, "the run row should exist (marked failed)");
    assert_eq!(runs[0]["status"], "failed");
    let message = runs[0]["message"].as_str().unwrap_or("");
    assert!(
        message.contains("dispatch"),
        "message should name the dispatch failure, got: {message:?}"
    );
}
