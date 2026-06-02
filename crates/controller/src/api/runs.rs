use axum::Json;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use serde::{Deserialize, Serialize};

use crate::app::AppState;
use crate::binding::BindingPolicy;
use crate::error::ApiError;
use crate::store::datasets;
use crate::store::runs::{self, Profile, RunStatus};
use crate::store::scenarios;

#[derive(Debug, Deserialize)]
pub struct CreateRunRequest {
    pub scenario_id: String,
    pub profile: Profile,
    #[serde(default)]
    pub env: std::collections::HashMap<String, String>,
}

#[derive(Debug, Serialize)]
pub struct RunResponse {
    pub id: String,
    pub scenario_id: String,
    /// Immutable snapshot of the scenario YAML this run executed against. The UI
    /// compares it to the live scenario to warn when a retry would use drifted
    /// settings (spec §4). Present on every run response, incl. the list.
    pub scenario_yaml: String,
    pub status: RunStatus,
    pub profile: Profile,
    pub env: serde_json::Value,
    pub started_at: Option<i64>,
    pub ended_at: Option<i64>,
    pub created_at: i64,
    pub message: Option<String>,
}

pub(crate) fn loop_cap_ok(cap: u32) -> bool {
    cap <= 10_000
}

/// Validate a run/preset config against the live datasets (spec §6). Returns the
/// validated dataset meta when a binding is present (so the caller resolves the
/// binding from it without a second `get_meta` — TOCTOU guard, controller
/// `CLAUDE.md`), or `None` when there is no binding. Shared by `runs::create`
/// (authoritative gate) and preset save (`api::presets`).
pub(crate) async fn validate_run_config(
    state: &AppState,
    profile: &Profile,
) -> Result<Option<datasets::DatasetMeta>, ApiError> {
    if profile.vus == 0 || profile.duration_seconds == 0 {
        return Err(ApiError::BadRequest(
            "vus and duration_seconds must be > 0".into(),
        ));
    }
    if !loop_cap_ok(profile.loop_breakdown_cap) {
        return Err(ApiError::BadRequest(
            "loop_breakdown_cap must be <= 10000 (0 disables breakdown)".into(),
        ));
    }
    let Some(b) = &profile.data_binding else {
        return Ok(None);
    };
    let meta = datasets::get_meta(&state.db, &b.dataset_id)
        .await?
        .ok_or_else(|| {
            ApiError::BadRequest("data_binding.dataset_id가 존재하지 않습니다".into())
        })?;
    if meta.row_count == 0 {
        return Err(ApiError::BadRequest(
            "빈 데이터셋은 바인딩할 수 없습니다".into(),
        ));
    }
    for col in b.referenced_columns() {
        if !meta.columns.iter().any(|c| c == col) {
            return Err(ApiError::BadRequest(format!(
                "매핑 컬럼 '{col}'이 데이터셋에 없습니다 (있는 컬럼: {:?})",
                meta.columns
            )));
        }
    }
    if matches!(b.policy, BindingPolicy::Unique) {
        // shard_split is u32 (grpc/shard.rs) — refuse rows that would truncate.
        if meta.row_count > u32::MAX as i64 {
            return Err(ApiError::BadRequest(
                "unique 정책은 데이터셋 행 수가 u32 범위를 넘을 수 없습니다".into(),
            ));
        }
        // Every worker must get at least one row, else a worker would generate
        // unbound load (dataset=None path). rows >= N ⟹ all shard counts >= 1.
        let n = state.coord.worker_count_for(profile.vus);
        if (meta.row_count as u64) < n as u64 {
            return Err(ApiError::BadRequest(format!(
                "unique 정책은 데이터셋 행 수가 워커 수 이상이어야 합니다: rows={} < workers={n}",
                meta.row_count
            )));
        }
    }
    // per-iteration policies stream the whole dataset → cap.
    // unique also streams the whole dataset (split across workers) → cap.
    // per_vu is sliced to min(vus, rows) so it is never capped (spec §11).
    let per_iteration = matches!(
        b.policy,
        BindingPolicy::IterSequential | BindingPolicy::IterRandom | BindingPolicy::Unique
    );
    if per_iteration && (meta.row_count as u64) > state.dataset_max_rows {
        return Err(ApiError::BadRequest(format!(
            "per-iteration 바인딩 행 수 {}가 상한 {}을 초과합니다",
            meta.row_count, state.dataset_max_rows
        )));
    }
    Ok(Some(meta))
}

