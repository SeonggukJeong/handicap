use axum::Json;
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use handicap_engine::{Scenario, Step, ThinkTime};
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

/// True when the think-time range is well-formed: `min <= max <= 600_000` (10 min).
/// Single source of truth shared by scenario/step validation (below) and the
/// run-level check (`api/runs.rs`), mirroring the UI Zod `ThinkTimeModel` rule.
pub(crate) fn think_time_in_range(tt: &ThinkTime) -> bool {
    tt.min_ms <= tt.max_ms && tt.max_ms <= 600_000
}

/// Validate the scenario's root `default_think_time` and every step's
/// `think_time` (recursing loop/if/parallel — the engine allows free nesting,
/// and a parallel branch step's *explicit* think still degrades if out of range,
/// so no step is exempt). Mirrors `validate_parallel_branch_names`' exhaustive walk.
pub(crate) fn validate_scenario_think_times(
    steps: &[Step],
    default: &Option<ThinkTime>,
) -> Result<(), String> {
    if let Some(tt) = default {
        if !think_time_in_range(tt) {
            return Err(
                "시나리오 기본 think time(default_think_time): min_ms <= max_ms <= 600000 (10분) 이어야 합니다"
                    .into(),
            );
        }
    }
    validate_steps_think(steps)
}

fn validate_steps_think(steps: &[Step]) -> Result<(), String> {
    for step in steps {
        match step {
            Step::Http(h) => {
                if let Some(tt) = &h.think_time {
                    if !think_time_in_range(tt) {
                        return Err(format!(
                            "스텝 \"{}\"의 think_time: min_ms <= max_ms <= 600000 (10분) 이어야 합니다",
                            h.name
                        ));
                    }
                }
            }
            Step::Loop(l) => validate_steps_think(&l.do_)?,
            Step::If(i) => {
                validate_steps_think(&i.then_)?;
                for e in &i.elif {
                    validate_steps_think(&e.then_)?;
                }
                validate_steps_think(&i.else_)?;
            }
            Step::Parallel(p) => {
                for b in &p.branches {
                    validate_steps_think(&b.steps)?;
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
    validate_scenario_think_times(&parsed.steps, &parsed.default_think_time)
        .map_err(ApiError::BadRequest)?;
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
    validate_scenario_think_times(&parsed.steps, &parsed.default_think_time)
        .map_err(ApiError::BadRequest)?;
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

#[cfg(test)]
mod think_validation_tests {
    use super::*;
    use handicap_engine::Scenario;

    fn scn(yaml: &str) -> Scenario {
        Scenario::from_yaml(yaml).expect("valid yaml")
    }

    // ULID chars exclude I/L/O/U — use "01HX00000000000000000000AA"-style valid ids.
    const HTTP: &str = r#"
version: 1
name: t
steps:
  - id: 01HX0000000000000000000AAA
    type: http
    name: s1
    request:
      method: GET
      url: http://x/
"#;

    #[test]
    fn rejects_default_min_gt_max() {
        let mut s = scn(HTTP);
        s.default_think_time = Some(handicap_engine::ThinkTime {
            min_ms: 5000,
            max_ms: 100,
        });
        assert!(validate_scenario_think_times(&s.steps, &s.default_think_time).is_err());
    }

    #[test]
    fn rejects_default_max_over_600000() {
        let mut s = scn(HTTP);
        s.default_think_time = Some(handicap_engine::ThinkTime {
            min_ms: 0,
            max_ms: 700_000,
        });
        assert!(validate_scenario_think_times(&s.steps, &s.default_think_time).is_err());
    }

    #[test]
    fn rejects_step_think_out_of_range_nested() {
        // step think inside a loop → walk must reach it and its name appears in the error.
        let yaml = r#"
version: 1
name: t
steps:
  - id: 01HX0000000000000000000P02
    type: loop
    name: L
    repeat: 2
    do:
      - id: 01HX0000000000000000000B01
        type: http
        name: innerstep
        request: { method: GET, url: http://x/ }
        think_time: { min_ms: 900000, max_ms: 900000 }
"#;
        let s = scn(yaml);
        let err = validate_scenario_think_times(&s.steps, &s.default_think_time).unwrap_err();
        assert!(
            err.contains("innerstep"),
            "error should name the step: {err}"
        );
    }

    #[test]
    fn accepts_in_range_and_absent() {
        let s = scn(HTTP);
        assert!(validate_scenario_think_times(&s.steps, &s.default_think_time).is_ok()); // absent
        let mut s2 = scn(HTTP);
        s2.default_think_time = Some(handicap_engine::ThinkTime {
            min_ms: 100,
            max_ms: 500,
        });
        assert!(validate_scenario_think_times(&s2.steps, &s2.default_think_time).is_ok());
    }

    #[test]
    fn predicate_matches_run_level_condition() {
        // byte-identical to the pre-existing run-level rule (min>max || max>600000).
        assert!(think_time_in_range(&handicap_engine::ThinkTime {
            min_ms: 0,
            max_ms: 600_000
        }));
        assert!(!think_time_in_range(&handicap_engine::ThinkTime {
            min_ms: 1,
            max_ms: 0
        }));
        assert!(!think_time_in_range(&handicap_engine::ThinkTime {
            min_ms: 0,
            max_ms: 600_001
        }));
    }
}
