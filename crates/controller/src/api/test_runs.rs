use std::collections::BTreeMap;
use std::time::Duration;

use axum::Json;
use axum::extract::State;
use axum::response::{IntoResponse, Response};
use handicap_engine::{
    Scenario, TraceOptions, trace_scenario, trace_scenario_rows, trace_scenario_with_seed,
};
// (주의: `ScenarioTrace`는 임포트하지 않는다 — 핸들러 리턴이 `Response`로 바뀌어
// 타입 표기가 사라지므로 unused import = clippy -D warnings 게이트 실패.)
use serde::Deserialize;

use crate::api::scenarios::validate_scenario_think_times;
use crate::binding::{Mapping, apply_mappings};
use crate::error::ApiError;
use crate::store::datasets;

const DEFAULT_MAX_REQUESTS: u32 = 50;
const WALL_CLOCK_CEILING_SECS: u64 = 120;

fn default_max_requests() -> u32 {
    DEFAULT_MAX_REQUESTS
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TestRunDatasetMode {
    SingleRow,
    Sequential,
}

#[derive(Debug, Deserialize)]
pub struct TestRunBinding {
    pub dataset_id: String,
    /// None = 전 컬럼→동명 변수 자동 매핑(서버가 명시 Column으로 실체화 — R3).
    /// Some(빈 배열) = 422 — run 와이어의 "빈 매핑 = 주입 없음"(runs.rs)과
    /// 같은 모양이 다른 뜻이 되는 이중 계약 금지 (spec §5).
    #[serde(default)]
    pub mappings: Option<Vec<Mapping>>,
    /// single_row 전용·필수(R9-⑩). sequential에서 지정 시 422 (R9-⑨).
    #[serde(default)]
    pub row_index: Option<u64>,
}

#[derive(Debug, Deserialize)]
pub struct TestRunDatasetConfig {
    pub mode: TestRunDatasetMode,
    pub bindings: Vec<TestRunBinding>,
    /// sequential 전용 (None=0). single_row에서 지정 시 422 (R9-⑨).
    #[serde(default)]
    pub start_row: Option<u64>,
    /// sequential 전용, None=전체 (R18 clamp).
    #[serde(default)]
    pub row_limit: Option<u64>,
}

#[derive(Debug, Deserialize)]
pub struct TestRunRequest {
    pub scenario_yaml: String,
    #[serde(default)]
    pub env: BTreeMap<String, String>,
    #[serde(default = "default_max_requests")]
    pub max_requests: u32,
    /// Opt-in: honor per-step `think_time` (actually sleep) for throttled
    /// previews. Default false = instant preview.
    #[serde(default)]
    pub apply_think_time: bool,
    /// Reserved for the future worker-based runner (spec §8-3). Ignored in v1.
    #[serde(default)]
    #[allow(dead_code)]
    pub runner: Option<String>,
    /// Optional dataset binding for the trace (ADR-0047). None = existing behavior.
    #[serde(default)]
    pub dataset: Option<TestRunDatasetConfig>,
}

/// 검증 통과한 바인딩 — 자동 매핑은 이미 명시 Column으로 실체화됨(R3).
struct EffectiveBinding {
    dataset_id: String,
    mappings: Vec<Mapping>,
    row_index: Option<u64>,
    row_count: u64,
}

/// R3 실체화 + R9 ①②⑤⑥⑦⑧(+⑪ 빈 데이터셋 방어). 메타는 바인딩당 1회
/// fetch(TOCTOU 가드 — 8c 함정) 후 필요한 필드만 남긴다.
async fn resolve_bindings(
    state: &crate::app::AppState,
    cfg: &TestRunDatasetConfig,
) -> Result<Vec<EffectiveBinding>, ApiError> {
    if cfg.bindings.is_empty() {
        return Err(ApiError::Unprocessable(
            "데이터셋 바인딩을 1개 이상 지정하세요 (bindings가 비어 있음)".into(),
        ));
    }
    let max_bindings = state.settings.max_data_bindings();
    if cfg.bindings.len() > max_bindings {
        return Err(ApiError::Unprocessable(format!(
            "데이터셋 바인딩은 최대 {max_bindings}개입니다 ({}개)",
            cfg.bindings.len()
        )));
    }
    let mut effective = Vec::with_capacity(cfg.bindings.len());
    let mut seen = std::collections::HashSet::new();
    for b in &cfg.bindings {
        let meta = datasets::get_meta(&state.db, &b.dataset_id)
            .await?
            .ok_or_else(|| {
                ApiError::Unprocessable(format!("데이터셋 '{}'이 존재하지 않습니다", b.dataset_id))
            })?;
        // R9 목록 외 방어: 0행 데이터셋은 비-첫 바인딩 wrap `% len`이 0-나눗셈이
        // 된다 — run 게이트와 같은 메시지로 선제 거부.
        if meta.row_count == 0 {
            return Err(ApiError::Unprocessable(
                "빈 데이터셋은 바인딩할 수 없습니다".into(),
            ));
        }
        let mappings: Vec<Mapping> = match &b.mappings {
            // R3: 생략 = 전 컬럼→동명 변수 자동 매핑을 명시 Column으로 실체화.
            None => meta
                .columns
                .iter()
                .map(|c| Mapping::Column {
                    var: c.clone(),
                    column: c.clone(),
                })
                .collect(),
            Some(v) if v.is_empty() => {
                return Err(ApiError::Unprocessable(
                    "mappings 빈 배열은 허용되지 않습니다 — 자동 매핑은 mappings 필드를 생략하세요"
                        .into(),
                ));
            }
            Some(v) => v.clone(),
        };
        // 실체화 후 effective 매핑 기준 단일 경로 검증 (R9-②·⑤ — auto-auto 충돌 포함).
        for m in &mappings {
            if let Mapping::Column { column, .. } = m {
                if !meta.columns.iter().any(|c| c == column) {
                    return Err(ApiError::Unprocessable(format!(
                        "매핑 컬럼 '{column}'이 데이터셋에 없습니다 (있는 컬럼: {:?})",
                        meta.columns
                    )));
                }
            }
            let var = match m {
                Mapping::Column { var, .. } | Mapping::Literal { var, .. } => var,
            };
            if !seen.insert(var.clone()) {
                return Err(ApiError::Unprocessable(format!(
                    "변수 '{var}'이 여러 데이터셋에 중복 매핑됨"
                )));
            }
        }
        effective.push(EffectiveBinding {
            dataset_id: b.dataset_id.clone(),
            mappings,
            row_index: b.row_index,
            row_count: meta.row_count as u64,
        });
    }
    Ok(effective)
}

/// single_row: R9 ③⑨⑩ 검증 + 바인딩별 1행 로드·매핑 병합 시드 (R4).
async fn seed_single_row(
    state: &crate::app::AppState,
    cfg: &TestRunDatasetConfig,
    effective: &[EffectiveBinding],
) -> Result<BTreeMap<String, String>, ApiError> {
    if cfg.start_row.is_some() || cfg.row_limit.is_some() {
        return Err(ApiError::Unprocessable(
            "single_row 모드에선 start_row/row_limit를 지정할 수 없습니다".into(),
        ));
    }
    let mut seed = BTreeMap::new();
    for b in effective {
        let idx = b.row_index.ok_or_else(|| {
            ApiError::Unprocessable("single_row 모드는 바인딩마다 row_index가 필요합니다".into())
        })?;
        if idx >= b.row_count {
            return Err(ApiError::Unprocessable(format!(
                "row_index {idx}가 데이터셋 행 수 {}를 벗어납니다",
                b.row_count
            )));
        }
        let rows = datasets::get_rows_range(&state.db, &b.dataset_id, idx as i64, 1).await?;
        let row = rows.into_iter().next().ok_or_else(|| {
            ApiError::Unprocessable(format!(
                "데이터셋 '{}'의 행 {idx}를 읽지 못했습니다",
                b.dataset_id
            ))
        })?;
        seed.extend(apply_mappings(&b.mappings, &row));
    }
    Ok(seed)
}

struct SequentialPlan {
    seeded_rows: Vec<(u64, BTreeMap<String, String>)>,
    /// 사용자 요청 구간 = row_limit ?? 첫 바인딩 잔여 (R6 truncated 판정 기준).
    requested_span: u64,
}

/// sequential: R9 ③④⑨ 검증 + R18 clamp + 행 로드(바인딩별 연속 range fetch
/// 1–2회, ≤ min(len, N)행 — 전체 선로드 금지) + 반복별 시드 (R4/R17).
async fn seed_sequential(
    state: &crate::app::AppState,
    cfg: &TestRunDatasetConfig,
    effective: &[EffectiveBinding],
    max_requests: u32,
) -> Result<SequentialPlan, ApiError> {
    if effective.iter().any(|b| b.row_index.is_some()) {
        return Err(ApiError::Unprocessable(
            "sequential 모드에선 row_index를 지정할 수 없습니다".into(),
        ));
    }
    if cfg.row_limit == Some(0) {
        return Err(ApiError::Unprocessable(
            "row_limit는 1 이상이어야 합니다".into(),
        ));
    }
    let first = &effective[0];
    let start = cfg.start_row.unwrap_or(0);
    if start >= first.row_count {
        return Err(ApiError::Unprocessable(format!(
            "start_row {start}가 첫 바인딩 데이터셋 행 수 {}를 벗어납니다",
            first.row_count
        )));
    }
    let remaining = first.row_count - start;
    let requested_span = cfg.row_limit.unwrap_or(remaining);
    // R18: N = min(row_limit ?? 잔여, 잔여, max_requests).
    let n = requested_span.min(remaining).min(max_requests as u64);
    // 행 로드: 첫 바인딩은 start부터 no-wrap 1회(start+n ≤ row_count 보장),
    // 비-첫은 start % len부터 — 테이블 끝에 못 미치면 head를 0부터 이어붙인다(wrap 2회째).
    let mut loaded: Vec<Vec<BTreeMap<String, String>>> = Vec::with_capacity(effective.len());
    for (k, b) in effective.iter().enumerate() {
        let len = b.row_count;
        let count = n.min(len);
        let first_idx = if k == 0 { start } else { start % len };
        let mut rows =
            datasets::get_rows_range(&state.db, &b.dataset_id, first_idx as i64, count as i64)
                .await?;
        if (rows.len() as u64) < count {
            let head = count - rows.len() as u64;
            let mut head_rows =
                datasets::get_rows_range(&state.db, &b.dataset_id, 0, head as i64).await?;
            rows.append(&mut head_rows);
        }
        if (rows.len() as u64) < count {
            // meta 검증 후 삭제된 rare TOCTOU — 500 대신 검증 계열 422.
            return Err(ApiError::Unprocessable(format!(
                "데이터셋 '{}'의 행을 읽지 못했습니다",
                b.dataset_id
            )));
        }
        loaded.push(rows);
    }
    // 반복 i의 비-첫 바인딩 행 = (start+i) % len = 로드 벡터의 i % len 위치
    // (로드가 start%len부터 wrap 순서라 by-construction 정렬 — R17).
    let mut seeded_rows = Vec::with_capacity(n as usize);
    for i in 0..n {
        let mut seed = BTreeMap::new();
        for (k, b) in effective.iter().enumerate() {
            let rows = &loaded[k];
            let row = &rows[(i as usize) % rows.len()];
            seed.extend(apply_mappings(&b.mappings, row));
        }
        seeded_rows.push((start + i, seed));
    }
    Ok(SequentialPlan {
        seeded_rows,
        requested_span,
    })
}

/// `POST /api/test-runs` — run an inline scenario once (1 VU, single pass)
/// in-process and return a per-request trace. Ephemeral: nothing is persisted.
pub async fn create(
    State(state): State<crate::app::AppState>,
    Json(body): Json<TestRunRequest>,
) -> Result<Response, ApiError> {
    let max_requests = state.settings.max_test_run_requests();
    if body.max_requests < 1 || body.max_requests > max_requests {
        return Err(ApiError::Unprocessable(format!(
            "max_requests must be 1..={max_requests}, got {}",
            body.max_requests
        )));
    }
    let scenario = Scenario::from_yaml(&body.scenario_yaml)
        .map_err(|e| ApiError::Unprocessable(format!("scenario parse: {e}")))?;
    validate_scenario_think_times(&scenario.steps, &scenario.default_think_time)
        .map_err(ApiError::Unprocessable)?;

    let opts = TraceOptions {
        env: body.env,
        max_requests: body.max_requests,
        max_wall: Duration::from_secs(WALL_CLOCK_CEILING_SECS),
        apply_think_time: body.apply_think_time,
    };
    match &body.dataset {
        // R1: dataset 없는 요청은 기존 경로 그대로.
        None => Ok(Json(trace_scenario(&scenario, &opts).await).into_response()),
        Some(cfg) => {
            let effective = resolve_bindings(&state, cfg).await?;
            match cfg.mode {
                TestRunDatasetMode::SingleRow => {
                    let seed = seed_single_row(&state, cfg, &effective).await?;
                    // R7: 기존 ScenarioTrace 형태 그대로 — 렌더러 무변경.
                    let trace = trace_scenario_with_seed(&scenario, &opts, &seed).await;
                    Ok(Json(trace).into_response())
                }
                TestRunDatasetMode::Sequential => {
                    let plan = seed_sequential(&state, cfg, &effective, body.max_requests).await?;
                    let mut rt = trace_scenario_rows(&scenario, &opts, &plan.seeded_rows).await;
                    // R6/R18: clamp로 요청 구간이 축소됐으면 all-green이어도 truncated.
                    let clamped = (plan.seeded_rows.len() as u64) < plan.requested_span;
                    rt.truncated = rt.truncated || clamped;
                    rt.ok = rt.ok && !clamped;
                    Ok(Json(rt).into_response())
                }
            }
        }
    }
}
