//! 계단 시험(stage-saturation-table) — profile.stair 설정·stages 펼침·정규화.
//! 와이어(proto)엔 없다: 워커는 펼쳐진 `stages`만 받는다.

use std::collections::BTreeMap;

use handicap_engine::Stage;
use handicap_engine::percentiles::{decode_hdr, merge_into};
use hdrhistogram::Histogram;
use serde::{Deserialize, Serialize};

use crate::auto_stop::{AutoStopRecord, StopInfo, StopKind};
use crate::store::metrics::WindowWithHdr;
use crate::store::open_loop::{OpenLoopSecondRow, WorkerStartRow};
use crate::store::runs::Profile;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct StairConfig {
    pub targets: Vec<u32>,
    pub hold_seconds: u32,
    pub ramp_seconds: u32,
    pub discard_seconds: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub p99_cap_ms: Option<u32>,
    /// 자동 정지 설정. 없으면 둘 다 끔(a 저장본과 바이트 동일).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auto_stop: Option<AutoStopConfig>,
}

/// 안쪽 키는 직렬화 때 항상 나온다(끄면 `null`). 입력은 키 생략 허용.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AutoStopConfig {
    #[serde(default)]
    pub saturation: Option<SaturationStopMode>,
    #[serde(default)]
    pub emergency: Option<EmergencyStop>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SaturationStopMode {
    TwoFails,
    FirstFail,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EmergencyStop {
    pub error_rate_pct: f64,
    pub p99_ms: u32,
    pub consecutive_seconds: u32,
    pub min_requests: u32,
}

/// 감시 객체인가 — auto_stop 칸이 하나라도 켜져 있을 때.
pub fn monitor_wanted(c: &StairConfig) -> bool {
    c.auto_stop
        .as_ref()
        .is_some_and(|a| a.saturation.is_some() || a.emergency.is_some())
}

/// 계단 i마다 `[상승 t_i, 유지 t_i]`. 엔진 stage는 앞 목표→이 목표 선형 보간이라
/// 상승 stage가 경사, 유지 stage가 평평한 구간이 된다.
pub fn expand_stair(c: &StairConfig) -> Vec<Stage> {
    c.targets
        .iter()
        .flat_map(|&t| {
            [
                Stage {
                    target: t,
                    duration_seconds: c.ramp_seconds,
                },
                Stage {
                    target: t,
                    duration_seconds: c.hold_seconds,
                },
            ]
        })
        .collect()
}

pub fn validate_stair(c: &StairConfig) -> Result<(), String> {
    if !(2..=50).contains(&c.targets.len()) {
        return Err("계단 목표는 2개 이상 50개 이하여야 합니다".into());
    }
    if let Some(t) = c.targets.iter().find(|t| !(1..=1_000_000).contains(*t)) {
        return Err(format!(
            "계단 목표 {t}은(는) 1 이상 1,000,000 이하여야 합니다"
        ));
    }
    if c.targets.windows(2).any(|w| w[1] <= w[0]) {
        return Err("계단 목표는 앞보다 커지는 순서(중복 불가)여야 합니다".into());
    }
    if !(20..=3600).contains(&c.hold_seconds) {
        return Err("계단 유지 시간은 20초 이상 3600초 이하여야 합니다".into());
    }
    if !(1..=600).contains(&c.ramp_seconds) {
        return Err("계단 상승 시간은 1초 이상 600초 이하여야 합니다".into());
    }
    if c.discard_seconds > c.hold_seconds - 10 {
        return Err(format!(
            "앞부분 버림은 {}초 이하여야 합니다 (측정 구간이 10초 이상 남아야 함)",
            c.hold_seconds - 10
        ));
    }
    if let Some(cap) = c.p99_cap_ms
        && !(1..=600_000).contains(&cap)
    {
        return Err("p99 상한은 1ms 이상 600,000ms 이하여야 합니다".into());
    }
    if let Some(e) = c.auto_stop.as_ref().and_then(|a| a.emergency.as_ref()) {
        if !(e.error_rate_pct.is_finite() && e.error_rate_pct > 0.0 && e.error_rate_pct <= 100.0) {
            return Err("즉시 정지 오류율은 0 초과 100 이하여야 합니다".into());
        }
        if !(1..=600_000).contains(&e.p99_ms) {
            return Err("즉시 정지 p99는 1ms 이상 600,000ms 이하여야 합니다".into());
        }
        if !(1..=60).contains(&e.consecutive_seconds) {
            return Err("즉시 정지 연속 초는 1초 이상 60초 이하여야 합니다".into());
        }
        if !(1..=100_000).contains(&e.min_requests) {
            return Err("즉시 정지 최소 요청 수는 1 이상 100,000 이하여야 합니다".into());
        }
    }
    Ok(())
}

/// `stair`가 있으면 stages를 펼쳐 채운다(없으면 no-op). 이미 stages가 있으면
/// 펼친 결과와 같을 때만 통과(저장본 재제출 round-trip). 반드시 `validate_run_config` 앞에서.
pub fn normalize_stair(p: &mut Profile) -> Result<(), String> {
    let Some(stair) = p.stair.as_ref() else {
        return Ok(());
    };
    validate_stair(stair)?;
    if p.target_rps.is_some() {
        return Err("계단 시험(stair)과 target_rps는 함께 쓸 수 없습니다".into());
    }
    if p.vu_stages.is_some() {
        return Err("계단 시험(stair)과 vu_stages는 함께 쓸 수 없습니다".into());
    }
    if p.duration_seconds > 0 {
        return Err(
            "계단 시험(stair)에선 duration_seconds를 비워야 합니다 (총 길이 = 계단 합)".into(),
        );
    }
    let expanded = expand_stair(stair);
    match p.stages.as_deref() {
        None | Some([]) => p.stages = Some(expanded),
        Some(existing) if existing == expanded.as_slice() => {}
        Some(_) => {
            return Err("계단 시험(stair)과 stages가 일치하지 않습니다 — stages를 비우세요".into());
        }
    }
    Ok(())
}

// ── 판정 (spec §5.3, bench `saturation.py` 이식) ──────────────────────────
// 모든 p99 비교는 정수 µs.

const ACHIEVED_MIN: f64 = 0.95;
const ERROR_MAX: f64 = 0.01;
const P99_MULT: u64 = 3;
const P99_FAST_US: u64 = 1000;
const P99_FAST_CAP_US: u64 = 5000;
/// knee: 바로 앞 정상 계단 대비 p99 ≥ 1.5× (정수로 `2·cur ≥ 3·prev`) ∧ p99 ≥ 1 ms.
const KNEE_MIN_US: u64 = 1000;

/// 판정에 쓰는 계단 하나의 숫자. `measured`는 누적기가 `complete ∧ 2·measured_seconds ≥ hold − discard`로 채운다.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct StepNumbers {
    pub target: u32,
    /// 달성한 초당 반복 수. 없으면 달성 조건을 보지 않는다.
    pub achieved: Option<f64>,
    /// 그 계단에서 생긴 dropped. 없으면 dropped 조건을 보지 않는다.
    pub dropped: Option<u64>,
    pub error_rate: f64,
    pub p99_us: u64,
    pub measured: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StepState {
    Ok,
    Spike,
    Saturated,
    Unconfirmed,
    After,
    NotMeasured,
    /// 즉시 정지가 일어난 계단(측정 완결 전) — 자동 정지 기록이 있을 때만.
    EmergencyStopped,
    /// 판정 계단 뒤, 정지 시각 전에 시작한 계단 — 자동 정지 기록이 있을 때만.
    Partial,
    /// 정지 시각 전에 시작하지 않은 계단 — 자동 정지 기록이 있을 때만.
    Skipped,
}

impl StepState {
    /// 행에 측정 숫자(달성·시작율·dropped)를 보이나 — 리포트·내보내기·화면의 단일 기준.
    pub fn shows_numbers(self) -> bool {
        match self {
            Self::Ok | Self::Spike | Self::Saturated | Self::Unconfirmed | Self::After => true,
            Self::NotMeasured | Self::EmergencyStopped | Self::Partial | Self::Skipped => false,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReasonKind {
    Achieved,
    Dropped,
    Errors,
    P99Cap,
    P99Relative,
}

/// 실패 사유. `value`: achieved = 달성 비율(0..1), dropped = 개수, errors = 오류 비율,
/// p99_cap = p99 ms, p99_relative = 기준 계단 대비 배수.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Reason {
    pub kind: ReasonKind,
    pub value: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HeadlineKind {
    Saturated,
    Unconfirmed,
    AllOk,
    OkThenUnmeasured,
    NoData,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Judgement {
    pub states: Vec<StepState>,
    pub reasons: Vec<Vec<Reason>>,
    pub slot_limited: Vec<bool>,
    pub last_ok: Option<usize>,
    pub spikes: Vec<usize>,
    pub saturation: Option<usize>,
    pub knee: Option<usize>,
    pub headline: HeadlineKind,
    pub later_ok_after_first_fail: bool,
}

/// bench `step_ok`와 같은 조건·순서. 실패 사유는 해당하는 것을 모두 담는다.
/// `p99_cap_ms`가 있으면 배수 규칙 대신 `p99 < cap`만 보고, 첫 계단에도 적용한다.
pub fn step_ok(
    cur: &StepNumbers,
    prev_ok: Option<&StepNumbers>,
    p99_cap_ms: Option<u32>,
) -> (bool, Vec<Reason>) {
    let mut reasons = Vec::new();
    if let Some(a) = cur.achieved
        && a < ACHIEVED_MIN * f64::from(cur.target)
    {
        reasons.push(Reason {
            kind: ReasonKind::Achieved,
            value: a / f64::from(cur.target),
        });
    }
    if let Some(d) = cur.dropped
        && d != 0
    {
        reasons.push(Reason {
            kind: ReasonKind::Dropped,
            value: d as f64,
        });
    }
    if cur.error_rate >= ERROR_MAX {
        reasons.push(Reason {
            kind: ReasonKind::Errors,
            value: cur.error_rate,
        });
    }
    if let Some(cap) = p99_cap_ms {
        if cur.p99_us >= u64::from(cap) * 1000 {
            reasons.push(Reason {
                kind: ReasonKind::P99Cap,
                value: cur.p99_us as f64 / 1000.0,
            });
        }
    } else if let Some(prev) = prev_ok {
        let limit = if prev.p99_us < P99_FAST_US {
            P99_FAST_CAP_US
        } else {
            P99_MULT.saturating_mul(prev.p99_us)
        };
        if cur.p99_us >= limit {
            reasons.push(Reason {
                kind: ReasonKind::P99Relative,
                value: cur.p99_us as f64 / prev.p99_us.max(1) as f64,
            });
        }
    }
    (reasons.is_empty(), reasons)
}

fn is_slot_limited(reasons: &[Reason]) -> bool {
    !reasons.is_empty()
        && reasons
            .iter()
            .all(|r| matches!(r.kind, ReasonKind::Achieved | ReasonKind::Dropped))
}

/// 계단 표 판정. 걷기는 bench `_walk`와 같고, `unconfirmed`·`after`·`not_measured`는 표시 전용.
pub fn judge(steps: &[StepNumbers], cfg: &StairConfig) -> Judgement {
    let cap = cfg.p99_cap_ms;
    let n = steps.len();
    let mut states = vec![StepState::NotMeasured; n];
    let mut reasons: Vec<Vec<Reason>> = vec![Vec::new(); n];
    let mut slot_limited = vec![false; n];
    let mut last: Option<usize> = None;
    let mut spikes = Vec::new();
    let mut saturation = None;
    let mut stopped_unmeasured = false;

    let mut i = 0;
    while i < n {
        if !steps[i].measured {
            stopped_unmeasured = true;
            break;
        }
        let prev = last.map(|l| &steps[l]);
        let (ok, r) = step_ok(&steps[i], prev, cap);
        if ok {
            states[i] = StepState::Ok;
            last = Some(i);
            i += 1;
            continue;
        }
        slot_limited[i] = is_slot_limited(&r);
        reasons[i] = r;
        if last.is_some()
            && i + 1 < n
            && steps[i + 1].measured
            && step_ok(&steps[i + 1], prev, cap).0
        {
            states[i] = StepState::Spike;
            spikes.push(i);
            i += 1;
            continue;
        }
        saturation = Some(i);
        break;
    }

    let mut headline = match (saturation, last) {
        (None, None) => HeadlineKind::NoData,
        (None, Some(_)) if stopped_unmeasured => HeadlineKind::OkThenUnmeasured,
        (None, Some(_)) => HeadlineKind::AllOk,
        (Some(_), _) => HeadlineKind::Saturated,
    };

    let mut later_ok_after_first_fail = false;
    if let Some(k) = saturation {
        let ref_ok = last.map(|l| &steps[l]);
        // 확정 계단 뒤로 판정에 쓰이지 않은 계단: 측정됐으면 after(사유는 고정 ref로 표시), 아니면 not_measured.
        let mut rest = k + 1;
        if k + 1 < n && !steps[k + 1].measured {
            states[k] = StepState::Unconfirmed;
            headline = HeadlineKind::Unconfirmed;
            rest = n;
        } else {
            states[k] = StepState::Saturated;
            if k + 1 < n {
                let (ok, r) = step_ok(&steps[k + 1], ref_ok, cap);
                if !ok {
                    states[k + 1] = StepState::Saturated;
                    slot_limited[k + 1] = is_slot_limited(&r);
                    reasons[k + 1] = r;
                    rest = k + 2;
                }
            }
        }
        for j in rest..n {
            if steps[j].measured {
                states[j] = StepState::After;
                reasons[j] = step_ok(&steps[j], ref_ok, cap).1;
            }
        }
        later_ok_after_first_fail = last.is_none()
            && k == 0
            && steps[1..]
                .iter()
                .any(|st| st.measured && step_ok(st, None, cap).0);
    }

    let mut knee = None;
    let mut prev_ok: Option<u64> = None;
    for (idx, st) in states.iter().enumerate() {
        if *st != StepState::Ok {
            continue;
        }
        let p = steps[idx].p99_us;
        if let Some(pp) = prev_ok
            && p >= KNEE_MIN_US
            && p.saturating_mul(2) >= pp.saturating_mul(3)
        {
            knee = Some(idx);
            break;
        }
        prev_ok = Some(p);
    }

    Judgement {
        states,
        reasons,
        slot_limited,
        last_ok: last,
        spikes,
        saturation,
        knee,
        headline,
        later_ok_after_first_fail,
    }
}

// ── 리포트 계단 집계 (spec §5.1–§5.7) ─────────────────────────────────────

/// 계단 run만 읽는 두 테이블. 비계단 run은 `Default`(빈 값)로 넘긴다.
#[derive(Debug, Default)]
pub struct StairInputs {
    pub open_loop: Vec<OpenLoopSecondRow>,
    pub starts: Vec<WorkerStartRow>,
    /// 자동 정지 기록(status `completed` run만 — 호출자가 거른다).
    pub auto_stop: Option<AutoStopRecord>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct StairReport {
    pub config: StairConfig,
    pub steps: Vec<StairStep>,
    pub headline: StairHeadline,
    pub knee_target: Option<u32>,
    pub spike_targets: Vec<u32>,
    pub max_in_flight: Option<u32>,
    pub dropped_total: Option<u64>,
    pub dropped_explained: bool,
    pub slot_limited_targets: Vec<u32>,
    pub notes: StairNotes,
    pub seconds: Vec<StairSecond>,
    pub bands: Vec<StairBand>,
    pub target_line: Vec<TargetPoint>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auto_stop: Option<AutoStopRecord>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct StairStep {
    pub index: u32,
    pub target: u32,
    /// 완료 반복/초(전 워커 합). 초 단위 계수가 없으면(예전 부하기) null.
    pub achieved: Option<f64>,
    pub launched_rate: Option<f64>,
    /// 요청/초(전 step 합).
    pub throughput_rps: f64,
    pub p50_us: u64,
    pub p95_us: u64,
    pub p99_us: u64,
    pub error_rate: f64,
    pub dropped: Option<u64>,
    /// 워커별 측정 초의 최솟값.
    pub measured_seconds: u32,
    /// 가장 이른 t0 워커 기준 실제 포함한 첫 초 시작·마지막 초 끝(wall-clock ms).
    pub measure_start_ms: i64,
    pub measure_end_ms: i64,
    pub state: StepState,
    pub reasons: Vec<Reason>,
    pub knee: bool,
    pub slot_limited: bool,
    pub head_p99_ratio: Option<f64>,
    pub discard_warning: bool,
    /// `partial` 행만: 가장 이른 t0 기준 계단 시작 → 정지 시각까지 초와 그때의 구간.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub partial: Option<PartialRun>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct PartialRun {
    pub seconds: u32,
    pub phase: BandKind,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct StairHeadline {
    pub kind: HeadlineKind,
    pub saturated_target: Option<u32>,
    pub last_ok_target: Option<u32>,
    /// 「N req/s까지 정상」의 N (`all_ok`·`ok_then_unmeasured`만).
    pub through_target: Option<u32>,
    pub first_fail_hint: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct StairNotes {
    pub t0_estimated: bool,
    pub open_loop_unknown: bool,
}

/// 1초 띠 데이터. `offset_s` = 워커별 t0 초로 맞춘 오프셋(전 워커 합산).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct StairSecond {
    pub offset_s: i64,
    pub launched: Option<u64>,
    pub completed: Option<u64>,
    pub dropped: Option<u64>,
    pub count: u64,
    pub p99_us: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BandKind {
    Ramp,
    Discard,
    Measure,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct StairBand {
    pub index: u32,
    pub kind: BandKind,
    pub start_s: u64,
    pub end_s: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TargetPoint {
    pub offset_s: u64,
    pub target: u32,
}

/// ⚠ 계산: 측정 초 20초 이상, 앞부분 = 측정 구간 첫 10초.
const HEAD_MIN_MEASURED: u32 = 20;
const HEAD_SECONDS: i64 = 10;
const HEAD_RATIO_WARN: u64 = 2;
const HEAD_MIN_US: u64 = 1000;

struct WorkerView<'a> {
    id: &'a str,
    t0_ms: i64,
    metrics: Vec<&'a WindowWithHdr>,
    open_loop: Vec<&'a OpenLoopSecondRow>,
}

/// 스케줄러가 그 초에 도착을 만들었나(시작했거나 슬롯이 없어 버렸나).
fn schedules(r: &OpenLoopSecondRow) -> bool {
    r.launched > 0 || r.dropped > 0
}

fn nonneg(v: i64) -> u64 {
    v.max(0) as u64
}

/// 저장된 계수(음수는 0)를 포화 덧셈으로 더한다.
fn add(acc: &mut u64, v: i64) {
    *acc = acc.saturating_add(nonneg(v));
}

fn clamp_u32(v: i64) -> u32 {
    u32::try_from(v.max(0)).unwrap_or(u32::MAX)
}

/// 워커 t0에서 계단 i의 측정 초 `[lo, hi)`: `[ts·1000, ts·1000+1000)`이 측정 구간에
/// 완전히 들어가고 `ts ≤ last`인 정수 초.
/// 시각은 부하기가 보낸 값이라 포화 산술로 계산한다(터무니없는 값에도 패닉 없음).
fn measure_window(cfg: &StairConfig, t0_ms: i64, bound: Bound, i: usize) -> (i64, i64) {
    let step_ms = i64::from(cfg.ramp_seconds + cfg.hold_seconds) * 1000;
    let start = t0_ms.saturating_add((i as i64).saturating_mul(step_ms));
    let ms = start.saturating_add(i64::from(cfg.ramp_seconds + cfg.discard_seconds) * 1000);
    let me = start.saturating_add(step_ms);
    let lo = ms.div_euclid(1000) + i64::from(ms.rem_euclid(1000) != 0);
    let hi = match bound {
        Bound::Upto(l) => me.div_euclid(1000).min(l.saturating_add(1)),
        Bound::Open => me.div_euclid(1000),
    };
    (lo, hi.max(lo))
}

/// 계단 측정 구간의 끝을 어디서 자르나.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Bound {
    /// 리포트: 스케줄러가 도착을 만든 마지막 초(`last`)까지만.
    Upto(i64),
    /// 감시: 측정 구간 끝까지(판정엔 완결 계단만 쓰므로 자를 필요 없음).
    Open,
}

/// 표(리포트)에 찍는 계단별 보조 숫자.
#[derive(Clone, Debug, PartialEq)]
pub struct StepDetail {
    pub throughput: f64,
    pub launched_rate: f64,
    pub p50_us: u64,
    pub p95_us: u64,
    pub head_p99_us: u64,
    pub rest_p99_us: u64,
    pub measured_seconds: u32,
}

/// 워커 하나의 정수 계수. f64 나눗셈·합은 `StairAccumulator`가 worker_id 순서로만 한다.
struct WorkerAcc {
    /// 계단 i의 측정 초 `[lo, hi)` (ts_second).
    windows: Vec<(i64, i64)>,
    completed: Vec<u64>,
    launched: Vec<u64>,
    count: Vec<u64>,
}

impl WorkerAcc {
    /// 계단 배정은 여기 한 곳뿐.
    fn step_of(&self, ts: i64) -> Option<usize> {
        self.windows
            .iter()
            .position(|&(lo, hi)| (lo..hi).contains(&ts))
    }
}

/// 워커 합산 계수(정수·HDR는 합산 순서와 무관).
#[derive(Default)]
struct StepAgg {
    dropped: u64,
    count: u64,
    errors: u64,
    hist: Option<Histogram<u64>>,
    head: Option<Histogram<u64>>,
    rest: Option<Histogram<u64>>,
}

/// 계단 집계 — 리포트(DB 행)와 감시(받은 배치)가 같이 쓴다.
pub struct StairAccumulator {
    cfg: StairConfig,
    /// true면 앞부분/나머지 HDR(⚠ 계산)도 모은다 — 리포트용.
    detail: bool,
    /// worker_id 정렬 — f64 합 순서의 단일 기준.
    workers: BTreeMap<String, WorkerAcc>,
    steps: Vec<StepAgg>,
    /// 감시가 판정을 끝내고 계수를 해제한 계단의 숫자.
    released: Vec<Option<StepNumbers>>,
}

impl StairAccumulator {
    pub fn new(cfg: &StairConfig, detail: bool) -> Self {
        let n = cfg.targets.len();
        Self {
            cfg: cfg.clone(),
            detail,
            workers: BTreeMap::new(),
            steps: (0..n).map(|_| StepAgg::default()).collect(),
            released: vec![None; n],
        }
    }

    /// 워커를 등록한다(워커당 한 번, 행을 밀어 넣기 전).
    pub fn set_worker(&mut self, w: &str, t0_ms: i64, bound: Bound) {
        let n = self.cfg.targets.len();
        let windows = (0..n)
            .map(|i| measure_window(&self.cfg, t0_ms, bound, i))
            .collect();
        // 첫 등록 유지 — 다시 불러도 쌓은 계수를 지우지 않는다.
        self.workers
            .entry(w.to_string())
            .or_insert_with(|| WorkerAcc {
                windows,
                completed: vec![0; n],
                launched: vec![0; n],
                count: vec![0; n],
            });
    }

    /// 등록 안 된 워커·해제된 계단의 행은 무시한다.
    pub fn push_open_loop(
        &mut self,
        w: &str,
        ts: i64,
        launched: i64,
        completed: i64,
        dropped: i64,
    ) {
        let Some(wa) = self.workers.get_mut(w) else {
            return;
        };
        let Some(i) = wa.step_of(ts) else {
            return;
        };
        if self.released[i].is_some() {
            return;
        }
        add(&mut wa.completed[i], completed);
        add(&mut wa.launched[i], launched);
        add(&mut self.steps[i].dropped, dropped);
    }

    pub fn push_metric(
        &mut self,
        w: &str,
        ts: i64,
        count: i64,
        errors: i64,
        h: Option<&Histogram<u64>>,
    ) {
        let Some(wa) = self.workers.get_mut(w) else {
            return;
        };
        let Some(i) = wa.step_of(ts) else {
            return;
        };
        if self.released[i].is_some() {
            return;
        }
        add(&mut wa.count[i], count);
        let acc = &mut self.steps[i];
        add(&mut acc.count, count);
        add(&mut acc.errors, errors);
        if let Some(h) = h {
            merge_opt(&mut acc.hist, h);
            if self.detail {
                let part = if ts < wa.windows[i].0.saturating_add(HEAD_SECONDS) {
                    &mut acc.head
                } else {
                    &mut acc.rest
                };
                merge_opt(part, h);
            }
        }
    }

    /// 워커 `w`의 계단 `i` 측정 초 `[lo, hi)`.
    pub fn window(&self, w: &str, i: usize) -> Option<(i64, i64)> {
        self.workers.get(w)?.windows.get(i).copied()
    }

    fn min_secs(&self, i: usize) -> Option<i64> {
        self.workers
            .values()
            .map(|w| w.windows[i].1.saturating_sub(w.windows[i].0))
            .min()
    }

    /// (달성, 시작율, 처리율) — 워커별 계수 ÷ 측정 초를 worker_id 순서로 더한다.
    fn rates(&self, i: usize) -> (f64, f64, f64) {
        let (mut achieved, mut launched, mut throughput) = (0.0, 0.0, 0.0);
        for w in self.workers.values() {
            let (lo, hi) = w.windows[i];
            let secs_w = hi.saturating_sub(lo);
            if secs_w > 0 {
                let d = secs_w as f64;
                achieved += w.completed[i] as f64 / d;
                launched += w.launched[i] as f64 / d;
                throughput += w.count[i] as f64 / d;
            }
        }
        (achieved, launched, throughput)
    }

    fn step_numbers(&self, i: usize, complete: bool, unknown: bool) -> StepNumbers {
        let acc = &self.steps[i];
        let measure_len = self
            .cfg
            .hold_seconds
            .saturating_sub(self.cfg.discard_seconds);
        let measured_seconds = clamp_u32(self.min_secs(i).unwrap_or(0));
        // 예전 부하기라 달성을 모르고 측정 구간 요청도 0이면 판정할 근거가 없다.
        let measured = complete
            && measured_seconds.saturating_mul(2) >= measure_len
            && !(unknown && acc.count == 0);
        StepNumbers {
            target: self.cfg.targets[i],
            achieved: (!unknown).then_some(self.rates(i).0),
            dropped: (!unknown).then_some(acc.dropped),
            error_rate: if acc.count == 0 {
                0.0
            } else {
                acc.errors as f64 / acc.count as f64
            },
            p99_us: q(&acc.hist, 0.99),
            measured,
        }
    }

    /// 계단별 판정 입력. `complete[i]` = 계단 i의 데이터가 다 왔나(리포트는 전부 true).
    pub fn numbers(&self, complete: &[bool], open_loop_unknown: bool) -> Vec<StepNumbers> {
        (0..self.cfg.targets.len())
            .map(|i| match &self.released[i] {
                Some(n) => n.clone(),
                None => self.step_numbers(
                    i,
                    complete.get(i).copied().unwrap_or(false),
                    open_loop_unknown,
                ),
            })
            .collect()
    }

    pub fn details(&self) -> Vec<StepDetail> {
        (0..self.cfg.targets.len())
            .map(|i| {
                let acc = &self.steps[i];
                let (_, launched_rate, throughput) = self.rates(i);
                StepDetail {
                    throughput,
                    launched_rate,
                    p50_us: q(&acc.hist, 0.50),
                    p95_us: q(&acc.hist, 0.95),
                    head_p99_us: q(&acc.head, 0.99),
                    rest_p99_us: q(&acc.rest, 0.99),
                    measured_seconds: clamp_u32(self.min_secs(i).unwrap_or(0)),
                }
            })
            .collect()
    }

    /// 감시: 판정 끝난 계단 `i`의 숫자(완결)를 캐시하고 그 계단 HDR·계수를 해제한다.
    /// 이후 `numbers()`는 `i`에 캐시값을 돌려준다(`judge`가 앞 계단 p99를 읽는다).
    pub fn release_step(&mut self, i: usize, open_loop_unknown: bool) {
        if i >= self.steps.len() || self.released[i].is_some() {
            return;
        }
        let n = self.step_numbers(i, true, open_loop_unknown);
        self.released[i] = Some(n);
        self.steps[i] = StepAgg::default();
        for w in self.workers.values_mut() {
            w.completed[i] = 0;
            w.launched[i] = 0;
            w.count[i] = 0;
        }
    }

    /// 계단 `i`의 HDR이 아직 살아 있나(해제 확인용).
    #[cfg(test)]
    pub(crate) fn step_hist_held(&self, i: usize) -> bool {
        self.steps[i].hist.is_some()
    }
}

#[derive(Default)]
struct SecAcc {
    launched: u64,
    completed: u64,
    dropped: u64,
    count: u64,
    hist: Option<Histogram<u64>>,
}

fn merge_opt(acc: &mut Option<Histogram<u64>>, h: &Histogram<u64>) {
    merge_into(acc.get_or_insert_with(crate::report::fresh_hist), h);
}

fn q(h: &Option<Histogram<u64>>, quantile: f64) -> u64 {
    h.as_ref().map_or(0, |h| h.value_at_quantile(quantile))
}

/// 머리말 숫자. 「첫 계단만 튀었을 수 있음」 힌트는 포화 머리말(정상 계단 없음)에만 둔다(§5.3).
fn stair_headline(j: &Judgement, targets: &[u32]) -> StairHeadline {
    let t = |i: usize| targets[i];
    StairHeadline {
        kind: j.headline,
        saturated_target: j.saturation.map(t),
        last_ok_target: j.last_ok.map(t),
        through_target: match j.headline {
            HeadlineKind::AllOk | HeadlineKind::OkThenUnmeasured => j.last_ok.map(t),
            _ => None,
        },
        first_fail_hint: j.later_ok_after_first_fail && j.headline == HeadlineKind::Saturated,
    }
}

/// 계단 run 리포트(spec §5). `profile.stair`가 없으면 None.
pub fn build_stair_report(
    profile: &Profile,
    run_dropped: u64,
    rows: &[WindowWithHdr],
    inp: &StairInputs,
) -> Option<StairReport> {
    let cfg = profile.stair.as_ref()?;
    let n = cfg.targets.len();
    let step_s = i64::from(cfg.ramp_seconds + cfg.hold_seconds);

    // 워커별로 모은다.
    type Rows<'a> = (Vec<&'a WindowWithHdr>, Vec<&'a OpenLoopSecondRow>);
    let mut by: BTreeMap<&str, Rows> = BTreeMap::new();
    for r in rows {
        by.entry(r.worker_id.as_str()).or_default().0.push(r);
    }
    for r in &inp.open_loop {
        by.entry(r.worker_id.as_str()).or_default().1.push(r);
    }
    let starts: BTreeMap<&str, i64> = inp
        .starts
        .iter()
        .map(|s| (s.worker_id.as_str(), s.started_at_ms))
        .collect();

    let mut notes = StairNotes::default();
    let mut acc = StairAccumulator::new(cfg, true);
    let mut workers: Vec<WorkerView> = Vec::new();
    for (w, (metrics, open_loop)) in by {
        // 일 없는 워커(도착을 한 번도 안 만든 워커)는 계단 집계에서 뺀다.
        let active = if open_loop.is_empty() {
            !metrics.is_empty()
        } else {
            open_loop.iter().any(|r| schedules(r))
        };
        if !active {
            continue;
        }
        if open_loop.is_empty() {
            notes.open_loop_unknown = true;
        }
        let t0_ms = match starts.get(w) {
            Some(&ms) => ms,
            None => {
                notes.t0_estimated = true;
                let min_ts = metrics
                    .iter()
                    .map(|r| r.ts_second)
                    .min()
                    .or_else(|| open_loop.iter().map(|r| r.ts_second).min())
                    .unwrap_or(0);
                min_ts.saturating_mul(1000)
            }
        };
        // run 끝 = 스케줄러가 도착을 만든 마지막 초(completed-only 꼬리 제외).
        let last = if open_loop.is_empty() {
            metrics.iter().map(|r| r.ts_second).max()
        } else {
            open_loop
                .iter()
                .filter(|r| schedules(r))
                .map(|r| r.ts_second)
                .max()
        };
        // last가 없는 워커는 위 `active` 검사로 이미 빠졌다.
        acc.set_worker(w, t0_ms, Bound::Upto(last.unwrap_or(i64::MIN)));
        workers.push(WorkerView {
            id: w,
            t0_ms,
            metrics,
            open_loop,
        });
    }
    let unknown = notes.open_loop_unknown;

    let mut secs: BTreeMap<i64, SecAcc> = BTreeMap::new();
    for w in &workers {
        let t0_s = w.t0_ms.div_euclid(1000);
        for r in &w.open_loop {
            let s = secs.entry(r.ts_second.saturating_sub(t0_s)).or_default();
            add(&mut s.launched, r.launched);
            add(&mut s.completed, r.completed);
            add(&mut s.dropped, r.dropped);
            acc.push_open_loop(w.id, r.ts_second, r.launched, r.completed, r.dropped);
        }
        for r in &w.metrics {
            let h = decode_hdr(&r.hdr_histogram).ok().flatten();
            let s = secs.entry(r.ts_second.saturating_sub(t0_s)).or_default();
            add(&mut s.count, r.count);
            if let Some(h) = &h {
                merge_opt(&mut s.hist, h);
            }
            acc.push_metric(w.id, r.ts_second, r.count, r.error_count, h.as_ref());
        }
    }

    let mut numbers = acc.numbers(&vec![true; n], unknown);
    let details = acc.details();
    // 자동 정지 run: 감시가 결정 순간 판정에 쓴 경계(`judged_through`) 뒤 계단은 판정 밖(§5.1).
    let stop = inp.auto_stop.as_ref().and_then(|r| r.stop.as_ref());
    if let Some(s) = stop {
        for (i, st) in numbers.iter_mut().enumerate() {
            if i as i64 > s.judged_through {
                st.measured = false;
            }
        }
    }
    let j = judge(&numbers, cfg);

    // 측정 시각 = 가장 이른 t0 워커의 실제 포함 초.
    let earliest = workers.iter().min_by_key(|w| w.t0_ms);
    // 행 상태: 판정 상태 위에 자동 정지 표시 상태를 얹는다(§5.2). 계단 시작 시각은 감시의 구간
    // 귀속과 같이 시작 시각을 보낸 워커 중 가장 이른 t0 기준.
    let stop_t0 = inp
        .starts
        .iter()
        .map(|s| s.started_at_ms)
        .min()
        .or(earliest.map(|w| w.t0_ms));
    let shown_states: Vec<(StepState, Option<PartialRun>)> = (0..n)
        .map(|i| match stop {
            Some(s) if i as i64 > s.judged_through => stop_row_state(cfg, s, stop_t0, i),
            _ => (j.states[i], None),
        })
        .collect();
    let steps: Vec<StairStep> = (0..n)
        .map(|i| {
            let d = &details[i];
            let measured_seconds = d.measured_seconds;
            // 측정 안 됨으로 보이는 계단(화면·인쇄는 숫자 「—」)은 달성·시작·dropped도 비운다 —
            // 내보내기가 부분 구간 숫자나 0을 측정값처럼 적지 않게.
            let (state, partial) = shown_states[i];
            let shown = state.shows_numbers();
            let (lo, hi) = earliest.and_then(|w| acc.window(w.id, i)).unwrap_or((0, 0));
            let head_p99 = d.head_p99_us;
            let rest_p99 = d.rest_p99_us;
            let head_p99_ratio = (shown && measured_seconds >= HEAD_MIN_MEASURED && rest_p99 > 0)
                .then(|| head_p99 as f64 / rest_p99 as f64);
            StairStep {
                index: i as u32,
                target: cfg.targets[i],
                achieved: numbers[i].achieved.filter(|_| shown),
                launched_rate: (!unknown && shown).then_some(d.launched_rate),
                throughput_rps: d.throughput,
                p50_us: d.p50_us,
                p95_us: d.p95_us,
                p99_us: numbers[i].p99_us,
                error_rate: numbers[i].error_rate,
                dropped: numbers[i].dropped.filter(|_| shown),
                measured_seconds,
                measure_start_ms: lo.saturating_mul(1000),
                measure_end_ms: hi.saturating_mul(1000),
                state,
                reasons: j.reasons[i].clone(),
                knee: j.knee == Some(i),
                slot_limited: j.slot_limited[i],
                head_p99_ratio,
                discard_warning: head_p99_ratio.is_some()
                    && head_p99 >= HEAD_MIN_US
                    && head_p99 >= HEAD_RATIO_WARN.saturating_mul(rest_p99),
                partial,
            }
        })
        .collect();

    // dropped가 생긴 모든 초가 "지연·오류로도 무너진 계단" 또는 포화 이후 계단 구간에 있을 때만 설명됨.
    // 초가 계단 경계에 걸치면 걸친 계단 모두가 설명돼야 한다. t0 이전 초는 설명 안 됨.
    let explains = |i: usize| match shown_states[i].0 {
        StepState::After => true,
        // 자동 정지로 판정 밖이 된 계단은 「포화 뒤」와 같다.
        StepState::EmergencyStopped | StepState::Partial | StepState::Skipped => true,
        StepState::Saturated | StepState::Unconfirmed | StepState::Spike => !j.slot_limited[i],
        // 포화 지점 뒤 측정 부족 계단(포화를 보고 run을 멈춘 경우)은 판정 밖이라 설명된다.
        StepState::NotMeasured => j.saturation.is_some_and(|k| i > k),
        StepState::Ok => false,
    };
    let step_ms = (step_s * 1000).max(1);
    let mut any_dropped = false;
    let mut all_explained = true;
    for w in &workers {
        for r in w.open_loop.iter().filter(|r| r.dropped > 0) {
            any_dropped = true;
            let a = r.ts_second.saturating_mul(1000).saturating_sub(w.t0_ms);
            if a < 0 {
                all_explained = false;
                continue;
            }
            let first = usize::try_from(a / step_ms)
                .unwrap_or(usize::MAX)
                .min(n.saturating_sub(1));
            let last = usize::try_from(a.saturating_add(999) / step_ms)
                .unwrap_or(usize::MAX)
                .min(n.saturating_sub(1));
            if !(first..=last).all(&explains) {
                all_explained = false;
            }
        }
    }
    let dropped_explained = !unknown && any_dropped && all_explained;

    let t = |i: usize| cfg.targets[i];
    let headline = stair_headline(&j, &cfg.targets);

    let seconds = secs
        .into_iter()
        .map(|(offset_s, s)| StairSecond {
            offset_s,
            launched: (!unknown).then_some(s.launched),
            completed: (!unknown).then_some(s.completed),
            dropped: (!unknown).then_some(s.dropped),
            count: s.count,
            p99_us: q(&s.hist, 0.99),
        })
        .collect();

    let mut bands = Vec::new();
    for i in 0..n {
        let base = i as u64 * step_s as u64;
        let ramp_end = base + u64::from(cfg.ramp_seconds);
        let discard_end = ramp_end + u64::from(cfg.discard_seconds);
        let end = base + step_s as u64;
        for (kind, start_s, end_s) in [
            (BandKind::Ramp, base, ramp_end),
            (BandKind::Discard, ramp_end, discard_end),
            (BandKind::Measure, discard_end, end),
        ] {
            if end_s > start_s {
                bands.push(StairBand {
                    index: i as u32,
                    kind,
                    start_s,
                    end_s,
                });
            }
        }
    }

    let mut target_line = vec![TargetPoint {
        offset_s: 0,
        target: 0,
    }];
    let mut at = 0u64;
    for st in expand_stair(cfg) {
        at += u64::from(st.duration_seconds);
        target_line.push(TargetPoint {
            offset_s: at,
            target: st.target,
        });
    }

    Some(StairReport {
        config: cfg.clone(),
        knee_target: j.knee.map(t),
        spike_targets: j.spikes.iter().map(|&i| t(i)).collect(),
        max_in_flight: profile.max_in_flight,
        dropped_total: Some(run_dropped),
        dropped_explained,
        slot_limited_targets: (0..n).filter(|&i| j.slot_limited[i]).map(t).collect(),
        notes,
        headline,
        steps,
        seconds,
        bands,
        target_line,
        auto_stop: inp.auto_stop.clone(),
    })
}

/// `judged_through` 뒤 계단 `i`의 표시 상태. 계단 시작 = `t0 + i·계단 ms`.
fn stop_row_state(
    cfg: &StairConfig,
    s: &StopInfo,
    t0_ms: Option<i64>,
    i: usize,
) -> (StepState, Option<PartialRun>) {
    let decided = s.decided_step as usize;
    if s.kind == StopKind::Emergency && i == decided {
        return (StepState::EmergencyStopped, None);
    }
    if i <= decided {
        // 즉시 정지 순간 아직 완결 안 된 앞 계단.
        return (StepState::NotMeasured, None);
    }
    let Some(t0) = t0_ms else {
        return (StepState::Skipped, None);
    };
    let step_ms = i64::from(cfg.ramp_seconds + cfg.hold_seconds) * 1000;
    let start = t0.saturating_add((i as i64).saturating_mul(step_ms));
    let elapsed = s.stopped_at_ms.saturating_sub(start);
    if elapsed <= 0 {
        return (StepState::Skipped, None);
    }
    let ramp_ms = i64::from(cfg.ramp_seconds) * 1000;
    let discard_end_ms = ramp_ms + i64::from(cfg.discard_seconds) * 1000;
    let phase = if elapsed < ramp_ms {
        BandKind::Ramp
    } else if elapsed < discard_end_ms {
        BandKind::Discard
    } else {
        BandKind::Measure
    };
    let seconds =
        u32::try_from(elapsed.div_euclid(1000) + i64::from(elapsed.rem_euclid(1000) != 0))
            .unwrap_or(u32::MAX);
    (StepState::Partial, Some(PartialRun { seconds, phase }))
}

#[cfg(test)]
mod tests {
    #[test]
    fn auto_stop_config_rejects_unknown_keys() {
        let bad = r#"{"targets":[1],"hold_seconds":1,"ramp_seconds":1,"discard_seconds":1,
            "auto_stop":{"emergancy":{"error_rate_pct":5,"p99_ms":1,"consecutive_seconds":1,"min_requests":1}}}"#;
        assert!(serde_json::from_str::<StairConfig>(bad).is_err());
        let bad2 = r#"{"emergency":{"error_rate_pct":5,"p99_ms":1,"consecutive_seconds":1,"min_requests":1,"extra":1}}"#;
        assert!(serde_json::from_str::<AutoStopConfig>(bad2).is_err());
        assert!(serde_json::from_str::<AutoStopConfig>("{}").is_ok());
    }

    use super::*;

    fn cfg() -> StairConfig {
        StairConfig {
            targets: vec![100, 200],
            hold_seconds: 60,
            ramp_seconds: 5,
            discard_seconds: 10,
            p99_cap_ms: None,
            auto_stop: None,
        }
    }

    fn profile(stair: Option<StairConfig>) -> Profile {
        serde_json::from_value(serde_json::json!({
            "duration_seconds": 0,
            "max_in_flight": 50,
        }))
        .map(|mut p: Profile| {
            p.stair = stair;
            p
        })
        .unwrap()
    }

    fn st(target: u32, d: u32) -> Stage {
        Stage {
            target,
            duration_seconds: d,
        }
    }

    #[test]
    fn expand_two_targets() {
        assert_eq!(
            expand_stair(&cfg()),
            vec![st(100, 5), st(100, 60), st(200, 5), st(200, 60)]
        );
    }

    #[test]
    fn validate_accepts_valid() {
        assert!(validate_stair(&cfg()).is_ok());
    }

    #[test]
    fn validate_rejects_bad_configs() {
        let bad: Vec<(&str, StairConfig)> = vec![
            (
                "one target",
                StairConfig {
                    targets: vec![100],
                    ..cfg()
                },
            ),
            (
                "51 targets",
                StairConfig {
                    targets: (1..=51).collect(),
                    ..cfg()
                },
            ),
            (
                "decreasing",
                StairConfig {
                    targets: vec![200, 100],
                    ..cfg()
                },
            ),
            (
                "duplicate",
                StairConfig {
                    targets: vec![100, 100],
                    ..cfg()
                },
            ),
            (
                "zero target",
                StairConfig {
                    targets: vec![0, 100],
                    ..cfg()
                },
            ),
            (
                "huge target",
                StairConfig {
                    targets: vec![100, 1_000_001],
                    ..cfg()
                },
            ),
            (
                "hold 19",
                StairConfig {
                    hold_seconds: 19,
                    discard_seconds: 0,
                    ..cfg()
                },
            ),
            (
                "hold 3601",
                StairConfig {
                    hold_seconds: 3601,
                    ..cfg()
                },
            ),
            (
                "ramp 0",
                StairConfig {
                    ramp_seconds: 0,
                    ..cfg()
                },
            ),
            (
                "ramp 601",
                StairConfig {
                    ramp_seconds: 601,
                    ..cfg()
                },
            ),
            (
                "discard too big",
                StairConfig {
                    discard_seconds: 51,
                    ..cfg()
                },
            ),
            (
                "cap 0",
                StairConfig {
                    p99_cap_ms: Some(0),
                    ..cfg()
                },
            ),
            (
                "cap huge",
                StairConfig {
                    p99_cap_ms: Some(600_001),
                    ..cfg()
                },
            ),
        ];
        for (name, c) in bad {
            assert!(validate_stair(&c).is_err(), "{name} should be rejected");
        }
    }

    #[test]
    fn validate_target_range_error_names_the_value() {
        let e = validate_stair(&StairConfig {
            targets: vec![0, 100],
            ..cfg()
        })
        .unwrap_err();
        assert_eq!(e, "계단 목표 0은(는) 1 이상 1,000,000 이하여야 합니다");
        let e = validate_stair(&StairConfig {
            targets: vec![100, 1_000_001],
            ..cfg()
        })
        .unwrap_err();
        assert_eq!(
            e,
            "계단 목표 1000001은(는) 1 이상 1,000,000 이하여야 합니다"
        );
    }

    #[test]
    fn validate_accepts_boundaries() {
        let c = StairConfig {
            targets: vec![1, 1_000_000],
            hold_seconds: 20,
            ramp_seconds: 1,
            discard_seconds: 10,
            p99_cap_ms: Some(600_000),
            auto_stop: None,
        };
        assert!(validate_stair(&c).is_ok());
        let c50 = StairConfig {
            targets: (1..=50).collect(),
            discard_seconds: 0,
            ..cfg()
        };
        assert!(validate_stair(&c50).is_ok());
    }

    fn em() -> EmergencyStop {
        EmergencyStop {
            error_rate_pct: 5.0,
            p99_ms: 2000,
            consecutive_seconds: 3,
            min_requests: 20,
        }
    }

    fn with_em(e: EmergencyStop) -> StairConfig {
        StairConfig {
            auto_stop: Some(AutoStopConfig {
                saturation: None,
                emergency: Some(e),
            }),
            ..cfg()
        }
    }

    #[test]
    fn validate_rejects_bad_auto_stop() {
        for v in [0.0, -1.0, 100.01, f64::NAN, f64::INFINITY] {
            let c = with_em(EmergencyStop {
                error_rate_pct: v,
                ..em()
            });
            assert!(validate_stair(&c).is_err(), "error_rate_pct {v}");
        }
        for v in [0, 600_001] {
            let c = with_em(EmergencyStop { p99_ms: v, ..em() });
            assert!(validate_stair(&c).is_err(), "p99_ms {v}");
        }
        for v in [0, 61] {
            let c = with_em(EmergencyStop {
                consecutive_seconds: v,
                ..em()
            });
            assert!(validate_stair(&c).is_err(), "consecutive {v}");
        }
        for v in [0, 100_001] {
            let c = with_em(EmergencyStop {
                min_requests: v,
                ..em()
            });
            assert!(validate_stair(&c).is_err(), "min_requests {v}");
        }
    }

    #[test]
    fn validate_accepts_auto_stop_boundaries() {
        let lo = EmergencyStop {
            error_rate_pct: 0.01,
            p99_ms: 1,
            consecutive_seconds: 1,
            min_requests: 1,
        };
        let hi = EmergencyStop {
            error_rate_pct: 100.0,
            p99_ms: 600_000,
            consecutive_seconds: 60,
            min_requests: 100_000,
        };
        assert!(validate_stair(&with_em(lo)).is_ok());
        assert!(validate_stair(&with_em(hi)).is_ok());
    }

    #[test]
    fn auto_stop_absent_bytes_unchanged() {
        let s = r#"{"targets":[100,200],"hold_seconds":60,"ramp_seconds":5,"discard_seconds":10}"#;
        let c: StairConfig = serde_json::from_str(s).unwrap();
        assert!(c.auto_stop.is_none());
        let out = serde_json::to_string(&c).unwrap();
        assert_eq!(out, s);
        assert!(!out.contains("auto_stop"));
    }

    #[test]
    fn auto_stop_inner_keys_always_present() {
        let c = with_em(em());
        let v = serde_json::to_value(&c).unwrap();
        let inner = v["auto_stop"].as_object().unwrap();
        assert!(inner.contains_key("saturation"));
        assert!(inner["saturation"].is_null());
        assert!(inner["emergency"].is_object());
        let c2 = StairConfig {
            auto_stop: Some(AutoStopConfig {
                saturation: Some(SaturationStopMode::FirstFail),
                emergency: None,
            }),
            ..cfg()
        };
        let v2 = serde_json::to_value(&c2).unwrap();
        let inner2 = v2["auto_stop"].as_object().unwrap();
        assert_eq!(inner2["saturation"], "first_fail");
        assert!(inner2.contains_key("emergency"));
        assert!(inner2["emergency"].is_null());
    }

    #[test]
    fn auto_stop_input_keys_may_be_omitted() {
        let s = r#"{"targets":[100,200],"hold_seconds":60,"ramp_seconds":5,"discard_seconds":10,"auto_stop":{}}"#;
        let c: StairConfig = serde_json::from_str(s).unwrap();
        let a = c.auto_stop.unwrap();
        assert!(a.saturation.is_none() && a.emergency.is_none());
    }

    #[test]
    fn monitor_wanted_table() {
        assert!(!monitor_wanted(&cfg()));
        let none = StairConfig {
            auto_stop: Some(AutoStopConfig {
                saturation: None,
                emergency: None,
            }),
            ..cfg()
        };
        assert!(!monitor_wanted(&none));
        let sat = StairConfig {
            auto_stop: Some(AutoStopConfig {
                saturation: Some(SaturationStopMode::TwoFails),
                emergency: None,
            }),
            ..cfg()
        };
        assert!(monitor_wanted(&sat));
        assert!(monitor_wanted(&with_em(em())));
    }

    #[test]
    fn normalize_fills_stages() {
        let mut p = profile(Some(cfg()));
        normalize_stair(&mut p).unwrap();
        assert_eq!(p.stages.unwrap(), expand_stair(&cfg()));
    }

    #[test]
    fn normalize_accepts_identical_stages_roundtrip() {
        let mut p = profile(Some(cfg()));
        p.stages = Some(expand_stair(&cfg()));
        assert!(normalize_stair(&mut p).is_ok());
        assert_eq!(p.stages.unwrap(), expand_stair(&cfg()));
    }

    #[test]
    fn normalize_rejects_different_stages() {
        let mut p = profile(Some(cfg()));
        p.stages = Some(vec![st(100, 5)]);
        assert!(normalize_stair(&mut p).is_err());
    }

    #[test]
    fn normalize_rejects_target_rps_vu_stages_and_duration() {
        let mut p = profile(Some(cfg()));
        p.target_rps = Some(10);
        assert!(normalize_stair(&mut p).is_err());
        let mut p = profile(Some(cfg()));
        p.vu_stages = Some(vec![st(1, 1)]);
        assert!(normalize_stair(&mut p).is_err());
        let mut p = profile(Some(cfg()));
        p.duration_seconds = 30;
        assert!(normalize_stair(&mut p).is_err());
    }

    #[test]
    fn normalize_rejects_invalid_config() {
        let mut p = profile(Some(StairConfig {
            targets: vec![100],
            ..cfg()
        }));
        assert!(normalize_stair(&mut p).is_err());
    }

    #[test]
    fn normalize_noop_without_stair() {
        let mut p = profile(None);
        p.target_rps = Some(10);
        normalize_stair(&mut p).unwrap();
        assert!(p.stages.is_none());
        assert_eq!(p.target_rps, Some(10));
    }

    #[test]
    fn profile_without_stair_serializes_without_key() {
        let p = profile(None);
        let v = serde_json::to_value(&p).unwrap();
        assert!(v.get("stair").is_none());
        let p = profile(Some(cfg()));
        let v = serde_json::to_value(&p).unwrap();
        assert!(v.get("stair").is_some());
        assert!(v["stair"].get("p99_cap_ms").is_none());
    }
}

/// 표 테스트 — bench `rllb/saturation.py`의 `_walk`(redis-large-list-bench, 읽기 전용 참조)를
/// 같은 입력으로 손으로 따라가 `(마지막 정상 index, blips, 걷기가 멈춘 index)`를 주석에 적었다.
/// bench는 포화 index를 반환하지 않고 걷기를 `break`한 i가 곧 포화 지점이다(끝까지 걸으면 없음).
#[cfg(test)]
mod judge_tests {
    use super::*;

    fn s(target: u32, achieved: f64, p99_us: u64, err: f64, dropped: u64) -> StepNumbers {
        StepNumbers {
            target,
            achieved: Some(achieved),
            dropped: Some(dropped),
            error_rate: err,
            p99_us,
            measured: true,
        }
    }

    fn nm(target: u32) -> StepNumbers {
        StepNumbers {
            target,
            achieved: None,
            dropped: None,
            error_rate: 0.0,
            p99_us: 0,
            measured: false,
        }
    }

    /// 목표 100,200,…에 달성 = 목표, 오류·dropped 0, p99만 다른 계단들.
    fn p99s(us: &[u64]) -> Vec<StepNumbers> {
        us.iter()
            .enumerate()
            .map(|(i, &p)| {
                let t = 100 * (i as u32 + 1);
                s(t, f64::from(t), p, 0.0, 0)
            })
            .collect()
    }

    fn cfg(cap: Option<u32>) -> StairConfig {
        StairConfig {
            targets: vec![100, 200],
            hold_seconds: 60,
            ramp_seconds: 5,
            discard_seconds: 10,
            p99_cap_ms: cap,
            auto_stop: None,
        }
    }

    fn walk(j: &Judgement) -> (Option<usize>, Vec<usize>, Option<usize>) {
        (j.last_ok, j.spikes.clone(), j.saturation)
    }

    use StepState::*;

    #[test]
    fn all_ok() {
        let j = judge(&p99s(&[10000, 12000, 15000]), &cfg(None));
        // bench _walk: last=2, blips=[], 끝까지 걸음(포화 없음)
        assert_eq!(walk(&j), (Some(2), vec![], None));
        assert_eq!(j.headline, HeadlineKind::AllOk);
        assert_eq!(j.states, vec![Ok, Ok, Ok]);
    }

    #[test]
    fn one_spike() {
        let j = judge(&p99s(&[10000, 12000, 40000, 15000, 18000]), &cfg(None));
        // bench _walk: 2(40000 ≥ 3×12000) 실패, 3(15000 < 36000) 정상 → blip 2; last=4, blips=[2], 포화 없음
        assert_eq!(walk(&j), (Some(4), vec![2], None));
        assert_eq!(j.states[2], Spike);
        assert_eq!(j.headline, HeadlineKind::AllOk);
    }

    #[test]
    fn consecutive_fail() {
        let j = judge(&p99s(&[10000, 12000, 40000, 50000, 60000]), &cfg(None));
        // bench _walk: 2 실패, 3(50000 vs ref 12000) 실패 → break i=2; last=1, blips=[]
        assert_eq!(walk(&j), (Some(1), vec![], Some(2)));
        assert_eq!(j.states, vec![Ok, Ok, Saturated, Saturated, After]);
        assert_eq!(j.headline, HeadlineKind::Saturated);
    }

    #[test]
    fn spike_then_consecutive_fail() {
        let j = judge(
            &p99s(&[10000, 12000, 40000, 15000, 50000, 60000]),
            &cfg(None),
        );
        // bench _walk: blip 2, last=3(15000); 4(50000 ≥ 45000) 실패, 5(60000) 실패 → break i=4
        assert_eq!(walk(&j), (Some(3), vec![2], Some(4)));
        assert_eq!(j.states, vec![Ok, Ok, Spike, Ok, Saturated, Saturated]);
    }

    #[test]
    fn first_fail_then_ok_is_not_spike() {
        let steps = vec![s(100, 100.0, 10000, 0.0, 5), s(200, 200.0, 12000, 0.0, 0)];
        let j = judge(&steps, &cfg(None));
        // bench _walk: 0 실패(dropped), last=None이라 blip 아님 → break i=0; last=None, blips=[]
        assert_eq!(walk(&j), (None, vec![], Some(0)));
        assert_eq!(j.states, vec![Saturated, After]);
        assert!(j.later_ok_after_first_fail);
        assert_eq!(j.headline, HeadlineKind::Saturated);
    }

    #[test]
    fn later_ok_flag_false_when_later_also_fails() {
        let steps = vec![s(100, 100.0, 10000, 0.0, 5), s(200, 200.0, 12000, 0.0, 3)];
        let j = judge(&steps, &cfg(None));
        assert_eq!(walk(&j), (None, vec![], Some(0)));
        assert!(!j.later_ok_after_first_fail);
    }

    #[test]
    fn last_step_fails() {
        let j = judge(&p99s(&[10000, 12000, 40000]), &cfg(None));
        // bench _walk: 2 실패, 다음 계단 없음 → break i=2; last=1, blips=[]
        assert_eq!(walk(&j), (Some(1), vec![], Some(2)));
        assert_eq!(j.states[2], Saturated);
        assert_eq!(j.headline, HeadlineKind::Saturated);
    }

    #[test]
    fn sub_ms_ref_cap_5ms() {
        let j = judge(&p99s(&[500, 4999]), &cfg(None));
        // bench _walk: ref 500 < 1000 → 4999 < 5000 정상; last=1, blips=[], 포화 없음
        assert_eq!(walk(&j), (Some(1), vec![], None));
        let j = judge(&p99s(&[500, 5000]), &cfg(None));
        // bench _walk: 5000 < 5000 거짓 → 실패, 다음 없음 → break i=1; last=0
        assert_eq!(walk(&j), (Some(0), vec![], Some(1)));
        assert_eq!(
            j.reasons[1],
            vec![Reason {
                kind: ReasonKind::P99Relative,
                value: 10.0
            }]
        );
    }

    #[test]
    fn abs_cap_applies_to_first_step() {
        let j = judge(&p99s(&[25000, 25000]), &cfg(Some(20)));
        // bench _walk(p99_abs_us=20000): 0 실패(첫 계단에도 적용), last=None → break i=0
        assert_eq!(walk(&j), (None, vec![], Some(0)));
        assert_eq!(
            j.reasons[0],
            vec![Reason {
                kind: ReasonKind::P99Cap,
                value: 25.0
            }]
        );
    }

    #[test]
    fn abs_cap_replaces_multiple_rule() {
        let j = judge(&p99s(&[10000, 90000]), &cfg(Some(100)));
        // bench _walk(p99_abs_us=100000): 90000 < 100000 정상(배수 9× 무시); last=1, 포화 없음
        assert_eq!(walk(&j), (Some(1), vec![], None));
        assert_eq!(j.headline, HeadlineKind::AllOk);
    }

    #[test]
    fn abs_cap_boundary_is_strict() {
        let j = judge(&p99s(&[10000, 100_000]), &cfg(Some(100)));
        assert_eq!(walk(&j), (Some(0), vec![], Some(1)));
    }

    #[test]
    fn not_measured_stops_walk() {
        let mut steps = p99s(&[10000, 12000]);
        steps.push(nm(300));
        steps.push(nm(400));
        let j = judge(&steps, &cfg(None));
        // bench엔 미측정 계단 개념이 없다(valid=False면 ValueError) — 걷기를 2에서 멈춘 것 = bench에 0..=1만 넘긴 결과: last=1, 포화 없음
        assert_eq!(walk(&j), (Some(1), vec![], None));
        assert_eq!(j.headline, HeadlineKind::OkThenUnmeasured);
        assert_eq!(&j.states[2..], &[NotMeasured, NotMeasured]);
        assert!(j.reasons[2].is_empty());
    }

    #[test]
    fn unconfirmed_when_next_not_measured() {
        let mut steps = p99s(&[10000, 40000]);
        steps.push(nm(300));
        let j = judge(&steps, &cfg(None));
        // bench에 0..=1만 넘긴 결과: 1 실패, 다음 없음 → break i=1; last=0, blips=[]
        assert_eq!(walk(&j), (Some(0), vec![], Some(1)));
        assert_eq!(j.states, vec![Ok, Unconfirmed, NotMeasured]);
        assert_eq!(j.headline, HeadlineKind::Unconfirmed);
    }

    #[test]
    fn no_data() {
        let j = judge(&[nm(100), nm(200)], &cfg(None));
        assert_eq!(walk(&j), (None, vec![], None));
        assert_eq!(j.headline, HeadlineKind::NoData);
        assert_eq!(j.states, vec![NotMeasured, NotMeasured]);
    }

    #[test]
    fn achieved_boundary() {
        let (ok, r) = step_ok(&s(100, 94.9, 10000, 0.0, 0), None, None);
        assert!(!ok);
        assert_eq!(r.len(), 1);
        assert_eq!(r[0].kind, ReasonKind::Achieved);
        assert!((r[0].value - 0.949).abs() < 1e-9);
        assert_eq!(
            step_ok(&s(100, 95.0, 10000, 0.0, 0), None, None),
            (true, vec![])
        );
    }

    #[test]
    fn achieved_none_is_not_judged() {
        let mut cur = s(100, 0.0, 10000, 0.0, 0);
        cur.achieved = None;
        cur.dropped = None;
        assert_eq!(step_ok(&cur, None, None), (true, vec![]));
    }

    #[test]
    fn error_rate_boundary() {
        assert_eq!(
            step_ok(&s(100, 100.0, 10000, 0.0099, 0), None, None),
            (true, vec![])
        );
        let (ok, r) = step_ok(&s(100, 100.0, 10000, 0.01, 0), None, None);
        assert!(!ok);
        assert_eq!(
            r,
            vec![Reason {
                kind: ReasonKind::Errors,
                value: 0.01
            }]
        );
    }

    #[test]
    fn all_failing_reasons_are_recorded() {
        let prev = s(100, 100.0, 10000, 0.0, 0);
        let (ok, r) = step_ok(&s(200, 100.0, 40000, 0.5, 7), Some(&prev), None);
        assert!(!ok);
        let kinds: Vec<ReasonKind> = r.iter().map(|x| x.kind).collect();
        assert_eq!(
            kinds,
            vec![
                ReasonKind::Achieved,
                ReasonKind::Dropped,
                ReasonKind::Errors,
                ReasonKind::P99Relative
            ]
        );
    }

    #[test]
    fn slot_limited_only_drop() {
        let mut steps = p99s(&[10000, 12000]);
        steps[1].dropped = Some(4);
        let j = judge(&steps, &cfg(None));
        assert_eq!(j.saturation, Some(1));
        assert_eq!(j.slot_limited, vec![false, true]);

        let mut steps = p99s(&[10000, 40000]);
        steps[1].dropped = Some(4);
        let j = judge(&steps, &cfg(None));
        assert_eq!(j.saturation, Some(1));
        assert_eq!(j.slot_limited, vec![false, false]);
    }

    #[test]
    fn after_steps_are_not_slot_limited() {
        let mut steps = p99s(&[10000, 12000, 40000, 50000, 60000]);
        steps[4].dropped = Some(9);
        let j = judge(&steps, &cfg(None));
        assert_eq!(j.states[4], After);
        assert!(!j.slot_limited[4]);
        assert!(j.reasons[4].iter().any(|r| r.kind == ReasonKind::Dropped));
    }

    #[test]
    fn knee_at_1_5x() {
        let j = judge(&p99s(&[10000, 12000, 18000]), &cfg(None));
        assert_eq!(walk(&j), (Some(2), vec![], None));
        assert_eq!(j.knee, Some(2));
        let j = judge(&p99s(&[10000, 12000, 17999]), &cfg(None));
        assert_eq!(j.knee, None);
    }

    #[test]
    fn knee_ignores_sub_ms() {
        let j = judge(&p99s(&[400, 700]), &cfg(None));
        assert_eq!(j.knee, None);
    }

    #[test]
    fn enums_serialize_snake_case() {
        assert_eq!(
            serde_json::to_value(NotMeasured).unwrap(),
            serde_json::json!("not_measured")
        );
        assert_eq!(
            serde_json::to_value(ReasonKind::P99Relative).unwrap(),
            serde_json::json!("p99_relative")
        );
        assert_eq!(
            serde_json::to_value(HeadlineKind::OkThenUnmeasured).unwrap(),
            serde_json::json!("ok_then_unmeasured")
        );
    }

    #[test]
    fn first_fail_hint_only_on_saturated_headline() {
        // 첫 계단 실패 → 다음 계단 미측정(unconfirmed). 뒤 계단이 정상 조건을 만족해도
        // 힌트는 「정상 계단 없음」 포화 머리말 전용이라 false.
        let steps = vec![
            s(100, 100.0, 1000, 0.5, 0),
            nm(200),
            s(300, 300.0, 1000, 0.0, 0),
        ];
        let targets = [100, 200, 300];
        let j = judge(&steps, &cfg(None));
        assert_eq!(j.headline, HeadlineKind::Unconfirmed);
        assert!(j.later_ok_after_first_fail);
        assert!(!stair_headline(&j, &targets).first_fail_hint);
        // 대조: 포화 머리말 + 뒤 정상이면 true.
        let steps = vec![
            s(100, 100.0, 1000, 0.5, 0),
            s(200, 50.0, 1000, 0.0, 0),
            s(300, 300.0, 1000, 0.0, 0),
        ];
        let j = judge(&steps, &cfg(None));
        assert_eq!(j.headline, HeadlineKind::Saturated);
        let h = stair_headline(&j, &targets);
        assert!(h.first_fail_hint);
        assert_eq!(
            (h.saturated_target, h.last_ok_target, h.through_target),
            (Some(100), None, None)
        );
    }

    #[test]
    fn fast_ref_boundary_uses_multiple_at_1000us() {
        // 기준 p99 = 정확히 1000µs는 "1 ms 미만"이 아니므로 배수 규칙(3×): 2999 정상, 3000 실패.
        let ok = judge(&p99s(&[1000, 2999]), &cfg(None));
        assert_eq!(ok.states, vec![Ok, Ok]);
        let bad = judge(&p99s(&[1000, 3000]), &cfg(None));
        assert_eq!(bad.states, vec![Ok, Saturated]);
        assert_eq!(bad.reasons[1][0].kind, ReasonKind::P99Relative);
    }
}
