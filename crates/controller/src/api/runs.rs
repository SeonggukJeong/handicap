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

/// run-level criteria 검증(spec §7). DB 불필요 — 순수. 위반은 BadRequest 메시지.
pub(crate) fn validate_criteria(c: &crate::store::runs::Criteria) -> Result<(), String> {
    if let Some(r) = c.max_error_rate {
        if !r.is_finite() || !(0.0..=1.0).contains(&r) {
            return Err("criteria.max_error_rate must be between 0.0 and 1.0".into());
        }
    }
    if let Some(r) = c.min_rps {
        if !r.is_finite() || r < 0.0 {
            return Err("criteria.min_rps must be >= 0".into());
        }
    }
    Ok(())
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
    // ── open-loop (S-C fixed-rate / S-D stages curve): is_open_loop switches the model ──
    if profile.is_open_loop() {
        // max_in_flight required + range (both fixed & curve)
        match profile.max_in_flight {
            None => {
                return Err(ApiError::BadRequest(
                    if profile.stages.as_ref().is_some_and(|s| !s.is_empty()) {
                        "stages(레이트 곡선)은 max_in_flight가 필요합니다 (closed-loop stages는 아직 미지원)".into()
                    } else {
                        "open-loop(target_rps)은 max_in_flight가 필요합니다".into()
                    },
                ));
            }
            Some(m) if m == 0 || m > 10_000 => {
                return Err(ApiError::BadRequest(
                    "max_in_flight must be between 1 and 10000".into(),
                ));
            }
            _ => {}
        }
        // knob conflicts shared by both open-loop sub-modes
        if profile.ramp_up_seconds > 0 {
            return Err(ApiError::BadRequest(
                "open-loop에선 ramp_up_seconds를 쓸 수 없습니다 (RPS 곡선은 S-D stages)".into(),
            ));
        }
        if profile.think_time.is_some() {
            return Err(ApiError::BadRequest(
                "open-loop에선 run-level think_time을 쓸 수 없습니다 (closed-loop 전용)".into(),
            ));
        }
        match &profile.stages {
            Some(stages) if !stages.is_empty() => {
                // ── curve mode (S-D) ──
                if profile.target_rps.is_some() {
                    return Err(ApiError::BadRequest(
                        "stages와 target_rps는 함께 쓸 수 없습니다 (레이트 지정 방식 충돌)".into(),
                    ));
                }
                if profile.duration_seconds > 0 {
                    return Err(ApiError::BadRequest(
                        "stages 사용 시 duration_seconds를 비워야 합니다 (총 길이 = stage 합)"
                            .into(),
                    ));
                }
                for s in stages {
                    if s.target > 1_000_000 {
                        return Err(ApiError::BadRequest(
                            "stage target must be between 0 and 1000000".into(),
                        ));
                    }
                    if s.duration_seconds == 0 {
                        return Err(ApiError::BadRequest(
                            "stage duration_seconds must be >= 1".into(),
                        ));
                    }
                }
                if !stages.iter().any(|s| s.target > 0) {
                    return Err(ApiError::BadRequest(
                        "최소 한 stage의 target은 0보다 커야 합니다".into(),
                    ));
                }
            }
            _ => {
                // ── fixed mode (S-C, unchanged) ──
                let rps = profile
                    .target_rps
                    .expect("is_open_loop && no stages ⟹ target_rps set");
                if rps == 0 || rps > 1_000_000 {
                    return Err(ApiError::BadRequest(
                        "target_rps must be between 1 and 1000000".into(),
                    ));
                }
                if profile.duration_seconds == 0 {
                    return Err(ApiError::BadRequest("duration_seconds must be > 0".into()));
                }
            }
        }
        // vus ignored in open-loop (slot pool = max_in_flight)
    } else if profile.vus == 0 || profile.duration_seconds == 0 {
        return Err(ApiError::BadRequest(
            "vus and duration_seconds must be > 0".into(),
        ));
    }
    if !loop_cap_ok(profile.loop_breakdown_cap) {
        return Err(ApiError::BadRequest(
            "loop_breakdown_cap must be <= 10000 (0 disables breakdown)".into(),
        ));
    }
    if profile.http_timeout_seconds == 0 || profile.http_timeout_seconds > 600 {
        return Err(ApiError::BadRequest(
            "http_timeout_seconds must be between 1 and 600".into(),
        ));
    }
    if let Some(tt) = &profile.think_time {
        if tt.min_ms > tt.max_ms || tt.max_ms > 600_000 {
            return Err(ApiError::BadRequest(
                "think_time: min_ms <= max_ms <= 600000 (10분) 이어야 합니다".into(),
            ));
        }
    }
    if let Some(c) = &profile.criteria {
        validate_criteria(c).map_err(ApiError::BadRequest)?;
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
        let n = if profile.is_open_loop() {
            1
        } else {
            state.coord.worker_count_for(profile.vus)
        };
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
                BindingPolicy::PerVu => {
                    // closed-loop: one row per VU (≤ vus rows); open-loop: one row per
                    // slot (≤ max_in_flight rows — slot index is the per_vu key, spec §4).
                    let slot_count = if body.profile.is_open_loop() {
                        body.profile.max_in_flight.unwrap_or(0) as u64
                    } else {
                        body.profile.vus as u64
                    };
                    (
                        handicap_proto::v1::data_binding::Policy::PerVu,
                        slot_count.min(meta.row_count as u64),
                    )
                }
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
            http_timeout_seconds: body.profile.http_timeout_seconds,
            think_time: body
                .profile
                .think_time
                .map(|t| handicap_proto::v1::ThinkTime {
                    min_ms: t.min_ms,
                    max_ms: t.max_ms,
                }),
            think_seed: body.profile.think_seed,
            target_rps: body.profile.target_rps,
            max_in_flight: body.profile.max_in_flight,
            stages: body
                .profile
                .stages
                .as_deref()
                .unwrap_or_default()
                .iter()
                .map(|s| handicap_proto::v1::Stage {
                    target: s.target,
                    duration_seconds: s.duration_seconds,
                })
                .collect(),
        },
        env: body.env.clone(),
        data_binding,
    };
    let n = if body.profile.is_open_loop() {
        1 // open-loop is single-worker in v1 (fan-out deferred — spec §9)
    } else {
        state.coord.worker_count_for(body.profile.vus)
    };
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

