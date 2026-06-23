use axum::Json;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use handicap_engine::{Scenario, Step};
use handicap_proto::v1 as pb;
use serde::{Deserialize, Serialize};

use crate::app::AppState;
use crate::binding::{BindingPolicy, collect_var_names};
use crate::error::ApiError;
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
}

pub(crate) fn loop_cap_ok(cap: u32, max: u32) -> bool {
    cap <= max
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
    for (i, sc) in c.step_criteria.iter().enumerate() {
        if !STEP_METRICS.contains(&sc.metric.as_str()) {
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
        let capacity = state.settings.worker_capacity_vus();
        let stages = profile.vu_stages.as_deref().unwrap_or_default();
        for s in stages {
            if s.duration_seconds == 0 {
                return Err(ApiError::BadRequest(
                    "stage duration_seconds must be >= 1".into(),
                ));
            }
            if !state.coord.is_pool_mode() && s.target > capacity {
                return Err(ApiError::BadRequest(format!(
                    "최대 목표 VU {}가 워커 용량 {capacity}을 초과합니다 \
                     (vu_stages는 단일 워커 — 멀티워커 곡선 샤딩 미지원, spec §9)",
                    s.target
                )));
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
    let n = if profile.is_vu_curve() {
        1 // 단일 워커 v1 (curve: 검증 ⑦이 capacity 이내 보장)
    } else if profile.is_open_loop() {
        profile.worker_count.unwrap_or(1)
    } else {
        crate::grpc::shard::worker_count(profile.vus, state.settings.worker_capacity_vus())
    };
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

/// Effective startup grace: at least the CLI floor, but never below the run's
/// HTTP timeout + margin (a black-hole SUT emits its first error-metric only
/// after the timeout), plus any leading idle stages. Mirrors worker's 0→30 fallback.
pub(crate) fn startup_grace_eff(
    p: &pb::Profile,
    startup_floor: std::time::Duration,
) -> std::time::Duration {
    let http_to = if p.http_timeout_seconds == 0 {
        30
    } else {
        p.http_timeout_seconds
    } as u64;
    let floor = startup_floor.max(std::time::Duration::from_secs(http_to + STARTUP_MARGIN));
    floor + std::time::Duration::from_secs(leading_idle_secs(p))
}

/// 검증된 run을 발사: insert → data_binding 해석 → enqueue → dispatch.
/// dispatch 실패 시 run을 failed로 마크하고 Err 반환(cancel_dispatch_failed +
/// mark_failed 수행 후). REST `create`(권위 게이트 통과 후 호출)와 스케줄러
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
    let row = runs::insert(&state.db, &scenario.id, &scenario.yaml, profile, &env_value).await?;

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

    // Enqueue the assignment so the coordinator can hand shards to N workers.
    let assignment = crate::grpc::coordinator::PendingAssignment {
        scenario_yaml: scenario.yaml.clone(),
        profile: handicap_proto::v1::Profile {
            vus: profile.vus,
            ramp_up_seconds: profile.ramp_up_seconds,
            duration_seconds: profile.duration_seconds,
            loop_breakdown_cap: profile.loop_breakdown_cap,
            http_timeout_seconds: profile.http_timeout_seconds,
            think_time: profile.think_time.map(|t| handicap_proto::v1::ThinkTime {
                min_ms: t.min_ms,
                max_ms: t.max_ms,
            }),
            think_seed: profile.think_seed,
            target_rps: profile.target_rps,
            max_in_flight: profile.max_in_flight,
            stages: profile
                .stages
                .as_deref()
                .unwrap_or_default()
                .iter()
                .map(|s| handicap_proto::v1::Stage {
                    target: s.target,
                    duration_seconds: s.duration_seconds,
                })
                .collect(),
            measure_phases: profile.measure_phases,
            vu_stages: profile
                .vu_stages
                .as_deref()
                .unwrap_or_default()
                .iter()
                .map(|s| handicap_proto::v1::Stage {
                    target: s.target,
                    duration_seconds: s.duration_seconds,
                })
                .collect(),
            ramp_down_immediate: matches!(
                profile.ramp_down,
                Some(handicap_engine::RampDown::Immediate)
            ),
        },
        env: env.clone(),
        data_bindings,
    };
    // Per-run liveness grace (G1a). Computed from the proto Profile BEFORE
    // `assignment` is moved into any enqueue branch. startup-A = floor (CLI ?? 90s)
    // raised to HTTP-timeout + margin + leading idle; backstop-B = engine run
    // duration + CLI grace (?? 120s).
    let (startup_floor, backstop_grace) = state.coord.watchdog_grace_config();
    let startup_grace = startup_grace_eff(&assignment.profile, startup_floor);
    let backstop_total =
        std::time::Duration::from_secs(handicap_proto::run_duration_secs(&assignment.profile))
            + backstop_grace;
    // vu-curve is single-worker v1 (검증 ⑦이 capacity 이내 보장, spec §9).
    let n = if profile.is_vu_curve() {
        1
    } else if profile.is_open_loop() {
        profile.worker_count.unwrap_or(1)
    } else {
        crate::grpc::shard::worker_count(profile.vus, state.settings.worker_capacity_vus())
    };
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
                    state.coord.cancel_dispatch_failed(&row.id).await;
                    runs::mark_failed(&state.db, &row.id, &msg).await?;
                    return Err(ApiError::BadRequest(msg));
                }
                crate::grpc::coordinator::PoolReservation::Insufficient { achievable } => {
                    // Rare TOCTOU (pool shrank after precheck) — mark failed.
                    let msg = format!(
                        "풀 용량 부족 (가용 {achievable} VU < 요청 {} VU)",
                        profile.concurrency_demand()
                    );
                    state.coord.cancel_dispatch_failed(&row.id).await;
                    runs::mark_failed(&state.db, &row.id, &msg).await?;
                    return Err(ApiError::Internal(anyhow::anyhow!(msg)));
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
                        state.coord.cancel_dispatch_failed(&row.id).await;
                        runs::mark_failed(&state.db, &row.id, &msg).await?;
                        return Err(ApiError::BadRequest(msg));
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
                    if state
                        .coord
                        .assign_pool_workers(&row.id, workers)
                        .await
                        .is_err()
                    {
                        let msg = "풀 워커 배정 실패(워커 이탈) — 재시도하세요".to_string();
                        state.coord.cancel_dispatch_failed(&row.id).await;
                        runs::mark_failed(&state.db, &row.id, &msg).await?;
                        return Err(ApiError::Internal(anyhow::anyhow!(msg)));
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
                state.coord.cancel_dispatch_failed(&row.id).await;
                runs::mark_failed(&state.db, &row.id, &msg).await?;
                return Err(ApiError::BadRequest(msg));
            }
            // R14: unique floor — reject before enqueue (assignment moved in).
            // Release reservation first so workers return to idle without reconnecting.
            if let Some((rows, n)) = pool_unique_floor_violation(&assignment, n_pool) {
                let msg = format!(
                    "unique 데이터셋 행 수가 풀 워커 수보다 적습니다: rows={rows} < workers={n}"
                );
                state.coord.release_pool_reservation(&reserved).await;
                state.coord.cancel_dispatch_failed(&row.id).await;
                runs::mark_failed(&state.db, &row.id, &msg).await?;
                return Err(ApiError::BadRequest(msg));
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
            if state
                .coord
                .assign_pool_workers(&row.id, reserved)
                .await
                .is_err()
            {
                let msg = "풀 워커 배정 실패(워커 이탈) — 재시도하세요".to_string();
                state.coord.cancel_dispatch_failed(&row.id).await;
                runs::mark_failed(&state.db, &row.id, &msg).await?;
                return Err(ApiError::Internal(anyhow::anyhow!(msg)));
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

    Ok(row)
}

pub async fn create(
    State(state): State<AppState>,
    // Query MUST precede Json (axum: body extractor must be last). (L3 R4.)
    axum::extract::Query(q): axum::extract::Query<ForceQuery>,
    Json(body): Json<CreateRunRequest>,
) -> Result<(StatusCode, Json<RunResponse>), ApiError> {
    let scenario = scenarios::get(&state.db, &body.scenario_id)
        .await?
        .ok_or(ApiError::NotFound)?;

    let validated_meta = validate_run_config(&state, &body.profile).await?;
    validate_step_criteria_targets(&body.profile, &scenario.yaml).map_err(ApiError::BadRequest)?;

    let row = spawn_run(
        &state,
        &scenario,
        &body.profile,
        validated_meta,
        &body.env,
        q.force,
    )
    .await?;

    Ok((StatusCode::CREATED, Json(to_response(row, None))))
}

pub async fn get(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<RunResponse>, ApiError> {
    let row = runs::get(&state.db, &id).await?.ok_or(ApiError::NotFound)?;
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
pub async fn build_report_for_run(
    db: &crate::store::Db,
    run_id: &str,
) -> Result<crate::report::ReportJson, ApiError> {
    let row = runs::get(db, run_id).await?.ok_or(ApiError::NotFound)?;
    let rows = crate::store::metrics::windows_with_hdr(db, run_id).await?;
    let loops = crate::store::metrics::loop_breakdown(db, run_id).await?;
    let branches = crate::store::metrics::if_breakdown(db, run_id).await?;
    let groups = crate::store::metrics::group_breakdown(db, run_id).await?;
    let phases = crate::store::metrics::phase_breakdown(db, run_id).await?;
    let active_vu = crate::store::metrics::active_vu_series(db, run_id).await?;
    let scenario_yaml = row.scenario_yaml.clone();
    Ok(crate::report::build_report(
        &row,
        &scenario_yaml,
        &rows,
        &loops,
        &branches,
        &groups,
        &phases,
        &active_vu,
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

pub async fn report_insights_csv(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<axum::response::Response, ApiError> {
    let row = runs::get(&state.db, &id).await?.ok_or(ApiError::NotFound)?;
    ensure_terminal(&row)?;
    let report = build_report_for_run(&state.db, &id).await?;
    let bytes = crate::export::report_to_insights_csv(&report);
    Ok(file_response(
        "text/csv; charset=utf-8",
        &format!("run-{id}-insights.csv"),
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

fn to_response(r: runs::RunRow, last_metric_ts: Option<i64>) -> RunResponse {
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
            super::startup_grace_eff(&p, std::time::Duration::from_secs(90)),
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
            super::startup_grace_eff(&p2, std::time::Duration::from_secs(90)),
            std::time::Duration::from_secs(90 + 20)
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
            worker_count: None,
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
                worker_count: None,
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
            worker_count: None,
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
            worker_count: None,
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
            worker_count: None,
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

        // ⑦b stage target > capacity(2000)
        let err = validate_run_config(
            &state,
            &curve_profile(vec![handicap_engine::Stage {
                target: 2001,
                duration_seconds: 10,
            }]),
        )
        .await
        .unwrap_err();
        assert!(
            matches!(&err, ApiError::BadRequest(m) if m.contains("워커 용량")),
            "⑦b expected capacity exceeded, got {err:?}"
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

    /// R6: worker capacity flows from SettingsState (not coord) to the validation
    /// site. A lowered capacity (2 via seed) must reject a closed-loop VU-curve run
    /// whose stage target (3) exceeds it. This is the validation half of the
    /// capacity-consistency invariant; the dispatch-N half (same accessor at the
    /// spawn site) is exercised by the multi-worker fanout e2e.
    #[tokio::test]
    async fn lowered_capacity_settings_enforced_at_validation() {
        let db = crate::store::connect("sqlite::memory:").await.unwrap();
        let state = state_with(db, 2).await; // SettingsState seeded with worker_capacity_vus=2
        // stage target 3 > capacity 2 → vu-curve capacity gate (reads settings) rejects.
        let over = curve_profile(vec![handicap_engine::Stage {
            target: 3,
            duration_seconds: 10,
        }]);
        let err = validate_run_config(&state, &over).await.unwrap_err();
        assert!(
            matches!(&err, ApiError::BadRequest(m) if m.contains("워커 용량") && m.contains('2')),
            "stage target above settings capacity must be rejected, got {err:?}"
        );
        // at/under capacity passes — confirms the bound is the settings value, not a constant.
        let ok = curve_profile(vec![handicap_engine::Stage {
            target: 2,
            duration_seconds: 10,
        }]);
        assert!(
            validate_run_config(&state, &ok).await.is_ok(),
            "stage target == settings capacity must be accepted"
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

    /// R7 inverse: non-pool mode must still reject a curve that exceeds single-worker capacity.
    #[tokio::test]
    async fn validate_vu_curve_nonpool_rejects() {
        let db = crate::store::connect("sqlite::memory:").await.unwrap();
        let state = state_with(db, 2000).await; // pool_mode defaults false
        let p = curve_profile(vec![handicap_engine::Stage {
            target: 5000,
            duration_seconds: 10,
        }]);
        assert!(
            matches!(
                validate_run_config(&state, &p).await,
                Err(ApiError::BadRequest(_))
            ),
            "non-pool mode: peak>capacity must be rejected with 400"
        );
    }
}
