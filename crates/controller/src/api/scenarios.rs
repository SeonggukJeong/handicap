use axum::Json;
use axum::extract::{Path, Query, State};
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

const ACTIVE_RUN_DELETE_MSG: &str =
    "이 시나리오의 실행 중(pending/running) run이 있어 삭제할 수 없습니다";

#[derive(Debug, Deserialize)]
pub struct DeleteQuery {
    #[serde(default)]
    pub force: bool,
}

/// DELETE /api/scenarios/{id}?force=
/// - 활성(pending/running) run 참조 → hard 409 (force로도 못 지움). 핸들러 체크는
///   advisory fast-fail — 권위 판정은 delete_cascade 트랜잭션 안(spec §3-5).
/// - 그 외 참조(run 이력·프리셋·스케줄) + force=false → soft 409 + 카운트 JSON.
/// - force=true → 참조 그래프 전체 cascade 삭제(ADR-0045) 후 204.
pub async fn delete(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Query(q): Query<DeleteQuery>,
) -> Result<StatusCode, ApiError> {
    if scenarios::get(&state.db, &id).await?.is_none() {
        return Err(ApiError::NotFound);
    }
    let (run_total, run_active) = crate::store::runs::count_by_scenario(&state.db, &id).await?;
    if run_active > 0 {
        return Err(ApiError::Conflict(ACTIVE_RUN_DELETE_MSG.into()));
    }
    let presets = crate::store::presets::count_by_scenario(&state.db, &id).await?;
    let schedules = crate::store::schedules::count_by_scenario(&state.db, &id).await?;
    if !q.force && (run_total + presets + schedules) > 0 {
        return Err(ApiError::ConflictJson(serde_json::json!({
            "error": "이 시나리오를 참조하는 데이터가 있습니다 — force=true로 함께 삭제할 수 있습니다",
            "runs": run_total,
            "presets": presets,
            "schedules": schedules,
        })));
    }
    match scenarios::delete_cascade(&state.db, &id).await? {
        scenarios::DeleteOutcome::Deleted => Ok(StatusCode::NO_CONTENT),
        scenarios::DeleteOutcome::ActiveRuns => {
            Err(ApiError::Conflict(ACTIVE_RUN_DELETE_MSG.into()))
        }
    }
}
