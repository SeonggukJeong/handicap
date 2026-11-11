//! `/api/monitor-boards` — 운영실 모니터 보드 CRUD·start/stop·status·preview-check (ops-monitor ①a, spec §5·§6.4).
//!
//! 쓰기 핸들러는 항상 "DB 쓰기 → `reconcile`"이며 둘 사이에 다른 `.await`를 두지 않는다
//! (reconcile이 직렬화 락 안에서 DB 행을 다시 읽어 마지막 상태로 수렴).
//! **예외**: 표시 전용 `PUT /{id}/latency-stats`는 reconcile 없이 원자 `json_set`만 한다
//! (칸 목록·점검 설정 필드엔 이 경로 금지 — 감독자와 DB가 어긋난다).
//! 없는 id는 reconcile 전에 404 — reconcile은 id마다 슬롯을 만들고 지우지 않으므로
//! 미지의 id로 부르면 메모리가 무한히 자란다.
//! `GET /{id}/panels/{panel_id}/records/{at_ms}` — 점검 기록(요청·응답, 가림·상한 적용본)
//! 조회. 감독자 메모리만 읽고(`existing_slot` 전용 — 슬롯 생성 없음) 없으면 구분 없이 404.

use axum::Json;
use axum::extract::{Path, State};
use axum::http::{StatusCode, header};
use axum::response::{IntoResponse, Response};
use serde::{Deserialize, Serialize};

use crate::app::AppState;
use crate::error::ApiError;
use crate::monitor::check::{CheckResult, run_check};
use crate::monitor::config::{
    BoardConfig, PanelConfig, check_step_id, normalize_step_panel, validate_and_normalize,
    validate_panel,
};
use crate::monitor::supervisor::{CheckNow, PanelSnapshot, consecutive_fail, initial_budget_secs};
use crate::monitor::unit::{CheckUnit, run_unit_check};
use crate::store;
use crate::store::monitor_boards::{self, MonitorBoardRow};
use handicap_engine::ScenarioTrace;

#[derive(Debug, Deserialize)]
pub struct BoardBody {
    pub name: String,
    #[serde(default)]
    pub config: BoardConfig,
}

#[derive(Debug, Serialize)]
pub struct BoardResponse {
    pub id: String,
    pub name: String,
    pub config: BoardConfig,
    pub enabled: bool,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Serialize)]
pub struct BoardListResponse {
    pub boards: Vec<BoardResponse>,
}

#[derive(Debug, Serialize)]
pub struct PanelStatus {
    pub panel_id: String,
    pub results: Vec<CheckResult>,
    pub consecutive_fail: u32,
    pub fail_since_ms: Option<i64>,
    pub running: bool,
    /// 이 칸 실행 단위의 바깥 제한(초) — 화면 stale 기준. 스냅샷 없으면 초기값.
    pub check_budget_seconds: u32,
}

#[derive(Debug, Serialize)]
pub struct StatusResponse {
    pub now_ms: i64,
    pub board_updated_at: i64,
    pub enabled: bool,
    pub started_at_ms: Option<i64>,
    pub panels: Vec<PanelStatus>,
}

#[derive(Debug, Serialize)]
pub struct PreviewResponse {
    pub trace: Option<ScenarioTrace>,
    pub result: CheckResult,
}

fn to_response(r: MonitorBoardRow) -> BoardResponse {
    BoardResponse {
        id: r.id,
        name: r.name,
        config: r.config,
        enabled: r.enabled,
        created_at: r.created_at,
        updated_at: r.updated_at,
    }
}

fn map_db_err(e: sqlx::Error) -> ApiError {
    if e.as_database_error()
        .map(|d| d.is_unique_violation())
        .unwrap_or(false)
    {
        return ApiError::Conflict("같은 이름의 모니터가 이미 있습니다".into());
    }
    ApiError::from(e)
}

async fn reconcile(state: &AppState, id: &str) -> Result<(), ApiError> {
    state.monitor.reconcile(&state.db, id).await?;
    Ok(())
}

