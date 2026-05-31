use std::collections::HashMap;

use axum::Json;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use serde::{Deserialize, Serialize};

use crate::app::AppState;
use crate::error::ApiError;
use crate::store::presets;
use crate::store::runs::Profile;
use crate::store::scenarios;

#[derive(Debug, Deserialize)]
pub struct PresetBody {
    pub name: String,
    pub profile: Profile,
    #[serde(default)]
    pub env: HashMap<String, String>,
}

#[derive(Debug, Serialize)]
pub struct PresetResponse {
    pub id: String,
    pub scenario_id: String,
    pub name: String,
    pub profile: Profile,
    pub env: serde_json::Value,
    pub created_at: i64,
    pub updated_at: i64,
}

/// Lightweight list row (no profile/env body — the dropdown only needs these).
#[derive(Debug, Serialize)]
pub struct PresetSummary {
    pub id: String,
    pub name: String,
    pub vus: u32,
    pub duration_seconds: u32,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Serialize)]
pub struct PresetListResponse {
    pub presets: Vec<PresetSummary>,
}

fn to_response(r: presets::PresetRow) -> PresetResponse {
    PresetResponse {
        id: r.id,
        scenario_id: r.scenario_id,
        name: r.name,
        profile: r.profile,
        env: r.env,
        created_at: r.created_at,
        updated_at: r.updated_at,
    }
}

/// Map a UNIQUE(scenario_id,name) violation to a 409; anything else is a 500.
fn map_db_err(e: sqlx::Error) -> ApiError {
    if e.as_database_error()
        .map(|d| d.is_unique_violation())
        .unwrap_or(false)
    {
        return ApiError::Conflict("같은 이름의 프리셋이 이미 있습니다".into());
    }
    ApiError::from(e)
}

pub async fn create(
    State(state): State<AppState>,
    Path(scenario_id): Path<String>,
    Json(body): Json<PresetBody>,
) -> Result<(StatusCode, Json<PresetResponse>), ApiError> {
    scenarios::get(&state.db, &scenario_id)
        .await?
        .ok_or(ApiError::NotFound)?;
    let name = body.name.trim();
    if name.is_empty() {
        return Err(ApiError::BadRequest("이름은 비어 있을 수 없습니다".into()));
    }
    crate::api::runs::validate_run_config(&state, &body.profile).await?;
    let env_value = serde_json::to_value(&body.env).expect("env map serializes to a JSON object");
    let row = presets::insert(&state.db, &scenario_id, name, &body.profile, &env_value)
        .await
        .map_err(map_db_err)?;
    Ok((StatusCode::CREATED, Json(to_response(row))))
}

pub async fn list(
    State(state): State<AppState>,
    Path(scenario_id): Path<String>,
) -> Result<Json<PresetListResponse>, ApiError> {
    scenarios::get(&state.db, &scenario_id)
        .await?
        .ok_or(ApiError::NotFound)?;
    let rows = presets::list_by_scenario(&state.db, &scenario_id).await?;
    let preset_summaries = rows
        .into_iter()
        .map(|r| PresetSummary {
            id: r.id,
            name: r.name,
            vus: r.profile.vus,
            duration_seconds: r.profile.duration_seconds,
            created_at: r.created_at,
            updated_at: r.updated_at,
        })
        .collect();
    Ok(Json(PresetListResponse {
        presets: preset_summaries,
    }))
}

pub async fn get(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<PresetResponse>, ApiError> {
    let row = presets::get(&state.db, &id)
        .await?
        .ok_or(ApiError::NotFound)?;
    Ok(Json(to_response(row)))
}

pub async fn update(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(body): Json<PresetBody>,
) -> Result<Json<PresetResponse>, ApiError> {
    let name = body.name.trim();
    if name.is_empty() {
        return Err(ApiError::BadRequest("이름은 비어 있을 수 없습니다".into()));
    }
    crate::api::runs::validate_run_config(&state, &body.profile).await?;
    let env_value = serde_json::to_value(&body.env).expect("env map serializes to a JSON object");
    let row = presets::update(&state.db, &id, name, &body.profile, &env_value)
        .await
        .map_err(map_db_err)?
        .ok_or(ApiError::NotFound)?;
    Ok(Json(to_response(row)))
}

pub async fn delete(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<StatusCode, ApiError> {
    presets::delete(&state.db, &id).await?;
    Ok(StatusCode::NO_CONTENT)
}
