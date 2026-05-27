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
    let row = runs::insert(
        &state.db,
        &scenario.id,
        &scenario.yaml,
        &body.profile,
        &body.env,
    )
    .await?;

    // Enqueue the assignment so the coordinator can hand it to the worker when it registers.
    let assignment = crate::grpc::coordinator::PendingAssignment {
        scenario_yaml: scenario.yaml.clone(),
        profile: handicap_proto::v1::Profile {
            vus: body.profile.vus,
            ramp_up_seconds: body.profile.ramp_up_seconds,
            duration_seconds: body.profile.duration_seconds,
        },
    };
    state.coord.enqueue(row.id.clone(), assignment).await;

    // Spawn the worker subprocess. If this fails we still return the run row;
    // the run will be left in `pending` and the operator can investigate.
    if let Err(e) =
        crate::worker_proc::spawn_worker(&state.worker_bin, state.grpc_addr, &row.id).await
    {
        tracing::warn!(run_id = %row.id, error = %e, "failed to spawn worker");
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
    }
}