pub async fn create(
    State(state): State<AppState>,
    Json(body): Json<CreateRunRequest>,
) -> Result<(StatusCode, Json<RunResponse>), ApiError> {
    let scenario = scenarios::get(&state.db, &body.scenario_id)
        .await?
        .ok_or(ApiError::NotFound)?;

    let validated_meta = validate_run_config(&state, &body.profile).await?;

    // env is already map<string,string> (rejected at the API boundary otherwise).
    // Serialize back to a JSON object for storage; clone the map for the proto.
    let env_value = serde_json::to_value(&body.env).expect("env map serializes to a JSON object");
    let row = runs::insert(
        &state.db,
        &scenario.id,
        &scenario.yaml,
        &body.profile,
        &env_value,
    )
    .await?;

    // Resolve the binding for the worker (spec §4/§7): proto policy, a
    // deterministic seed folded from the run id, and the sliced row count.
    // Reuses the meta validate_run_config already fetched — no second DB call.
    let data_binding = match (&body.profile.data_binding, validated_meta) {
        (Some(b), Some(meta)) => {
            let (policy, row_count) = match b.policy {
                BindingPolicy::PerVu => (
                    handicap_proto::v1::data_binding::Policy::PerVu,
                    (body.profile.vus as u64).min(meta.row_count as u64),
                ),
                BindingPolicy::IterSequential => (
                    handicap_proto::v1::data_binding::Policy::IterSequential,
                    meta.row_count as u64,
                ),
                BindingPolicy::IterRandom => (
                    handicap_proto::v1::data_binding::Policy::IterRandom,
                    meta.row_count as u64,
                ),
                // unique stores the TOTAL row count; assignment_for partitions it
                // into per-worker disjoint slices at register time (Task 5).
                BindingPolicy::Unique => (
                    handicap_proto::v1::data_binding::Policy::Unique,
                    meta.row_count as u64,
                ),
            };
            Some(crate::grpc::coordinator::PendingDataBinding {
                dataset_id: b.dataset_id.clone(),
                policy,
                seed: fold_seed(&row.id),
                mappings: b.mappings.clone(),
                row_count,
            })
        }
        // (None, None) is the only other reachable arm — binding absent → no PendingDataBinding.
        // (Some, None) / (None, Some) cannot occur: validate_run_config returns Some(meta)
        // iff data_binding is Some, and None otherwise.
        _ => None,
    };

    // Enqueue the assignment so the coordinator can hand shards to N workers.
    let assignment = crate::grpc::coordinator::PendingAssignment {
        scenario_yaml: scenario.yaml.clone(),
        profile: handicap_proto::v1::Profile {
            vus: body.profile.vus,
            ramp_up_seconds: body.profile.ramp_up_seconds,
            duration_seconds: body.profile.duration_seconds,
            loop_breakdown_cap: body.profile.loop_breakdown_cap,
        },
        env: body.env.clone(),
        data_binding,
    };
    let n = state.coord.worker_count_for(body.profile.vus);
    state
        .coord
        .enqueue(row.id.clone(), assignment, n, body.profile.vus)
        .await;

    // Dispatch N workers (subprocess: N children; K8s: 1 Job, Indexed in A3c).
    // Dispatch failure (missing worker binary, K8s Job creation denied, cluster
    // unreachable) is an authoritative run-start failure: tear down the enqueued
    // coordinator state, mark the run `failed` with the cause, and surface a 5xx
    // — instead of returning 201 and letting the 60s watchdog fail it anonymously
    // (codex eval, item 2).
    if let Err(e) = state.dispatcher.dispatch(&row.id, n).await {
        let message = format!("failed to dispatch workers: {e}");
        tracing::error!(run_id = %row.id, error = %e, "worker dispatch failed; marking run failed");
        state.coord.cancel_dispatch_failed(&row.id).await;
        runs::mark_failed(&state.db, &row.id, &message).await?;
        return Err(ApiError::Internal(anyhow::anyhow!(message)));
    }

    Ok((StatusCode::CREATED, Json(to_response(row))))
}

