use std::collections::BTreeMap;

use axum::Json;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use serde::{Deserialize, Serialize};

use crate::app::AppState;
use crate::error::ApiError;
use crate::store::environments;

#[derive(Debug, Deserialize)]
pub struct EnvironmentBody {
    pub name: String,
    #[serde(default)]
    pub vars: BTreeMap<String, String>,
}

#[derive(Debug, Serialize)]
pub struct EnvironmentResponse {
    pub id: String,
    pub name: String,
    pub vars: BTreeMap<String, String>,
    pub created_at: i64,
    pub updated_at: i64,
}

/// Lightweight list row (no vars body — the dropdown/list only needs these).
#[derive(Debug, Serialize)]
pub struct EnvironmentSummary {
    pub id: String,
    pub name: String,
    pub var_count: usize,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Serialize)]
pub struct EnvironmentListResponse {
    pub environments: Vec<EnvironmentSummary>,
}

fn to_response(r: environments::EnvironmentRow) -> EnvironmentResponse {
    EnvironmentResponse {
        id: r.id,
        name: r.name,
        vars: r.vars,
        created_at: r.created_at,
        updated_at: r.updated_at,
    }
}

/// Map a UNIQUE(name) violation to a 409; anything else is a 500. Mirrors
/// api/presets.rs::map_db_err.
fn map_db_err(e: sqlx::Error) -> ApiError {
    if e.as_database_error()
        .map(|d| d.is_unique_violation())
        .unwrap_or(false)
    {
        return ApiError::Conflict("같은 이름의 환경이 이미 있습니다".into());
    }
    ApiError::from(e)
}

/// Validate a (name, vars) body. Name must be non-empty after trim. Var keys must
/// be usable as `${KEY}` env references: non-empty, and free of whitespace, `}`,
/// and `:`. The `:` ban is a conservative guard against the `:-` default separator
/// the engine's template.rs splits on (spec §5) — a bare `:` is wider than strictly
/// needed but keeps the rule simple. Reserved system-var names
/// (vu_id/iter_id/loop_index) are NOT rejected here — the engine resolves them to
/// system values regardless, so the UI surfaces a soft warning instead.
fn validate_env(name: &str, vars: &BTreeMap<String, String>) -> Result<(), ApiError> {
    if name.trim().is_empty() {
        return Err(ApiError::BadRequest("이름은 비어 있을 수 없습니다".into()));
    }
    for key in vars.keys() {
        let k = key.trim();
        if k.is_empty() {
            return Err(ApiError::BadRequest(
                "변수 이름은 비어 있을 수 없습니다".into(),
            ));
        }
        if k.chars().any(|c| c.is_whitespace() || c == '}' || c == ':') {
            return Err(ApiError::BadRequest(format!(
                "변수 이름 '{key}'에 공백·중괄호·콜론은 쓸 수 없습니다"
            )));
        }
    }
    Ok(())
}

pub async fn create(
    State(state): State<AppState>,
    Json(body): Json<EnvironmentBody>,
) -> Result<(StatusCode, Json<EnvironmentResponse>), ApiError> {
    validate_env(&body.name, &body.vars)?;
    let row = environments::insert(&state.db, body.name.trim(), &body.vars)
        .await
        .map_err(map_db_err)?;
    Ok((StatusCode::CREATED, Json(to_response(row))))
}

pub async fn list(
    State(state): State<AppState>,
) -> Result<Json<EnvironmentListResponse>, ApiError> {
    let rows = environments::list(&state.db).await?;
    let environments = rows
        .into_iter()
        .map(|r| EnvironmentSummary {
            id: r.id,
            name: r.name,
            var_count: r.vars.len(),
            created_at: r.created_at,
            updated_at: r.updated_at,
        })
        .collect();
    Ok(Json(EnvironmentListResponse { environments }))
}

pub async fn get(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<EnvironmentResponse>, ApiError> {
    let row = environments::get(&state.db, &id)
        .await?
        .ok_or(ApiError::NotFound)?;
    Ok(Json(to_response(row)))
}

pub async fn update(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(body): Json<EnvironmentBody>,
) -> Result<Json<EnvironmentResponse>, ApiError> {
    validate_env(&body.name, &body.vars)?;
    let row = environments::update(&state.db, &id, body.name.trim(), &body.vars)
        .await
        .map_err(map_db_err)?
        .ok_or(ApiError::NotFound)?;
    Ok(Json(to_response(row)))
}

pub async fn delete(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<StatusCode, ApiError> {
    environments::delete(&state.db, &id).await?;
    Ok(StatusCode::NO_CONTENT)
}
