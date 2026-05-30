use axum::Json;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use serde::{Deserialize, Serialize};

use crate::app::AppState;
use crate::error::ApiError;
use crate::store::runs::{self, Profile, RunStatus};
use crate::store::scenarios;

#[derive(Debug, Deserialize)]
pub struct CreateRunRequest {
    pub scenario_id: String,
    pub profile: Profile,
    #[serde(default)]
    pub env: serde_json::Value,
}

#[derive(Debug, Serialize)]
pub struct RunResponse {
    pub id: String,
    pub scenario_id: String,
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

pub async fn create(
    State(state): State<AppState>,
    Json(body): Json<CreateRunRequest>,
) -> Result<(StatusCode, Json<RunResponse>), ApiError> {
    let scenario = scenarios::get(&state.db, &body.scenario_id)
        .await?
        .ok_or(ApiError::NotFound)?;
    if body.profile.vus == 0 || body.profile.duration_seconds == 0 {
        return Err(ApiError::BadRequest(
            "vus and duration_seconds must be > 0".into(),
        ));
    }
    if !loop_cap_ok(body.profile.loop_breakdown_cap) {
        return Err(ApiError::BadRequest(
            "loop_breakdown_cap must be <= 10000 (0 disables breakdown)".into(),
        ));
    }

    // Data-binding validation gate (spec §11). `unique` is reserved for a later slice.
    if let Some(b) = &body.profile.data_binding {
        use crate::binding::BindingPolicy;
        if matches!(b.policy, BindingPolicy::Unique) {
            return Err(ApiError::BadRequest(
                "unique 정책은 아직 지원하지 않습니다 (다음 슬라이스)".into(),
            ));
        }
        let meta = crate::store::datasets::get_meta(&state.db, &b.dataset_id)
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
        // per-iteration policies stream the whole dataset → cap.
        // per_vu is sliced to min(vus, rows) so it is never capped (spec §11).
        let per_iteration = matches!(
            b.policy,
            BindingPolicy::IterSequential | BindingPolicy::IterRandom
        );
        if per_iteration && (meta.row_count as u64) > state.dataset_max_rows {
            return Err(ApiError::BadRequest(format!(
                "per-iteration 바인딩 행 수 {}가 상한 {}을 초과합니다",
                meta.row_count, state.dataset_max_rows
            )));
        }
    }

    let row = runs::insert(
        &state.db,
        &scenario.id,
        &scenario.yaml,
        &body.profile,
        &body.env,
    )
    .await?;

    // Parse env_json to HashMap<String,String> for the proto assignment.
    // Non-string values are silently dropped (ADR-0014: env vars are always strings).
    let env: std::collections::HashMap<String, String> =
        serde_json::from_value::<serde_json::Map<String, serde_json::Value>>(body.env.clone())
            .unwrap_or_default()
            .into_iter()
            .filter_map(|(k, v)| v.as_str().map(|s| (k, s.to_string())))
            .collect();

    // Enqueue the assignment so the coordinator can hand it to the worker when it registers.
    let assignment = crate::grpc::coordinator::PendingAssignment {
        scenario_yaml: scenario.yaml.clone(),
        profile: handicap_proto::v1::Profile {
            vus: body.profile.vus,
            ramp_up_seconds: body.profile.ramp_up_seconds,
            duration_seconds: body.profile.duration_seconds,
            loop_breakdown_cap: body.profile.loop_breakdown_cap,
        },
        env,
    };
    state.coord.enqueue(row.id.clone(), assignment).await;

    // Dispatch the worker (subprocess locally, K8s Job in prod). If this
    // fails we still return the run row; the run will be left in `pending`
    // and the operator can investigate.
    let worker_id = ulid::Ulid::new().to_string();
    if let Err(e) = state.dispatcher.dispatch(&row.id, &worker_id).await {
        tracing::warn!(run_id = %row.id, error = %e, "failed to dispatch worker");
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
    let scenario_yaml = row.scenario_yaml.clone();
    Ok(Json(crate::report::build_report(
        &row,
        &scenario_yaml,
        &rows,
        &loops,
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

fn to_response(r: runs::RunRow) -> RunResponse {
    RunResponse {
        id: r.id,
        scenario_id: r.scenario_id,
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
    #[test]
    fn validates_loop_breakdown_cap_bounds() {
        assert!(super::loop_cap_ok(0)); // off allowed
        assert!(super::loop_cap_ok(256));
        assert!(super::loop_cap_ok(10_000));
        assert!(!super::loop_cap_ok(10_001)); // over cap rejected
    }
}
