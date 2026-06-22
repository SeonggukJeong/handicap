use axum::{Json, extract::State};
use serde::Serialize;

use crate::app::AppState;

#[derive(Serialize)]
pub struct PoolWorkerSummary {
    pub worker_id: String,
    pub hostname: String,
    pub capacity_vus: u32,
    pub busy: bool,
    pub run_id: Option<String>,
    pub last_seen_secs_ago: u64,
}

#[derive(Serialize)]
pub struct PoolWorkersResponse {
    pub pool_mode: bool,
    pub workers: Vec<PoolWorkerSummary>,
    pub heartbeat_interval_seconds: u64,
    pub stale_timeout_seconds: u64,
}

/// GET /api/pool/workers — read-only pool snapshot for the dashboard (L2).
/// Off-pool deployments return `{pool_mode:false, workers:[]}` (not 404).
/// Exposes only display fields — never token/env/dataset (R12).
pub async fn list_workers(State(state): State<AppState>) -> Json<PoolWorkersResponse> {
    let pool_mode = state.coord.is_pool_mode();
    let workers = state
        .coord
        .pool_snapshot(tokio::time::Instant::now())
        .await
        .into_iter()
        .map(|i| PoolWorkerSummary {
            worker_id: i.worker_id,
            hostname: i.hostname,
            capacity_vus: i.capacity_vus,
            busy: i.assigned_run.is_some(),
            run_id: i.assigned_run,
            last_seen_secs_ago: i.last_seen_secs_ago,
        })
        .collect();
    Json(PoolWorkersResponse {
        pool_mode,
        workers,
        heartbeat_interval_seconds: state.heartbeat_interval_seconds,
        stale_timeout_seconds: state.stale_timeout_seconds,
    })
}