/// Fetch a run's metrics and build its full report. Shared by the `report`
/// JSON handler, single-run export, and N-run comparison export. Returns
/// `NotFound` if the run id doesn't exist.
pub async fn build_report_for_run(
    db: &crate::store::Db,
    run_id: &str,
) -> Result<crate::report::ReportJson, ApiError> {
    let row = runs::get(db, run_id).await?.ok_or(ApiError::NotFound)?;
    let rows = crate::store::metrics::windows_with_hdr(db, run_id).await?;
    let loops = crate::store::metrics::loop_breakdown(db, run_id).await?;
    let branches = crate::store::metrics::if_breakdown(db, run_id).await?;
    let scenario_yaml = row.scenario_yaml.clone();
    Ok(crate::report::build_report(
        &row,
        &scenario_yaml,
        &rows,
        &loops,
        &branches,
    ))
}

pub async fn report(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<crate::report::ReportJson>, ApiError> {
    Ok(Json(build_report_for_run(&state.db, &id).await?))
}

fn file_response(content_type: &str, filename: &str, bytes: Vec<u8>) -> axum::response::Response {
    use axum::http::header;
    axum::response::Response::builder()
        .header(header::CONTENT_TYPE, content_type)
        .header(
            header::CONTENT_DISPOSITION,
            format!("attachment; filename=\"{filename}\""),
        )
        .body(axum::body::Body::from(bytes))
        .expect("valid file response")
}

fn ensure_terminal(row: &runs::RunRow) -> Result<(), ApiError> {
    match row.status {
        RunStatus::Completed | RunStatus::Failed | RunStatus::Aborted => Ok(()),
        _ => Err(ApiError::BadRequest(
            "run is not finished; export is available after a run completes".into(),
        )),
    }
}

pub async fn report_csv(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<axum::response::Response, ApiError> {
    let row = runs::get(&state.db, &id).await?.ok_or(ApiError::NotFound)?;
    ensure_terminal(&row)?;
    let report = build_report_for_run(&state.db, &id).await?;
    let bytes = crate::export::report_to_csv(&report);
    Ok(file_response(
        "text/csv; charset=utf-8",
        &format!("run-{id}-report.csv"),
        bytes,
    ))
}

pub async fn report_xlsx(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<axum::response::Response, ApiError> {
    let row = runs::get(&state.db, &id).await?.ok_or(ApiError::NotFound)?;
    ensure_terminal(&row)?;
    let report = build_report_for_run(&state.db, &id).await?;
    let bytes = crate::export::report_to_xlsx(&report);
    Ok(file_response(
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        &format!("run-{id}-report.xlsx"),
        bytes,
    ))
}

#[derive(serde::Deserialize)]
pub struct CompareParams {
    pub run_ids: String,
    pub baseline: String,
}

const MAX_COMPARE_RUNS: usize = 50;

/// Validate and load the comparison set. `run_ids` is comma-separated, order
/// preserved. Returns `(reports, baseline_idx)` where `baseline_idx` is the
/// position of `params.baseline` in the ordered list.
async fn resolve_comparison(
    state: &AppState,
    scenario_id: &str,
    params: &CompareParams,
) -> Result<(Vec<crate::report::ReportJson>, usize), ApiError> {
    let _ = scenarios::get(&state.db, scenario_id)
        .await?
        .ok_or(ApiError::NotFound)?;
    let ids: Vec<String> = params
        .run_ids
        .split(',')
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect();
    if ids.len() < 2 {
        return Err(ApiError::BadRequest(
            "comparison needs at least 2 runs".into(),
        ));
    }
    if ids.len() > MAX_COMPARE_RUNS {
        return Err(ApiError::BadRequest(format!(
            "at most {MAX_COMPARE_RUNS} runs"
        )));
    }
    let baseline_idx = ids
        .iter()
        .position(|id| id == &params.baseline)
        .ok_or_else(|| ApiError::BadRequest("baseline must be one of run_ids".into()))?;
    let mut reports = Vec::with_capacity(ids.len());
    for id in &ids {
        let row = runs::get(&state.db, id).await?.ok_or(ApiError::NotFound)?;
        if row.scenario_id != scenario_id {
            return Err(ApiError::BadRequest(format!(
                "run {id} is not in this scenario"
            )));
        }
        ensure_terminal(&row)?;
        reports.push(build_report_for_run(&state.db, id).await?);
    }
    Ok((reports, baseline_idx))
}

pub async fn compare_csv(
    State(state): State<AppState>,
    Path(scenario_id): Path<String>,
    axum::extract::Query(params): axum::extract::Query<CompareParams>,
) -> Result<axum::response::Response, ApiError> {
    let (reports, base) = resolve_comparison(&state, &scenario_id, &params).await?;
    let bytes = crate::export::comparison_to_csv(&reports, base);
    Ok(file_response(
        "text/csv; charset=utf-8",
        "comparison.csv",
        bytes,
    ))
}

pub async fn compare_xlsx(
    State(state): State<AppState>,
    Path(scenario_id): Path<String>,
    axum::extract::Query(params): axum::extract::Query<CompareParams>,
) -> Result<axum::response::Response, ApiError> {
    let (reports, base) = resolve_comparison(&state, &scenario_id, &params).await?;
    let bytes = crate::export::comparison_to_xlsx(&reports, base);
    Ok(file_response(
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "comparison.xlsx",
        bytes,
    ))
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
            http_timeout_seconds: 30,
            data_binding: Some(DataBinding {
                dataset_id,
                policy: BindingPolicy::Unique,
                mappings: vec![],
            }),
            criteria: None,
            think_time: None,
            think_seed: None,
            target_rps: None,
            max_in_flight: None,
            stages: None,
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

    #[test]
    fn validate_criteria_accepts_valid_and_empty() {
        use crate::store::runs::Criteria;
        assert!(validate_criteria(&Criteria::default()).is_ok());
        assert!(
            validate_criteria(&Criteria {
                max_p95_ms: Some(500),
                max_error_rate: Some(0.01),
                min_rps: Some(100.0),
                ..Default::default()
            })
            .is_ok()
        );
    }

    #[test]
    fn validate_criteria_rejects_bad_error_rate() {
        use crate::store::runs::Criteria;
        assert!(
            validate_criteria(&Criteria {
                max_error_rate: Some(1.5),
                ..Default::default()
            })
            .is_err()
        );
        assert!(
            validate_criteria(&Criteria {
                max_error_rate: Some(f64::NAN),
                ..Default::default()
            })
            .is_err()
        );
    }

    #[test]
    fn validate_criteria_rejects_negative_rps() {
        use crate::store::runs::Criteria;
        assert!(
            validate_criteria(&Criteria {
                min_rps: Some(-1.0),
                ..Default::default()
            })
            .is_err()
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

    #[tokio::test]
    async fn rejects_out_of_range_http_timeout() {
        let db = crate::store::connect("sqlite::memory:").await.unwrap();
        let state = state_with(db, 1).await;
        let mut p = Profile {
            vus: 2,
            ramp_up_seconds: 0,
            duration_seconds: 5,
            loop_breakdown_cap: 256,
            data_binding: None,
            criteria: None,
            http_timeout_seconds: 0,
            think_time: None,
            think_seed: None,
            target_rps: None,
            max_in_flight: None,
            stages: None,
        };
        let err = validate_run_config(&state, &p).await.unwrap_err();
        assert!(matches!(err, ApiError::BadRequest(_)), "0 must be rejected");
        p.http_timeout_seconds = 601;
        let err = validate_run_config(&state, &p).await.unwrap_err();
        assert!(
            matches!(err, ApiError::BadRequest(_)),
            ">600 must be rejected"
        );
        // Inclusive boundaries must be accepted (guards against an off-by-one flip).
        p.http_timeout_seconds = 1;
        assert!(
            validate_run_config(&state, &p).await.is_ok(),
            "1 must be accepted"
        );
        p.http_timeout_seconds = 600;
        assert!(
            validate_run_config(&state, &p).await.is_ok(),
            "600 must be accepted"
        );
    }

    #[test]
    fn old_profile_json_without_http_timeout_defaults_to_30() {
        // profile_json rows persisted before S-A have no http_timeout_seconds key.
        let json = serde_json::json!({ "vus": 2, "duration_seconds": 5 });
        let p: Profile = serde_json::from_value(json).expect("deserializes with serde default");
        assert_eq!(p.http_timeout_seconds, 30);
    }

    fn think_profile(think_time: Option<handicap_engine::ThinkTime>) -> Profile {
        Profile {
            vus: 2,
            ramp_up_seconds: 0,
            duration_seconds: 5,
            loop_breakdown_cap: 256,
            http_timeout_seconds: 30,
            data_binding: None,
            criteria: None,
            think_time,
            think_seed: None,
            target_rps: None,
            max_in_flight: None,
            stages: None,
        }
    }

    #[tokio::test]
    async fn validate_rejects_think_time_min_gt_max() {
        let db = crate::store::connect("sqlite::memory:").await.unwrap();
        let state = state_with(db, 1).await;
        let p = think_profile(Some(handicap_engine::ThinkTime {
            min_ms: 500,
            max_ms: 100,
        }));
        let err = validate_run_config(&state, &p).await.unwrap_err();
        assert!(
            matches!(err, ApiError::BadRequest(_)),
            "min > max must be rejected"
        );
    }

    #[tokio::test]
    async fn validate_rejects_think_time_max_over_600000() {
        let db = crate::store::connect("sqlite::memory:").await.unwrap();
        let state = state_with(db, 1).await;
        let p = think_profile(Some(handicap_engine::ThinkTime {
            min_ms: 0,
            max_ms: 600_001,
        }));
        let err = validate_run_config(&state, &p).await.unwrap_err();
        assert!(
            matches!(err, ApiError::BadRequest(_)),
            "max > 600000 must be rejected"
        );
    }

    fn ol_profile() -> Profile {
        Profile {
            vus: 0,
            ramp_up_seconds: 0,
            duration_seconds: 10,
            loop_breakdown_cap: 256,
            http_timeout_seconds: 30,
            data_binding: None,
            criteria: None,
            think_time: None,
            think_seed: None,
            target_rps: Some(100),
            max_in_flight: Some(16),
            stages: None,
        }
    }

    #[tokio::test]
    async fn validate_open_loop_requires_max_in_flight_and_rejects_conflicts() {
        let db = crate::store::connect("sqlite::memory:").await.unwrap();
        let state = state_with(db, 2000).await;
        assert!(validate_run_config(&state, &ol_profile()).await.is_ok());

        let no_cap = Profile {
            max_in_flight: None,
            ..ol_profile()
        };
        assert!(validate_run_config(&state, &no_cap).await.is_err());

        let ramp = Profile {
            ramp_up_seconds: 5,
            ..ol_profile()
        };
        assert!(validate_run_config(&state, &ramp).await.is_err());

        let tt = Profile {
            think_time: Some(handicap_engine::ThinkTime {
                min_ms: 100,
                max_ms: 100,
            }),
            ..ol_profile()
        };
        assert!(validate_run_config(&state, &tt).await.is_err());

        let huge = Profile {
            max_in_flight: Some(10_001),
            ..ol_profile()
        };
        assert!(validate_run_config(&state, &huge).await.is_err());

        let bad_rps = Profile {
            target_rps: Some(0),
            ..ol_profile()
        };
        assert!(validate_run_config(&state, &bad_rps).await.is_err());

        let zero_dur = Profile {
            duration_seconds: 0,
            ..ol_profile()
        };
        assert!(validate_run_config(&state, &zero_dur).await.is_err());

        let rps_over = Profile {
            target_rps: Some(1_000_001),
            ..ol_profile()
        };
        assert!(validate_run_config(&state, &rps_over).await.is_err());

        let rps_max = Profile {
            target_rps: Some(1_000_000),
            ..ol_profile()
        };
        assert!(validate_run_config(&state, &rps_max).await.is_ok());
    }

    #[tokio::test]
    async fn validate_accepts_think_time_in_range_and_none() {
        let db = crate::store::connect("sqlite::memory:").await.unwrap();
        let state = state_with(db, 1).await;
        // In-range range accepted.
        let p = think_profile(Some(handicap_engine::ThinkTime {
            min_ms: 100,
            max_ms: 500,
        }));
        assert!(
            validate_run_config(&state, &p).await.is_ok(),
            "{{100,500}} must be accepted"
        );
        // Absent think_time accepted.
        let p = think_profile(None);
        assert!(
            validate_run_config(&state, &p).await.is_ok(),
            "None think_time must be accepted"
        );
        // Inclusive upper boundary accepted (guards off-by-one).
        let p = think_profile(Some(handicap_engine::ThinkTime {
            min_ms: 0,
            max_ms: 600_000,
        }));
        assert!(
            validate_run_config(&state, &p).await.is_ok(),
            "max == 600000 must be accepted"
        );
    }

    #[test]
    fn is_open_loop_predicate() {
        let mut p = Profile {
            target_rps: None,
            stages: None,
            ..ol_profile()
        };
        assert!(!p.is_open_loop());
        p.target_rps = Some(100);
        assert!(p.is_open_loop());
        p.target_rps = None;
        p.stages = Some(vec![]); // empty == absent
        assert!(!p.is_open_loop());
        p.stages = Some(vec![handicap_engine::Stage {
            target: 100,
            duration_seconds: 5,
        }]);
        assert!(p.is_open_loop());
    }

    #[tokio::test]
    async fn validate_stages_curve_rejects_conflicts_and_bounds() {
        let db = crate::store::connect("sqlite::memory:").await.unwrap();
        let state = state_with(db, 2000).await;
        let curve = || Profile {
            target_rps: None,
            vus: 0,
            duration_seconds: 0,
            max_in_flight: Some(50),
            stages: Some(vec![handicap_engine::Stage {
                target: 200,
                duration_seconds: 30,
            }]),
            ..ol_profile()
        };
        // valid: stages + max_in_flight only
        assert!(validate_run_config(&state, &curve()).await.is_ok());
        // stages + target_rps → conflict
        assert!(
            validate_run_config(
                &state,
                &Profile {
                    target_rps: Some(100),
                    ..curve()
                }
            )
            .await
            .is_err()
        );
        // stages + duration_seconds>0
        assert!(
            validate_run_config(
                &state,
                &Profile {
                    duration_seconds: 10,
                    ..curve()
                }
            )
            .await
            .is_err()
        );
        // stages + ramp_up_seconds>0
        assert!(
            validate_run_config(
                &state,
                &Profile {
                    ramp_up_seconds: 5,
                    ..curve()
                }
            )
            .await
            .is_err()
        );
        // stages + run-level think_time
        assert!(
            validate_run_config(
                &state,
                &Profile {
                    think_time: Some(handicap_engine::ThinkTime {
                        min_ms: 100,
                        max_ms: 100,
                    }),
                    ..curve()
                }
            )
            .await
            .is_err()
        );
        // stages + no max_in_flight
        assert!(
            validate_run_config(
                &state,
                &Profile {
                    max_in_flight: None,
                    ..curve()
                }
            )
            .await
            .is_err()
        );
        // all stage targets 0 → no load
        assert!(
            validate_run_config(
                &state,
                &Profile {
                    stages: Some(vec![handicap_engine::Stage {
                        target: 0,
                        duration_seconds: 30,
                    }]),
                    ..curve()
                }
            )
            .await
            .is_err()
        );
        // stage duration_seconds == 0
        assert!(
            validate_run_config(
                &state,
                &Profile {
                    stages: Some(vec![handicap_engine::Stage {
                        target: 200,
                        duration_seconds: 0,
                    }]),
                    ..curve()
                }
            )
            .await
            .is_err()
        );
    }
}
