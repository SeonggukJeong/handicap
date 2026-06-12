use axum::Json;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use handicap_engine::{Scenario, Step};
use serde::{Deserialize, Serialize};

use crate::app::AppState;
use crate::error::ApiError;
use crate::store::scenarios;

/// Parallel branch names are the `(step_id, branch)` metric key of
/// `run_group_metrics`: an empty name aliases the branch's samples into the
/// page row (branch="" is the page key — silent count/distribution
/// contamination) and duplicate names silently merge into one BranchLatency
/// row. Mirrors the UI Zod gate exactly (`min(1)` — no trim — plus
/// exact-match uniqueness) so UI-authored scenarios can never be rejected
/// here. Recurses because the engine model allows free nesting even though
/// the UI gate keeps parallel top-level.
fn validate_parallel_branch_names(steps: &[Step]) -> Result<(), String> {
    for step in steps {
        match step {
            Step::Http(_) => {}
            Step::Loop(l) => validate_parallel_branch_names(&l.do_)?,
            Step::If(i) => {
                validate_parallel_branch_names(&i.then_)?;
                for e in &i.elif {
                    validate_parallel_branch_names(&e.then_)?;
                }
                validate_parallel_branch_names(&i.else_)?;
            }
            Step::Parallel(p) => {
                let mut seen = std::collections::HashSet::new();
                for b in &p.branches {
                    if b.name.is_empty() {
                        return Err(format!(
                            "parallel step \"{}\": branch name required",
                            p.name
                        ));
                    }
                    if !seen.insert(b.name.as_str()) {
                        return Err(format!(
                            "parallel step \"{}\": duplicate branch name \"{}\"",
                            p.name, b.name
                        ));
                    }
                    validate_parallel_branch_names(&b.steps)?;
                }
            }
        }
    }
    Ok(())
}

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
    validate_parallel_branch_names(&parsed.steps).map_err(ApiError::BadRequest)?;
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
    validate_parallel_branch_names(&parsed.steps).map_err(ApiError::BadRequest)?;
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
