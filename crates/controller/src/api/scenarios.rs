use axum::Json;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use handicap_engine::Scenario;
use serde::{Deserialize, Serialize};

use crate::app::AppState;
use crate::error::ApiError;
use crate::store::scenarios;

#[derive(Debug, Deserialize)]
pub struct CreateRequest {
    pub yaml: String,
}

#[derive(Debug, Serialize)]
pub struct ScenarioResponse {
    pub id: String,
    pub name: String,
    pub yaml: String,
    pub version: i64,
    pub created_at: i64,
    pub updated_at: i64,
}

pub async fn create(
    State(state): State<AppState>,
    Json(body): Json<CreateRequest>,
) -> Result<(StatusCode, Json<ScenarioResponse>), ApiError> {
    let parsed = Scenario::from_yaml(&body.yaml)?;
    let row = scenarios::insert(&state.db, &parsed, &body.yaml).await?;
    Ok((
        StatusCode::CREATED,
        Json(ScenarioResponse {
            id: row.id,
            name: row.name,
            yaml: row.yaml,
            version: row.version,
            created_at: row.created_at,
            updated_at: row.updated_at,
        }),
    ))
}

pub async fn get(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<ScenarioResponse>, ApiError> {
    let row = scenarios::get(&state.db, &id)
        .await?
        .ok_or(ApiError::NotFound)?;
    Ok(Json(ScenarioResponse {
        id: row.id,
        name: row.name,
        yaml: row.yaml,
        version: row.version,
        created_at: row.created_at,
        updated_at: row.updated_at,
    }))
}

#[derive(Debug, Serialize)]
pub struct ScenarioListResponse {
    pub scenarios: Vec<ScenarioResponse>,
}

#[derive(Debug, Deserialize)]
pub struct UpdateRequest {
    pub yaml: String,
    pub version: i64,
}

pub async fn list(State(state): State<AppState>) -> Result<Json<ScenarioListResponse>, ApiError> {
    let rows = scenarios::list(&state.db).await?;
    Ok(Json(ScenarioListResponse {
        scenarios: rows
            .into_iter()
            .map(|r| ScenarioResponse {
                id: r.id,
                name: r.name,
                yaml: r.yaml,
                version: r.version,
                created_at: r.created_at,
                updated_at: r.updated_at,
            })
            .collect(),
    }))
}

pub async fn update(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(body): Json<UpdateRequest>,
) -> Result<Json<ScenarioResponse>, ApiError> {
    let parsed = Scenario::from_yaml(&body.yaml)?;
    let outcome = scenarios::update(&state.db, &id, &parsed.name, &body.yaml, body.version).await?;
    match outcome {
        scenarios::UpdateOutcome::Updated(row) => Ok(Json(ScenarioResponse {
            id: row.id,
            name: row.name,
            yaml: row.yaml,
            version: row.version,
            created_at: row.created_at,
            updated_at: row.updated_at,
        })),
        scenarios::UpdateOutcome::NotFound => Err(ApiError::NotFound),
        scenarios::UpdateOutcome::VersionMismatch { current } => Err(ApiError::Conflict(format!(
            "stale version: client sent {}, current is {}",
            body.version, current
        ))),
    }
}
