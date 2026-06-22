use axum::{
    Json,
    extract::{Path, State},
    http::StatusCode,
};
use serde::{Deserialize, Deserializer, Serialize};

use crate::app::AppState;
use crate::error::ApiError;
use crate::grpc::coordinator::PoolWorkerInfo;

#[derive(Serialize)]
pub struct PoolWorkerSummary {
    pub worker_id: String,
    pub hostname: String,
    pub capacity_vus: u32,
    pub busy: bool,
    pub run_id: Option<String>,
    pub last_seen_secs_ago: u64,
    pub drained: bool,
    pub capacity_override: Option<u32>,
    pub label: Option<String>,
}

impl From<PoolWorkerInfo> for PoolWorkerSummary {
    fn from(i: PoolWorkerInfo) -> Self {
        PoolWorkerSummary {
            worker_id: i.worker_id,
            hostname: i.hostname,
            capacity_vus: i.capacity_vus,
            busy: i.assigned_run.is_some(),
            run_id: i.assigned_run,
            last_seen_secs_ago: i.last_seen_secs_ago,
            drained: i.drained,
            capacity_override: i.capacity_override,
            label: i.label,
        }
    }
}

#[derive(Serialize)]
pub struct PoolWorkersResponse {
    pub pool_mode: bool,
    pub workers: Vec<PoolWorkerSummary>,
    pub heartbeat_interval_seconds: u64,
    pub stale_timeout_seconds: u64,
}

/// serde helper: distinguish absent (→ None) from present-null (→ Some(None)).
fn deserialize_some<'de, T, D>(d: D) -> Result<Option<T>, D::Error>
where
    T: Deserialize<'de>,
    D: Deserializer<'de>,
{
    T::deserialize(d).map(Some)
}

#[derive(Deserialize)]
pub struct PatchWorkerReq {
    #[serde(default)]
    drained: Option<bool>,
    #[serde(default, deserialize_with = "deserialize_some")]
    capacity_override: Option<Option<u32>>,
    #[serde(default, deserialize_with = "deserialize_some")]
    label: Option<Option<String>>,
}

#[derive(Deserialize, Default)]
pub struct ExcludeReq {
    #[serde(default)]
    reason: Option<String>,
}

const CAPACITY_OVERRIDE_MAX: u32 = 1_000_000;
const LABEL_MAX_LEN: usize = 200;
const REASON_MAX_LEN: usize = 500;

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
        .map(PoolWorkerSummary::from)
        .collect();
    Json(PoolWorkersResponse {
        pool_mode,
        workers,
        heartbeat_interval_seconds: state.settings.pool_heartbeat_interval_seconds(),
        stale_timeout_seconds: state.settings.pool_stale_timeout_seconds(),
    })
}

/// PATCH /api/pool/workers/{id} — partial control update. (spec R8)
pub async fn patch_worker(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(req): Json<PatchWorkerReq>,
) -> Result<Json<PoolWorkerSummary>, ApiError> {
    if let Some(Some(c)) = req.capacity_override {
        if !(1..=CAPACITY_OVERRIDE_MAX).contains(&c) {
            return Err(ApiError::BadRequest(
                "capacity_override out of range (1..=1000000)".into(),
            ));
        }
    }
    if let Some(Some(l)) = &req.label {
        if l.chars().count() > LABEL_MAX_LEN {
            return Err(ApiError::BadRequest("label too long (max 200)".into()));
        }
    }
    if !state
        .coord
        .pool_set_control(&id, req.drained, req.capacity_override, req.label)
        .await
    {
        return Err(ApiError::NotFound);
    }
    // return the updated summary
    let summary = state
        .coord
        .pool_snapshot(tokio::time::Instant::now())
        .await
        .into_iter()
        .find(|i| i.worker_id == id)
        .map(PoolWorkerSummary::from)
        .ok_or(ApiError::NotFound)?;
    Ok(Json(summary))
}

/// POST /api/pool/workers/{id}/exclude — hard remove + worker exit. (spec R6/R8)
pub async fn exclude_worker(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(req): Json<ExcludeReq>,
) -> Result<StatusCode, ApiError> {
    if let Some(r) = &req.reason {
        if r.chars().count() > REASON_MAX_LEN {
            return Err(ApiError::BadRequest("reason too long (max 500)".into()));
        }
    }
    let reason = req.reason.unwrap_or_default();
    if state.coord.pool_exclude(&id, &reason).await {
        Ok(StatusCode::OK)
    } else {
        Err(ApiError::NotFound)
    }
}