/// 한 칸의 status 항목 조립. `snap`이 없으면(꺼짐·미시작) 빈 상태.
/// `consecutive_fail`/`fail_since_ms`는 자르기 전 전체 버퍼로, `results`는 최신 `bar_count`개로.
pub fn build_panel_status(cfg: &PanelConfig, snap: Option<&PanelSnapshot>) -> PanelStatus {
    let Some(snap) = snap else {
        return PanelStatus {
            panel_id: cfg.id.clone(),
            results: Vec::new(),
            consecutive_fail: 0,
            fail_since_ms: None,
            running: false,
            check_budget_seconds: initial_budget_secs(cfg),
        };
    };
    let (consecutive_fail, fail_since_ms) = consecutive_fail(&snap.results);
    let skip = snap.results.len().saturating_sub(cfg.bar_count as usize);
    // 사유·detail은 최신 결과에만 싣는다(ADR-0053 ①b 보완) — 나머지는 막대용 verdict/지연만.
    let mut results = snap.results[skip..].to_vec();
    let last = results.len().saturating_sub(1);
    for r in results.iter_mut().take(last) {
        r.reason = None;
        r.detail = None;
        r.display = Vec::new();
    }
    PanelStatus {
        panel_id: cfg.id.clone(),
        results,
        consecutive_fail,
        fail_since_ms,
        running: snap.running,
        check_budget_seconds: snap.budget_secs,
    }
}

pub async fn create(
    State(state): State<AppState>,
    Json(mut body): Json<BoardBody>,
) -> Result<(StatusCode, Json<BoardResponse>), ApiError> {
    let name =
        validate_and_normalize(&body.name, &mut body.config).map_err(ApiError::BadRequest)?;
    let row = monitor_boards::insert(&state.db, &name, &body.config)
        .await
        .map_err(map_db_err)?;
    Ok((StatusCode::CREATED, Json(to_response(row))))
}

pub async fn list(State(state): State<AppState>) -> Result<Json<BoardListResponse>, ApiError> {
    let rows = monitor_boards::list(&state.db).await?;
    Ok(Json(BoardListResponse {
        boards: rows.into_iter().map(to_response).collect(),
    }))
}

