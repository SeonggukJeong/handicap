use axum::Json;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use handicap_engine::{Scenario, Step, ThinkTime};
use handicap_proto::v1 as pb;
use serde::{Deserialize, Serialize};

use crate::api::scenarios::think_time_in_range;
use crate::app::AppState;
use crate::binding::{BindingPolicy, collect_var_names};
use crate::error::ApiError;
use crate::grpc::coordinator::AbortOutcome;
use crate::store::datasets;
use crate::store::runs::{self, Profile, RunStatus};
use crate::store::scenarios;

/// Query parameter for POST /api/runs. `?force=true` skips the capacity guard
/// (L3 R4) and routes to the legacy even-split path.
#[derive(Debug, Deserialize)]
pub struct ForceQuery {
    #[serde(default)]
    pub force: bool,
}

#[derive(Debug, Deserialize)]
pub struct CreateRunRequest {
    pub scenario_id: String,
    pub profile: Profile,
    #[serde(default)]
    pub env: std::collections::HashMap<String, String>,
    #[serde(default)]
    pub label: Option<String>,
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
    /// A4a SLO verdict(완료 run, criteria 있을 때만 non-null). 목록 배지용.
    pub verdict: Option<crate::report::Verdict>,
    /// 마지막 메트릭 윈도의 wall-clock unix초(running run 진행 stall 판정용, G1b 목록 배지).
    /// running이 아니거나 메트릭 0이면 None. advisory-only — list 경로만 채운다(FIX-3).
    pub last_metric_ts: Option<i64>,
    /// 사용자(또는 스케줄러 자동) run 라벨. 없으면 JSON `null`(run-identity spec §3/§5).
    pub label: Option<String>,
    /// 계단 자동 정지 기록 — status가 `completed`이고 값이 있을 때만(아니면 키 생략).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub auto_stop: Option<crate::auto_stop::AutoStopRecord>,
    /// 계단 run 실행 중 요약 — `GET /api/runs/{id}`가 running 계단 run에만 싣는다(아니면 키 생략).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub auto_stop_live: Option<crate::stair_live::LiveState>,
    /// 실행 중 run의 준비 구간 VU 결과 합 — `GET /api/runs/{id}`가 running이고 행이 있을 때만(아니면 키 생략).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub setup_live: Option<SetupLive>,
}

#[derive(Debug, Serialize)]
pub struct SetupLive {
    pub ok: u64,
    pub failed: u64,
    pub interrupted: u64,
}

pub(crate) fn loop_cap_ok(cap: u32, max: u32) -> bool {
    cap <= max
}

/// run 라벨 정규화(spec §3): trim → 빈=None, 문자 수 200 초과=Err(400 메시지).
/// create·PUT 공유. 스케줄러는 이 함수 대신 truncate(자동 경로는 400 불가).
fn normalize_label(raw: Option<String>) -> Result<Option<String>, String> {
    let Some(s) = raw else { return Ok(None) };
    let t = s.trim();
    if t.is_empty() {
        return Ok(None);
    }
    if t.chars().count() > 200 {
        return Err("라벨은 200자 이하여야 합니다".into());
    }
    Ok(Some(t.to_string()))
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
    for (name, r) in [
        ("max_4xx_rate", c.max_4xx_rate),
        ("max_5xx_rate", c.max_5xx_rate),
    ] {
        if let Some(r) = r {
            if !r.is_finite() || !(0.0..=1.0).contains(&r) {
                return Err(format!("criteria.{name} must be between 0.0 and 1.0"));
            }
        }
    }
    if let Some(r) = c.min_window_rps {
        if !r.is_finite() || r < 0.0 {
            return Err("criteria.min_window_rps must be >= 0".into());
        }
    }
    // step-level criteria 범위 검증(spec §4.1). target 존재성(scenario step_id 대조)은
    // Task 4의 별도 cross-resource 관심사 — 여기선 vocabulary/op/threshold/비-빈 target만.
    const STEP_METRICS: [&str; 8] = [
        "p50_ms",
        "p95_ms",
        "p99_ms",
        "error_rate",
        "4xx_rate",
        "5xx_rate",
        "4xx_count",
        "5xx_count",
    ];
    // 새 시간 값(평균·최대·백분위 한계·스텝 새 항목): 유한·0..=60000·소수 셋째 자리까지.
    fn time_limit_ok(v: f64) -> bool {
        v.is_finite()
            && (0.0..=60000.0).contains(&v)
            && crate::percentile_name::is_three_decimals(v)
    }
    for (name, v) in [("max_mean_ms", c.max_mean_ms), ("max_max_ms", c.max_max_ms)] {
        if let Some(v) = v {
            if !time_limit_ok(v) {
                return Err(format!(
                    "criteria.{name}은 0 이상 60000 이하, 소수 셋째 자리까지여야 합니다"
                ));
            }
        }
    }
    if c.max_percentiles_ms.len() > 10 {
        return Err("criteria.max_percentiles_ms는 10개까지입니다".into());
    }
    let mut seen_milli: Vec<u32> = Vec::new();
    for (i, pl) in c.max_percentiles_ms.iter().enumerate() {
        let Some(milli) = crate::percentile_name::to_milli(pl.percentile) else {
            return Err(format!(
                "criteria.max_percentiles_ms[{i}].percentile은 0보다 크고 100보다 작은 수(소수 셋째 자리까지)여야 합니다"
            ));
        };
        if !time_limit_ok(pl.max_ms) {
            return Err(format!(
                "criteria.max_percentiles_ms[{i}].max_ms은 0 이상 60000 이하, 소수 셋째 자리까지여야 합니다"
            ));
        }
        let n = crate::percentile_name::percentile_metric_name(pl.percentile);
        let n = n
            .trim_start_matches('p')
            .trim_end_matches("_ms")
            .to_string();
        if seen_milli.contains(&milli) {
            return Err(format!(
                "criteria.max_percentiles_ms[{i}]: 같은 백분위(p{n})가 이미 있습니다"
            ));
        }
        seen_milli.push(milli);
        if matches!(milli, 50_000 | 95_000 | 99_000) {
            return Err(format!(
                "criteria.max_percentiles_ms[{i}]: p{n}은 위의 최대 p{n} 칸을 쓰세요"
            ));
        }
    }
    for (i, sc) in c.step_criteria.iter().enumerate() {
        // 기존 8개(p50/p95/p99 포함)는 옛 검증 그대로(면제) — 새 항목만 새 규칙.
        let new_time_metric = !STEP_METRICS.contains(&sc.metric.as_str())
            && (sc.metric == "mean_ms"
                || sc.metric == "max_ms"
                || crate::percentile_name::parse_percentile_metric(&sc.metric).is_some());
        if new_time_metric && !time_limit_ok(sc.threshold) {
            return Err(format!(
                "criteria.step_criteria[{i}].threshold는 0 이상 60000 이하, 소수 셋째 자리까지여야 합니다"
            ));
        }
        if !STEP_METRICS.contains(&sc.metric.as_str()) && !new_time_metric {
            return Err(format!(
                "criteria.step_criteria[{i}].metric '{}'은 지원하지 않습니다",
                sc.metric
            ));
        }
        if sc.op != "max" && sc.op != "min" {
            return Err(format!(
                "criteria.step_criteria[{i}].op은 'max' 또는 'min'이어야 합니다"
            ));
        }
        if !sc.threshold.is_finite() {
            return Err(format!(
                "criteria.step_criteria[{i}].threshold가 유효하지 않습니다"
            ));
        }
        let is_rate = matches!(sc.metric.as_str(), "error_rate" | "4xx_rate" | "5xx_rate");
        if is_rate && !(0.0..=1.0).contains(&sc.threshold) {
            return Err(format!(
                "criteria.step_criteria[{i}].threshold는 0.0..=1.0이어야 합니다 (rate)"
            ));
        } else if !is_rate && sc.threshold < 0.0 {
            return Err(format!(
                "criteria.step_criteria[{i}].threshold는 0 이상이어야 합니다"
            ));
        }
        if sc.target.trim().is_empty() {
            return Err(format!(
                "criteria.step_criteria[{i}].target(step_id)가 비어 있습니다"
            ));
        }
    }
    Ok(())
}

/// 시나리오 트리에서 http-leaf step_id를 수집(중첩 loop/if/parallel 하강).
/// container 노드 id(loop/if/parallel)는 제외 — ReportStep latency가 없어 target 불가.
fn collect_http_step_ids(steps: &[Step], out: &mut std::collections::HashSet<String>) {
    for step in steps {
        match step {
            Step::Http(h) => {
                out.insert(h.id.clone());
            }
            Step::Loop(l) => collect_http_step_ids(&l.do_, out),
            Step::If(i) => {
                collect_http_step_ids(&i.then_, out);
                for e in &i.elif {
                    collect_http_step_ids(&e.then_, out);
                }
                collect_http_step_ids(&i.else_, out);
            }
            Step::Parallel(p) => {
                for b in &p.branches {
                    collect_http_step_ids(&b.steps, out);
                }
            }
        }
    }
}

/// step-level criteria의 target이 시나리오의 실제 http-leaf step_id인지 검증(spec §4.2).
/// `validate_criteria`(profile-only)가 못 보는 cross-resource(시나리오 YAML) 관심사라
/// 시나리오를 손에 든 호출부(run-create·preset·schedule·fire)가 별도로 호출한다.
pub(crate) fn validate_step_criteria_targets(
    profile: &crate::store::runs::Profile,
    scenario_yaml: &str,
) -> Result<(), String> {
    let Some(criteria) = &profile.criteria else {
        return Ok(());
    };
    if criteria.step_criteria.is_empty() {
        return Ok(());
    }
    let sc = Scenario::from_yaml(scenario_yaml).map_err(|e| format!("시나리오 파싱 실패: {e}"))?;
    let mut ids = std::collections::HashSet::new();
    collect_http_step_ids(&sc.steps, &mut ids);
    for criterion in &criteria.step_criteria {
        if !ids.contains(&criterion.target) {
            return Err(format!(
                "criteria target '{}'은 시나리오의 http 스텝이 아닙니다",
                criterion.target
            ));
        }
    }
    Ok(())
}

/// Non-pool fan-out worker count N, shared by validate_run_config (unique-floor, R4)
/// and spawn_run (dispatch) so they can never drift. A closed-loop VU curve fans out
/// on its peak VU exactly as a fixed-VU run fans out on `vus` (R1).
fn fanout_worker_count(profile: &Profile, capacity: u32) -> u32 {
    if profile.is_vu_curve() {
        crate::grpc::shard::worker_count(profile.vu_curve_max(), capacity)
    } else if profile.is_open_loop() {
        profile.worker_count.unwrap_or(1)
    } else {
        crate::grpc::shard::worker_count(profile.vus, capacity)
    }
}