pub async fn get(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<RunResponse>, ApiError> {
    let row = runs::get(&state.db, &id).await?.ok_or(ApiError::NotFound)?;
    Ok(Json(to_response(row)))
}

pub async fn metrics(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<crate::store::metrics::MetricSummary>, ApiError> {
    // 404 if the run doesn't exist.
    let _ = runs::get(&state.db, &id).await?.ok_or(ApiError::NotFound)?;
    let s = crate::store::metrics::summary(&state.db, &id).await?;
    Ok(Json(s))
}

pub async fn report(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<crate::report::ReportJson>, ApiError> {
    let row = runs::get(&state.db, &id).await?.ok_or(ApiError::NotFound)?;
    let rows = crate::store::metrics::windows_with_hdr(&state.db, &id).await?;
    let loops = crate::store::metrics::loop_breakdown(&state.db, &id).await?;
    let branches = crate::store::metrics::if_breakdown(&state.db, &id).await?;
    let scenario_yaml = row.scenario_yaml.clone();
    Ok(Json(crate::report::build_report(
        &row,
        &scenario_yaml,
        &rows,
        &loops,
        &branches,
    )))
}

#[derive(Debug, Serialize)]
pub struct RunListResponse {
    pub runs: Vec<RunResponse>,
}

pub async fn list_for_scenario(
    State(state): State<AppState>,
    Path(scenario_id): Path<String>,
) -> Result<Json<RunListResponse>, ApiError> {
    // 404 if scenario doesn't exist (so the UI distinguishes empty from missing).
    let _ = scenarios::get(&state.db, &scenario_id)
        .await?
        .ok_or(ApiError::NotFound)?;
    let rows = runs::list_by_scenario(&state.db, &scenario_id).await?;
    Ok(Json(RunListResponse {
        runs: rows.into_iter().map(to_response).collect(),
    }))
}

pub async fn abort_run(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<axum::http::StatusCode, ApiError> {
    let row = runs::get(&state.db, &id).await?.ok_or(ApiError::NotFound)?;
    match row.status {
        runs::RunStatus::Running | runs::RunStatus::Pending => {}
        _ => {
            return Err(ApiError::Conflict(format!(
                "run is {} and cannot be aborted",
                row.status.as_str()
            )));
        }
    }
    // Best-effort: send AbortRun to the worker if it is already connected.
    // If the worker hasn't registered yet (still pending), mark_aborted below is sufficient.
    state.coord.abort(&id).await;
    runs::mark_aborted(&state.db, &id).await?;
    Ok(axum::http::StatusCode::OK)
}

/// Fold a run id (ULID, 26 Crockford chars) into a u32 PRNG seed. Determinism
/// is all we need (spec §4) — collisions are harmless since the seed only
/// drives `iter_random` reproducibility within a single run.
fn fold_seed(run_id: &str) -> u32 {
    // FNV-1a over the id bytes.
    let mut h: u32 = 0x811C_9DC5;
    for byte in run_id.as_bytes() {
        h ^= *byte as u32;
        h = h.wrapping_mul(0x0100_0193);
    }
    h
}

fn to_response(r: runs::RunRow) -> RunResponse {
    RunResponse {
        id: r.id,
        scenario_id: r.scenario_id,
        scenario_yaml: r.scenario_yaml,
        status: r.status,
        profile: r.profile,
        env: r.env,
        started_at: r.started_at,
        ended_at: r.ended_at,
        created_at: r.created_at,
        message: r.message,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app::AppState;
    use crate::binding::{BindingPolicy, DataBinding};
    use crate::grpc::coordinator::CoordinatorState;
    use crate::store::runs::Profile;
    use std::sync::Arc;

    #[test]
    fn validates_loop_breakdown_cap_bounds() {
        assert!(super::loop_cap_ok(0)); // off allowed
        assert!(super::loop_cap_ok(256));
        assert!(super::loop_cap_ok(10_000));
        assert!(!super::loop_cap_ok(10_001)); // over cap rejected
    }

    #[test]
    fn fold_seed_is_deterministic_and_varies() {
        assert_eq!(
            super::fold_seed("01HX0000000000000000000001"),
            super::fold_seed("01HX0000000000000000000001")
        );
        assert_ne!(
            super::fold_seed("01HX0000000000000000000001"),
            super::fold_seed("01HX0000000000000000000002")
        );
    }

    async fn state_with(db: crate::store::Db, capacity: u32) -> AppState {
        AppState {
            db: db.clone(),
            coord: CoordinatorState::with_capacity(db, capacity),
            dispatcher: Arc::new(crate::dispatcher::subprocess::SubprocessDispatcher::new(
                "worker".to_string(),
                "127.0.0.1:1".parse().unwrap(),
            )),
            ui_dir: None,
            dataset_max_rows: 1_000_000,
        }
    }

    fn unique_profile(dataset_id: String, vus: u32) -> Profile {
        Profile {
            vus,
            ramp_up_seconds: 0,
            duration_seconds: 1,
            loop_breakdown_cap: 256,
            data_binding: Some(DataBinding {
                dataset_id,
                policy: BindingPolicy::Unique,
                mappings: vec![],
            }),
            criteria: None,
        }
    }

    #[tokio::test]
    async fn unique_rejected_when_rows_below_worker_count() {
        let db = crate::store::connect("sqlite::memory:").await.unwrap();
        // 1 row; capacity 1 + vus 2 → N = 2; rows 1 < 2 → reject.
        let dataset_id = crate::store::datasets::insert(
            &db,
            "d",
            &["c".to_string()],
            &[vec!["a".to_string()]],
            0,
        )
        .await
        .unwrap();
        let state = state_with(db, 1).await;
        let err = validate_run_config(&state, &unique_profile(dataset_id, 2))
            .await
            .unwrap_err();
        assert!(
            matches!(err, ApiError::BadRequest(_)),
            "rows < N must reject"
        );
    }

    #[tokio::test]
    async fn unique_accepted_when_rows_meet_worker_count() {
        let db = crate::store::connect("sqlite::memory:").await.unwrap();
        // 2 rows; capacity 1 + vus 2 → N = 2; rows 2 >= 2 → Ok(Some(meta)).
        let dataset_id = crate::store::datasets::insert(
            &db,
            "d",
            &["c".to_string()],
            &[vec!["a".to_string()], vec!["b".to_string()]],
            0,
        )
        .await
        .unwrap();
        let state = state_with(db, 1).await;
        let meta = validate_run_config(&state, &unique_profile(dataset_id, 2))
            .await
            .unwrap();
        assert!(
            meta.is_some(),
            "valid unique binding returns the dataset meta"
        );
    }
}