pub async fn get(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<BoardResponse>, ApiError> {
    let row = monitor_boards::get(&state.db, &id)
        .await?
        .ok_or(ApiError::NotFound)?;
    Ok(Json(to_response(row)))
}

pub async fn update(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(mut body): Json<BoardBody>,
) -> Result<Json<BoardResponse>, ApiError> {
    let name =
        validate_and_normalize(&body.name, &mut body.config).map_err(ApiError::BadRequest)?;
    let row = monitor_boards::update(&state.db, &id, &name, &body.config)
        .await
        .map_err(map_db_err)?
        .ok_or(ApiError::NotFound)?;
    reconcile(&state, &id).await?;
    Ok(Json(to_response(row)))
}

pub async fn delete(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<StatusCode, ApiError> {
    monitor_boards::get(&state.db, &id)
        .await?
        .ok_or(ApiError::NotFound)?;
    monitor_boards::delete(&state.db, &id).await?;
    reconcile(&state, &id).await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn set_enabled(
    state: AppState,
    id: String,
    enabled: bool,
) -> Result<Json<BoardResponse>, ApiError> {
    let row = monitor_boards::set_enabled(&state.db, &id, enabled)
        .await?
        .ok_or(ApiError::NotFound)?;
    reconcile(&state, &id).await?;
    Ok(Json(to_response(row)))
}

pub async fn start(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<BoardResponse>, ApiError> {
    set_enabled(state, id, true).await
}

#[derive(Debug, Deserialize)]
pub struct LatencyStatsBody {
    pub show: bool,
}

/// 표시 전용 토글 — 예외적으로 reconcile 없음(점검 설정 불변, 실행 중 점검을 재시작하지 않는다).
pub async fn set_latency_stats(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(body): Json<LatencyStatsBody>,
) -> Result<Json<BoardResponse>, ApiError> {
    let row = monitor_boards::set_latency_stats(&state.db, &id, body.show)
        .await?
        .ok_or(ApiError::NotFound)?;
    Ok(Json(to_response(row)))
}

pub async fn stop(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<BoardResponse>, ApiError> {
    set_enabled(state, id, false).await
}

pub async fn status(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<StatusResponse>, ApiError> {
    let row = monitor_boards::get(&state.db, &id)
        .await?
        .ok_or(ApiError::NotFound)?;
    let snap = state.monitor.snapshot(&id).await;
    let panels = row
        .config
        .panels
        .iter()
        .map(|p| build_panel_status(p, snap.as_ref().and_then(|s| s.panels.get(&p.id))))
        .collect();
    Ok(Json(StatusResponse {
        now_ms: store::now_ms(),
        board_updated_at: row.updated_at,
        enabled: row.enabled,
        started_at_ms: snap.as_ref().map(|s| s.started_at_ms),
        panels,
    }))
}

/// 점검 기록 하나 — 보드 없음/꺼짐·칸 없음·기록 없음은 모두 404(구분 없음).
///
/// 워크스페이스 serde에 `rc` feature가 없어 `Json(Arc<_>)`는 안 되므로 `&*rec`를 직접
/// 직렬화한다(수 MB 기록을 복제하지 않기 위해).
pub async fn record(
    State(state): State<AppState>,
    Path((id, panel_id, at_ms)): Path<(String, String, i64)>,
) -> Result<Response, ApiError> {
    let rec = state
        .monitor
        .record(&id, &panel_id, at_ms)
        .await
        .ok_or(ApiError::NotFound)?;
    let bytes = serde_json::to_vec(&*rec)
        .map_err(|e| ApiError::Internal(anyhow::anyhow!("record serialization failed: {e}")))?;
    // 응답 본문(마스킹 후에도 업무 데이터)이 담긴다 — 브라우저/프록시 캐시에 남기지 않는다.
    Ok((
        [
            (header::CONTENT_TYPE, "application/json"),
            (header::CACHE_CONTROL, "no-store"),
        ],
        bytes,
    )
        .into_response())
}

const CHECK_OFF: &str = "점검이 꺼져 있습니다";

#[derive(Debug, Serialize)]
pub struct CheckNowResponse {
    /// 요청 직전 그 칸의 마지막 결과 시각(없으면 `null` — 키는 항상 직렬화된다).
    pub last_at_ms: Option<i64>,
}

/// 지금 점검 — 그 칸이 속한 실행 단위를 깨운다(spec tui-check-now §3.3). 본문 없음.
pub async fn check_now(
    State(state): State<AppState>,
    Path((id, panel_id)): Path<(String, String)>,
) -> Result<Json<CheckNowResponse>, ApiError> {
    let row = monitor_boards::get(&state.db, &id)
        .await?
        .ok_or(ApiError::NotFound)?;
    if !row.enabled {
        return Err(ApiError::Conflict(CHECK_OFF.into()));
    }
    match state.monitor.check_now(&id, &panel_id) {
        CheckNow::Requested { last_at_ms } => Ok(Json(CheckNowResponse { last_at_ms })),
        CheckNow::Off => Err(ApiError::Conflict(CHECK_OFF.into())),
        CheckNow::NoPanel => Err(ApiError::NotFound),
    }
}

pub async fn preview_check(
    State(state): State<AppState>,
    Json(mut panel): Json<PanelConfig>,
) -> Result<Json<PreviewResponse>, ApiError> {
    // 스텝 id 형식 → 정규화 → 검증 순서(정규화가 조건의 빈 step_id를 칸 스텝으로 채운다).
    check_step_id(&panel).map_err(ApiError::BadRequest)?;
    normalize_step_panel(&mut panel);
    validate_panel(&mut panel).map_err(ApiError::BadRequest)?;
    if panel.step_id.is_none() {
        let (trace, result) = run_check(&state.db, &panel).await;
        return Ok(Json(PreviewResponse { trace, result }));
    }
    // 스텝 칸 = 칸 1개짜리 묶음 경로(다른 칸의 스텝 제한은 반영 안 됨 — spec §8.3).
    let unit = CheckUnit {
        scenario_id: panel.scenario_id.clone(),
        environment_id: panel.environment_id.clone(),
        interval_seconds: panel.interval_seconds,
        panels: vec![panel],
    };
    let out = run_unit_check(&state.db, &unit).await;
    let result = out
        .results
        .into_iter()
        .next()
        .ok_or_else(|| ApiError::Internal(anyhow::anyhow!("unit check returned no result")))?;
    Ok(Json(PreviewResponse {
        trace: out.trace,
        result,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::monitor::check::Verdict;

    fn res(at: i64, v: Verdict) -> CheckResult {
        CheckResult {
            at_ms: at,
            verdict: v,
            latency_ms: None,
            reason: None,
            detail: None,
            display: vec![],
        }
    }

    fn cfg(bar: u32) -> PanelConfig {
        PanelConfig {
            id: "P".into(),
            bar_count: bar,
            ..PanelConfig::default()
        }
    }

    #[test]
    fn status_results_truncated_to_bar_count() {
        let results: Vec<_> = (0..300).map(|i| res(i, Verdict::Ok)).collect();
        let snap = PanelSnapshot {
            results,
            running: true,
            budget_secs: 0,
        };
        let s = build_panel_status(&cfg(10), Some(&snap));
        assert_eq!(s.results.len(), 10);
        assert_eq!(s.results[0].at_ms, 290);
        assert_eq!(s.results[9].at_ms, 299);
        assert!(s.running);
    }

    #[test]
    fn consecutive_fail_computed_before_truncation() {
        // 최근 50개 연속 fail, 그 앞은 ok — bar_count 10으로 잘려도 50/시작 시각은 전체 기준.
        let mut results: Vec<_> = (0..100).map(|i| res(i, Verdict::Ok)).collect();
        results.extend((100..150).map(|i| res(i, Verdict::Fail)));
        let snap = PanelSnapshot {
            results,
            running: false,
            budget_secs: 0,
        };
        let s = build_panel_status(&cfg(10), Some(&snap));
        assert_eq!(s.results.len(), 10);
        assert_eq!(s.consecutive_fail, 50);
        assert_eq!(s.fail_since_ms, Some(100));
    }

    #[test]
    fn missing_snapshot_is_empty_status() {
        let s = build_panel_status(&cfg(10), None);
        assert!(s.results.is_empty());
        assert_eq!(s.consecutive_fail, 0);
        assert_eq!(s.fail_since_ms, None);
        assert!(!s.running);
        assert_eq!(s.panel_id, "P");
    }

    #[test]
    fn status_reasons_only_on_latest_result() {
        let results: Vec<_> = (0..5)
            .map(|i| {
                let mut r = res(i, Verdict::Fail);
                r.reason = Some("x".into());
                r.detail = Some("d".into());
                r
            })
            .collect();
        let snap = PanelSnapshot {
            results,
            running: true,
            budget_secs: 0,
        };
        let s = build_panel_status(&cfg(10), Some(&snap));
        for r in &s.results[..4] {
            assert!(r.reason.is_none() && r.detail.is_none());
        }
        assert_eq!(s.results[4].reason.as_deref(), Some("x"));
        assert_eq!(s.results[4].detail.as_deref(), Some("d"));
        assert_eq!(s.consecutive_fail, 5);
    }

    #[test]
    fn short_buffer_not_padded() {
        let snap = PanelSnapshot {
            results: vec![res(1, Verdict::Ok)],
            running: false,
            budget_secs: 0,
        };
        assert_eq!(build_panel_status(&cfg(60), Some(&snap)).results.len(), 1);
    }

    #[test]
    fn status_strips_display_except_latest() {
        let results: Vec<_> = (0..5)
            .map(|i| {
                let mut r = res(i, Verdict::Ok);
                r.display = vec![Some("x".into())];
                r
            })
            .collect();
        let snap = PanelSnapshot {
            results,
            running: true,
            budget_secs: 0,
        };
        let s = build_panel_status(&cfg(10), Some(&snap));
        for r in &s.results[..4] {
            assert!(r.display.is_empty());
        }
        assert_eq!(s.results[4].display, vec![Some("x".to_string())]);
    }

    #[test]
    fn status_check_budget_seconds() {
        let mut step = cfg(10);
        step.step_id = Some("01J0000000000000000000000A".into());
        step.timeout_seconds = 7;
        let mut whole = cfg(10);
        whole.timeout_seconds = 7;
        // 스냅샷 없음(꺼짐·미시작) → 초기값: 스텝 칸 152(120+30+2), 흐름 칸 timeout_seconds.
        assert_eq!(build_panel_status(&step, None).check_budget_seconds, 152);
        assert_eq!(build_panel_status(&whole, None).check_budget_seconds, 7);
        // 스냅샷이 있으면 감독자가 저장한 값.
        let snap = PanelSnapshot {
            results: vec![res(1, Verdict::Ok)],
            running: false,
            budget_secs: 41,
        };
        assert_eq!(
            build_panel_status(&step, Some(&snap)).check_budget_seconds,
            41
        );
        assert_eq!(
            build_panel_status(&whole, Some(&snap)).check_budget_seconds,
            41
        );
        // 와이어 키 이름.
        let v = serde_json::to_value(build_panel_status(&step, Some(&snap))).unwrap();
        assert_eq!(v["check_budget_seconds"], 41);
    }
}