/// Validate a run/preset config against the live datasets (spec §6). Returns one
/// validated dataset meta per binding, in `profile.data_bindings()` order (so the
/// caller resolves each binding from its meta without a second `get_meta` —
/// TOCTOU guard, controller `CLAUDE.md`); an empty vec when there is no binding.
/// `spawn_run` zips this vec back over `data_bindings()` in the same order — the
/// accessor is the single source of order, so the alignment holds. Shared by
/// `runs::create` (authoritative gate) and preset save (`api::presets`).
pub(crate) async fn validate_run_config(
    state: &AppState,
    profile: &Profile,
) -> Result<Vec<datasets::DatasetMeta>, ApiError> {
    // ── ramp_down은 VU 곡선 전용 노브 (spec §3.2 ⑨) ──
    if !profile.is_vu_curve() && profile.ramp_down.is_some() {
        return Err(ApiError::BadRequest(
            "ramp_down은 vu_stages(VU 곡선) 전용입니다".into(),
        ));
    }
    // ── graceful ramp-down 상한은 graceful VU 곡선 전용 (spec §7.2) ──
    if profile.graceful_ramp_down_seconds.is_some() {
        if !profile.is_vu_curve() {
            return Err(ApiError::BadRequest(
                "graceful_ramp_down_seconds는 vu_stages(VU 곡선) 전용입니다".into(),
            ));
        }
        if profile.ramp_down == Some(handicap_engine::RampDown::Immediate) {
            return Err(ApiError::BadRequest(
                "graceful_ramp_down_seconds는 graceful ramp-down에서만 유효합니다".into(),
            ));
        }
        if profile.graceful_ramp_down_seconds == Some(0) {
            return Err(ApiError::BadRequest(
                "graceful_ramp_down_seconds는 1 이상이어야 합니다".into(),
            ));
        }
    }
    // ── worker_count: open-loop 전용 멀티워커 fan-out 노브 (spec 2026-06-15) ──
    if let Some(w) = profile.worker_count {
        let cap = state.settings.max_open_loop_worker_count();
        if w == 0 || w > cap {
            return Err(ApiError::BadRequest(format!(
                "worker_count must be between 1 and {cap}"
            )));
        }
        if w > 1 && !profile.is_open_loop() {
            return Err(ApiError::BadRequest(
                "worker_count는 open-loop(target_rps/stages) 전용입니다 — \
                 closed-loop은 vus로 워커 수가 정해집니다"
                    .into(),
            ));
        }
    }
    // ── closed-loop VU curve (spec §3.2 ①–⑧): open-loop 분기보다 먼저 — curve
    //    규칙이 open-loop 필드 배제를 포함하므로 에러 메시지의 권위가 여기다 ──
    if profile.is_vu_curve() {
        if profile.target_rps.is_some() {
            return Err(ApiError::BadRequest(
                "vu_stages와 target_rps는 함께 쓸 수 없습니다 (VU 곡선 vs RPS 지정 충돌)".into(),
            ));
        }
        if profile.max_in_flight.is_some() {
            return Err(ApiError::BadRequest(
                "vu_stages에선 max_in_flight를 쓸 수 없습니다 (open-loop 전용)".into(),
            ));
        }
        if profile.stages.as_ref().is_some_and(|s| !s.is_empty()) {
            return Err(ApiError::BadRequest(
                "vu_stages와 stages(RPS 곡선)는 함께 쓸 수 없습니다".into(),
            ));
        }
        if profile.ramp_up_seconds > 0 {
            return Err(ApiError::BadRequest(
                "vu_stages 사용 시 ramp_up_seconds를 비워야 합니다 (곡선이 ramp의 일반화)".into(),
            ));
        }
        if profile.duration_seconds > 0 {
            return Err(ApiError::BadRequest(
                "vu_stages 사용 시 duration_seconds를 비워야 합니다 (총 길이 = stage 합)".into(),
            ));
        }
        if profile.vus > 0 {
            return Err(ApiError::BadRequest(
                "vu_stages 사용 시 vus를 비워야 합니다 (곡선이 VU 수를 정의)".into(),
            ));
        }
        let stages = profile.vu_stages.as_deref().unwrap_or_default();
        for s in stages {
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
    } else if profile.is_open_loop() {
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
        // #5 open-loop에선 vus가 무시된다 → 비정합 신호, worker_count/closed-loop로 리다이렉트.
        if profile.vus > 0 {
            return Err(ApiError::BadRequest(
                "open-loop에선 vus가 무시됩니다 — 수평 확장은 worker_count, \
                 VU 기반 부하는 closed-loop(vus)을 쓰세요"
                    .into(),
            ));
        }
        // #3·#4 멀티워커 fan-out 분할 가능성 (worker_count > 1):
        if let Some(w) = profile.worker_count {
            if w > 1 {
                // #3 워커당 ≥1 슬롯 (0-슬롯 워커는 자기 도착 전부 drop)
                let mif = profile.max_in_flight.unwrap_or(0);
                if mif < w {
                    return Err(ApiError::BadRequest(format!(
                        "worker_count={w}이면 max_in_flight >= {w} 필요 (워커당 ≥1 슬롯)"
                    )));
                }
                // #4 고정모드: 워커당 ≥1 rps (엔진 .max(1)이 0-share를 왜곡). 곡선모드 면제.
                let is_curve = profile.stages.as_ref().is_some_and(|s| !s.is_empty());
                if !is_curve {
                    let rps = profile.target_rps.unwrap_or(0);
                    if rps < w {
                        return Err(ApiError::BadRequest(format!(
                            "worker_count={w}이면 target_rps >= {w} 필요 (워커당 ≥1 rps)"
                        )));
                    }
                }
            }
        }
    } else if profile.vus == 0 || profile.duration_seconds == 0 {
        return Err(ApiError::BadRequest(
            "vus and duration_seconds must be > 0".into(),
        ));
    }
    let loop_cap_max = state.settings.max_loop_breakdown_cap();
    if !loop_cap_ok(profile.loop_breakdown_cap, loop_cap_max) {
        return Err(ApiError::BadRequest(format!(
            "loop_breakdown_cap must be <= {loop_cap_max} (0 disables breakdown)"
        )));
    }
    if profile.http_timeout_seconds == 0 || profile.http_timeout_seconds > 600 {
        return Err(ApiError::BadRequest(
            "http_timeout_seconds must be between 1 and 600".into(),
        ));
    }
    if let Some(ct) = profile.connect_timeout_seconds {
        if !(1..=600).contains(&ct) {
            return Err(ApiError::BadRequest(
                "connect_timeout_seconds must be between 1 and 600".into(),
            ));
        }
        // http_timeout_seconds는 바로 위에서 1..=600으로 검증된 실값(serde default 30).
        // 같으면 어느 쪽이 먼저 발화할지 보장 못 하므로 < 를 강제한다.
        if ct >= profile.http_timeout_seconds {
            return Err(ApiError::BadRequest(
                "connect_timeout_seconds must be less than http_timeout_seconds".into(),
            ));
        }
    }
    if let Some(tt) = &profile.think_time {
        if !think_time_in_range(tt) {
            return Err(ApiError::BadRequest(
                "think_time: min_ms <= max_ms <= 600000 (10분) 이어야 합니다".into(),
            ));
        }
    }
    if let Some(c) = &profile.criteria {
        validate_criteria(c).map_err(ApiError::BadRequest)?;
    }
    // ── data bindings: N independent bindings (spec multi-dataset) ──
    // Effective list comes from the accessor (data_bindings vec, or the legacy
    // single binding folded to one element). Empty → no binding to validate.
    let bindings = profile.data_bindings();
    if bindings.is_empty() {
        return Ok(Vec::new());
    }
    let max_bindings = state.settings.max_data_bindings();
    if bindings.len() > max_bindings {
        return Err(ApiError::BadRequest(format!(
            "데이터셋 바인딩은 최대 {max_bindings}개입니다 ({}개)",
            bindings.len()
        )));
    }
    // Cross-binding variable-name uniqueness: the same var injected from two
    // datasets is ambiguous. (Same dataset_id bound twice is allowed — only var
    // names must be globally unique across all bindings.) Empty-mapping bindings
    // contribute no names (allowed; they inject nothing).
    let mut seen = std::collections::HashSet::new();
    for var in collect_var_names(&bindings) {
        if !seen.insert(var.clone()) {
            return Err(ApiError::BadRequest(format!(
                "변수 '{var}'이 여러 데이터셋에 중복 매핑됨"
            )));
        }
    }
    // Per-binding validation (independent): the worker count N is shared (it
    // derives from the profile, not the binding), but every other check is
    // per-binding. Collect validated meta in data_bindings() order.
    // Worker count — only consumed by the Unique row-count check below; hoisted so it's computed once.
    let n = fanout_worker_count(profile, state.settings.worker_capacity_vus());
    let mut metas = Vec::with_capacity(bindings.len());
    for b in &bindings {
        let meta = datasets::get_meta(&state.db, &b.dataset_id)
            .await?
            .ok_or_else(|| {
                ApiError::BadRequest(format!("데이터셋 '{}'이 존재하지 않습니다", b.dataset_id))
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
        if per_iteration && (meta.row_count as u64) > state.settings.dataset_max_rows() {
            return Err(ApiError::BadRequest(format!(
                "per-iteration 바인딩 행 수 {}가 상한 {}을 초과합니다",
                meta.row_count,
                state.settings.dataset_max_rows()
            )));
        }
        metas.push(meta);
    }
    Ok(metas)
}

/// Pool 경로 두 분기 공통 unique floor 검사 — n_pool 직후, enqueue *전* 호출.
/// `policy == Unique && row_count < n_pool` 이면 `(row_count, n_pool)` 반환.
/// `PendingDataBinding.policy`는 Policy **enum**(coordinator.rs:47) — `as i32` 불필요.
fn pool_unique_floor_violation(
    assignment: &crate::grpc::coordinator::PendingAssignment,
    n_pool: u32,
) -> Option<(u64, u32)> {
    use handicap_proto::v1::data_binding::Policy;
    assignment.data_bindings.iter().find_map(|b| {
        if b.policy == Policy::Unique && b.row_count < n_pool as u64 {
            Some((b.row_count, n_pool))
        } else {
            None
        }
    })
}

const STARTUP_MARGIN: u64 = 15;

/// Leading consecutive zero-load stages (delayed start): open-loop `stages` or
/// closed-loop `vu_stages` whose `target == 0`. Normal runs → 0.
pub(crate) fn leading_idle_secs(p: &pb::Profile) -> u64 {
    let lead = if !p.vu_stages.is_empty() {
        &p.vu_stages
    } else {
        &p.stages
    };
    lead.iter()
        .take_while(|s| s.target == 0)
        .map(|s| u64::from(s.duration_seconds))
        .sum()
}

/// open-loop 곡선(`stages`)의 첫 도착 지연 상한(초). 엔진은 곡선 도착을 누적 역산
/// Λ⁻¹(k+½)로 쏘므로 0→s ramp(D초)의 첫 도착은 √(D/s)로 늦을 수 있고, open-loop
/// 엔진은 도착 0이면 MetricBatch(heartbeat)도 없어 startup 라이브니스 워치독이 먼저
/// 터질 수 있다. 첫 양 stage(선두 target==0 run 다음)의 목표 T·길이 D에 대해, 가장 바쁜
/// 워커의 정수 몫 s ≥ ceil(T/N) ≥ 1 이므로 √(D/s) ≤ √(N·D/T), 또한 ≤ D
/// (stage 누적 s·D/2 ≥ 0.5). 반환 = `min(D, ceil(√(N·D/T)))`. N은 곡선을 나눠 갖는
/// 워커 수의 **상한**(클수록 grace가 길어 안전). VU 곡선(active-VU 샘플 매초)·고정
/// `target_rps`·closed-loop·전부 0 stage → 0.
pub(crate) fn curve_first_arrival_secs(p: &pb::Profile, n_workers: u32) -> u64 {
    if !p.vu_stages.is_empty() {
        return 0;
    }
    let Some(s) = p.stages.iter().find(|s| s.target != 0) else {
        return 0;
    };
    let d = u64::from(s.duration_seconds);
    if d == 0 {
        return 0;
    }
    let n = f64::from(n_workers.max(1));
    let bound = (n * d as f64 / f64::from(s.target)).sqrt().ceil() as u64;
    bound.min(d)
}

/// Effective startup grace: at least the CLI floor, but never below the run's
/// HTTP timeout + margin (a black-hole SUT emits its first error-metric only
/// after the timeout), plus any leading idle stages + the first-arrival delay of
/// a slow open-loop curve ramp. Mirrors worker's 0→30 fallback.
pub(crate) fn startup_grace_eff(
    p: &pb::Profile,
    startup_floor: std::time::Duration,
    n_workers: u32,
) -> std::time::Duration {
    let http_to = if p.http_timeout_seconds == 0 {
        30
    } else {
        p.http_timeout_seconds
    } as u64;
    let floor = startup_floor.max(std::time::Duration::from_secs(http_to + STARTUP_MARGIN));
    floor
        + std::time::Duration::from_secs(leading_idle_secs(p))
        + std::time::Duration::from_secs(curve_first_arrival_secs(p, n_workers))
}

/// open-loop에서 시나리오 think를 무시할 때만, 워커-전송 YAML에서 think를 제거한다.
/// 무-think·apply·closed는 원본 clone(파싱조차 안 함). 라운드트립 속성
/// (`from_yaml(to_yaml(s)) == s`, engine `scenario.rs` 테스트)이 안전 담보 — 워커가
/// 어차피 재파싱하므로 리포맷/주석 손실은 실행에 무의미. 저장 스냅샷은 원본을 쓴다.
fn maybe_strip_think(yaml: &str, profile: &Profile) -> String {
    if !(profile.is_open_loop() && !profile.apply_scenario_think_time) {
        return yaml.to_string();
    }
    let mut sc = match Scenario::from_yaml(yaml) {
        Ok(s) => s,
        // 파싱 실패는 생성 시 검증에서 이미 걸렸을 것 — 방어적으로 원본 유지.
        Err(_) => return yaml.to_string(),
    };
    if strip_scenario_think(&mut sc) {
        sc.to_yaml().unwrap_or_else(|_| yaml.to_string())
    } else {
        yaml.to_string()
    }
}

/// 루트 default + 모든 스텝 think를 None으로. 하나라도 바꿨으면 true.
/// 단, 조건 반복(`while` + keep_think) 본문의 스텝은 think를 지우지 않고(루트 기본값으로 채워)
/// 남긴다 — 폴링 대기 간격이 사라지면 대기 서버를 두드리게 된다.
fn strip_scenario_think(sc: &mut Scenario) -> bool {
    let root_default = sc.default_think_time.take();
    let mut changed = root_default.is_some();
    if let Some(setup) = sc.setup.as_mut()
        && strip_steps_think(&mut setup.steps, root_default.as_ref(), false)
    {
        changed = true;
    }
    if strip_steps_think(&mut sc.steps, root_default.as_ref(), false) {
        changed = true;
    }
    changed
}

fn strip_steps_think(steps: &mut [Step], root_default: Option<&ThinkTime>, keep: bool) -> bool {
    let mut changed = false;
    for step in steps.iter_mut() {
        match step {
            Step::Http(h) => {
                if keep {
                    if h.think_time.is_none()
                        && let Some(d) = root_default
                    {
                        h.think_time = Some(*d);
                        changed = true;
                    }
                } else if h.think_time.take().is_some() {
                    changed = true;
                }
            }
            Step::Loop(l) => {
                let k = keep || l.keeps_think();
                if strip_steps_think(&mut l.do_, root_default, k) {
                    changed = true;
                }
            }
            Step::If(i) => {
                if strip_steps_think(&mut i.then_, root_default, keep) {
                    changed = true;
                }
                for e in &mut i.elif {
                    if strip_steps_think(&mut e.then_, root_default, keep) {
                        changed = true;
                    }
                }
                if strip_steps_think(&mut i.else_, root_default, keep) {
                    changed = true;
                }
            }
            Step::Parallel(p) => {
                // 엔진은 parallel 분기에 시나리오 기본 think를 적용하지 않는다 — 복사 금지.
                for b in &mut p.branches {
                    if strip_steps_think(&mut b.steps, None, keep) {
                        changed = true;
                    }
                }
            }
        }
    }
    changed
}

/// 검증된 run을 발사: insert → data_binding 해석 → enqueue → dispatch.
/// 풀 사전 실패·배정 실패·dispatch 실패(생성 실패)는 `fail_run_start` 하나를 지난다: 코디네이터 항목을
/// 정리하고 활성 run만 failed로 마크한 뒤 Err, 행이 이미 aborted면 그 행을 Ok로 돌려준다. REST `create`(권위 게이트 통과 후 호출)와 스케줄러
/// 루프(34b)가 공유한다. `validated_metas`는 `validate_run_config`가 돌려준
/// 검증된 dataset meta(TOCTOU 회피 재사용) — `profile.data_bindings()`와 같은
/// 순서. binding 없으면 빈 vec.
pub(crate) async fn spawn_run(
    state: &AppState,
    scenario: &scenarios::ScenarioRow,
    profile: &Profile,
    validated_metas: Vec<datasets::DatasetMeta>,
    env: &std::collections::HashMap<String, String>,
    force: bool,
    label: Option<&str>,
) -> Result<runs::RunRow, ApiError> {
    // L3/L4/L5: pool capacity precheck (before any DB insert → 409 leaves no run row, R3).
    // Covers closed-loop, open-loop (fixed+curve), AND closed-loop VU curve.
    // Empty pool (idle 0) is NOT a 409 — falls through to existing empty-pool 400 below.
    if state.coord.is_pool_mode() && !force {
        let (idle, achievable) = state
            .coord
            .pool_achievable_capacity(profile.pool_worker_cap())
            .await;
        let demand = profile.concurrency_demand();
        if idle > 0 && demand > achievable {
            return Err(ApiError::ConflictJson(serde_json::json!({
                "achievable_vus": achievable,
                "requested_vus": demand,
            })));
        }
    }

    // env is already map<string,string> (rejected at the API boundary otherwise).
    // Serialize back to a JSON object for storage; clone the map for the proto.
    let env_value = serde_json::to_value(env).expect("env map serializes to a JSON object");
    let row = runs::insert(
        &state.db,
        &scenario.id,
        &scenario.yaml,
        profile,
        &env_value,
        label,
    )
    .await?;

    // Resolve each binding for the workers (spec §4/§7): proto policy, a
    // deterministic seed folded from the run id, and the sliced row count.
    // Reuses the metas validate_run_config already fetched — no second DB call.
    // `data_bindings()` and `validated_metas` are in lockstep order (the accessor
    // is the single source of order — validate iterated it identically), so the
    // zip aligns each binding with its own meta.
    let seed = fold_seed(&row.id);
    let data_bindings: Vec<crate::grpc::coordinator::PendingDataBinding> = profile
        .data_bindings()
        .iter()
        .zip(validated_metas)
        .map(|(b, meta)| {
            let (policy, row_count) = match b.policy {
                BindingPolicy::PerVu => {
                    // closed-loop: one row per VU; open-loop: one row per slot
                    // (max_in_flight); vu-curve: one row per max(stage.target).
                    let slot_count = if profile.is_vu_curve() {
                        u64::from(profile.vu_curve_max())
                    } else if profile.is_open_loop() {
                        profile.max_in_flight.unwrap_or(0) as u64
                    } else {
                        profile.vus as u64
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
            crate::grpc::coordinator::PendingDataBinding {
                dataset_id: b.dataset_id.clone(),
                policy,
                seed,
                mappings: b.mappings.clone(),
                row_count,
            }
        })
        .collect();

    // open-loop think 무시(§B21 ②): 워커-전송 복사본에서만 think strip. 스냅샷
    // (runs::insert(&scenario.yaml))은 원본 유지 — 리포트 스텝 라벨·retry drift 정본.
    let worker_yaml = maybe_strip_think(&scenario.yaml, profile);

    // Enqueue the assignment so the coordinator can hand shards to N workers.
    let assignment = crate::grpc::coordinator::PendingAssignment {
        scenario_yaml: worker_yaml,
        profile: crate::grpc::profile::to_proto_profile(profile),
        env: env.clone(),
        data_bindings,
        stair: profile.stair.clone(),
    };
    // Per-run liveness grace (G1a). Computed from the proto Profile BEFORE
    // `assignment` is moved into any enqueue branch. startup-A = floor (CLI ?? 90s)
    // raised to HTTP-timeout + margin + leading idle; backstop-B = engine run
    // duration + CLI grace (?? 120s).
    let startup_floor = std::time::Duration::from_secs(state.settings.run_startup_grace_seconds());
    let backstop_grace =
        std::time::Duration::from_secs(state.settings.run_backstop_grace_seconds());
    // N = 곡선을 나눠 갖는 워커 수의 상한 (풀: 예약 ≤ pool_worker_cap, 비-풀: fan-out N).
    let n = if state.coord.is_pool_mode() {
        profile.pool_worker_cap()
    } else {
        fanout_worker_count(profile, state.settings.worker_capacity_vus())
    };
    let startup_grace = startup_grace_eff(&assignment.profile, startup_floor, n);
    let backstop_total =
        std::time::Duration::from_secs(handicap_proto::run_duration_secs(&assignment.profile))
            + backstop_grace;
    // curve의 total_vus = max(stage.target); open-loop의 total_vus = max_in_flight(슬롯 풀).
    // profile.vus(=0)를 넘기면 register의 shard_split(0,…)이 vu_count=0을 만들어 §5 와이어
    // 약속과 모순 (spec §3.3). validate가 open-loop max_in_flight=Some 보장 → unwrap_or는 방어.
    let total_vus = if profile.is_vu_curve() {
        profile.vu_curve_max()
    } else if profile.is_open_loop() {
        profile.max_in_flight.unwrap_or(1)
    } else {
        profile.vus
    };
    // Pool mode: use the always-on worker pool instead of spawning new workers.
    // L3/L4/L5: fork by mode — closed-loop, open-loop (fixed+curve), AND vu-curve non-force use
    // capacity-aware path (R2/R13); ?force uses legacy even-split (byte-identical L1).
    if state.coord.is_pool_mode() {
        // guarded = capacity-aware path applies to all pool modes (L5: curve now included).
        let guarded = true;
        if guarded && !force {
            // Capacity-aware path (R2/R13): worker_cap limits worker count, slot_total is
            // the concurrency demand (max_in_flight for open-loop, vus for closed-loop).
            // total_vus local (lines above) == concurrency_demand() for all modes — single source.
            match state
                .coord
                .reserve_idle_pool_capacity(
                    &row.id,
                    profile.pool_worker_cap(),
                    profile.concurrency_demand(),
                )
                .await
            {
                crate::grpc::coordinator::PoolReservation::Reserved { workers, counts: _ }
                    if workers.is_empty() =>
                {
                    // empty pool → existing 400 (idle 0).
                    let msg = "연결된 LAN 워커가 없습니다 — 워커를 1대 이상 띄우세요".to_string();
                    return fail_run_start(
                        &state.coord,
                        &state.db,
                        &row.id,
                        &msg,
                        ApiError::BadRequest(msg.clone()),
                        StartFailedAt::BeforeEnqueue,
                    )
                    .await;
                }
                crate::grpc::coordinator::PoolReservation::Insufficient { achievable } => {
                    // 사전 검사 뒤 풀이 줄어든 드문 경합.
                    let msg = format!(
                        "풀 용량 부족 (가용 {achievable} VU < 요청 {} VU)",
                        profile.concurrency_demand()
                    );
                    return fail_run_start(
                        &state.coord,
                        &state.db,
                        &row.id,
                        &msg,
                        ApiError::Internal(anyhow::anyhow!(msg.clone())),
                        StartFailedAt::BeforeEnqueue,
                    )
                    .await;
                }
                crate::grpc::coordinator::PoolReservation::Reserved { workers, counts } => {
                    let n_pool = workers.len() as u32;
                    // R14: unique floor — reject before enqueue (assignment moved in).
                    // Release reservation first so workers return to idle without reconnecting.
                    if let Some((rows, n)) = pool_unique_floor_violation(&assignment, n_pool) {
                        let msg = format!(
                            "unique 데이터셋 행 수가 풀 워커 수보다 적습니다: rows={rows} < workers={n}"
                        );
                        state.coord.release_pool_reservation(&workers).await;
                        return fail_run_start(
                            &state.coord,
                            &state.db,
                            &row.id,
                            &msg,
                            ApiError::BadRequest(msg.clone()),
                            StartFailedAt::BeforeEnqueue,
                        )
                        .await;
                    }
                    state
                        .coord
                        .enqueue(
                            row.id.clone(),
                            assignment,
                            n_pool,
                            total_vus,
                            Some(counts),
                            startup_grace,
                            backstop_total,
                        )
                        .await;
                    if let Some(done) = row_if_no_longer_pending(state, &row.id, &workers).await? {
                        return Ok(done);
                    }
                    if state
                        .coord
                        .assign_pool_workers(&row.id, workers)
                        .await
                        .is_err()
                    {
                        return fail_pool_assignment(&state.coord, &state.db, &row.id).await;
                    }
                    return Ok(row);
                }
            }
        } else {
            // Legacy pool path: ?force (any mode) OR vu-curve (single-worker v1).
            // Even split via register's shard_split (precomputed None) = byte-identical L1.
            let n_cap: usize = if profile.is_vu_curve() {
                profile.vu_curve_max() as usize // R6: force curve fans out (even-split), was 1
            } else if profile.is_open_loop() {
                let slots = profile.max_in_flight.unwrap_or(1);
                let rate = profile.target_rps.unwrap_or_else(|| {
                    profile
                        .stages
                        .as_deref()
                        .unwrap_or_default()
                        .iter()
                        .map(|s| s.target)
                        .max()
                        .unwrap_or(1)
                });
                (slots as usize).min(rate as usize)
            } else {
                profile.vus as usize
            };
            let reserved = state.coord.reserve_idle_pool(&row.id, n_cap).await;
            let n_pool = reserved.len() as u32;
            if n_pool == 0 {
                let msg = "연결된 LAN 워커가 없습니다 — 워커를 1대 이상 띄우세요".to_string();
                return fail_run_start(
                    &state.coord,
                    &state.db,
                    &row.id,
                    &msg,
                    ApiError::BadRequest(msg.clone()),
                    StartFailedAt::BeforeEnqueue,
                )
                .await;
            }
            // R14: unique floor — reject before enqueue (assignment moved in).
            // Release reservation first so workers return to idle without reconnecting.
            if let Some((rows, n)) = pool_unique_floor_violation(&assignment, n_pool) {
                let msg = format!(
                    "unique 데이터셋 행 수가 풀 워커 수보다 적습니다: rows={rows} < workers={n}"
                );
                state.coord.release_pool_reservation(&reserved).await;
                return fail_run_start(
                    &state.coord,
                    &state.db,
                    &row.id,
                    &msg,
                    ApiError::BadRequest(msg.clone()),
                    StartFailedAt::BeforeEnqueue,
                )
                .await;
            }
            state
                .coord
                .enqueue(
                    row.id.clone(),
                    assignment,
                    n_pool,
                    total_vus,
                    None,
                    startup_grace,
                    backstop_total,
                )
                .await;
            if let Some(done) = row_if_no_longer_pending(state, &row.id, &reserved).await? {
                return Ok(done);
            }
            if state
                .coord
                .assign_pool_workers(&row.id, reserved)
                .await
                .is_err()
            {
                return fail_pool_assignment(&state.coord, &state.db, &row.id).await;
            }
            return Ok(row);
        }
    }

    state
        .coord
        .enqueue(
            row.id.clone(),
            assignment,
            n,
            total_vus,
            None,
            startup_grace,
            backstop_total,
        )
        .await;
    if let Some(done) = row_if_no_longer_pending(state, &row.id, &[]).await? {
        return Ok(done);
    }

    // Dispatch N workers (subprocess: N children; K8s: 1 Job, Indexed in A3c).
    // Dispatch failure (missing worker binary, K8s Job creation denied, cluster
    // unreachable) is an authoritative run-start failure: tear down the enqueued
    // coordinator state, mark the run `failed` with the cause, and surface a 5xx
    // — instead of returning 201 and letting the 60s watchdog fail it anonymously
    // (codex eval, item 2). Failure goes through `fail_run_start`: an active run
    // becomes `failed` with the cause and the call returns 5xx; a run that was
    // already aborted is returned as it is.
    if let Err(e) = state.dispatcher.dispatch(&row.id, n).await {
        let message = format!("failed to dispatch workers: {e}");
        tracing::error!(run_id = %row.id, error = %e, "worker dispatch failed");
        return fail_run_start(
            &state.coord,
            &state.db,
            &row.id,
            &message,
            ApiError::Internal(anyhow::anyhow!(message.clone())),
            StartFailedAt::AfterEnqueue,
        )
        .await;
    }

    Ok(row)
}

pub async fn create(
    State(state): State<AppState>,
    // Query MUST precede Json (axum: body extractor must be last). (L3 R4.)
    axum::extract::Query(q): axum::extract::Query<ForceQuery>,
    Json(mut body): Json<CreateRunRequest>,
) -> Result<(StatusCode, Json<RunResponse>), ApiError> {
    let scenario = scenarios::get(&state.db, &body.scenario_id)
        .await?
        .ok_or(ApiError::NotFound)?;

    crate::stair::normalize_stair(&mut body.profile).map_err(ApiError::BadRequest)?;
    crate::steady::normalize_steady(&mut body.profile).map_err(ApiError::BadRequest)?;
    let validated_meta = validate_run_config(&state, &body.profile).await?;
    validate_step_criteria_targets(&body.profile, &scenario.yaml).map_err(ApiError::BadRequest)?;
    let label = normalize_label(body.label).map_err(ApiError::BadRequest)?;

    let row = spawn_run(
        &state,
        &scenario,
        &body.profile,
        validated_meta,
        &body.env,
        q.force,
        label.as_deref(),
    )
    .await?;

    Ok((StatusCode::CREATED, Json(to_response(row, None))))
}

pub async fn get(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<RunResponse>, ApiError> {
    let row = runs::get(&state.db, &id).await?.ok_or(ApiError::NotFound)?;
    // 계단 아닌 run·끝난 run은 coordinator를 조회하지 않는다.
    let live = if row.status == RunStatus::Running && row.profile.stair.is_some() {
        state.coord.live_of(&id).await
    } else {
        None
    };
    let setup_live = if row.status == RunStatus::Running {
        crate::store::section::section_outcome_totals(
            &state.db,
            &id,
            handicap_engine::Section::Setup.as_str(),
        )
        .await?
    } else {
        None
    };
    let mut resp = to_response(row, None);
    resp.auto_stop_live = live;
    resp.setup_live = setup_live.map(|t| SetupLive {
        ok: t.ok.max(0) as u64,
        failed: t.failed.max(0) as u64,
        interrupted: t.interrupted.max(0) as u64,
    });
    Ok(Json(resp))
}

#[derive(Debug, serde::Deserialize)]
pub struct UpdateLabelRequest {
    #[serde(default)]
    pub label: Option<String>, // 키 부재·null 동일 = 라벨 제거 (spec §4.3)
}

/// 사후 편집(US4): `PUT /api/runs/{id}/label`. `normalize_label`을 create와
/// 공유(trim→빈=None, 200자 초과=400). 미존재 id는 404.
pub async fn update_label(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(body): Json<UpdateLabelRequest>,
) -> Result<Json<RunResponse>, ApiError> {
    let label = normalize_label(body.label).map_err(ApiError::BadRequest)?;
    let row = runs::update_label(&state.db, &id, label.as_deref())
        .await?
        .ok_or(ApiError::NotFound)?;
    Ok(Json(to_response(row, None)))
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
///
/// `basis: None` selects the default basis. For a run with `steady` whose steady
/// window exists the default is the steady report; otherwise (window empty) it is
/// the whole-run report. For a run without `steady` the argument is ignored and the
/// report has no `basis` block.
pub async fn build_report_for_run(
    db: &crate::store::Db,
    run_id: &str,
    basis: Option<crate::steady::Basis>,
    sample: Option<crate::sample::Sample>,
) -> Result<crate::report::ReportJson, ApiError> {
    build_reports_for_run(db, run_id, basis, sample)
        .await
        .map(|(r, _)| r)
}

/// `build_report_for_run`과 같은 리포트(첫째)에 더해, `steady` 구간이 있는 run이면
/// 반대 기준의 리포트 전체(둘째)를 함께 돌려준다. 둘째는 반대 `?basis=`로 받은
/// 리포트와 JSON이 같다. `steady`가 없는 run은 둘째가 `None`이다.
pub async fn build_reports_for_run(
    db: &crate::store::Db,
    run_id: &str,
    basis: Option<crate::steady::Basis>,
    sample: Option<crate::sample::Sample>,
) -> Result<(crate::report::ReportJson, Option<crate::report::ReportJson>), ApiError> {
    let row = runs::get(db, run_id).await?.ok_or(ApiError::NotFound)?;
    let rows = crate::store::metrics::windows_with_hdr(db, run_id).await?;
    let loops = crate::store::metrics::loop_breakdown(db, run_id).await?;
    let branches = crate::store::metrics::if_breakdown(db, run_id).await?;
    let groups = crate::store::metrics::group_breakdown(db, run_id).await?;
    let phases = crate::store::metrics::phase_breakdown(db, run_id).await?;
    let active_vu = crate::store::metrics::active_vu_series(db, run_id).await?;
    // Per-worker breakdown is curve-only — skip the query entirely for non-curve runs.
    let active_vu_by_worker = if row.profile.is_vu_curve() {
        crate::store::metrics::active_vu_by_worker(db, run_id).await?
    } else {
        Vec::new()
    };
    let error_kinds = crate::store::metrics::error_kind_breakdown(db, run_id).await?;
    let loop_exits = crate::store::metrics::loop_exit_breakdown(db, run_id).await?;
    // 계단 run만 초 단위 계수·워커 시작 시각을 읽는다(비계단 run은 조회 0회).
    let stair_inputs = if row.profile.stair.is_some() {
        crate::stair::StairInputs {
            open_loop: crate::store::open_loop::open_loop_seconds(db, run_id).await?,
            starts: crate::store::open_loop::worker_starts(db, run_id).await?,
            // 기록은 completed일 때만 의미 — aborted 행엔 경합으로 남은 기록이 있을 수 있다.
            auto_stop: row
                .auto_stop
                .clone()
                .filter(|_| row.status == RunStatus::Completed),
        }
    } else {
        crate::stair::StairInputs::default()
    };
    // 유지 구간 run만 워커 시작 시각을 읽고, open-loop이면 초 단위 계수도 읽는다(없는 run은 조회 0회).
    let steady_inputs = match row.profile.steady.clone() {
        Some(cfg) => {
            let starts = crate::store::open_loop::worker_starts(db, run_id).await?;
            let open_loop_rows = if row.profile.is_open_loop() {
                crate::store::open_loop::open_loop_seconds(db, run_id).await?
            } else {
                Vec::new()
            };
            Some((cfg, starts, open_loop_rows))
        }
        None => None,
    };
    // 초별 합계는 버림이 있는 open-loop run만(stall 진단 입력). 계단·유지 구간 run은 이미 읽은 행을 더한다.
    let open_loop_totals = if needs_open_loop_totals(&row.profile, row.dropped) {
        if row.profile.stair.is_some() {
            crate::store::open_loop::sum_by_second(&stair_inputs.open_loop)
        } else if let Some((_, _, open_loop_rows)) = &steady_inputs {
            crate::store::open_loop::sum_by_second(open_loop_rows)
        } else {
            crate::store::open_loop::open_loop_totals(db, run_id).await?
        }
    } else {
        Vec::new()
    };
    let scenario_yaml = row.scenario_yaml.clone();
    // 준비 스텝이 있는 시나리오만 구간 통계 두 표를 읽는다(없으면 조회 0회).
    let parsed = handicap_engine::Scenario::from_yaml(&scenario_yaml).ok();
    let setup_steps = parsed.as_ref().map_or(&[][..], |sc| sc.setup_steps());
    let (section_steps, section_outcomes) = if setup_steps.is_empty() {
        (Vec::new(), Vec::new())
    } else {
        (
            crate::store::section::section_steps(db, run_id).await?,
            crate::store::section::section_outcomes(db, run_id).await?,
        )
    };
    let setup_report =
        crate::report::build_setup_report(setup_steps, &section_steps, &section_outcomes);
    let build = |scope: Option<&crate::report::SteadyScope<'_>>| {
        crate::report::build_report(
            &row,
            &scenario_yaml,
            &rows,
            &loops,
            &branches,
            &groups,
            &phases,
            &active_vu,
            &active_vu_by_worker,
            &error_kinds,
            &loop_exits,
            &stair_inputs,
            &open_loop_totals,
            setup_report.as_ref(),
            scope,
            sample,
        )
    };
    let whole = build(None);
    let Some((cfg, starts, open_loop_rows)) = steady_inputs else {
        return Ok((whole, None));
    };

    use crate::steady::{Basis, BasisBlock, BasisOther, BasisWindow};
    let spans = crate::steady::worker_spans(&rows);
    // 준비 완료 시각은 VU 고정 부하에서만 유지 구간 시작을 민다(open-loop·VU 곡선은 그대로).
    let mut setup_done: std::collections::HashMap<&str, i64> = std::collections::HashMap::new();
    if !row.profile.is_open_loop() && !row.profile.is_vu_curve() {
        let setup = handicap_engine::Section::Setup.as_str();
        for o in section_outcomes
            .iter()
            .filter(|o| o.section == setup && o.last_done_ms > 0)
        {
            let e = setup_done.entry(o.worker_id.as_str()).or_insert(0);
            *e = (*e).max(o.last_done_ms);
        }
    }
    let w = crate::steady::steady_window_from_spans(
        &cfg,
        row.status == RunStatus::Completed,
        row.ended_at,
        &spans,
        &starts,
        &setup_done,
    );
    let mut dropped_whole_run = false;
    let steady_report = w.range.map(|(lo, hi)| {
        let warmup_seconds = row
            .profile
            .criteria
            .as_ref()
            .and_then(|c| c.rps_warmup_seconds)
            .unwrap_or(0)
            .saturating_sub(cfg.ramp_seconds + cfg.discard_seconds);
        let target = cfg.target.or(row.profile.target_rps);
        let in_window = || {
            open_loop_rows
                .iter()
                .filter(move |r| r.ts_second >= lo && r.ts_second < hi)
        };
        let counted_workers: std::collections::HashSet<&str> = open_loop_rows
            .iter()
            .map(|r| r.worker_id.as_str())
            .collect();
        let recountable = spans.keys().all(|w| counted_workers.contains(w));
        dropped_whole_run = row.profile.is_open_loop() && !recountable;
        let totals = if recountable {
            crate::store::open_loop::sum_by_second(in_window())
        } else {
            Vec::new()
        };
        let open_loop = target.filter(|_| row.profile.is_open_loop()).map(|target| {
            crate::report::ScopedOpenLoop {
                target,
                dropped: recountable.then(|| in_window().map(|r| r.dropped.max(0) as u64).sum()),
                totals: &totals,
            }
        });
        let scope = crate::report::SteadyScope {
            lo,
            hi,
            warmup_seconds,
            open_loop,
            whole: &whole,
        };
        build(Some(&scope))
    });

    let default = if steady_report.is_some() {
        Basis::Steady
    } else {
        Basis::Whole
    };
    let selected = match (basis.unwrap_or(default), steady_report.is_some()) {
        (Basis::Steady, false) => Basis::Whole,
        (b, _) => b,
    };
    let other_of = |s: &crate::report::ReportSummary| BasisOther {
        rps: s.rps,
        p50_ms: s.p50_ms,
        p95_ms: s.p95_ms,
        p99_ms: s.p99_ms,
        error_rate: if s.count == 0 {
            0.0
        } else {
            s.errors as f64 / s.count as f64
        },
        count: s.count,
        duration_seconds: s.duration_seconds,
        stats: s.stats,
    };
    let block = |selected: Basis, other: Option<BasisOther>| BasisBlock {
        selected,
        default,
        state: w.state,
        config: cfg.clone(),
        window: w.range.map(|(lo, hi)| BasisWindow {
            start_ms: lo * 1000,
            end_ms: hi * 1000,
            measured_seconds: hi - lo,
        }),
        t0_estimated: w.t0_estimated,
        dropped_whole_run,
        other,
    };
    let Some(mut steady) = steady_report else {
        let mut whole = whole;
        whole.basis = Some(block(selected, None));
        return Ok((whole, None));
    };
    let mut whole = whole;
    let steady_other = other_of(&steady.summary);
    let whole_other = other_of(&whole.summary);
    steady.basis = Some(block(Basis::Steady, Some(whole_other)));
    whole.basis = Some(block(Basis::Whole, Some(steady_other)));
    Ok(match selected {
        Basis::Steady => (steady, Some(whole)),
        Basis::Whole => (whole, Some(steady)),
    })
}

fn needs_open_loop_totals(profile: &Profile, dropped: i64) -> bool {
    profile.is_open_loop() && dropped > 0
}

#[derive(Deserialize)]
pub struct ReportParams {
    basis: Option<String>,
    sample: Option<String>,
}

fn parse_sample(raw: Option<&str>) -> Result<Option<crate::sample::Sample>, ApiError> {
    use crate::sample::Sample;
    match raw {
        None => Ok(None),
        Some("passed") => Ok(Some(Sample::Passed)),
        Some("failed") => Ok(Some(Sample::Failed)),
        Some("all") => Ok(Some(Sample::All)),
        Some(_) => Err(ApiError::BadRequest(
            "sample은 passed, failed, all 중 하나여야 합니다".into(),
        )),
    }
}

fn parse_basis(raw: Option<&str>) -> Result<Option<crate::steady::Basis>, ApiError> {
    match raw {
        None => Ok(None),
        Some("steady") => Ok(Some(crate::steady::Basis::Steady)),
        Some("whole") => Ok(Some(crate::steady::Basis::Whole)),
        Some(_) => Err(ApiError::BadRequest(
            "basis는 steady 또는 whole이어야 합니다".into(),
        )),
    }
}

pub async fn report(
    State(state): State<AppState>,
    Path(id): Path<String>,
    axum::extract::Query(params): axum::extract::Query<ReportParams>,
) -> Result<Json<crate::report::ReportJson>, ApiError> {
    let basis = parse_basis(params.basis.as_deref())?;
    let sample = parse_sample(params.sample.as_deref())?;
    Ok(Json(
        build_report_for_run(&state.db, &id, basis, sample).await?,
    ))
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

/// 내보내기 파일 이름 뼈대. `basis` 블록이 있는 리포트(= `steady` run)에만
/// 고른 기준(`steady`/`whole`)을 붙인다.
fn export_stem(id: &str, kind: &str, report: &crate::report::ReportJson) -> String {
    match &report.basis {
        None => format!("run-{id}-{kind}"),
        Some(b) => {
            let tag = match b.selected {
                crate::steady::Basis::Steady => "steady",
                crate::steady::Basis::Whole => "whole",
            };
            format!("run-{id}-{kind}-{tag}")
        }
    }
}

pub async fn report_csv(
    State(state): State<AppState>,
    Path(id): Path<String>,
    axum::extract::Query(params): axum::extract::Query<ReportParams>,
) -> Result<axum::response::Response, ApiError> {
    let basis = parse_basis(params.basis.as_deref())?;
    let row = runs::get(&state.db, &id).await?.ok_or(ApiError::NotFound)?;
    ensure_terminal(&row)?;
    let report = build_report_for_run(&state.db, &id, basis, None).await?;
    let bytes = crate::export::report_to_csv(&report);
    Ok(file_response(
        "text/csv; charset=utf-8",
        &format!("{}.csv", export_stem(&id, "report", &report)),
        bytes,
    ))
}

pub async fn report_xlsx(
    State(state): State<AppState>,
    Path(id): Path<String>,
    axum::extract::Query(params): axum::extract::Query<ReportParams>,
) -> Result<axum::response::Response, ApiError> {
    let basis = parse_basis(params.basis.as_deref())?;
    let row = runs::get(&state.db, &id).await?.ok_or(ApiError::NotFound)?;
    ensure_terminal(&row)?;
    let (report, other) = build_reports_for_run(&state.db, &id, basis, None).await?;
    let bytes = crate::export::report_to_xlsx(&report, other.as_ref());
    Ok(file_response(
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        &format!("{}.xlsx", export_stem(&id, "report", &report)),
        bytes,
    ))
}

pub async fn report_insights_csv(
    State(state): State<AppState>,
    Path(id): Path<String>,
    axum::extract::Query(params): axum::extract::Query<ReportParams>,
) -> Result<axum::response::Response, ApiError> {
    let basis = parse_basis(params.basis.as_deref())?;
    let row = runs::get(&state.db, &id).await?.ok_or(ApiError::NotFound)?;
    ensure_terminal(&row)?;
    let report = build_report_for_run(&state.db, &id, basis, None).await?;
    let bytes = crate::export::report_to_insights_csv(&report);
    Ok(file_response(
        "text/csv; charset=utf-8",
        &format!("{}.csv", export_stem(&id, "insights", &report)),
        bytes,
    ))
}

pub async fn report_stairs_csv(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<axum::response::Response, ApiError> {
    let row = runs::get(&state.db, &id).await?.ok_or(ApiError::NotFound)?;
    ensure_terminal(&row)?;
    let report = build_report_for_run(&state.db, &id, None, None).await?;
    let bytes = crate::export::report_to_stairs_csv(&report).ok_or(ApiError::NotFound)?;
    Ok(file_response(
        "text/csv; charset=utf-8",
        &format!("run-{id}-stairs.csv"),
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
        reports.push(build_report_for_run(&state.db, id, None, None).await?);
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

pub async fn compare_insights_csv(
    State(state): State<AppState>,
    Path(scenario_id): Path<String>,
    axum::extract::Query(params): axum::extract::Query<CompareParams>,
) -> Result<axum::response::Response, ApiError> {
    // 인사이트는 run간 delta 의미가 없어 baseline 인덱스를 쓰지 않는다(long-format).
    // resolve_comparison의 baseline ∈ run_ids 게이트는 그대로 재사용.
    let (reports, _base) = resolve_comparison(&state, &scenario_id, &params).await?;
    let bytes = crate::export::comparison_to_insights_csv(&reports);
    Ok(file_response(
        "text/csv; charset=utf-8",
        "comparison-insights.csv",
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
    let last_ts =
        crate::store::metrics::last_metric_ts_by_scenario(&state.db, &scenario_id).await?;
    Ok(Json(RunListResponse {
        runs: rows
            .into_iter()
            .map(|r| {
                let lt = if matches!(r.status, RunStatus::Running) {
                    last_ts.get(&r.id).copied()
                } else {
                    None
                };
                to_response(r, lt)
            })
            .collect(),
    }))
}

const POOL_ASSIGN_FAILED_MSG: &str = "풀 워커 배정 실패(워커 이탈) — 재시도하세요";
const RUN_START_READ_FAILED_MSG: &str = "실행 시작 확인 중 저장소 읽기에 실패했습니다";

/// 생성 실패가 `enqueue` 전인지 후인지.
#[derive(Clone, Copy, PartialEq, Eq)]
enum StartFailedAt {
    BeforeEnqueue,
    AfterEnqueue,
}

/// 생성 실패 처리. 활성 행이면 `failed` + `reason` 뒤 `err`. 이미 `aborted`면 그 행
/// (`BeforeEnqueue`면 빈 사유에 `ABORT_MSG_NOT_STARTED`를 채운 뒤). 그 밖은 `err`.
async fn fail_run_start(
    coord: &crate::grpc::coordinator::CoordinatorState,
    db: &crate::store::Db,
    run_id: &str,
    reason: &str,
    err: ApiError,
    at: StartFailedAt,
) -> Result<runs::RunRow, ApiError> {
    coord.cancel_dispatch_failed(run_id).await;
    if runs::mark_failed_if_active(db, run_id, reason).await? {
        return Err(err);
    }
    if at == StartFailedAt::BeforeEnqueue {
        runs::set_abort_reason_if_absent(db, run_id, runs::ABORT_MSG_NOT_STARTED).await?;
    }
    match runs::get(db, run_id).await? {
        Some(row) if row.status == runs::RunStatus::Aborted => {
            tracing::info!(
                run_id,
                reason,
                "생성 실패 도중 중단된 run — 중단된 행을 돌려준다"
            );
            Ok(row)
        }
        _ => Err(err),
    }
}

/// 풀 배정 실패 처리(`enqueue` 뒤). 행이 `aborted`면 그 행, 아니면 오류. 이미 끝난 run은 덮어쓰지 않는다.
async fn fail_pool_assignment(
    coord: &crate::grpc::coordinator::CoordinatorState,
    db: &crate::store::Db,
    run_id: &str,
) -> Result<runs::RunRow, ApiError> {
    fail_run_start(
        coord,
        db,
        run_id,
        POOL_ASSIGN_FAILED_MSG,
        ApiError::Internal(anyhow::anyhow!(POOL_ASSIGN_FAILED_MSG)),
        StartFailedAt::AfterEnqueue,
    )
    .await
}

/// `enqueue` 뒤·디스패치 앞에서 부른다. 행이 더는 `pending`이 아니면 풀 예약을 풀고(`reserved`가
/// 비어 있지 않으면) 코디네이터 항목을 정리하고(`aborted`면 시작 전 사유를 남기고) 다시 읽은 행을
/// 돌려준다. `pending`이면 None. 행 읽기가 실패해도 같은 정리를 하고, 가드 UPDATE로 `failed` 표시를
/// 시도한 뒤(결과 무시) 오류를 돌려준다.
async fn row_if_no_longer_pending(
    state: &AppState,
    run_id: &str,
    reserved: &[(String, crate::grpc::coordinator::WorkerTx)],
) -> Result<Option<runs::RunRow>, ApiError> {
    let status = runs::status_of(&state.db, run_id).await;
    if let Ok(Some(RunStatus::Pending)) = &status {
        return Ok(None);
    }
    if !reserved.is_empty() {
        state.coord.release_pool_reservation(reserved).await;
    }
    state.coord.cancel_dispatch_failed(run_id).await;
    if status.is_err() {
        // 행이 pending으로 남으면 감시견도 없다 — 가드 UPDATE로 실패 처리한다.
        let _ = runs::mark_failed_if_active(&state.db, run_id, RUN_START_READ_FAILED_MSG).await;
    }
    if let Ok(Some(RunStatus::Aborted)) = &status {
        runs::set_abort_reason_if_absent(&state.db, run_id, runs::ABORT_MSG_NOT_STARTED).await?;
    }
    status?;
    Ok(Some(
        runs::get(&state.db, run_id)
            .await?
            .ok_or(ApiError::NotFound)?,
    ))
}

pub async fn abort_run(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<axum::http::StatusCode, ApiError> {
    // 가드 UPDATE가 먼저다: 끝난 run의 상태는 덮지 않는다.
    if !runs::abort_if_active(&state.db, &id).await? {
        let row = runs::get(&state.db, &id).await?.ok_or(ApiError::NotFound)?;
        return Err(ApiError::Conflict(format!(
            "run is {} and cannot be aborted",
            row.status.as_str()
        )));
    }
    let reason = match state.coord.abort(&id).await {
        AbortOutcome::NotStarted => Some(runs::ABORT_MSG_NOT_STARTED.to_string()),
        AbortOutcome::Marked {
            registered,
            expected,
        } if registered < expected => Some(runs::abort_msg_partial(registered, expected)),
        _ => None,
    };
    if let Some(reason) = reason {
        if let Err(e) = runs::set_abort_reason_if_absent(&state.db, &id, &reason).await {
            tracing::warn!(run_id = %id, error = %e, "abort reason write failed; run is already aborted");
        }
    }
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

fn to_response(r: runs::RunRow, last_metric_ts: Option<i64>) -> RunResponse {
    let auto_stop = if r.status == RunStatus::Completed {
        r.auto_stop
    } else {
        None
    };
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
        verdict: r.verdict,
        last_metric_ts,
        label: r.label,
        auto_stop,
        auto_stop_live: None,
        setup_live: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app::AppState;
    use crate::binding::{BindingPolicy, DataBinding};
    use crate::grpc::coordinator::CoordinatorState;
    use crate::settings::SettingsState;
    use crate::store::runs::Profile;
    use std::sync::Arc;

    #[test]
    fn validates_loop_breakdown_cap_bounds() {
        let max = 10_000;
        assert!(super::loop_cap_ok(0, max)); // off allowed
        assert!(super::loop_cap_ok(256, max));
        assert!(super::loop_cap_ok(10_000, max));
        assert!(!super::loop_cap_ok(10_001, max)); // over cap rejected
    }

    #[test]
    fn normalize_label_table() {
        assert_eq!(normalize_label(None), Ok(None));
        assert_eq!(normalize_label(Some("".into())), Ok(None));
        assert_eq!(normalize_label(Some("  ".into())), Ok(None));
        assert_eq!(normalize_label(Some("  x  ".into())), Ok(Some("x".into())));
        let two_hundred: String = "가".repeat(200);
        assert_eq!(
            normalize_label(Some(two_hundred.clone())),
            Ok(Some(two_hundred))
        );
        assert!(normalize_label(Some("가".repeat(201))).is_err());
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

    #[test]
    fn leading_idle_only_counts_leading_zeros() {
        let z = |t: u32, d: u32| pb::Stage {
            target: t,
            duration_seconds: d,
        };
        let p = pb::Profile {
            stages: vec![z(0, 5), z(0, 3), z(100, 10), z(0, 2)],
            ..Default::default()
        };
        assert_eq!(super::leading_idle_secs(&p), 8); // 선두 0,0 만, 중간 0은 제외
    }

    #[test]
    fn startup_grace_floor_respects_http_timeout_and_idle() {
        // floor 90s vs http_timeout 600 + margin 15 = 615 → 615 채택, + leading idle 0
        let p = pb::Profile {
            http_timeout_seconds: 600,
            ..Default::default()
        };
        assert_eq!(
            super::startup_grace_eff(&p, std::time::Duration::from_secs(90), 1),
            std::time::Duration::from_secs(615)
        );
        // http_timeout 작으면(30) floor 90 채택 + leading idle 20
        let p2 = pb::Profile {
            http_timeout_seconds: 30,
            stages: vec![
                pb::Stage {
                    target: 0,
                    duration_seconds: 20,
                },
                pb::Stage {
                    target: 50,
                    duration_seconds: 10,
                },
            ],
            ..Default::default()
        };
        assert_eq!(
            super::startup_grace_eff(&p2, std::time::Duration::from_secs(90), 1),
            // + 첫 양 stage(T=50,D=10,N=1)의 첫 도착 지연 ceil(sqrt(10/50))=1
            std::time::Duration::from_secs(90 + 20 + 1)
        );
    }

    #[test]
    fn curve_first_arrival_bounds_slow_ramps() {
        let st = |t: u32, d: u32| pb::Stage {
            target: t,
            duration_seconds: d,
        };
        // (open-loop stages, vu_stages, target_rps, N) -> expected secs
        type Case = (Vec<pb::Stage>, Vec<pb::Stage>, Option<u32>, u32, u64);
        let cases: Vec<Case> = vec![
            (vec![st(2, 21600)], vec![], None, 1, 104), // §B34 회귀 케이스
            (vec![st(8, 21600)], vec![], None, 4, 104), // fan-out: 워커당 2 rps
            (vec![st(0, 30), st(2, 21600)], vec![], None, 1, 104), // 선두 idle 제외
            (vec![st(1, 5)], vec![], None, 3, 4),       // min(5, ceil(sqrt(15)))
            (vec![st(1, 2)], vec![], None, 10, 2),      // D로 cap
            (vec![st(100, 10)], vec![], None, 1, 1),    // ceil(sqrt(0.1))
            (vec![st(0, 10)], vec![], None, 1, 0),      // 전부 0
            (vec![], vec![], None, 1, 0),               // fixed/closed
            (vec![], vec![st(2, 21600)], None, 1, 0),   // VU 곡선
        ];
        for (stages, vu_stages, rps, n, want) in cases {
            let p = pb::Profile {
                stages: stages.clone(),
                vu_stages: vu_stages.clone(),
                target_rps: rps,
                ..Default::default()
            };
            assert_eq!(
                super::curve_first_arrival_secs(&p, n),
                want,
                "stages={stages:?} vu_stages={vu_stages:?} n={n}"
            );
        }
        let p = pb::Profile {
            http_timeout_seconds: 30,
            stages: vec![st(2, 21600)],
            ..Default::default()
        };
        assert_eq!(
            super::startup_grace_eff(&p, std::time::Duration::from_secs(90), 1),
            std::time::Duration::from_secs(90 + 104)
        );
    }

    async fn state_with(db: crate::store::Db, capacity: u32) -> AppState {
        AppState {
            db: db.clone(),
            coord: CoordinatorState::new(db.clone()),
            dispatcher: Arc::new(crate::dispatcher::subprocess::SubprocessDispatcher::new(
                "worker".to_string(),
                "127.0.0.1:1".parse().unwrap(),
                db,
            )),
            ui_dir: None,
            settings: SettingsState::seeded_for_test_with(&[(
                "worker_capacity_vus",
                capacity as i64,
            )]),
            scheduler_tz: chrono_tz::UTC,
            monitor: crate::monitor::MonitorSupervisor::default(),
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
            data_bindings: vec![],
            criteria: None,
            think_time: None,
            think_seed: None,
            target_rps: None,
            max_in_flight: None,
            stages: None,
            measure_phases: false,
            vu_stages: None,
            ramp_down: None,
            graceful_ramp_down_seconds: None,
            connect_timeout_seconds: None,
            worker_count: None,
            apply_scenario_think_time: true,
            stair: None,
            steady: None,
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
    fn validate_criteria_new_time_fields() {
        use crate::store::runs::{Criteria, Criterion, PercentileLimit};
        let pl = |p: f64, m: f64| PercentileLimit {
            percentile: p,
            max_ms: m,
        };
        let step = |metric: &str, th: f64| Criteria {
            step_criteria: vec![Criterion {
                metric: metric.into(),
                op: "max".into(),
                threshold: th,
                target: "a".into(),
            }],
            ..Default::default()
        };
        let ok: Vec<Criteria> = vec![
            Criteria {
                max_mean_ms: Some(3000.0),
                ..Default::default()
            },
            Criteria {
                max_max_ms: Some(60000.0),
                ..Default::default()
            },
            Criteria {
                max_percentiles_ms: vec![pl(90.0, 2500.0), pl(99.9, 8000.0)],
                ..Default::default()
            },
            step("mean_ms", 1200.5),
            step("max_ms", 1200.5),
            step("p90_ms", 1200.5),
            step("p99.9_ms", 1200.5),
            step("p95_ms", 70000.0), // 기존 항목은 면제
        ];
        for (i, c) in ok.iter().enumerate() {
            assert!(
                validate_criteria(c).is_ok(),
                "ok[{i}]: {:?}",
                validate_criteria(c)
            );
        }
        let mean = |v: f64| Criteria {
            max_mean_ms: Some(v),
            ..Default::default()
        };
        let list = |v: Vec<PercentileLimit>| Criteria {
            max_percentiles_ms: v,
            ..Default::default()
        };
        let bad: Vec<(Criteria, &str)> = vec![
            (mean(60000.5), "60000"),
            (mean(-1.0), "60000"),
            (mean(f64::NAN), "60000"),
            (mean(1.0005), "소수 셋째 자리"),
            (
                list((0..11).map(|i| pl(10.0 + i as f64, 1.0)).collect()),
                "10개까지",
            ),
            (list(vec![pl(90.0, 1.0), pl(90.0, 2.0)]), "같은 백분위"),
            (list(vec![pl(95.0, 1.0)]), "위의 최대 p95 칸을 쓰세요"),
            (list(vec![pl(100.0, 1.0)]), "percentile"),
            (list(vec![pl(0.0, 1.0)]), "percentile"),
            (step("p90.0_ms", 1.0), "metric"),
            (step("p100_ms", 1.0), "metric"),
            (step("median_ms", 1.0), "metric"),
            (step("mean_ms", 60001.0), "60000"),
        ];
        for (i, (c, want)) in bad.iter().enumerate() {
            let e = validate_criteria(c).expect_err(&format!("bad[{i}] should fail"));
            assert!(e.contains(want), "bad[{i}]: {e}");
        }
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

    #[test]
    fn validate_criteria_rejects_bad_status_rate_and_window_rps() {
        use crate::store::runs::Criteria;
        // 4xx/5xx rate 범위 밖
        assert!(
            validate_criteria(&Criteria {
                max_5xx_rate: Some(1.5),
                ..Default::default()
            })
            .is_err()
        );
        assert!(
            validate_criteria(&Criteria {
                max_4xx_rate: Some(-0.1),
                ..Default::default()
            })
            .is_err()
        );
        assert!(
            validate_criteria(&Criteria {
                max_5xx_rate: Some(f64::NAN),
                ..Default::default()
            })
            .is_err()
        );
        // min_window_rps 음수/비유한
        assert!(
            validate_criteria(&Criteria {
                min_window_rps: Some(-1.0),
                ..Default::default()
            })
            .is_err()
        );
        assert!(
            validate_criteria(&Criteria {
                min_window_rps: Some(f64::INFINITY),
                ..Default::default()
            })
            .is_err()
        );
        // 정상값 통과(rate 0..1, count 임의 u64, warmup 임의 u32)
        assert!(
            validate_criteria(&Criteria {
                max_4xx_rate: Some(0.0),
                max_5xx_rate: Some(0.05),
                max_4xx_count: Some(0),
                max_5xx_count: Some(100),
                min_window_rps: Some(50.0),
                rps_warmup_seconds: Some(5),
                ..Default::default()
            })
            .is_ok()
        );
    }

    #[test]
    fn validate_criteria_step_ranges() {
        use crate::store::runs::{Criteria, Criterion};
        let mk = |metric: &str, op: &str, threshold: f64| Criteria {
            step_criteria: vec![Criterion {
                metric: metric.into(),
                op: op.into(),
                threshold,
                target: "A".into(),
            }],
            ..Default::default()
        };
        // 정상
        assert!(validate_criteria(&mk("p95_ms", "max", 300.0)).is_ok());
        assert!(validate_criteria(&mk("error_rate", "min", 0.0)).is_ok());
        // 미지원 metric
        assert!(validate_criteria(&mk("rps", "max", 1.0)).is_err());
        // 미지원 op
        assert!(validate_criteria(&mk("p95_ms", "lt", 1.0)).is_err());
        // rate > 1
        assert!(validate_criteria(&mk("4xx_rate", "max", 1.5)).is_err());
        // 음수 ms
        assert!(validate_criteria(&mk("p95_ms", "max", -1.0)).is_err());
        // NaN
        assert!(validate_criteria(&mk("p95_ms", "max", f64::NAN)).is_err());
        // 빈 target
        assert!(
            validate_criteria(&Criteria {
                step_criteria: vec![Criterion {
                    metric: "p95_ms".into(),
                    op: "max".into(),
                    threshold: 1.0,
                    target: "  ".into()
                }],
                ..Default::default()
            })
            .is_err()
        );
    }

    #[test]
    fn validate_step_criteria_targets_checks_http_leaf_existence() {
        use crate::store::runs::{Criteria, Criterion, Profile};
        // 중첩(loop do:) http leaf까지 잡혀야 한다.
        let yaml = r#"
version: 1
name: t
steps:
  - id: 0AAAAAAAAAAAAAAAAAAAAAAAA1
    type: http
    name: top
    request: { method: GET, url: "http://x/a" }
  - id: 0AAAAAAAAAAAAAAAAAAAAAAAA2
    type: loop
    name: lp
    repeat: 2
    do:
      - id: 0AAAAAAAAAAAAAAAAAAAAAAAA3
        type: http
        name: inner
        request: { method: GET, url: "http://x/b" }
"#;
        fn profile_with(criteria: Option<Criteria>) -> Profile {
            Profile {
                vus: 1,
                ramp_up_seconds: 0,
                duration_seconds: 1,
                loop_breakdown_cap: 256,
                http_timeout_seconds: 30,
                data_binding: None,
                data_bindings: vec![],
                criteria,
                think_time: None,
                think_seed: None,
                target_rps: None,
                max_in_flight: None,
                stages: None,
                measure_phases: false,
                vu_stages: None,
                ramp_down: None,
                graceful_ramp_down_seconds: None,
                connect_timeout_seconds: None,
                worker_count: None,
                apply_scenario_think_time: true,
                stair: None,
                steady: None,
            }
        }
        let mk = |target: &str| {
            profile_with(Some(Criteria {
                step_criteria: vec![Criterion {
                    metric: "p95_ms".into(),
                    op: "max".into(),
                    threshold: 1.0,
                    target: target.into(),
                }],
                ..Default::default()
            }))
        };
        // 최상위 http leaf OK
        assert!(validate_step_criteria_targets(&mk("0AAAAAAAAAAAAAAAAAAAAAAAA1"), yaml).is_ok());
        // 중첩 http leaf OK
        assert!(validate_step_criteria_targets(&mk("0AAAAAAAAAAAAAAAAAAAAAAAA3"), yaml).is_ok());
        // loop 컨테이너 id는 http leaf 아님 → 거부
        assert!(validate_step_criteria_targets(&mk("0AAAAAAAAAAAAAAAAAAAAAAAA2"), yaml).is_err());
        // 없는 id → 거부
        assert!(validate_step_criteria_targets(&mk("NOPE"), yaml).is_err());
        // step_criteria 비면 시나리오 파싱 없이 Ok(빈 yaml이어도)
        assert!(validate_step_criteria_targets(&profile_with(None), "").is_ok());
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
        let metas = validate_run_config(&state, &unique_profile(dataset_id, 2))
            .await
            .unwrap();
        assert!(
            !metas.is_empty(),
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
            data_bindings: vec![],
            criteria: None,
            http_timeout_seconds: 0,
            think_time: None,
            think_seed: None,
            target_rps: None,
            max_in_flight: None,
            stages: None,
            measure_phases: false,
            vu_stages: None,
            ramp_down: None,
            graceful_ramp_down_seconds: None,
            connect_timeout_seconds: None,
            worker_count: None,
            apply_scenario_think_time: true,
            stair: None,
            steady: None,
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
            data_bindings: vec![],
            criteria: None,
            think_time,
            think_seed: None,
            target_rps: None,
            max_in_flight: None,
            stages: None,
            measure_phases: false,
            vu_stages: None,
            ramp_down: None,
            graceful_ramp_down_seconds: None,
            connect_timeout_seconds: None,
            worker_count: None,
            apply_scenario_think_time: true,
            stair: None,
            steady: None,
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
            data_bindings: vec![],
            criteria: None,
            think_time: None,
            think_seed: None,
            target_rps: Some(100),
            max_in_flight: Some(16),
            stages: None,
            measure_phases: false,
            vu_stages: None,
            ramp_down: None,
            graceful_ramp_down_seconds: None,
            connect_timeout_seconds: None,
            worker_count: None,
            apply_scenario_think_time: true,
            stair: None,
            steady: None,
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
    async fn worker_count_validation() {
        let db = crate::store::connect("sqlite::memory:").await.unwrap();
        let state = state_with(db, 2000).await; // capacity는 worker_count 검증과 무관(직접 임계)

        // #1 worker_count는 open-loop 전용: closed-loop에 w>1 → Err
        let mut closed = ol_profile();
        closed.target_rps = None; // closed-loop
        closed.vus = 2;
        closed.max_in_flight = None;
        closed.worker_count = Some(2);
        assert!(validate_run_config(&state, &closed).await.is_err());

        // #2 범위: 0·65 → Err
        let mut w0 = ol_profile();
        w0.worker_count = Some(0);
        assert!(validate_run_config(&state, &w0).await.is_err());
        let mut w65 = ol_profile();
        w65.worker_count = Some(65);
        w65.max_in_flight = Some(65);
        w65.target_rps = Some(1000);
        assert!(validate_run_config(&state, &w65).await.is_err());

        // #3 슬롯 충분: max_in_flight < w → Err (w=3, mif=2)
        let mut slots = ol_profile(); // ol_profile: target_rps=Some, max_in_flight=Some
        slots.worker_count = Some(3);
        slots.max_in_flight = Some(2);
        slots.target_rps = Some(1000);
        assert!(validate_run_config(&state, &slots).await.is_err());

        // #4 레이트 충분(고정): target_rps < w → Err (w=3, rps=2)
        let mut rate = ol_profile();
        rate.worker_count = Some(3);
        rate.max_in_flight = Some(10);
        rate.target_rps = Some(2);
        assert!(validate_run_config(&state, &rate).await.is_err());

        // #5 open-loop + vus>0 → Err (리다이렉트)
        let mut volu = ol_profile();
        volu.vus = 1;
        assert!(validate_run_config(&state, &volu).await.is_err());

        // OK: open-loop + vus=0 + worker_count=2 + 충분한 slots/rate
        let mut ok = ol_profile();
        ok.worker_count = Some(2);
        ok.max_in_flight = Some(10);
        ok.target_rps = Some(1000);
        ok.vus = 0;
        assert!(validate_run_config(&state, &ok).await.is_ok());

        // OK: 곡선모드 stage.target < w 면제 (w=3, stages target 2)
        let mut curve = ol_profile();
        curve.target_rps = None;
        curve.duration_seconds = 0;
        curve.stages = Some(vec![handicap_engine::Stage {
            target: 2,
            duration_seconds: 5,
        }]);
        curve.max_in_flight = Some(10);
        curve.worker_count = Some(3);
        assert!(validate_run_config(&state, &curve).await.is_ok());

        // OK: closed-loop w=None·vus>0 무영향
        let mut closed_ok = ol_profile();
        closed_ok.target_rps = None;
        closed_ok.max_in_flight = None;
        closed_ok.vus = 2;
        closed_ok.worker_count = None;
        assert!(validate_run_config(&state, &closed_ok).await.is_ok());
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
    fn needs_open_loop_totals_gate() {
        let closed = Profile {
            target_rps: None,
            stages: None,
            ..ol_profile()
        };
        assert!(!needs_open_loop_totals(&closed, 5));
        let open = ol_profile();
        assert!(!needs_open_loop_totals(&open, 0));
        assert!(needs_open_loop_totals(&open, 1));
        let stages_only = Profile {
            target_rps: None,
            stages: Some(vec![handicap_engine::Stage {
                target: 100,
                duration_seconds: 5,
            }]),
            ..ol_profile()
        };
        assert!(needs_open_loop_totals(&stages_only, 1));
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

    // ── VU curve helpers ──────────────────────────────────────────────────────

    /// VU curve 검증용 base: ol_profile()에서 open-loop/closed-fixed 필드를 무효화.
    fn curve_profile(stages: Vec<handicap_engine::Stage>) -> Profile {
        Profile {
            vus: 0,
            duration_seconds: 0,
            ramp_up_seconds: 0,
            target_rps: None,
            max_in_flight: None,
            vu_stages: Some(stages),
            ..ol_profile()
        }
    }

    #[test]
    fn fanout_worker_count_vu_curve_uses_peak() {
        // vu_curve N = ceil(peak / capacity), peak = max(vu_stages.target).
        let p = curve_profile(vec![
            handicap_engine::Stage {
                target: 10,
                duration_seconds: 5,
            },
            handicap_engine::Stage {
                target: 50,
                duration_seconds: 5,
            },
        ]);
        assert_eq!(fanout_worker_count(&p, 50), 1, "peak <= capacity → N=1");
        assert_eq!(fanout_worker_count(&p, 25), 2, "ceil(50/25)");
        assert_eq!(fanout_worker_count(&p, 20), 3, "ceil(50/20)");
    }

    #[test]
    fn is_vu_curve_predicate() {
        let mut p = curve_profile(vec![handicap_engine::Stage {
            target: 5,
            duration_seconds: 10,
        }]);
        assert!(p.is_vu_curve());
        assert!(!p.is_open_loop()); // vu_stages는 is_open_loop에 영향 없음
        assert_eq!(p.vu_curve_max(), 5);
        p.vu_stages = Some(vec![]); // Some(vec![]) ≡ absent (S-D 미러)
        assert!(!p.is_vu_curve());
        p.vu_stages = None;
        assert!(!p.is_vu_curve());
    }

    #[tokio::test]
    async fn validate_vu_curve_rejects_conflicts_and_bounds() {
        let db = crate::store::connect("sqlite::memory:").await.unwrap();
        let state = state_with(db, 2000).await;
        let one_stage = vec![handicap_engine::Stage {
            target: 5,
            duration_seconds: 10,
        }];

        // ① vu_stages + target_rps → conflict
        let err = validate_run_config(
            &state,
            &Profile {
                target_rps: Some(10),
                ..curve_profile(one_stage.clone())
            },
        )
        .await
        .unwrap_err();
        assert!(
            matches!(&err, ApiError::BadRequest(m) if m.contains("vu_stages와 target_rps")),
            "① expected vu_stages와 target_rps conflict, got {err:?}"
        );

        // ② vu_stages + max_in_flight → conflict
        let err = validate_run_config(
            &state,
            &Profile {
                max_in_flight: Some(10),
                ..curve_profile(one_stage.clone())
            },
        )
        .await
        .unwrap_err();
        assert!(
            matches!(&err, ApiError::BadRequest(m) if m.contains("max_in_flight")),
            "② expected max_in_flight conflict, got {err:?}"
        );

        // ③ vu_stages + stages (RPS curve) → conflict
        let err = validate_run_config(
            &state,
            &Profile {
                stages: Some(vec![handicap_engine::Stage {
                    target: 10,
                    duration_seconds: 10,
                }]),
                ..curve_profile(one_stage.clone())
            },
        )
        .await
        .unwrap_err();
        assert!(
            matches!(&err, ApiError::BadRequest(m) if m.contains("stages(RPS 곡선)")),
            "③ expected stages conflict, got {err:?}"
        );

        // ④ vu_stages + ramp_up_seconds → conflict
        let err = validate_run_config(
            &state,
            &Profile {
                ramp_up_seconds: 5,
                ..curve_profile(one_stage.clone())
            },
        )
        .await
        .unwrap_err();
        assert!(
            matches!(&err, ApiError::BadRequest(m) if m.contains("ramp_up_seconds")),
            "④ expected ramp_up_seconds conflict, got {err:?}"
        );

        // ⑤ vu_stages + duration_seconds → conflict
        let err = validate_run_config(
            &state,
            &Profile {
                duration_seconds: 10,
                ..curve_profile(one_stage.clone())
            },
        )
        .await
        .unwrap_err();
        assert!(
            matches!(&err, ApiError::BadRequest(m) if m.contains("duration_seconds")),
            "⑤ expected duration_seconds conflict, got {err:?}"
        );

        // ⑥ vu_stages + vus → conflict
        let err = validate_run_config(
            &state,
            &Profile {
                vus: 5,
                ..curve_profile(one_stage.clone())
            },
        )
        .await
        .unwrap_err();
        assert!(
            matches!(&err, ApiError::BadRequest(m) if m.contains("vus를 비워야")),
            "⑥ expected vus conflict, got {err:?}"
        );

        // ⑦a stage duration_seconds == 0
        let err = validate_run_config(
            &state,
            &curve_profile(vec![handicap_engine::Stage {
                target: 5,
                duration_seconds: 0,
            }]),
        )
        .await
        .unwrap_err();
        assert!(
            matches!(&err, ApiError::BadRequest(m) if m.contains("duration_seconds must be >= 1")),
            "⑦a expected duration_seconds>=1, got {err:?}"
        );

        // ⑦b stage target > capacity(2000) now validate-passes (fans out non-pool, not rejected); N arithmetic is covered by fanout_worker_count_vu_curve_uses_peak.
        assert!(
            validate_run_config(
                &state,
                &curve_profile(vec![handicap_engine::Stage {
                    target: 2001,
                    duration_seconds: 10,
                }]),
            )
            .await
            .is_ok(),
            "⑦b B9: peak>capacity fans out non-pool, not rejected"
        );

        // ⑧ all stage targets == 0
        let err = validate_run_config(
            &state,
            &curve_profile(vec![handicap_engine::Stage {
                target: 0,
                duration_seconds: 10,
            }]),
        )
        .await
        .unwrap_err();
        assert!(
            matches!(&err, ApiError::BadRequest(m) if m.contains("0보다 커야")),
            "⑧ expected target>0, got {err:?}"
        );

        // ⑨ ramp_down without vu_stages → rejected (vu-curve 전용 노브)
        let err = validate_run_config(
            &state,
            &Profile {
                // closed-loop fixed: vus/duration set, no vu_stages
                vus: 5,
                duration_seconds: 10,
                ramp_down: Some(handicap_engine::RampDown::Graceful),
                vu_stages: None,
                ..ol_profile()
            },
        )
        .await
        .unwrap_err();
        assert!(
            matches!(&err, ApiError::BadRequest(m) if m.contains("VU 곡선") && m.contains("전용")),
            "⑨ expected ramp_down VU-curve-only, got {err:?}"
        );

        // 유효 통과: vus=0, duration=0, ramp_up=0 + vu_stages + ramp_down Immediate
        assert!(
            validate_run_config(
                &state,
                &Profile {
                    ramp_down: Some(handicap_engine::RampDown::Immediate),
                    ..curve_profile(vec![
                        handicap_engine::Stage {
                            target: 5,
                            duration_seconds: 10,
                        },
                        handicap_engine::Stage {
                            target: 1,
                            duration_seconds: 10,
                        },
                    ])
                }
            )
            .await
            .is_ok(),
            "valid vu_stages+ramp_down must be accepted"
        );
    }

    /// B9 + capacity-from-settings: worker capacity flows from SettingsState (not
    /// coord) into validate, where it drives the fan-out worker count N. A curve
    /// whose peak exceeds a lowered capacity now FANS OUT (N=ceil(peak/cap)) instead
    /// of rejecting; with a Unique binding, that capacity-driven N gates the
    /// row-count floor. (was lowered_capacity_settings_enforced_at_validation — B9
    /// removed the single-worker rejection this used to assert.)
    #[tokio::test]
    async fn lowered_capacity_settings_drives_fanout_not_rejection() {
        // cap=2 seeded in SettingsState. Hold the Unique dataset at 1 row so the
        // same lowered capacity gates differently purely via N: peak 3 → N=ceil(3/2)=2,
        // rows 1 < 2 → reject; peak 2 → N=1, rows 1 >= 1 → ok. Would FAIL if
        // fanout_worker_count ignored capacity (peak 3 would then be N=1 → pass).
        let db = crate::store::connect("sqlite::memory:").await.unwrap();
        let dataset_id = crate::store::datasets::insert(
            &db,
            "d",
            &["c".to_string()],
            &[vec!["a".to_string()]],
            0,
        )
        .await
        .unwrap();
        let state = state_with(db, 2).await;
        assert!(
            matches!(
                validate_run_config(&state, &unique_curve_profile(dataset_id.clone(), 3)).await,
                Err(ApiError::BadRequest(_))
            ),
            "peak 3 @ cap 2 → N=2; unique rows 1 < 2 must reject (capacity drove N)"
        );
        assert!(
            validate_run_config(&state, &unique_curve_profile(dataset_id, 2))
                .await
                .is_ok(),
            "peak 2 @ cap 2 → N=1; unique rows 1 >= 1 must pass"
        );
    }

    /// R7: pool mode defers the capacity check to spawn_run (409), so validate
    /// must NOT reject a curve whose peak exceeds the single-worker capacity.
    #[tokio::test]
    async fn validate_vu_curve_pool_defers_to_guard() {
        let db = crate::store::connect("sqlite::memory:").await.unwrap();
        // capacity=2000 via state_with; curve peak=5000 > 2000.
        let state = state_with(db, 2000).await;
        state.coord.set_pool_mode(true);
        let p = curve_profile(vec![handicap_engine::Stage {
            target: 5000,
            duration_seconds: 10,
        }]);
        assert!(
            validate_run_config(&state, &p).await.is_ok(),
            "pool mode: peak>capacity must pass validate (409 deferred to spawn_run)"
        );
    }

    /// B9: non-pool mode now FANS OUT a curve whose peak exceeds single-worker
    /// capacity (N = ceil(peak/cap)) instead of rejecting. (was validate_vu_curve_nonpool_rejects)
    #[tokio::test]
    async fn validate_vu_curve_nonpool_fans_out() {
        let db = crate::store::connect("sqlite::memory:").await.unwrap();
        let state = state_with(db, 2000).await; // pool_mode false; peak 5000 > 2000 → N=3
        let p = curve_profile(vec![handicap_engine::Stage {
            target: 5000,
            duration_seconds: 10,
        }]);
        assert!(
            validate_run_config(&state, &p).await.is_ok(),
            "non-pool: peak>capacity now fans out (N=ceil(peak/cap)), not rejected"
        );
    }

    fn unique_curve_profile(dataset_id: String, peak: u32) -> Profile {
        Profile {
            data_binding: Some(DataBinding {
                dataset_id,
                policy: BindingPolicy::Unique,
                mappings: vec![],
            }),
            ..curve_profile(vec![handicap_engine::Stage {
                target: peak,
                duration_seconds: 5,
            }])
        }
    }

    #[tokio::test]
    async fn nonpool_vu_curve_unique_rows_lt_workers_rejected() {
        let db = crate::store::connect("sqlite::memory:").await.unwrap();
        // 1 row; cap 25, peak 50 → N = ceil(50/25) = 2; rows 1 < 2 → reject (R4).
        let dataset_id = crate::store::datasets::insert(
            &db,
            "d",
            &["c".to_string()],
            &[vec!["a".to_string()]],
            0,
        )
        .await
        .unwrap();
        let state = state_with(db, 25).await;
        assert!(
            matches!(
                validate_run_config(&state, &unique_curve_profile(dataset_id, 50)).await,
                Err(ApiError::BadRequest(_))
            ),
            "curve peak 50 @ cap 25 → N=2; unique rows 1 < 2 must reject"
        );
    }

    #[tokio::test]
    async fn nonpool_vu_curve_unique_rows_ge_workers_ok() {
        let db = crate::store::connect("sqlite::memory:").await.unwrap();
        // 2 rows; cap 25, peak 50 → N=2; rows 2 >= 2 → ok.
        let dataset_id = crate::store::datasets::insert(
            &db,
            "d",
            &["c".to_string()],
            &[vec!["a".to_string()], vec!["b".to_string()]],
            0,
        )
        .await
        .unwrap();
        let state = state_with(db, 25).await;
        assert!(
            validate_run_config(&state, &unique_curve_profile(dataset_id, 50))
                .await
                .is_ok(),
            "curve peak 50 @ cap 25 → N=2; unique rows 2 >= 2 must pass"
        );
    }

    // ── graceful ramp-down cap (spec §7.2, B9) ──────────────────────────────

    #[tokio::test]
    async fn graceful_cap_rejected_when_not_vu_curve() {
        let db = crate::store::connect("sqlite::memory:").await.unwrap();
        let state = state_with(db, 0).await;
        let mut p = ol_profile(); // fixed (not vu-curve)
        p.graceful_ramp_down_seconds = Some(5);
        let err = validate_run_config(&state, &p).await.unwrap_err();
        assert!(
            matches!(err, ApiError::BadRequest(ref m) if m.contains("vu_stages")),
            "reject cap outside vu-curve: {err:?}"
        );
    }

    #[tokio::test]
    async fn graceful_cap_rejected_with_immediate() {
        let db = crate::store::connect("sqlite::memory:").await.unwrap();
        let state = state_with(db, 0).await;
        let mut p = curve_profile(vec![
            handicap_engine::Stage {
                target: 3,
                duration_seconds: 2,
            },
            handicap_engine::Stage {
                target: 0,
                duration_seconds: 2,
            },
        ]);
        p.ramp_down = Some(handicap_engine::RampDown::Immediate);
        p.graceful_ramp_down_seconds = Some(5);
        let err = validate_run_config(&state, &p).await.unwrap_err();
        assert!(
            matches!(err, ApiError::BadRequest(ref m) if m.contains("graceful")),
            "reject cap with immediate: {err:?}"
        );
    }

    #[tokio::test]
    async fn graceful_cap_rejected_when_zero() {
        let db = crate::store::connect("sqlite::memory:").await.unwrap();
        let state = state_with(db, 0).await;
        let mut p = curve_profile(vec![
            handicap_engine::Stage {
                target: 3,
                duration_seconds: 2,
            },
            handicap_engine::Stage {
                target: 0,
                duration_seconds: 2,
            },
        ]);
        p.graceful_ramp_down_seconds = Some(0);
        let err = validate_run_config(&state, &p).await.unwrap_err();
        assert!(
            matches!(err, ApiError::BadRequest(ref m) if m.contains("1 이상")),
            "reject cap=0: {err:?}"
        );
    }

    #[tokio::test]
    async fn graceful_cap_accepted_on_graceful_vu_curve() {
        let db = crate::store::connect("sqlite::memory:").await.unwrap();
        let state = state_with(db, 0).await;
        let mut p = curve_profile(vec![
            handicap_engine::Stage {
                target: 3,
                duration_seconds: 2,
            },
            handicap_engine::Stage {
                target: 0,
                duration_seconds: 2,
            },
        ]); // ramp_down None(=graceful)
        p.graceful_ramp_down_seconds = Some(10);
        assert!(validate_run_config(&state, &p).await.is_ok());
    }

    // ── connect_timeout_seconds (E3 Task 3, spec §3.4) ──────────────────────

    // Minimal closed profile literal helper (fill remaining required fields).
    fn closed_min() -> Profile {
        Profile {
            vus: 1,
            ramp_up_seconds: 0,
            duration_seconds: 10,
            loop_breakdown_cap: 256,
            http_timeout_seconds: 30,
            data_binding: None,
            data_bindings: vec![],
            criteria: None,
            think_time: None,
            think_seed: None,
            target_rps: None,
            max_in_flight: None,
            stages: None,
            measure_phases: false,
            vu_stages: None,
            ramp_down: None,
            graceful_ramp_down_seconds: None,
            connect_timeout_seconds: None,
            worker_count: None,
            apply_scenario_think_time: true,
            stair: None,
            steady: None,
        }
    }

    #[tokio::test]
    async fn connect_timeout_zero_is_rejected() {
        let db = crate::store::connect("sqlite::memory:").await.unwrap();
        let state = state_with(db, 0).await;
        let mut p = closed_min();
        p.http_timeout_seconds = 30;
        p.connect_timeout_seconds = Some(0);
        let err = validate_run_config(&state, &p).await.unwrap_err();
        assert!(
            matches!(&err, ApiError::BadRequest(m) if m.contains("between 1 and 600")),
            "got {err:?}"
        );
    }

    #[tokio::test]
    async fn connect_timeout_over_600_is_rejected() {
        let db = crate::store::connect("sqlite::memory:").await.unwrap();
        let state = state_with(db, 0).await;
        let mut p = closed_min();
        p.http_timeout_seconds = 600;
        p.connect_timeout_seconds = Some(601);
        let err = validate_run_config(&state, &p).await.unwrap_err();
        assert!(
            matches!(&err, ApiError::BadRequest(m) if m.contains("between 1 and 600")),
            "got {err:?}"
        );
    }

    #[tokio::test]
    async fn connect_timeout_equal_to_http_timeout_is_rejected() {
        // 경계: 같아도 거부(< 강제). 어느 쪽이 먼저 발화할지 보장 못 하면 분류가 무의미.
        let db = crate::store::connect("sqlite::memory:").await.unwrap();
        let state = state_with(db, 0).await;
        let mut p = closed_min();
        p.http_timeout_seconds = 5;
        p.connect_timeout_seconds = Some(5);
        let err = validate_run_config(&state, &p).await.unwrap_err();
        assert!(
            matches!(&err, ApiError::BadRequest(m) if m.contains("less than http_timeout_seconds")),
            "got {err:?}"
        );
    }

    #[tokio::test]
    async fn connect_timeout_below_http_timeout_is_accepted() {
        let db = crate::store::connect("sqlite::memory:").await.unwrap();
        let state = state_with(db, 0).await;
        let mut p = closed_min();
        p.http_timeout_seconds = 5;
        p.connect_timeout_seconds = Some(4);
        assert!(validate_run_config(&state, &p).await.is_ok());
    }

    #[tokio::test]
    async fn connect_timeout_absent_is_accepted() {
        // 미설정 = 오늘과 동일 경로(하위호환 — 기존 프리셋/스케줄이 400을 맞지 않는다).
        let db = crate::store::connect("sqlite::memory:").await.unwrap();
        let state = state_with(db, 0).await;
        let mut p = closed_min();
        p.connect_timeout_seconds = None;
        assert!(validate_run_config(&state, &p).await.is_ok());
    }

    async fn seed_plain_run(db: &crate::store::Db) -> String {
        let yaml = "version: 1\nname: t\nsteps: []\n";
        let sc: handicap_engine::Scenario = serde_yaml::from_str(yaml).unwrap();
        let scenario = crate::store::scenarios::insert(db, &sc, yaml)
            .await
            .unwrap();
        let mut profile = unique_profile("unused".into(), 1);
        profile.data_binding = None;
        runs::insert(
            db,
            &scenario.id,
            yaml,
            &profile,
            &serde_json::json!({}),
            None,
        )
        .await
        .unwrap()
        .id
    }

    fn pending_assignment() -> crate::grpc::coordinator::PendingAssignment {
        let mut profile = unique_profile("unused".into(), 1);
        profile.data_binding = None;
        crate::grpc::coordinator::PendingAssignment {
            scenario_yaml: "version: 1\nname: t\nsteps: []\n".to_string(),
            profile: crate::grpc::profile::to_proto_profile(&profile),
            env: std::collections::HashMap::new(),
            data_bindings: vec![],
            stair: None,
        }
    }

    async fn enqueue_expecting(state: &AppState, id: &str, expected: u32) {
        let long = std::time::Duration::from_secs(3600);
        state
            .coord
            .enqueue(
                id.to_string(),
                pending_assignment(),
                expected,
                4,
                None,
                long,
                long,
            )
            .await;
    }

    async fn register_worker(state: &AppState, id: &str, worker: &str) {
        let (tx, _rx) = tokio::sync::mpsc::channel(8);
        state.coord.register(id, worker, tx).await;
    }

    async fn abort_msg(state: &AppState, id: &str) -> (runs::RunStatus, Option<String>) {
        let row = runs::get(&state.db, id).await.unwrap().unwrap();
        (row.status, row.message)
    }

    #[tokio::test]
    async fn abort_run_before_any_worker_leaves_not_started_reason() {
        let db = crate::store::connect("sqlite::memory:").await.unwrap();
        let id = seed_plain_run(&db).await;
        let state = state_with(db, 0).await;
        enqueue_expecting(&state, &id, 1).await;
        let code = super::abort_run(State(state.clone()), Path(id.clone()))
            .await
            .unwrap();
        assert_eq!(code, StatusCode::OK);
        let (status, message) = abort_msg(&state, &id).await;
        assert_eq!(status, runs::RunStatus::Aborted);
        assert_eq!(message.as_deref(), Some(runs::ABORT_MSG_NOT_STARTED));
        let (tx, _rx) = tokio::sync::mpsc::channel(8);
        assert!(matches!(
            state.coord.register(&id, "w0", tx).await,
            crate::grpc::coordinator::RegisterOutcome::NoRun
        ));
    }

    #[tokio::test]
    async fn abort_run_with_partial_registration_leaves_partial_reason() {
        let db = crate::store::connect("sqlite::memory:").await.unwrap();
        let id = seed_plain_run(&db).await;
        let state = state_with(db, 0).await;
        enqueue_expecting(&state, &id, 2).await;
        register_worker(&state, &id, "w0").await;
        super::abort_run(State(state.clone()), Path(id.clone()))
            .await
            .unwrap();
        let (status, message) = abort_msg(&state, &id).await;
        assert_eq!(status, runs::RunStatus::Aborted);
        assert_eq!(
            message.as_deref(),
            Some("부하기 2대 중 1대만 접속한 상태에서 중단했습니다")
        );
    }

    #[tokio::test]
    async fn abort_run_fully_registered_leaves_no_reason() {
        let db = crate::store::connect("sqlite::memory:").await.unwrap();
        let id = seed_plain_run(&db).await;
        let state = state_with(db, 0).await;
        enqueue_expecting(&state, &id, 1).await;
        register_worker(&state, &id, "w0").await;
        super::abort_run(State(state.clone()), Path(id.clone()))
            .await
            .unwrap();
        let (status, message) = abort_msg(&state, &id).await;
        assert_eq!(status, runs::RunStatus::Aborted);
        assert_eq!(message, None);
    }

    #[tokio::test]
    async fn abort_run_does_not_overwrite_finished_run() {
        let db = crate::store::connect("sqlite::memory:").await.unwrap();
        let id = seed_plain_run(&db).await;
        runs::set_status(&db, &id, runs::RunStatus::Completed, Some(1), Some(5))
            .await
            .unwrap();
        let state = state_with(db, 0).await;
        let err = super::abort_run(State(state.clone()), Path(id.clone()))
            .await
            .unwrap_err();
        assert!(matches!(err, ApiError::Conflict(_)));
        let (status, _) = abort_msg(&state, &id).await;
        assert_eq!(status, runs::RunStatus::Completed);
    }

    #[tokio::test]
    async fn abort_run_on_already_aborted_run_conflicts() {
        let db = crate::store::connect("sqlite::memory:").await.unwrap();
        let id = seed_plain_run(&db).await;
        assert!(
            runs::mark_aborted_if_active(&db, &id, "앱 종료로 중단")
                .await
                .unwrap()
        );
        let state = state_with(db, 0).await;
        let err = super::abort_run(State(state.clone()), Path(id.clone()))
            .await
            .unwrap_err();
        match err {
            ApiError::Conflict(m) => assert!(m.contains("aborted"), "{m}"),
            other => panic!("expected Conflict, got {other:?}"),
        }
        let (_, message) = abort_msg(&state, &id).await;
        assert_eq!(message.as_deref(), Some("앱 종료로 중단"));
    }

    #[tokio::test]
    async fn abort_run_unknown_id_is_not_found() {
        let db = crate::store::connect("sqlite::memory:").await.unwrap();
        let state = state_with(db, 0).await;
        let err = super::abort_run(State(state), Path("nope".to_string()))
            .await
            .unwrap_err();
        assert!(matches!(err, ApiError::NotFound));
    }

    #[tokio::test]
    async fn fail_pool_assignment_keeps_finished_run() {
        let db = crate::store::connect("sqlite::memory:").await.unwrap();
        let id = seed_plain_run(&db).await;
        runs::set_status(&db, &id, runs::RunStatus::Completed, None, Some(5))
            .await
            .unwrap();
        let coord = CoordinatorState::new(db.clone());
        let err = super::fail_pool_assignment(&coord, &db, &id)
            .await
            .err()
            .expect("오류를 돌려준다");
        assert!(matches!(err, ApiError::Internal(_)));
        let row = runs::get(&db, &id).await.unwrap().unwrap();
        assert_eq!(row.status, runs::RunStatus::Completed);
        assert_eq!(row.message.as_deref(), None);
    }

    #[tokio::test]
    async fn fail_pool_assignment_fails_active_run() {
        let db = crate::store::connect("sqlite::memory:").await.unwrap();
        let id = seed_plain_run(&db).await;
        let coord = CoordinatorState::new(db.clone());
        let err = super::fail_pool_assignment(&coord, &db, &id)
            .await
            .err()
            .expect("오류를 돌려준다");
        assert!(matches!(err, ApiError::Internal(_)));
        let row = runs::get(&db, &id).await.unwrap().unwrap();
        assert_eq!(row.status, runs::RunStatus::Failed);
        assert_eq!(row.message.as_deref(), Some(super::POOL_ASSIGN_FAILED_MSG));
    }

    #[tokio::test]
    async fn fail_pool_assignment_returns_row_when_aborted() {
        let db = crate::store::connect("sqlite::memory:").await.unwrap();
        let id = seed_plain_run(&db).await;
        assert!(runs::abort_if_active(&db, &id).await.unwrap());
        let coord = CoordinatorState::new(db.clone());
        let row = super::fail_pool_assignment(&coord, &db, &id).await.unwrap();
        assert_eq!(row.id, id);
        assert_eq!(row.status, runs::RunStatus::Aborted);
        let after = runs::get(&db, &id).await.unwrap().unwrap();
        assert_eq!(after.status, runs::RunStatus::Aborted);
        assert_eq!(after.message, None);
    }

    // ---- run 생성 도중의 중단: enqueue 뒤 상태 다시 읽기 ----

    #[tokio::test]
    async fn row_if_no_longer_pending_returns_none_for_pending() {
        let db = crate::store::connect("sqlite::memory:").await.unwrap();
        let id = seed_plain_run(&db).await;
        let state = state_with(db, 0).await;
        enqueue_expecting(&state, &id, 1).await;
        let got = super::row_if_no_longer_pending(&state, &id, &[])
            .await
            .unwrap();
        assert!(got.is_none());
        let (tx, _rx) = tokio::sync::mpsc::channel(8);
        assert!(matches!(
            state.coord.register(&id, "w0", tx).await,
            crate::grpc::coordinator::RegisterOutcome::Assigned { .. }
        ));
    }

    #[tokio::test]
    async fn row_if_no_longer_pending_tears_down_aborted_run() {
        let db = crate::store::connect("sqlite::memory:").await.unwrap();
        let id = seed_plain_run(&db).await;
        let state = state_with(db.clone(), 0).await;
        assert!(runs::abort_if_active(&db, &id).await.unwrap());
        enqueue_expecting(&state, &id, 1).await;
        let row = super::row_if_no_longer_pending(&state, &id, &[])
            .await
            .unwrap()
            .expect("aborted row");
        assert_eq!(row.status, runs::RunStatus::Aborted);
        assert_eq!(row.message.as_deref(), Some(runs::ABORT_MSG_NOT_STARTED));
        let (tx, _rx) = tokio::sync::mpsc::channel(8);
        assert!(matches!(
            state.coord.register(&id, "w0", tx).await,
            crate::grpc::coordinator::RegisterOutcome::NoRun
        ));
    }

    #[tokio::test]
    async fn row_if_no_longer_pending_keeps_existing_reason() {
        let db = crate::store::connect("sqlite::memory:").await.unwrap();
        let id = seed_plain_run(&db).await;
        let state = state_with(db.clone(), 0).await;
        assert!(
            runs::mark_aborted_if_active(&db, &id, "앱 종료로 중단")
                .await
                .unwrap()
        );
        enqueue_expecting(&state, &id, 1).await;
        let row = super::row_if_no_longer_pending(&state, &id, &[])
            .await
            .unwrap()
            .expect("aborted row");
        assert_eq!(row.status, runs::RunStatus::Aborted);
        assert_eq!(row.message.as_deref(), Some("앱 종료로 중단"));
    }

    struct CountingDispatcher {
        dispatches: Arc<std::sync::atomic::AtomicUsize>,
        cleanups: Arc<std::sync::atomic::AtomicUsize>,
    }
    #[async_trait::async_trait]
    impl crate::dispatcher::WorkerDispatcher for CountingDispatcher {
        async fn dispatch(&self, _run_id: &str, _worker_count: u32) -> anyhow::Result<()> {
            self.dispatches
                .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            Ok(())
        }
        async fn cleanup(&self, _run_id: &str) -> anyhow::Result<()> {
            self.cleanups
                .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            Ok(())
        }
    }

    async fn state_with_counting(
        db: crate::store::Db,
        capacity: u32,
    ) -> (AppState, Arc<std::sync::atomic::AtomicUsize>) {
        let dispatches = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let mut state = state_with(db, capacity).await;
        state.dispatcher = Arc::new(CountingDispatcher {
            dispatches: dispatches.clone(),
            cleanups: Arc::new(std::sync::atomic::AtomicUsize::new(0)),
        });
        (state, dispatches)
    }

    /// `runs::insert` 직후 행이 `aborted`가 되게 하는 시험용 트리거(= 생성 도중의 중단).
    async fn abort_on_insert_trigger(db: &crate::store::Db) {
        sqlx::query(
            "CREATE TRIGGER abort_on_insert AFTER INSERT ON runs BEGIN \
             UPDATE runs SET status = 'aborted' WHERE id = NEW.id; END",
        )
        .execute(db)
        .await
        .unwrap();
    }

    async fn plain_scenario(db: &crate::store::Db) -> crate::store::scenarios::ScenarioRow {
        let yaml = "version: 1\nname: t\nsteps: []\n";
        let sc: handicap_engine::Scenario = serde_yaml::from_str(yaml).unwrap();
        crate::store::scenarios::insert(db, &sc, yaml)
            .await
            .unwrap()
    }

    fn plain_profile(vus: u32) -> Profile {
        let mut p = unique_profile("unused".into(), vus);
        p.data_binding = None;
        p
    }

    async fn call_spawn_run(
        state: &AppState,
        scenario: &crate::store::scenarios::ScenarioRow,
        vus: u32,
        force: bool,
    ) -> Result<runs::RunRow, ApiError> {
        super::spawn_run(
            state,
            scenario,
            &plain_profile(vus),
            vec![],
            &std::collections::HashMap::new(),
            force,
            None,
        )
        .await
    }

    #[tokio::test]
    async fn spawn_run_skips_dispatch_when_aborted_during_create() {
        let db = crate::store::connect("sqlite::memory:").await.unwrap();
        let scenario = plain_scenario(&db).await;
        abort_on_insert_trigger(&db).await;
        let (state, dispatches) = state_with_counting(db, 100).await;
        let row = call_spawn_run(&state, &scenario, 1, false).await.unwrap();
        assert_eq!(dispatches.load(std::sync::atomic::Ordering::SeqCst), 0);
        assert_eq!(row.status, runs::RunStatus::Aborted);
        assert_eq!(row.message.as_deref(), Some(runs::ABORT_MSG_NOT_STARTED));
        let (tx, _rx) = tokio::sync::mpsc::channel(8);
        assert!(matches!(
            state.coord.register(&row.id, "w0", tx).await,
            crate::grpc::coordinator::RegisterOutcome::NoRun
        ));
    }

    async fn abort_with_reason_on_insert_trigger(db: &crate::store::Db) {
        sqlx::query(
            "CREATE TRIGGER abort_with_reason_on_insert AFTER INSERT ON runs BEGIN \
             UPDATE runs SET status = 'aborted', message = '앱 종료로 중단' WHERE id = NEW.id; END",
        )
        .execute(db)
        .await
        .unwrap();
    }

    async fn only_run(state: &AppState) -> runs::RunRow {
        let id: String = sqlx::query_scalar("SELECT id FROM runs")
            .fetch_one(&state.db)
            .await
            .unwrap();
        runs::get(&state.db, &id).await.unwrap().unwrap()
    }

    enum BeforeFail {
        Nothing,
        AbortInDb(crate::store::Db),
        AbortViaApi(AppState),
    }

    struct FailingDispatcher {
        before_fail: BeforeFail,
    }
    #[async_trait::async_trait]
    impl crate::dispatcher::WorkerDispatcher for FailingDispatcher {
        async fn dispatch(&self, run_id: &str, _worker_count: u32) -> anyhow::Result<()> {
            match &self.before_fail {
                BeforeFail::Nothing => {}
                BeforeFail::AbortInDb(db) => {
                    assert!(runs::abort_if_active(db, run_id).await.unwrap());
                }
                BeforeFail::AbortViaApi(state) => {
                    super::abort_run(State(state.clone()), Path(run_id.to_string()))
                        .await
                        .unwrap();
                }
            }
            Err(anyhow::anyhow!("simulated dispatch failure"))
        }
        async fn cleanup(&self, _run_id: &str) -> anyhow::Result<()> {
            Ok(())
        }
    }

    async fn state_with_failing_dispatcher(
        db: crate::store::Db,
        make: impl FnOnce(AppState) -> BeforeFail,
    ) -> AppState {
        let mut state = state_with(db, 100).await;
        let before_fail = make(state.clone());
        state.dispatcher = Arc::new(FailingDispatcher { before_fail });
        state
    }

    #[tokio::test]
    async fn dispatch_failure_returns_aborted_row() {
        let db = crate::store::connect("sqlite::memory:").await.unwrap();
        let scenario = plain_scenario(&db).await;
        let state = state_with_failing_dispatcher(db.clone(), |_| BeforeFail::AbortInDb(db)).await;
        let row = call_spawn_run(&state, &scenario, 1, false).await.unwrap();
        assert_eq!(row.status, runs::RunStatus::Aborted);
        assert_eq!(row.message, None);
        assert_eq!(only_run(&state).await.message, None);
    }

    #[tokio::test]
    async fn dispatch_failure_after_abort_api_keeps_api_reason() {
        let db = crate::store::connect("sqlite::memory:").await.unwrap();
        let scenario = plain_scenario(&db).await;
        let state = state_with_failing_dispatcher(db, BeforeFail::AbortViaApi).await;
        let row = call_spawn_run(&state, &scenario, 1, false).await.unwrap();
        assert_eq!(row.status, runs::RunStatus::Aborted);
        assert_eq!(
            only_run(&state).await.message.as_deref(),
            Some(runs::ABORT_MSG_NOT_STARTED)
        );
    }

    #[tokio::test]
    async fn dispatch_failure_without_abort_fails_run() {
        let db = crate::store::connect("sqlite::memory:").await.unwrap();
        let scenario = plain_scenario(&db).await;
        let state = state_with_failing_dispatcher(db, |_| BeforeFail::Nothing).await;
        let msg = "failed to dispatch workers: simulated dispatch failure";
        match call_spawn_run(&state, &scenario, 1, false).await {
            Err(ApiError::Internal(e)) => assert_eq!(e.to_string(), msg),
            _ => panic!("expected Internal error"),
        }
        let row = only_run(&state).await;
        assert_eq!(row.status, runs::RunStatus::Failed);
        assert_eq!(row.message.as_deref(), Some(msg));
    }

    async fn call_spawn_run_unique(
        state: &AppState,
        scenario: &crate::store::scenarios::ScenarioRow,
        vus: u32,
        rows: i64,
        force: bool,
    ) -> Result<runs::RunRow, ApiError> {
        super::spawn_run(
            state,
            scenario,
            &unique_profile("ds".into(), vus),
            vec![crate::store::datasets::DatasetMeta {
                id: "ds".into(),
                name: "d".into(),
                columns: vec![],
                row_count: rows,
                byte_size: 0,
                created_at: 0,
            }],
            &std::collections::HashMap::new(),
            force,
            None,
        )
        .await
    }

    /// 중단이 낀 사전 실패의 공통 단언: Ok(중단된 행), 시작 전 사유, DB도 같다.
    async fn assert_prefail_aborted(
        state: &AppState,
        got: Result<runs::RunRow, ApiError>,
    ) -> runs::RunRow {
        let row = got.expect("중단된 행을 돌려준다");
        assert_eq!(row.status, runs::RunStatus::Aborted);
        assert_eq!(row.message.as_deref(), Some(runs::ABORT_MSG_NOT_STARTED));
        let db_row = only_run(state).await;
        assert_eq!(db_row.id, row.id);
        assert_eq!(db_row.status, runs::RunStatus::Aborted);
        assert_eq!(db_row.message.as_deref(), Some(runs::ABORT_MSG_NOT_STARTED));
        row
    }

    #[tokio::test]
    async fn prefail_empty_pool_force_returns_aborted_row() {
        let db = crate::store::connect("sqlite::memory:").await.unwrap();
        let scenario = plain_scenario(&db).await;
        abort_on_insert_trigger(&db).await;
        let state = state_with(db, 100).await;
        state.coord.set_pool_mode(true);
        let got = call_spawn_run(&state, &scenario, 1, true).await;
        assert_prefail_aborted(&state, got).await;
    }

    #[tokio::test]
    async fn prefail_empty_pool_returns_aborted_row() {
        let db = crate::store::connect("sqlite::memory:").await.unwrap();
        let scenario = plain_scenario(&db).await;
        abort_on_insert_trigger(&db).await;
        let state = state_with(db, 100).await;
        state.coord.set_pool_mode(true);
        let got = call_spawn_run(&state, &scenario, 1, false).await;
        assert_prefail_aborted(&state, got).await;
    }

    #[tokio::test]
    async fn prefail_unique_floor_returns_aborted_row() {
        let db = crate::store::connect("sqlite::memory:").await.unwrap();
        let scenario = plain_scenario(&db).await;
        abort_on_insert_trigger(&db).await;
        let (state, mut rxs) = pool_state_with_two_workers(db).await;
        let got = call_spawn_run_unique(&state, &scenario, 2, 1, false).await;
        let row = assert_prefail_aborted(&state, got).await;
        assert_pool_released(&state, &mut rxs, &row).await;
    }

    #[tokio::test]
    async fn prefail_unique_floor_force_returns_aborted_row() {
        let db = crate::store::connect("sqlite::memory:").await.unwrap();
        let scenario = plain_scenario(&db).await;
        abort_on_insert_trigger(&db).await;
        let (state, mut rxs) = pool_state_with_two_workers(db).await;
        let got = call_spawn_run_unique(&state, &scenario, 2, 1, true).await;
        let row = assert_prefail_aborted(&state, got).await;
        assert_pool_released(&state, &mut rxs, &row).await;
    }

    #[tokio::test]
    async fn prefail_keeps_existing_abort_reason() {
        let db = crate::store::connect("sqlite::memory:").await.unwrap();
        let scenario = plain_scenario(&db).await;
        abort_with_reason_on_insert_trigger(&db).await;
        let state = state_with(db, 100).await;
        state.coord.set_pool_mode(true);
        let row = call_spawn_run(&state, &scenario, 1, false)
            .await
            .expect("중단된 행을 돌려준다");
        assert_eq!(row.status, runs::RunStatus::Aborted);
        assert_eq!(row.message.as_deref(), Some("앱 종료로 중단"));
    }

    #[tokio::test]
    async fn prefail_empty_pool_without_abort_fails_run() {
        for force in [false, true] {
            let db = crate::store::connect("sqlite::memory:").await.unwrap();
            let scenario = plain_scenario(&db).await;
            let state = state_with(db, 100).await;
            state.coord.set_pool_mode(true);
            let Err(ApiError::BadRequest(m)) = call_spawn_run(&state, &scenario, 1, force).await
            else {
                panic!("BadRequest여야 한다 (force={force})");
            };
            assert_eq!(m, "연결된 LAN 워커가 없습니다 — 워커를 1대 이상 띄우세요");
            let row = only_run(&state).await;
            assert_eq!(row.status, runs::RunStatus::Failed);
            assert_eq!(row.message.as_deref(), Some(m.as_str()));
        }
    }

    #[tokio::test]
    async fn prefail_unique_floor_without_abort_fails_run() {
        for force in [false, true] {
            let db = crate::store::connect("sqlite::memory:").await.unwrap();
            let scenario = plain_scenario(&db).await;
            let (state, _rxs) = pool_state_with_two_workers(db).await;
            let Err(ApiError::BadRequest(m)) =
                call_spawn_run_unique(&state, &scenario, 2, 1, force).await
            else {
                panic!("BadRequest여야 한다 (force={force})");
            };
            assert_eq!(
                m,
                "unique 데이터셋 행 수가 풀 워커 수보다 적습니다: rows=1 < workers=2"
            );
            let row = only_run(&state).await;
            assert_eq!(row.status, runs::RunStatus::Failed);
            assert_eq!(row.message.as_deref(), Some(m.as_str()));
            let snap = state.coord.pool_snapshot(tokio::time::Instant::now()).await;
            assert_eq!(snap.len(), 2);
            assert!(snap.iter().all(|w| w.assigned_run.is_none()));
        }
    }

    #[tokio::test]
    async fn fail_run_start_keeps_finished_run_before_enqueue() {
        let db = crate::store::connect("sqlite::memory:").await.unwrap();
        let id = seed_plain_run(&db).await;
        runs::set_status(&db, &id, runs::RunStatus::Completed, None, Some(5))
            .await
            .unwrap();
        let coord = CoordinatorState::new(db.clone());
        let got = super::fail_run_start(
            &coord,
            &db,
            &id,
            "x",
            ApiError::BadRequest("x".into()),
            super::StartFailedAt::BeforeEnqueue,
        )
        .await;
        assert!(matches!(got, Err(ApiError::BadRequest(_))));
        let row = runs::get(&db, &id).await.unwrap().unwrap();
        assert_eq!(row.status, runs::RunStatus::Completed);
        assert_eq!(row.message.as_deref(), None);
    }

    #[tokio::test]
    async fn spawn_run_dispatches_normally_without_abort() {
        let db = crate::store::connect("sqlite::memory:").await.unwrap();
        let scenario = plain_scenario(&db).await;
        let (state, dispatches) = state_with_counting(db, 100).await;
        let row = call_spawn_run(&state, &scenario, 1, false).await.unwrap();
        assert_eq!(dispatches.load(std::sync::atomic::Ordering::SeqCst), 1);
        assert_eq!(row.status, runs::RunStatus::Pending);
    }

    type WorkerRx =
        tokio::sync::mpsc::Receiver<Result<handicap_proto::v1::ServerMessage, tonic::Status>>;

    /// 풀 모드 상태: 유휴 워커 2대(capacity 100)와 그 수신 큐.
    async fn pool_state_with_two_workers(db: crate::store::Db) -> (AppState, Vec<WorkerRx>) {
        let state = state_with(db, 100).await;
        state.coord.set_pool_mode(true);
        let mut rxs = Vec::new();
        for w in ["w0", "w1"] {
            let (tx, rx) = tokio::sync::mpsc::channel(8);
            state
                .coord
                .pool_register_idle(w, tx, 100, "host".into(), false)
                .await;
            rxs.push(rx);
        }
        (state, rxs)
    }

    /// 사전 검사(부하기 2대·각 100 VU, 요청 150 VU)를 통과한 뒤 예약 전에 w1이 빠지게 한다.
    /// 다른 연결이 쓰기 잠금을 쥐는 동안 `spawn_run`이 사전 검사에서 `runs::insert`로 넘어가
    /// 잠금에서 대기하고, 그 사이 `pool_exclude`로 풀을 줄인다. current-thread 런타임 전제.
    async fn spawn_run_with_pool_shrunk_before_reserve(
        state: &AppState,
        scenario: crate::store::scenarios::ScenarioRow,
    ) -> Result<runs::RunRow, ApiError> {
        let mut holder = state.db.acquire().await.unwrap();
        sqlx::query("BEGIN IMMEDIATE")
            .execute(&mut *holder)
            .await
            .unwrap();
        let task_state = state.clone();
        let task =
            tokio::spawn(async move { call_spawn_run(&task_state, &scenario, 150, false).await });
        tokio::task::yield_now().await;
        state.coord.pool_exclude("w1", "test").await;
        sqlx::query("ROLLBACK").execute(&mut *holder).await.unwrap();
        drop(holder);
        task.await.unwrap()
    }

    #[tokio::test]
    async fn prefail_insufficient_without_abort_fails_run() {
        let db = crate::store::connect("sqlite::memory:").await.unwrap();
        let scenario = plain_scenario(&db).await;
        let (state, _rxs) = pool_state_with_two_workers(db).await;
        let Err(ApiError::Internal(e)) =
            spawn_run_with_pool_shrunk_before_reserve(&state, scenario).await
        else {
            panic!("Internal이어야 한다");
        };
        let msg = "풀 용량 부족 (가용 100 VU < 요청 150 VU)";
        assert_eq!(e.to_string(), msg);
        let row = only_run(&state).await;
        assert_eq!(row.status, runs::RunStatus::Failed);
        assert_eq!(row.message.as_deref(), Some(msg));
        let snap = state.coord.pool_snapshot(tokio::time::Instant::now()).await;
        let w0 = snap.iter().find(|w| w.worker_id == "w0").unwrap();
        assert!(w0.assigned_run.is_none());
    }

    #[tokio::test]
    async fn prefail_insufficient_returns_aborted_row() {
        let db = crate::store::connect("sqlite::memory:").await.unwrap();
        let scenario = plain_scenario(&db).await;
        abort_on_insert_trigger(&db).await;
        let (state, _rxs) = pool_state_with_two_workers(db).await;
        let cleanups = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        state.coord.set_dispatcher(Arc::new(CountingDispatcher {
            dispatches: Arc::new(std::sync::atomic::AtomicUsize::new(0)),
            cleanups: cleanups.clone(),
        }));
        let got = spawn_run_with_pool_shrunk_before_reserve(&state, scenario).await;
        assert_prefail_aborted(&state, got).await;
        assert_eq!(cleanups.load(std::sync::atomic::Ordering::SeqCst), 0);
    }

    async fn assert_pool_released(state: &AppState, rxs: &mut [WorkerRx], row: &runs::RunRow) {
        assert_eq!(row.status, runs::RunStatus::Aborted);
        let snap = state.coord.pool_snapshot(tokio::time::Instant::now()).await;
        assert_eq!(snap.len(), 2);
        assert!(snap.iter().all(|w| w.assigned_run.is_none()));
        for rx in rxs.iter_mut() {
            assert!(rx.try_recv().is_err(), "배정이 가면 안 된다");
        }
    }

    #[tokio::test]
    async fn spawn_recheck_releases_pool_reservation() {
        let db = crate::store::connect("sqlite::memory:").await.unwrap();
        let scenario = plain_scenario(&db).await;
        abort_on_insert_trigger(&db).await;
        let (state, mut rxs) = pool_state_with_two_workers(db).await;
        let row = call_spawn_run(&state, &scenario, 2, false).await.unwrap();
        assert_pool_released(&state, &mut rxs, &row).await;
    }

    #[tokio::test]
    async fn spawn_recheck_releases_pool_reservation_force() {
        let db = crate::store::connect("sqlite::memory:").await.unwrap();
        let scenario = plain_scenario(&db).await;
        abort_on_insert_trigger(&db).await;
        let (state, mut rxs) = pool_state_with_two_workers(db).await;
        let row = call_spawn_run(&state, &scenario, 2, true).await.unwrap();
        assert_pool_released(&state, &mut rxs, &row).await;
    }
    // ---- 계단 실행 중 요약 (`auto_stop_live`) ----

    const LONG: std::time::Duration = std::time::Duration::from_secs(3600);

    fn stair_profile() -> Profile {
        let mut p = unique_profile("unused".into(), 0);
        p.data_binding = None;
        p.max_in_flight = Some(100);
        p.stair = Some(crate::stair::StairConfig {
            targets: vec![10, 20, 30],
            hold_seconds: 20,
            ramp_seconds: 1,
            discard_seconds: 5,
            p99_cap_ms: None,
            auto_stop: None,
        });
        p
    }

    /// run 행을 만들고 status를 `status`로 둔다. `enqueue`면 coordinator에도 등록.
    async fn seed_run_with(
        state: &AppState,
        profile: Profile,
        status: RunStatus,
        enqueue: bool,
    ) -> String {
        let yaml = "version: 1\nname: t\nsteps: []\n";
        let sc: handicap_engine::Scenario = serde_yaml::from_str(yaml).unwrap();
        let scenario = crate::store::scenarios::insert(&state.db, &sc, yaml)
            .await
            .unwrap();
        let id = runs::insert(
            &state.db,
            &scenario.id,
            yaml,
            &profile,
            &serde_json::json!({}),
            None,
        )
        .await
        .unwrap()
        .id;
        if enqueue {
            let assignment = crate::grpc::coordinator::PendingAssignment {
                scenario_yaml: yaml.to_string(),
                profile: crate::grpc::profile::to_proto_profile(&profile),
                env: std::collections::HashMap::new(),
                data_bindings: vec![],
                stair: profile.stair.clone(),
            };
            state
                .coord
                .enqueue(id.clone(), assignment, 1, 1, None, LONG, LONG)
                .await;
        }
        runs::set_status(&state.db, &id, RunStatus::Running, Some(1), None)
            .await
            .unwrap();
        if status != RunStatus::Running {
            runs::set_status(&state.db, &id, status, None, Some(2))
                .await
                .unwrap();
        }
        id
    }

    async fn get_json(state: &AppState, id: &str) -> serde_json::Value {
        let Json(r) = super::get(State(state.clone()), Path(id.to_string()))
            .await
            .expect("200");
        serde_json::to_value(&r).unwrap()
    }

    #[tokio::test]
    async fn get_running_stair_run_includes_live() {
        let db = crate::store::connect("sqlite::memory:").await.unwrap();
        let state = state_with(db, 2000).await;
        let id = seed_run_with(&state, stair_profile(), RunStatus::Running, true).await;
        let v = get_json(&state, &id).await;
        let live = v.as_object().unwrap()["auto_stop_live"]
            .as_object()
            .expect("auto_stop_live 객체");
        assert_eq!(live["step_states"].as_array().unwrap().len(), 3);
        assert!(live.contains_key("current_step"));
        assert!(live["current_step"].is_null());
    }

    #[tokio::test]
    async fn get_non_stair_run_has_no_live_key() {
        let db = crate::store::connect("sqlite::memory:").await.unwrap();
        let state = state_with(db, 2000).await;
        let mut p = unique_profile("unused".into(), 1);
        p.data_binding = None;
        let id = seed_run_with(&state, p, RunStatus::Running, true).await;
        let v = get_json(&state, &id).await;
        assert!(!v.as_object().unwrap().contains_key("auto_stop_live"));
    }

    #[tokio::test]
    async fn get_completed_stair_run_has_no_live_key() {
        let db = crate::store::connect("sqlite::memory:").await.unwrap();
        let state = state_with(db, 2000).await;
        let id = seed_run_with(&state, stair_profile(), RunStatus::Completed, true).await;
        assert!(
            state.coord.live_of(&id).await.is_some(),
            "coordinator엔 아직 요약이 있다"
        );
        let v = get_json(&state, &id).await;
        assert!(!v.as_object().unwrap().contains_key("auto_stop_live"));
    }

    async fn seed_setup_rows(state: &AppState, id: &str) {
        let row = |worker: &str, ok: i64, failed: i64| crate::store::section::SectionOutcomeRow {
            run_id: id.to_string(),
            worker_id: worker.to_string(),
            section: "setup".to_string(),
            ok,
            failed,
            interrupted: 0,
            last_done_ms: 1,
        };
        crate::store::section::insert_section_outcome_batch(
            &state.db,
            &[row("w0", 10, 0), row("w0", 20, 1), row("w1", 7, 1)],
        )
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn get_running_run_with_setup_rows_includes_setup_live() {
        let db = crate::store::connect("sqlite::memory:").await.unwrap();
        let state = state_with(db, 2000).await;
        let mut p = unique_profile("unused".into(), 1);
        p.data_binding = None;
        let id = seed_run_with(&state, p, RunStatus::Running, false).await;
        seed_setup_rows(&state, &id).await;
        let v = get_json(&state, &id).await;
        assert_eq!(
            v["setup_live"],
            serde_json::json!({"ok":37,"failed":2,"interrupted":0})
        );
    }

    #[tokio::test]
    async fn get_running_run_without_setup_rows_has_no_setup_live_key() {
        let db = crate::store::connect("sqlite::memory:").await.unwrap();
        let state = state_with(db, 2000).await;
        let mut p = unique_profile("unused".into(), 1);
        p.data_binding = None;
        let id = seed_run_with(&state, p, RunStatus::Running, false).await;
        let v = get_json(&state, &id).await;
        assert!(!v.as_object().unwrap().contains_key("setup_live"));
    }

    #[tokio::test]
    async fn get_completed_run_with_setup_rows_has_no_setup_live_key() {
        let db = crate::store::connect("sqlite::memory:").await.unwrap();
        let state = state_with(db, 2000).await;
        let mut p = unique_profile("unused".into(), 1);
        p.data_binding = None;
        let id = seed_run_with(&state, p, RunStatus::Completed, false).await;
        seed_setup_rows(&state, &id).await;
        let v = get_json(&state, &id).await;
        assert!(!v.as_object().unwrap().contains_key("setup_live"));
    }

    #[tokio::test]
    async fn get_pending_run_has_no_setup_live_key() {
        let db = crate::store::connect("sqlite::memory:").await.unwrap();
        let state = state_with(db, 2000).await;
        let yaml = "version: 1\nname: t\nsteps: []\n";
        let sc: handicap_engine::Scenario = serde_yaml::from_str(yaml).unwrap();
        let scenario = crate::store::scenarios::insert(&state.db, &sc, yaml)
            .await
            .unwrap();
        let mut p = unique_profile("unused".into(), 1);
        p.data_binding = None;
        let id = runs::insert(
            &state.db,
            &scenario.id,
            yaml,
            &p,
            &serde_json::json!({}),
            None,
        )
        .await
        .unwrap()
        .id;
        seed_setup_rows(&state, &id).await;
        let v = get_json(&state, &id).await;
        assert_eq!(v["status"], "pending");
        assert!(!v.as_object().unwrap().contains_key("setup_live"));
    }

    #[tokio::test]
    async fn get_running_run_missing_from_coordinator() {
        let db = crate::store::connect("sqlite::memory:").await.unwrap();
        let state = state_with(db, 2000).await;
        let id = seed_run_with(&state, stair_profile(), RunStatus::Running, false).await;
        let v = get_json(&state, &id).await;
        assert!(!v.as_object().unwrap().contains_key("auto_stop_live"));
    }
}

#[cfg(test)]
mod strip_think_tests {
    use super::*;

    const YAML_THINK: &str = r#"
version: 1
name: t
default_think_time: { min_ms: 500, max_ms: 500 }
steps:
  - id: 01HX0000000000000000000AAA
    type: http
    name: s1
    request: { method: GET, url: http://x/ }
    think_time: { min_ms: 300, max_ms: 300 }
"#;

    const YAML_THINK_REFRESH: &str = r#"
version: 1
name: t
default_think_time: { min_ms: 500, max_ms: 500 }
variables:
  f: { gen: uuid, refresh: request }
steps:
  - id: 01HX0000000000000000000AAA
    type: http
    name: s1
    request: { method: GET, url: "http://x/?f={{f}}" }
"#;

    const YAML_SETUP_THINK: &str = r#"
version: 1
name: t
setup:
  steps:
    - id: 01HX0000000000000000000SSS
      type: http
      name: login
      request: { method: POST, url: http://x/login }
      think_time: { min_ms: 200, max_ms: 200 }
steps:
  - id: 01HX0000000000000000000AAA
    type: http
    name: s1
    request: { method: GET, url: http://x/ }
    think_time: { min_ms: 300, max_ms: 300 }
"#;

    #[test]
    fn strip_think_strips_setup_steps() {
        let out = maybe_strip_think(YAML_SETUP_THINK, &open_profile(false));
        let sc = Scenario::from_yaml(&out).unwrap();
        assert_eq!(sc.setup_steps().len(), 1, "setup 구조는 남는다: {out}");
        for s in sc.all_steps() {
            let Step::Http(h) = s else {
                panic!("http only")
            };
            assert!(h.think_time.is_none(), "{} think 남음: {out}", h.name);
        }
    }

    #[test]
    fn strip_think_without_setup_is_unchanged() {
        const EXPECTED: &str = "version: 1\nname: t\nvariables: {}\ncookie_jar: auto\nsteps:\n- type: http\n  id: 01HX0000000000000000000AAA\n  name: s1\n  request:\n    method: GET\n    url: http://x/\n    headers: {}\n    body: null\n  assert: []\n  extract: []\n";
        let out = maybe_strip_think(YAML_THINK, &open_profile(false));
        assert_eq!(out, EXPECTED);
    }

    #[test]
    fn open_ignore_strip_keeps_refresh_request() {
        // maybe_strip_think는 엔진 Serialize로 재직렬화하는 유일한 소비처(spec §4.1) —
        // refresh가 빠지면 이 run만 조용히 반복 단위로 돌아간다.
        let out = maybe_strip_think(YAML_THINK_REFRESH, &open_profile(false));
        assert_ne!(out, YAML_THINK_REFRESH, "strip 경로를 실제로 탔어야 한다");
        assert!(out.contains("refresh: request"), "{out}");
        let sc = Scenario::from_yaml(&out).unwrap();
        assert!(matches!(
            sc.variables["f"],
            handicap_engine::VarDecl::Gen {
                refresh: handicap_engine::Refresh::Request,
                ..
            }
        ));
    }

    const YAML_NOTHINK: &str = r#"
version: 1
name: t
steps:
  - id: 01HX0000000000000000000AAA
    type: http
    name: s1
    request: { method: GET, url: http://x/ }
"#;

    fn open_profile(apply: bool) -> Profile {
        // open-loop fixed: target_rps set (is_open_loop() == true).
        let mut p = Profile {
            duration_seconds: 10,
            target_rps: Some(100),
            max_in_flight: Some(50),
            apply_scenario_think_time: apply,
            stair: None,
            steady: None,
            ..closed_min()
        };
        p.vus = 0;
        p
    }

    // Minimal closed profile literal helper (fill remaining required fields).
    fn closed_min() -> Profile {
        Profile {
            vus: 1,
            ramp_up_seconds: 0,
            duration_seconds: 10,
            loop_breakdown_cap: 256,
            http_timeout_seconds: 30,
            data_binding: None,
            data_bindings: vec![],
            criteria: None,
            think_time: None,
            think_seed: None,
            target_rps: None,
            max_in_flight: None,
            stages: None,
            measure_phases: false,
            vu_stages: None,
            ramp_down: None,
            graceful_ramp_down_seconds: None,
            connect_timeout_seconds: None,
            worker_count: None,
            apply_scenario_think_time: true,
            stair: None,
            steady: None,
        }
    }

    #[test]
    fn open_ignore_strips_think() {
        let out = maybe_strip_think(YAML_THINK, &open_profile(false));
        let sc = Scenario::from_yaml(&out).unwrap();
        assert!(
            sc.default_think_time.is_none(),
            "default_think_time removed"
        );
        if let Step::Http(h) = &sc.steps[0] {
            assert!(h.think_time.is_none(), "step think removed");
        } else {
            panic!("expected http step");
        }
    }

    #[test]
    fn open_apply_keeps_original() {
        let out = maybe_strip_think(YAML_THINK, &open_profile(true));
        assert_eq!(out, YAML_THINK, "apply=true → original clone");
    }

    #[test]
    fn closed_never_strips() {
        let mut p = closed_min();
        p.apply_scenario_think_time = false; // closed + false: still no strip (open-loop only)
        let out = maybe_strip_think(YAML_THINK, &p);
        assert_eq!(out, YAML_THINK);
    }

    #[test]
    fn open_ignore_no_think_keeps_original() {
        // gate passes but nothing to strip → original (changed==false).
        let out = maybe_strip_think(YAML_NOTHINK, &open_profile(false));
        assert_eq!(out, YAML_NOTHINK);
    }

    // Nested http steps (inside a loop body AND a parallel branch) must also have
    // think stripped — a future edit turning a recursion arm (Step::Loop /
    // Step::Parallel) into a no-op would otherwise silently let think survive the
    // open-loop "ignore" toggle (§B21 ②).
    const YAML_NESTED_THINK: &str = r#"
version: 1
name: t
default_think_time: { min_ms: 500, max_ms: 500 }
steps:
  - id: 01HX0000000000000000000BBB
    type: loop
    name: loopstep
    repeat: 1
    do:
      - id: 01HX0000000000000000000CCC
        type: http
        name: inner
        request: { method: GET, url: http://x/ }
        think_time: { min_ms: 300, max_ms: 300 }
  - id: 01HX0000000000000000000DDD
    type: parallel
    name: parstep
    branches:
      - name: branchA
        steps:
          - id: 01HX0000000000000000000EEE
            type: http
            name: pinner
            request: { method: GET, url: http://x/ }
            think_time: { min_ms: 300, max_ms: 300 }
"#;

    #[test]
    fn open_ignore_strips_nested_think() {
        let out = maybe_strip_think(YAML_NESTED_THINK, &open_profile(false));
        let sc = Scenario::from_yaml(&out).unwrap();
        assert!(
            sc.default_think_time.is_none(),
            "default_think_time removed"
        );
        let Step::Loop(l) = &sc.steps[0] else {
            panic!("expected loop step");
        };
        if let Step::Http(h) = &l.do_[0] {
            assert!(h.think_time.is_none(), "loop-body http think removed");
        } else {
            panic!("expected http step inside loop body");
        }
        let Step::Parallel(p) = &sc.steps[1] else {
            panic!("expected parallel step");
        };
        if let Step::Http(h) = &p.branches[0].steps[0] {
            assert!(h.think_time.is_none(), "parallel-branch http think removed");
        } else {
            panic!("expected http step inside parallel branch");
        }
    }

    fn http_think(st: &Step) -> Option<(u32, u32)> {
        let Step::Http(h) = st else {
            panic!("expected http step");
        };
        h.think_time.as_ref().map(|t| (t.min_ms, t.max_ms))
    }

    const YAML_KEEP: &str = r#"
version: 1
name: t
default_think_time: { min_ms: 100, max_ms: 100 }
steps:
  - id: 01HX0000000000000000000AAA
    type: http
    name: a
    request: { method: GET, url: http://x/ }
  - id: 01HX0000000000000000000BBB
    type: loop
    name: keep
    while: { left: "{{code}}", op: eq, right: WAIT }
    do:
      - id: 01HX0000000000000000000CCC
        type: http
        name: b
        request: { method: GET, url: http://x/ }
        think_time: { min_ms: 50, max_ms: 50 }
      - id: 01HX0000000000000000000DDD
        type: http
        name: c
        request: { method: GET, url: http://x/ }
  - id: 01HX0000000000000000000EEE
    type: loop
    name: nokeep
    while: { left: "{{code}}", op: eq, right: WAIT }
    keep_think: false
    do:
      - id: 01HX0000000000000000000FFF
        type: http
        name: d
        request: { method: GET, url: http://x/ }
        think_time: { min_ms: 50, max_ms: 50 }
"#;

    #[test]
    fn strip_keeps_think_inside_keep_think_loop() {
        let out = maybe_strip_think(YAML_KEEP, &open_profile(false));
        let sc = Scenario::from_yaml(&out).unwrap();
        assert!(sc.default_think_time.is_none());
        assert_eq!(http_think(&sc.steps[0]), None, "A");
        let Step::Loop(l1) = &sc.steps[1] else {
            panic!("loop")
        };
        assert_eq!(http_think(&l1.do_[0]), Some((50, 50)), "B");
        assert_eq!(http_think(&l1.do_[1]), Some((100, 100)), "C root copy");
        let Step::Loop(l2) = &sc.steps[2] else {
            panic!("loop")
        };
        assert_eq!(http_think(&l2.do_[0]), None, "D");
    }

    #[test]
    fn strip_output_unchanged_without_cond_loops() {
        // R0 회귀 가드: while 없는 loop은 keep 대상이 아니다 — 전부 제거.
        let y = YAML_NESTED_THINK;
        let out = maybe_strip_think(y, &open_profile(false));
        let sc = Scenario::from_yaml(&out).unwrap();
        assert!(sc.default_think_time.is_none());
        let Step::Loop(l) = &sc.steps[0] else {
            panic!("loop")
        };
        assert_eq!(http_think(&l.do_[0]), None);
        let Step::Parallel(p) = &sc.steps[1] else {
            panic!("par")
        };
        assert_eq!(http_think(&p.branches[0].steps[0]), None);
    }

    #[test]
    fn strip_if_inside_keep_loop_keeps_think() {
        let y = r#"
version: 1
name: t
default_think_time: { min_ms: 100, max_ms: 100 }
steps:
  - id: 01HX0000000000000000000BBB
    type: loop
    name: keep
    while: { left: "{{code}}", op: eq, right: WAIT }
    do:
      - id: 01HX0000000000000000000GGG
        type: if
        name: iff
        cond: { left: "1", op: eq, right: "1" }
        then:
          - id: 01HX0000000000000000000CCC
            type: http
            name: b
            request: { method: GET, url: http://x/ }
            think_time: { min_ms: 50, max_ms: 50 }
          - id: 01HX0000000000000000000HHH
            type: http
            name: nothink
            request: { method: GET, url: http://x/ }
"#;
        let out = maybe_strip_think(y, &open_profile(false));
        let sc = Scenario::from_yaml(&out).unwrap();
        let Step::Loop(l) = &sc.steps[0] else {
            panic!("loop")
        };
        let Step::If(i) = &l.do_[0] else { panic!("if") };
        assert_eq!(http_think(&i.then_[0]), Some((50, 50)));
        assert_eq!(http_think(&i.then_[1]), Some((100, 100)), "root default");
    }

    #[test]
    fn strip_nested_loops_inside_keep_loop_keep_think() {
        let y = r#"
version: 1
name: t
default_think_time: { min_ms: 100, max_ms: 100 }
steps:
  - id: 01HX0000000000000000000BBB
    type: loop
    name: keep
    while: { left: "{{code}}", op: eq, right: WAIT }
    do:
      - id: 01HX0000000000000000000III
        type: loop
        name: inner-nokeep
        while: { left: "{{code}}", op: eq, right: WAIT }
        keep_think: false
        do:
          - id: 01HX0000000000000000000CCC
            type: http
            name: b
            request: { method: GET, url: http://x/ }
            think_time: { min_ms: 50, max_ms: 50 }
      - id: 01HX0000000000000000000JJJ
        type: loop
        name: inner-plain
        repeat: 2
        do:
          - id: 01HX0000000000000000000DDD
            type: http
            name: c
            request: { method: GET, url: http://x/ }
            think_time: { min_ms: 60, max_ms: 60 }
"#;
        let out = maybe_strip_think(y, &open_profile(false));
        let sc = Scenario::from_yaml(&out).unwrap();
        let Step::Loop(l) = &sc.steps[0] else {
            panic!("loop")
        };
        let Step::Loop(a) = &l.do_[0] else {
            panic!("loop")
        };
        let Step::Loop(b) = &l.do_[1] else {
            panic!("loop")
        };
        assert_eq!(http_think(&a.do_[0]), Some((50, 50)));
        assert_eq!(http_think(&b.do_[0]), Some((60, 60)));
    }

    #[test]
    fn strip_parallel_inside_keep_loop_does_not_copy_root_default() {
        let y = r#"
version: 1
name: t
default_think_time: { min_ms: 100, max_ms: 100 }
steps:
  - id: 01HX0000000000000000000BBB
    type: loop
    name: keep
    while: { left: "{{code}}", op: eq, right: WAIT }
    do:
      - id: 01HX0000000000000000000DDD
        type: parallel
        name: par
        branches:
          - name: br
            steps:
              - id: 01HX0000000000000000000CCC
                type: http
                name: own
                request: { method: GET, url: http://x/ }
                think_time: { min_ms: 50, max_ms: 50 }
              - id: 01HX0000000000000000000EEE
                type: http
                name: none
                request: { method: GET, url: http://x/ }
"#;
        let out = maybe_strip_think(y, &open_profile(false));
        let sc = Scenario::from_yaml(&out).unwrap();
        let Step::Loop(l) = &sc.steps[0] else {
            panic!("loop")
        };
        let Step::Parallel(p) = &l.do_[0] else {
            panic!("par")
        };
        assert_eq!(http_think(&p.branches[0].steps[0]), Some((50, 50)));
        assert_eq!(http_think(&p.branches[0].steps[1]), None);
    }
}
