use crate::latency_stats::{LatencyStats, latency_stats};
use crate::sample::{Resolved, Sample, SampleBlock, SplitHist};
use crate::store::metrics::{
    GroupMetricRow, IfBranchRow, LoopMetricRow, PhaseMetricRow, WindowWithHdr,
};
use crate::store::runs::{RunRow, RunStatus};
use handicap_engine::percentiles::{
    CURVE_QUANTILES, HISTOGRAM_BINS, Percentiles, decode_hdr, log_buckets, merge_into,
    percentile_curve, percentiles_of,
};
use handicap_engine::{
    PHASE_LOOP_CUT, PHASE_LOOP_CUT_ERR, PHASE_LOOP_FINAL, PHASE_LOOP_FINAL_ERR, PHASE_LOOP_RETRY,
    PHASE_LOOP_RETRY_ERR,
};
use hdrhistogram::Histogram;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};

#[derive(Debug, Serialize, Deserialize)]
pub struct ReportJson {
    pub run: ReportRun,
    pub scenario_yaml: String,
    pub summary: ReportSummary,
    pub windows: Vec<ReportWindow>,
    pub steps: Vec<ReportStep>,
    pub status_distribution: BTreeMap<String, u64>,
    pub if_breakdown: Vec<IfBreakdown>,
    /// E1: run-level rollup of send-failure transport error kinds (count desc,
    /// kind asc on ties). Omitted entirely when empty (byte-identical for runs
    /// with no transport errors).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub error_kinds: Vec<ErrorKindCount>,
    /// 조건 반복(while loop) 진입 종료 집계 (loop-while-report). 조건 반복 집계가 없으면
    /// 키 자체를 내지 않는다(기존 리포트 byte-identical).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub loop_exits: Vec<LoopExit>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub verdict: Option<Verdict>,
    #[serde(default)]
    pub insights: Vec<crate::insights::Insight>,
    #[serde(default)]
    pub dropped: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub latency: Option<LatencyDistribution>,
    #[serde(default)]
    pub group_latency: Vec<GroupLatency>,
    #[serde(default)]
    pub active_vu_series: Vec<ActiveVuSample>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub active_vu_by_worker: Vec<WorkerActiveVuSeries>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub worker_breakdown: Vec<WorkerBreakdown>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub connection: Option<ConnectionStats>,
    /// Soft validity (A11). Default = ok/empty for **deserialization only**;
    /// production `build_report` always recomputes.
    #[serde(default)]
    pub validity: crate::validity::Validity,
    /// Soft narrative (A11). Default empty for deserialization only; always recomputed.
    #[serde(default)]
    pub narrative: crate::validity::Narrative,
    /// 계단 시험 집계(spec §5.6). 계단 run이 아니면 키 자체를 내지 않는다(byte-identical).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stair: Option<crate::stair::StairReport>,
    /// 응답 속도 구간 건수(인쇄 보고서의 응답 속도 구간 절). 표본이 없으면 키 자체를 내지 않는다.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub speed_bands: Option<crate::speed_bands::SpeedBands>,
    /// 집계 기준(유지 구간 설정이 있는 run만). 없으면 키 자체를 내지 않는다(byte-identical).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub basis: Option<crate::steady::BasisBlock>,
    /// 준비 스텝 통계(D10). 시나리오에 준비 스텝이 없으면 키 자체를 내지 않는다.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub setup: Option<SetupReport>,
    /// 응답 시간 숫자가 어느 표본으로 계산됐는지.
    #[serde(default)]
    pub sample: SampleBlock,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SetupReport {
    pub ok: u64,
    pub failed: u64,
    pub interrupted: u64,
    pub steps: Vec<SetupStepReport>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SetupStepReport {
    pub step_id: String,
    pub count: u64,
    pub errors: u64,
    pub p50_ms: u64,
    pub p95_ms: u64,
    pub max_ms: u64,
    pub status_counts: BTreeMap<String, u64>,
    pub failure_kinds: BTreeMap<String, u64>,
}

/// 준비 스텝(`Scenario::setup_steps()`)이 없으면 None. `setup` 구간의 행만 센다.
/// 순서 = 시나리오의 준비 스텝 순서. 통계가 없는 스텝은 0행.
pub fn build_setup_report(
    setup: &[handicap_engine::Step],
    steps: &[crate::store::section::SectionStepRow],
    outcomes: &[crate::store::section::SectionOutcomeRow],
) -> Option<SetupReport> {
    use handicap_engine::Section;
    if setup.is_empty() {
        return None;
    }
    let out_steps = setup
        .iter()
        .map(|st| {
            let id = st.id();
            let mut acc = SetupStepReport {
                step_id: id.to_string(),
                count: 0,
                errors: 0,
                p50_ms: 0,
                p95_ms: 0,
                max_ms: 0,
                status_counts: BTreeMap::new(),
                failure_kinds: BTreeMap::new(),
            };
            let mut hist = fresh_hist();
            for r in steps
                .iter()
                .filter(|r| r.section == Section::Setup.as_str() && r.step_id == id)
            {
                acc.count += r.count.max(0) as u64;
                acc.errors += r.error_count.max(0) as u64;
                add_status(
                    &mut acc.status_counts,
                    &parse_status_counts(&r.status_counts),
                );
                add_status(
                    &mut acc.failure_kinds,
                    &parse_status_counts(&r.failure_kinds),
                );
                if let Ok(Some(h)) = decode_hdr(&r.hdr_histogram) {
                    merge_into(&mut hist, &h);
                }
            }
            let p = percentiles_of(&hist);
            acc.p50_ms = p.p50_ms;
            acc.p95_ms = p.p95_ms;
            acc.max_ms = hist.max() / 1_000;
            acc
        })
        .collect();
    let own = || {
        outcomes
            .iter()
            .filter(|o| o.section == Section::Setup.as_str())
    };
    Some(SetupReport {
        ok: own().map(|o| o.ok.max(0) as u64).sum(),
        failed: own().map(|o| o.failed.max(0) as u64).sum(),
        interrupted: own().map(|o| o.interrupted.max(0) as u64).sum(),
        steps: out_steps,
    })
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ReportRun {
    pub id: String,
    pub scenario_id: String,
    pub status: String,
    pub profile: serde_json::Value,
    pub env: serde_json::Value,
    pub started_at: Option<i64>,
    pub ended_at: Option<i64>,
    pub created_at: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    /// 이 run이 오류를 센 상태 코드 규칙 번호(1 = 옛 규칙, 2 = 현재). 늘 싣는다.
    #[serde(default = "status_rule_legacy")]
    pub status_rule: u8,
    /// 이 run의 응답 시간 판정 비교 규칙 번호(1 = 내린 ms, 2 = µs). 늘 싣는다.
    #[serde(default = "latency_rule_legacy")]
    pub latency_rule: u8,
}

fn status_rule_legacy() -> u8 {
    crate::store::runs::STATUS_RULE_LEGACY
}

fn latency_rule_legacy() -> u8 {
    crate::store::runs::LATENCY_RULE_LEGACY
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReportSummary {
    pub count: u64,
    pub errors: u64,
    pub rps: f64,
    pub duration_seconds: i64,
    pub mean_ms: u64,
    pub p50_ms: u64,
    pub p95_ms: u64,
    pub p99_ms: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stats: Option<crate::latency_stats::LatencyStats>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ReportWindow {
    pub ts_second: i64,
    pub step_id: String,
    pub count: u64,
    pub error_count: u64,
    pub status_counts: BTreeMap<String, u64>,
    pub p50_ms: u64,
    pub p95_ms: u64,
    pub p99_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LoopBucket {
    pub loop_index: Option<u32>, // None = overflow bucket: loop_index was >= cap at record time (engine sentinel u32::MAX)
    pub count: u64,
    pub error_count: u64,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct IfBranchBucket {
    pub branch: String, // "then" | "elif_0".. | "else" | "none"
    pub count: u64,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct IfBreakdown {
    pub step_id: String, // the `if` node's id
    pub branches: Vec<IfBranchBucket>,
}

/// E1: run-level rollup of a single transport error kind (spec §3.1 8-way
/// taxonomy, e.g. "connect_refused"/"timeout"/"dns"). Counts-only.
#[derive(Debug, Serialize, Deserialize)]
pub struct ErrorKindCount {
    pub kind: String,
    pub count: u64,
}

/// 조건 반복 하나의 진입 종료 집계. `entered` = 진입 건수(세 방식 합),
/// `passes` = 시작한 본문 회차 합(재시도 = passes − entered).
#[derive(Debug, Serialize, Deserialize)]
pub struct LoopExit {
    pub step_id: String,
    pub entered: u64,
    pub passes: u64,
    pub exhausted: u64,
    pub truncated: u64,
    pub buckets: Vec<LoopExitBucket>,
}

/// `pass`는 1부터 센 회차(`loop_index`는 0부터 — 다르다). `None` = 21번째 이후.
/// `null`을 그대로 직렬화한다(skip 없음).
#[derive(Debug, Serialize, Deserialize)]
pub struct LoopExitBucket {
    pub pass: Option<u32>,
    pub completed: u64,
    pub exhausted: u64,
    pub truncated: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReportStep {
    pub step_id: String,
    pub count: u64,
    pub error_count: u64,
    pub status_counts: BTreeMap<String, u64>,
    pub p50_ms: u64,
    pub p95_ms: u64,
    pub p99_ms: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stats: Option<crate::latency_stats::LatencyStats>,
    pub loop_breakdown: Vec<LoopBucket>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub download: Option<PhaseStats>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub wait: Option<PhaseStats>,
    /// 조건 반복에서 이어진 회차가 있는 스텝만: 끝낸 응답 / 재시도(이어짐+끊김) 응답 분리.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub loop_split: Option<LoopSplit>,
    /// 보내지 않은 요청 수(분류 blank_var의 스텝별 건수). 0건이면 None(직렬화 생략).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub not_sent: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct LoopSplitStats {
    pub count: u64,
    pub error_count: u64,
    pub p50_ms: u64,
    pub p95_ms: u64,
    pub p99_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct LoopSplit {
    #[serde(rename = "final")]
    pub ended: LoopSplitStats,
    pub retry: LoopSplitStats,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ConnectionStats {
    /// DNS resolution distribution across new connections this run.
    pub dns: PhaseStats,
    /// connect(TCP+TLS) distribution across new connections this run.
    pub connect: PhaseStats,
    /// Number of new connections opened (= count of `connect` phase samples). Approximate
    /// (background-spawned connects under pool contention may be missed).
    pub connections_opened: u64,
    /// Total requests this run (Σ step counts).
    pub requests_total: u64,
    /// Fraction of requests served by a reused connection = 1 − opened/total (0 if total 0).
    pub reuse_ratio: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct PhaseStats {
    pub count: u64,
    pub p50_ms: u64,
    pub p95_ms: u64,
    pub p99_ms: u64,
    pub max_ms: u64,
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct PercentilePoint {
    pub quantile: f64,
    pub value_us: u64,
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct HistogramBucket {
    pub lower_us: u64,
    pub upper_us: u64,
    pub count: u64,
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct GroupLatency {
    pub step_id: String, // the `parallel` node's id
    pub count: u64,
    pub p50_ms: u64,
    pub p95_ms: u64,
    pub p99_ms: u64,
    pub max_ms: u64,
    /// per-branch latency nested under this parallel node (empty if no parallel branches).
    /// `#[serde(default)]` only (no skip_serializing_if) → always serialized so the UI
    /// schema can use a plain required array (no `.default()` leak).
    #[serde(default)]
    pub branches: Vec<BranchLatency>,
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct BranchLatency {
    pub branch: String, // the parallel branch name
    pub count: u64,
    pub p50_ms: u64,
    pub p95_ms: u64,
    pub p99_ms: u64,
    pub max_ms: u64,
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct LatencyDistribution {
    pub percentile_curve: Vec<PercentilePoint>,
    pub histogram: Vec<HistogramBucket>,
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct ActiveVuSample {
    pub ts_second: i64,
    pub desired: u32,
    pub actual: u32,
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct WorkerActiveVuSeries {
    pub worker_id: String,
    pub samples: Vec<ActiveVuSample>,
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct WorkerBreakdown {
    pub worker_id: String,
    pub count: u64,
    pub errors: u64,
    pub p50_ms: u64,
    pub p95_ms: u64,
    pub p99_ms: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stats: Option<crate::latency_stats::LatencyStats>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Verdict {
    pub passed: bool, // 모든 활성 기준 AND
    pub criteria: Vec<CriterionResult>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct CriterionResult {
    pub metric: String,    // "p50_ms" | "p95_ms" | "p99_ms" | "error_rate" | "rps"
    pub direction: String, // "max" | "min"
    pub threshold: f64,    // 정수 ms 기준도 f64로 (A2 출력 shape 공유, spec §5/N-1)
    pub actual: f64,
    pub passed: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target: Option<String>, // step_id; fixed-field run-level 행은 None
    /// 응답 시간 기준인데 통과한 요청이 하나도 없어 실패한 행. 그 외에는 키 자체를 내지 않는다.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub no_sample: bool,
    /// 실측이 60초 칸에 걸려 하한일 뿐인 행(규칙 2·새 항목만). 그 외에는 키 자체를 내지 않는다.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub capped: bool,
}

/// 기본 표본(통과한 요청)에서 통과한 요청이 하나도 없는 자리. `Broken`(계산 실패)은 넣지 않는다.
pub struct NoSample<'a> {
    pub run: bool,
    pub steps: &'a BTreeSet<String>,
}

impl NoSample<'static> {
    pub fn none() -> Self {
        static EMPTY: BTreeSet<String> = BTreeSet::new();
        NoSample {
            run: false,
            steps: &EMPTY,
        }
    }
}

/// 특정 클래스(prefix '4'/'5')의 응답 수.
pub(crate) fn status_class_count(status_dist: &BTreeMap<String, u64>, first: char) -> u64 {
    status_dist
        .iter()
        .filter(|(k, _)| k.starts_with(first))
        .map(|(_, v)| *v)
        .sum()
}

/// HTTP 응답 총수(키 첫 글자 '1'..='5'; transport 실패 "0" 제외).
/// insights status_class와 동일 분모 — Task 3에서 insights가 이 함수를 재사용한다.
pub(crate) fn http_response_total(status_dist: &BTreeMap<String, u64>) -> u64 {
    status_dist
        .iter()
        .filter(|(k, _)| matches!(k.chars().next(), Some('1'..='5')))
        .map(|(_, v)| *v)
        .sum()
}

/// per-second 총 RPS(그 ts_second의 모든 step count 합)의 정상상태 최소값.
/// 첫·마지막 second(경계 부분초)를 항상 제외하고, 추가로 앞 `warmup`초를 제외한다.
/// eligible 윈도가 없으면(짧은 run·과대 warmup) None → criterion skip(평가 불가).
fn min_window_rps(windows: &[ReportWindow], warmup_seconds: u32) -> Option<f64> {
    let mut by_sec: BTreeMap<i64, u64> = BTreeMap::new();
    for w in windows {
        *by_sec.entry(w.ts_second).or_default() += w.count;
    }
    let first = *by_sec.keys().next()?;
    let last = *by_sec.keys().next_back()?;
    let lo = first + warmup_seconds as i64;
    by_sec
        .iter()
        .filter(|&(&ts, _)| ts > first && ts < last && ts >= lo)
        .map(|(_, &c)| c as f64)
        .min_by(|a, b| a.partial_cmp(b).unwrap())
}

/// 판정 입력. `overall_hist`·`step_hists`는 판정 표본(기본 표본) 분포 — 규칙 2와 새 시간 항목이 읽는다.
pub struct JudgeInput<'a> {
    pub summary: &'a ReportSummary,
    pub status_dist: &'a BTreeMap<String, u64>,
    pub windows: &'a [ReportWindow],
    pub steps: &'a [ReportStep],
    pub warmup_override: Option<u32>,
    pub no_sample: &'a NoSample<'a>,
    /// `store::runs::LATENCY_RULE_*`
    pub latency_rule: u8,
    /// run 판정 분포. 쓸 수 있는 분포가 없으면(통과 없음·계산 실패) None.
    pub overall_hist: Option<&'a Histogram<u64>>,
    /// 스텝 id → 판정 분포. 없는 스텝은 쓸 수 있는 분포가 없다.
    pub step_hists: &'a BTreeMap<String, Histogram<u64>>,
}

/// 응답 시간 값 하나의 종류. 백분위는 N × 1000(정수 순위).
#[derive(Debug, Clone, Copy, PartialEq)]
enum TimeKind {
    Mean,
    Max,
    Milli(u32),
}

impl TimeKind {
    /// `mean_ms`·`max_ms`·정본 `p<N>_ms`(p50·p95·p99 포함). 그 밖은 None.
    fn of_metric(metric: &str) -> Option<Self> {
        match metric {
            "mean_ms" => Some(TimeKind::Mean),
            "max_ms" => Some(TimeKind::Max),
            _ => crate::percentile_name::parse_percentile_metric(metric)
                .and_then(crate::percentile_name::to_milli)
                .map(TimeKind::Milli),
        }
    }
}

/// 시간 값 하나(µs)와 「실측이 하한일 뿐인가」(60초 칸). 통계 블록(`latency_stats`)과 같은 식이다(R15).
fn time_actual(kind: TimeKind, h: &Histogram<u64>) -> Option<(u64, bool)> {
    use crate::latency_stats as ls;
    match kind {
        TimeKind::Mean => ls::latency_stats(h).map(|s| (s.mean_us, s.capped)),
        TimeKind::Max => ls::max_us(h).map(|v| (v, ls::is_cap_value(h, h.max()))),
        TimeKind::Milli(n) => ls::value_at_milli_capped(h, n),
    }
}

/// 규칙 2 방식의 시간 기준 행. `hist`가 없거나 비었거나 `no_sample`이면 실패 + `no_sample`.
fn time_row(
    metric: String,
    op: &str,
    threshold: f64,
    target: Option<String>,
    kind: TimeKind,
    hist: Option<&Histogram<u64>>,
    no_sample: bool,
) -> CriterionResult {
    let measured = hist
        .filter(|h| !no_sample && !h.is_empty())
        .and_then(|h| time_actual(kind, h));
    let (actual, passed, capped, no_sample) = match measured {
        None => (0.0, false, false, true),
        Some((us, capped)) => {
            let t_us = (threshold * 1000.0).round() as u64;
            // 실측이 하한일 뿐이면(60초 칸) 상한 기준은 실패(R12), 하한 기준은 보통 비교.
            let passed = if op == "min" {
                us >= t_us
            } else {
                !capped && us <= t_us
            };
            (us as f64 / 1000.0, passed, capped, false)
        }
    };
    CriterionResult {
        metric,
        direction: op.to_string(),
        threshold,
        actual,
        passed,
        target,
        no_sample,
        capped,
    }
}

/// 순수: 입력만으로 결정적. 활성(Some) 기준만 결과 행을 만든다.
pub fn evaluate_criteria(c: &crate::store::runs::Criteria, input: &JudgeInput<'_>) -> Verdict {
    let s = input.summary;
    let no_sample = input.no_sample;
    let rule2 = input.latency_rule == crate::store::runs::LATENCY_RULE_CURRENT;
    let mut criteria = Vec::new();

    // run 시간 기준(R11): 평균 → 백분위(고정 + 목록, N 오름차순) → 최대.
    // 규칙 2 행과 새 항목 행(규칙 1의 방어 경로 포함)은 요청이 0건이면 만들지 않는다(R10).
    {
        let rule2_row = |metric: String, threshold: f64, kind: TimeKind| {
            time_row(
                metric,
                "max",
                threshold,
                None,
                kind,
                input.overall_hist,
                no_sample.run,
            )
        };
        let mut time_rows: Vec<(u32, CriterionResult)> = Vec::new();
        let has_requests = s.count > 0;
        if let (Some(t), true) = (c.max_mean_ms, has_requests) {
            time_rows.push((0, rule2_row("mean_ms".into(), t, TimeKind::Mean)));
        }
        for (milli, metric, threshold, legacy_actual) in [
            (50_000u32, "p50_ms", c.max_p50_ms, s.p50_ms),
            (95_000, "p95_ms", c.max_p95_ms, s.p95_ms),
            (99_000, "p99_ms", c.max_p99_ms, s.p99_ms),
        ] {
            let Some(t) = threshold else { continue };
            if rule2 {
                if has_requests {
                    time_rows.push((
                        milli,
                        rule2_row(metric.into(), t as f64, TimeKind::Milli(milli)),
                    ));
                }
            } else {
                let (threshold, actual) = (t as f64, legacy_actual as f64);
                time_rows.push((
                    milli,
                    CriterionResult {
                        metric: metric.to_string(),
                        direction: "max".to_string(),
                        threshold,
                        actual,
                        passed: actual <= threshold && !no_sample.run,
                        target: None,
                        no_sample: no_sample.run,
                        capped: false,
                    },
                ));
            }
        }
        if has_requests {
            for pl in &c.max_percentiles_ms {
                // 검증이 N을 막는다 — 정본으로 못 쓰는 값은 건너뛴다(방어).
                let Some(milli) = crate::percentile_name::to_milli(pl.percentile) else {
                    continue;
                };
                let name = crate::percentile_name::percentile_metric_name(pl.percentile);
                time_rows.push((milli, rule2_row(name, pl.max_ms, TimeKind::Milli(milli))));
            }
            if let Some(t) = c.max_max_ms {
                time_rows.push((u32::MAX, rule2_row("max_ms".into(), t, TimeKind::Max)));
            }
        }
        // 안정 정렬: 같은 N이면 넣은 순서(고정 칸 → 목록).
        time_rows.sort_by_key(|(k, _)| *k);
        criteria.extend(time_rows.into_iter().map(|(_, r)| r));
    }

    if let Some(t) = c.max_error_rate {
        let actual = if s.count == 0 {
            0.0
        } else {
            s.errors as f64 / s.count as f64
        };
        criteria.push(CriterionResult {
            metric: "error_rate".to_string(),
            direction: "max".to_string(),
            threshold: t,
            actual,
            passed: actual <= t,
            target: None,
            no_sample: false,
            capped: false,
        });
    }
    // status-class rate(분모=HTTP 응답 수, transport "0" 제외) — 4xx, 5xx 순.
    let http_total = http_response_total(input.status_dist);
    for (first, rate_t, metric) in [
        ('4', c.max_4xx_rate, "4xx_rate"),
        ('5', c.max_5xx_rate, "5xx_rate"),
    ] {
        if let Some(t) = rate_t {
            let class = status_class_count(input.status_dist, first);
            let actual = if http_total == 0 {
                0.0
            } else {
                class as f64 / http_total as f64
            };
            criteria.push(CriterionResult {
                metric: metric.to_string(),
                direction: "max".to_string(),
                threshold: t,
                actual,
                passed: actual <= t,
                target: None,
                no_sample: false,
                capped: false,
            });
        }
    }
    // status-class count — 4xx, 5xx 순.
    for (first, count_t, metric) in [
        ('4', c.max_4xx_count, "4xx_count"),
        ('5', c.max_5xx_count, "5xx_count"),
    ] {
        if let Some(t) = count_t {
            let (threshold, actual) = (
                t as f64,
                status_class_count(input.status_dist, first) as f64,
            );
            criteria.push(CriterionResult {
                metric: metric.to_string(),
                direction: "max".to_string(),
                threshold,
                actual,
                passed: actual <= threshold,
                target: None,
                no_sample: false,
                capped: false,
            });
        }
    }
    if let Some(t) = c.min_rps {
        criteria.push(CriterionResult {
            metric: "rps".to_string(),
            direction: "min".to_string(),
            threshold: t,
            actual: s.rps,
            passed: s.rps >= t,
            target: None,
            no_sample: false,
            capped: false,
        });
    }
    // per-window 최소 RPS: 정상상태 윈도의 최소 RPS ≥ threshold. eligible 부족이면 skip(행 미생성).
    if let Some(t) = c.min_window_rps {
        let warmup = input
            .warmup_override
            .unwrap_or_else(|| c.rps_warmup_seconds.unwrap_or(0));
        if let Some(actual) = min_window_rps(input.windows, warmup) {
            criteria.push(CriterionResult {
                metric: "min_window_rps".to_string(),
                direction: "min".to_string(),
                threshold: t,
                actual,
                passed: actual >= t,
                target: None,
                no_sample: false,
                capped: false,
            });
        }
    }

    // step-level criteria (spec §3.3) — fixed-field 행 뒤에 입력 순서대로 append.
    for sc in &c.step_criteria {
        let Some(step) = input.steps.iter().find(|s| s.step_id == sc.target) else {
            continue; // 미존재 스텝 → skip (거짓 FAIL 금지)
        };
        if step.count == 0 {
            continue; // 실행 0회 → skip
        }
        let legacy_time = matches!(sc.metric.as_str(), "p50_ms" | "p95_ms" | "p99_ms");
        // 규칙 2의 시간 기준, 그리고 새 시간 항목(규칙 1의 방어 경로 포함)은 그 스텝 분포에서 µs로.
        if let Some(kind) = TimeKind::of_metric(&sc.metric).filter(|_| rule2 || !legacy_time) {
            criteria.push(time_row(
                sc.metric.clone(),
                &sc.op,
                sc.threshold,
                Some(sc.target.clone()),
                kind,
                input.step_hists.get(&sc.target),
                no_sample.steps.contains(&sc.target),
            ));
            continue;
        }
        let actual = match sc.metric.as_str() {
            "p50_ms" => step.p50_ms as f64,
            "p95_ms" => step.p95_ms as f64,
            "p99_ms" => step.p99_ms as f64,
            "error_rate" => step.error_count as f64 / step.count as f64,
            "4xx_rate" | "5xx_rate" => {
                let first = if sc.metric.starts_with('4') { '4' } else { '5' };
                let total = http_response_total(&step.status_counts);
                if total == 0 {
                    0.0
                } else {
                    status_class_count(&step.status_counts, first) as f64 / total as f64
                }
            }
            "4xx_count" => status_class_count(&step.status_counts, '4') as f64,
            "5xx_count" => status_class_count(&step.status_counts, '5') as f64,
            _ => continue, // 검증으로 도달 불가(방어)
        };
        let step_no_sample = legacy_time && no_sample.steps.contains(&sc.target);
        let passed = !step_no_sample
            && if sc.op == "min" {
                actual >= sc.threshold
            } else {
                actual <= sc.threshold
            };
        criteria.push(CriterionResult {
            metric: sc.metric.clone(),
            direction: sc.op.clone(),
            threshold: sc.threshold,
            actual,
            passed,
            target: Some(sc.target.clone()),
            no_sample: step_no_sample,
            capped: false,
        });
    }

    let passed = criteria.iter().all(|r| r.passed);
    Verdict { passed, criteria }
}

fn parse_status_counts(s: &str) -> BTreeMap<String, u64> {
    serde_json::from_str(s).unwrap_or_default()
}

fn add_status(into: &mut BTreeMap<String, u64>, from: &BTreeMap<String, u64>) {
    for (k, v) in from {
        *into.entry(k.clone()).or_insert(0) += v;
    }
}

const HDR_LO_US: u64 = 1;
const HDR_HI_US: u64 = 60_000_000;
const HDR_SIGFIG: u8 = 3;

pub(crate) fn fresh_hist() -> Histogram<u64> {
    Histogram::<u64>::new_with_bounds(HDR_LO_US, HDR_HI_US, HDR_SIGFIG)
        .expect("HDR bounds are valid")
}

/// 유지 구간 기준 리포트의 입력. `None`이면 지금과 같은 전체 구간 계산.
pub struct SteadyScope<'a> {
    /// ts_second 반열린 [lo, hi)
    pub lo: i64,
    pub hi: i64,
    /// run 시작부터 센 warmup에서 (ramp+discard)를 뺀 나머지(0 이상). min_window_rps에 쓴다.
    pub warmup_seconds: u32,
    /// open-loop의 창 안 계수. closed-loop면 None.
    pub open_loop: Option<ScopedOpenLoop<'a>>,
    /// 같은 run의 전체 구간 리포트 — 나눌 수 없는 값의 출처.
    pub whole: &'a ReportJson,
}

pub struct ScopedOpenLoop<'a> {
    /// 평평한 목표(iter/s). 예정 도착 수 = target × (hi − lo).
    pub target: u32,
    /// 창 안 버림 합. None = 초 단위 계수가 없는 워커가 섞여 다시 셀 수 없다(dropped_whole_run).
    pub dropped: Option<u64>,
    /// 창 안의 초별 합계(오름차순). dropped가 None이면 빈 슬라이스.
    pub totals: &'a [crate::store::open_loop::OpenLoopTotal],
}

#[allow(clippy::too_many_arguments)]
pub fn build_report(
    run: &RunRow,
    scenario_yaml: &str,
    rows: &[WindowWithHdr],
    loops: &[LoopMetricRow],
    branches: &[IfBranchRow],
    groups: &[GroupMetricRow],
    phases: &[PhaseMetricRow],
    active_vu: &[crate::store::metrics::ActiveVuRow],
    active_vu_by_worker: &[crate::store::metrics::ActiveVuRow],
    error_kinds: &[crate::store::metrics::ErrorKindRow],
    loop_exits: &[crate::store::metrics::LoopExitRow],
    stair_inputs: &crate::stair::StairInputs,
    open_loop_totals: &[crate::store::open_loop::OpenLoopTotal],
    setup: Option<&SetupReport>,
    scope: Option<&SteadyScope<'_>>,
    sample: Option<Sample>,
) -> ReportJson {
    // Build per-step loop breakdown map (loops already ordered by step_id, loop_index from SQL).
    let mut loop_by_step: BTreeMap<String, Vec<LoopBucket>> = BTreeMap::new();
    for r in loops {
        let idx = r.loop_index as u32;
        loop_by_step
            .entry(r.step_id.clone())
            .or_default()
            .push(LoopBucket {
                loop_index: if idx == u32::MAX { None } else { Some(idx) },
                count: r.count as u64,
                error_count: r.error_count as u64,
            });
    }

    // Group branch decision counts by `if` node id (rows already ordered by
    // step_id, branch from SQL). Keyed by the `if` id, NOT an http leaf — `if` ids
    // never appear in `steps`, and the `none` bucket has no leaf at all.
    let mut if_by_step: BTreeMap<String, Vec<IfBranchBucket>> = BTreeMap::new();
    for r in branches {
        if_by_step
            .entry(r.step_id.clone())
            .or_default()
            .push(IfBranchBucket {
                branch: r.branch.clone(),
                count: r.count as u64,
            });
    }
    let if_breakdown: Vec<IfBreakdown> = if_by_step
        .into_iter()
        .map(|(step_id, branches)| IfBreakdown { step_id, branches })
        .collect();

    // E1: run-level rollup of transport error kinds. Per-step rows (already
    // ordered by step_id, kind from SQL) collapse to a kind-only total —
    // step attribution isn't surfaced in the report (spec §3.1/§9.2, counts-only)
    // — except `blank_var`, which is surfaced per step as `ReportStep.not_sent`.
    let mut kind_totals: BTreeMap<String, u64> = BTreeMap::new();
    // blank_var(보내지 않은 요청)은 스텝별로도 모아 범위가 없을 때 ReportStep.not_sent에 싣는다.
    let mut not_sent_by_step: BTreeMap<String, u64> = BTreeMap::new();
    for r in error_kinds {
        let n = r.count.max(0) as u64;
        *kind_totals.entry(r.kind.clone()).or_default() += n;
        if r.kind == "blank_var" && n > 0 {
            *not_sent_by_step.entry(r.step_id.clone()).or_default() += n;
        }
    }
    let not_sent_total: u64 = not_sent_by_step.values().sum();
    let mut error_kinds_rolled: Vec<ErrorKindCount> = kind_totals
        .into_iter()
        .map(|(kind, count)| ErrorKindCount { kind, count })
        .collect();
    error_kinds_rolled.sort_by(|a, b| b.count.cmp(&a.count).then(a.kind.cmp(&b.kind)));

    // 조건 반복 진입 종료(loop-while-report): (step_id, pass_bucket)별로 세 방식을 한 칸에 모은다.
    // BTreeMap 키 순서 = step_id 오름차순, 칸 오름차순(21 = "21번째 이후"가 맨 끝).
    let mut exit_acc: BTreeMap<String, (u64, BTreeMap<i64, [u64; 3]>)> = BTreeMap::new();
    for r in loop_exits {
        let Ok(o) = usize::try_from(r.outcome) else {
            continue;
        };
        if o > 2 {
            continue;
        }
        let e = exit_acc.entry(r.step_id.clone()).or_default();
        e.0 += r.pass_sum.max(0) as u64;
        e.1.entry(r.pass_bucket).or_insert([0; 3])[o] += r.count.max(0) as u64;
    }
    let cap = i64::from(handicap_engine::LOOP_EXIT_PASS_CAP);
    let loop_exits_rolled: Vec<LoopExit> = exit_acc
        .into_iter()
        .map(|(step_id, (passes, by_bucket))| {
            let buckets: Vec<LoopExitBucket> = by_bucket
                .into_iter()
                .filter(|(_, c)| c.iter().sum::<u64>() > 0)
                .map(|(bucket, c)| LoopExitBucket {
                    pass: if bucket > cap {
                        None
                    } else {
                        Some(bucket.max(1) as u32)
                    },
                    completed: c[0],
                    exhausted: c[1],
                    truncated: c[2],
                })
                .collect();
            LoopExit {
                step_id,
                entered: buckets
                    .iter()
                    .map(|b| b.completed + b.exhausted + b.truncated)
                    .sum(),
                passes,
                exhausted: buckets.iter().map(|b| b.exhausted).sum(),
                truncated: buckets.iter().map(|b| b.truncated).sum(),
                buckets,
            }
        })
        .filter(|l| l.entered > 0)
        .collect();

    // Per-(ts_second, step_id) accumulator merging all workers sharing the window.
    struct WindowAcc<'r> {
        count: u64,
        error_count: u64,
        status: BTreeMap<String, u64>,
        hist: SplitHist<'r>,
    }
    // 나눌 수 있는 run(모든 행에 실패 칸)이면 기본 표본 = 통과한 요청, 아니면 모든 요청.
    let split = crate::sample::run_is_split(rows);
    let default_sample = if split { Sample::Passed } else { Sample::All };
    let selected = sample
        .filter(|s| split || *s == Sample::All)
        .unwrap_or(default_sample);
    let mut window_acc: BTreeMap<(i64, String), WindowAcc> = BTreeMap::new();
    let mut overall = SplitHist::default();
    let mut per_step: BTreeMap<String, SplitHist> = BTreeMap::new();
    // (count, error_count, status_counts, 범위가 있을 때 응답 수 합 Σ status_counts)
    let mut per_step_count: BTreeMap<String, (u64, u64, BTreeMap<String, u64>, u64)> =
        BTreeMap::new();
    let mut status_dist: BTreeMap<String, u64> = BTreeMap::new();
    let mut total_count: u64 = 0;
    let mut total_errors: u64 = 0;

    // Per-worker breakdown (ALL fan-out: closed/open/curve). Pre-scan distinct non-empty
    // worker_ids so single-worker runs do ZERO extra per-worker work (byte-identical build
    // cost); only >=2 -> accumulate below in the SAME loop (reuse the decoded row `d`, no extra decode).
    let multi_worker = {
        let mut seen = std::collections::HashSet::new();
        for r in rows {
            if !r.worker_id.is_empty() {
                seen.insert(r.worker_id.as_str());
            }
        }
        seen.len() >= 2
    };
    struct WorkerAcc<'r> {
        count: u64,
        errors: u64,
        hist: SplitHist<'r>,
    }
    let mut worker_acc: BTreeMap<String, WorkerAcc> = BTreeMap::new();

    for r in rows {
        let sc = parse_status_counts(&r.status_counts);
        let acc = window_acc
            .entry((r.ts_second, r.step_id.clone()))
            .or_insert_with(|| WindowAcc {
                count: 0,
                error_count: 0,
                status: BTreeMap::new(),
                hist: SplitHist::default(),
            });
        acc.count += r.count as u64;
        acc.error_count += r.error_count as u64;
        add_status(&mut acc.status, &sc);
        // 그림용 창은 모든 행, 나머지 누적은 범위 안의 행만(범위가 없으면 전부).
        let counted = scope.is_none_or(|s| r.ts_second >= s.lo && r.ts_second < s.hi);
        // NEW: per-worker count/errors (multi-worker fan-out only; '' legacy excluded)
        if counted && multi_worker && !r.worker_id.is_empty() {
            let w = worker_acc
                .entry(r.worker_id.clone())
                .or_insert_with(|| WorkerAcc {
                    count: 0,
                    errors: 0,
                    hist: SplitHist::default(),
                });
            w.count += r.count as u64;
            w.errors += r.error_count as u64;
        }
        // 행 BLOB은 한 번만 디코드해 네 자리(창·전체·스텝·워커)가 같이 쓴다. 깨진 행은 분포에서만 빠진다.
        let failed_blob = if split {
            r.failed_hdr_histogram.as_deref()
        } else {
            None
        };
        if let Some(d) = crate::sample::decode_row(&r.hdr_histogram, failed_blob) {
            let raw = match (&d.failed, failed_blob) {
                (Some(f), Some(fb)) if !f.is_empty() => Some((r.hdr_histogram.as_slice(), fb)),
                _ => None,
            };
            acc.hist.add(&d, raw);
            if counted {
                overall.add(&d, raw);
                per_step.entry(r.step_id.clone()).or_default().add(&d, raw);
                if multi_worker && !r.worker_id.is_empty() {
                    let w = worker_acc
                        .entry(r.worker_id.clone())
                        .or_insert_with(|| WorkerAcc {
                            count: 0,
                            errors: 0,
                            hist: SplitHist::default(),
                        });
                    w.hist.add(&d, raw);
                }
            }
        }
        if !counted {
            continue;
        }
        total_count += r.count as u64;
        total_errors += r.error_count as u64;
        add_status(&mut status_dist, &sc);
        let step_acc = per_step_count.entry(r.step_id.clone()).or_default();
        step_acc.0 += r.count as u64;
        step_acc.1 += r.error_count as u64;
        add_status(&mut step_acc.2, &sc);
        if scope.is_some() {
            step_acc.3 += sc.values().sum::<u64>();
        }
    }

    // 응답 시간 값의 세 용도: 보여 주는 값(`selected`), 판정(항상 `default_sample` — 판정·속도 구간·
    // 느린 스텝 인사이트), 점유(항상 모든 요청 — 포화 원인의 `latency_rose`).
    // Emit one window per (ts_second, step_id) — BTreeMap iterates sorted by (ts, step),
    // matching the previous SQL ORDER BY. Percentiles come from the merged histogram.
    let window_of = |ts_second: i64,
                     step_id: String,
                     status_counts: BTreeMap<String, u64>,
                     acc: &WindowAcc,
                     sample: Sample|
     -> ReportWindow {
        let wp = acc
            .hist
            .resolve(sample)
            .hist()
            .map(percentiles_of)
            .unwrap_or_else(Percentiles::empty);
        ReportWindow {
            ts_second,
            step_id,
            count: acc.count,
            error_count: acc.error_count,
            status_counts,
            p50_ms: wp.p50_ms,
            p95_ms: wp.p95_ms,
            p99_ms: wp.p99_ms,
        }
    };
    // 모든 요청 표본을 보여 줄 때는 보여 주는 창이 점유 창이다. 아닐 때만 빌려서 따로 만든다.
    let occupancy_windows: Option<Vec<ReportWindow>> = (selected != Sample::All).then(|| {
        window_acc
            .iter()
            .map(|((ts, step), acc)| {
                window_of(*ts, step.clone(), acc.status.clone(), acc, Sample::All)
            })
            .collect()
    });
    // 보여 주는 창은 누적을 옮겨 가며(복사 없이) 만든다.
    let windows: Vec<ReportWindow> = window_acc
        .into_iter()
        .map(|((ts, step), mut acc)| {
            let status = std::mem::take(&mut acc.status);
            window_of(ts, step, status, &acc, selected)
        })
        .collect();
    let occupancy: &[ReportWindow] = occupancy_windows.as_deref().unwrap_or(&windows);

    let overall_judging = overall.resolve(default_sample);
    let no_samples = fresh_hist();
    let overall_h: &Histogram<u64> = overall_judging.hist().unwrap_or(&no_samples);
    let overall_p = percentiles_of(overall_h);
    let overall_shown = (selected != default_sample).then(|| overall.resolve(selected));
    let shown_h: &Histogram<u64> = match &overall_shown {
        Some(r) => r.hist().unwrap_or(&no_samples),
        None => overall_h,
    };
    let latency = if !shown_h.is_empty() {
        Some(LatencyDistribution {
            percentile_curve: percentile_curve(shown_h, &CURVE_QUANTILES)
                .into_iter()
                .map(|(quantile, value_us)| PercentilePoint { quantile, value_us })
                .collect(),
            histogram: log_buckets(shown_h, HISTOGRAM_BINS)
                .into_iter()
                .map(|(lower_us, upper_us, count)| HistogramBucket {
                    lower_us,
                    upper_us,
                    count,
                })
                .collect(),
        })
    } else {
        None
    };
    let profile_val = serde_json::to_value(&run.profile).unwrap_or(serde_json::Value::Null);
    let env_val = run.env.clone();
    // runs.started_at / ended_at are wall-clock milliseconds (now_ms in store/runs.rs).
    // Convert to seconds for the report; keep ms for rps so sub-second resolution survives.
    // 시작 시각이 없는 run(부하 시작 전 중단 등)은 측정 구간(첫~마지막 창, 양끝 포함)으로,
    // 끝 시각이 없는 실행 중 run은 0으로 둔다 — 0 기준 뺄셈은 epoch 기준 값이나 음수를 낳는다.
    let scoped_seconds = scope.map(|s| s.hi.saturating_sub(s.lo).max(0));
    let duration_ms = match (scoped_seconds, run.started_at, run.ended_at) {
        (Some(secs), _, _) => secs.saturating_mul(1_000),
        (None, Some(s), Some(e)) => e.saturating_sub(s).max(0),
        (None, None, _) => match (
            rows.iter().map(|w| w.ts_second).min(),
            rows.iter().map(|w| w.ts_second).max(),
        ) {
            (Some(lo), Some(hi)) => hi
                .saturating_sub(lo)
                .saturating_add(1)
                .saturating_mul(1_000),
            _ => 0,
        },
        (None, Some(_), None) => 0,
    };
    let duration_seconds = duration_ms / 1_000;
    let rps = if duration_ms > 0 {
        total_count as f64 * 1_000.0 / duration_ms as f64
    } else {
        0.0
    };

    // Phase (download) latency: SEPARATE accumulator keyed by step_id (phase=="download").
    // Surfaces onto each ReportStep. NOT merged into summary/overall/per_step(TTFB)/windows
    // (isolation; spec §4.6).
    let mut download_acc: BTreeMap<String, (Histogram<u64>, u64)> = BTreeMap::new();
    for p in phases.iter().filter(|p| p.phase == "download") {
        let e = download_acc
            .entry(p.step_id.clone())
            .or_insert_with(|| (fresh_hist(), 0));
        if let Ok(Some(h)) = decode_hdr(&p.hdr_histogram) {
            merge_into(&mut e.0, &h); // fail-soft on bad blob
        }
        e.1 += p.count as u64;
    }
    let mut download_by_step: BTreeMap<String, PhaseStats> = download_acc
        .into_iter()
        .map(|(step_id, (h, count))| {
            let pc = percentiles_of(&h);
            (
                step_id,
                PhaseStats {
                    count,
                    p50_ms: pc.p50_ms,
                    p95_ms: pc.p95_ms,
                    p99_ms: pc.p99_ms,
                    max_ms: h.max() / 1_000,
                },
            )
        })
        .collect();

    // Wait latency: per-step accumulator (phase=="wait"), mirrors download_acc pattern.
    let mut wait_acc: BTreeMap<String, (Histogram<u64>, u64)> = BTreeMap::new();
    for p in phases.iter().filter(|p| p.phase == "wait") {
        let e = wait_acc
            .entry(p.step_id.clone())
            .or_insert_with(|| (fresh_hist(), 0));
        if let Ok(Some(h)) = decode_hdr(&p.hdr_histogram) {
            merge_into(&mut e.0, &h); // fail-soft on bad blob
        }
        e.1 += p.count as u64;
    }
    let mut wait_by_step: BTreeMap<String, PhaseStats> = wait_acc
        .into_iter()
        .map(|(step_id, (h, count))| {
            let pc = percentiles_of(&h);
            (
                step_id,
                PhaseStats {
                    count,
                    p50_ms: pc.p50_ms,
                    p95_ms: pc.p95_ms,
                    p99_ms: pc.p99_ms,
                    max_ms: h.max() / 1_000,
                },
            )
        })
        .collect();

    // 조건 반복 응답 시간 분리: 구간 여섯 종 행을 스텝별로 모은다(download/wait와 별도 누적).
    // 끝냄 = loop_final, 재시도 = loop_retry + loop_cut. 표시 조건 = loop_retry 건수 합 >= 1(끊김 제외).
    #[derive(Default)]
    struct SplitAcc {
        final_h: Option<Histogram<u64>>,
        retry_h: Option<Histogram<u64>>,
        final_n: u64,
        retry_n: u64,
        cont_n: u64,
        final_err: u64,
        retry_err: u64,
    }
    let mut split_acc: BTreeMap<String, SplitAcc> = BTreeMap::new();
    for p in phases {
        let name = p.phase.as_str();
        if ![
            PHASE_LOOP_FINAL,
            PHASE_LOOP_RETRY,
            PHASE_LOOP_CUT,
            PHASE_LOOP_FINAL_ERR,
            PHASE_LOOP_RETRY_ERR,
            PHASE_LOOP_CUT_ERR,
        ]
        .contains(&name)
        {
            continue;
        }
        let n = p.count.max(0) as u64;
        let e = split_acc.entry(p.step_id.clone()).or_default();
        let decoded = || decode_hdr(&p.hdr_histogram).ok().flatten();
        match name {
            PHASE_LOOP_FINAL => {
                if let Some(h) = decoded() {
                    merge_into(e.final_h.get_or_insert_with(fresh_hist), &h);
                }
                e.final_n = e.final_n.saturating_add(n);
            }
            PHASE_LOOP_RETRY | PHASE_LOOP_CUT => {
                if let Some(h) = decoded() {
                    merge_into(e.retry_h.get_or_insert_with(fresh_hist), &h);
                }
                e.retry_n = e.retry_n.saturating_add(n);
                if name == PHASE_LOOP_RETRY {
                    e.cont_n = e.cont_n.saturating_add(n);
                }
            }
            PHASE_LOOP_FINAL_ERR => e.final_err = e.final_err.saturating_add(n),
            _ => e.retry_err = e.retry_err.saturating_add(n), // PHASE_LOOP_RETRY_ERR | PHASE_LOOP_CUT_ERR
        }
    }
    let mut split_by_step: BTreeMap<String, LoopSplit> = split_acc
        .into_iter()
        .filter(|(_, a)| a.cont_n >= 1)
        .map(|(step_id, a)| {
            let side = |h: Option<Histogram<u64>>, count: u64, err: u64| {
                // 건수 0인 갈래는 샘플이 있어도 백분위 0.
                let pc = h
                    .as_ref()
                    .filter(|_| count > 0)
                    .map(percentiles_of)
                    .unwrap_or_else(Percentiles::empty);
                LoopSplitStats {
                    count,
                    error_count: err.min(count),
                    p50_ms: pc.p50_ms,
                    p95_ms: pc.p95_ms,
                    p99_ms: pc.p99_ms,
                }
            };
            (
                step_id,
                LoopSplit {
                    ended: side(a.final_h, a.final_n, a.final_err),
                    retry: side(a.retry_h, a.retry_n, a.retry_err),
                },
            )
        })
        .collect();

    // Connection cost: dns + connect phases rolled up RUN-LEVEL (step_id ignored — a
    // connection serves many steps). connections_opened = Σ connect counts. NOT per-step.
    let mut dns_hist = fresh_hist();
    let mut dns_count: u64 = 0;
    let mut connect_hist = fresh_hist();
    let mut connect_count: u64 = 0;
    // 범위가 있으면 전체 구간 리포트의 값을 그대로 쓰므로 다시 모으지 않는다.
    let connection_phases = if scope.is_some() { &[][..] } else { phases };
    for p in connection_phases {
        let (h, c) = match p.phase.as_str() {
            "dns" => (&mut dns_hist, &mut dns_count),
            "connect" => (&mut connect_hist, &mut connect_count),
            _ => continue,
        };
        if let Ok(Some(decoded)) = decode_hdr(&p.hdr_histogram) {
            merge_into(h, &decoded);
        }
        *c += p.count as u64;
    }
    // total_count is the Σ step requests already computed for the summary (see ReportSummary).
    let connection = if let Some(s) = scope {
        s.whole.connection.clone()
    } else if connect_count > 0 || dns_count > 0 {
        let phase_stats = |h: &Histogram<u64>, count: u64| {
            let pc = percentiles_of(h);
            PhaseStats {
                count,
                p50_ms: pc.p50_ms,
                p95_ms: pc.p95_ms,
                p99_ms: pc.p99_ms,
                max_ms: h.max() / 1_000,
            }
        };
        // 보내지 않은 요청은 연결을 쓰지 않으므로 분모에서 뺀다.
        let sent_total = total_count.saturating_sub(not_sent_total);
        let reuse_ratio = if sent_total == 0 {
            0.0
        } else {
            1.0 - (connect_count as f64 / sent_total as f64)
        };
        Some(ConnectionStats {
            dns: phase_stats(&dns_hist, dns_count),
            connect: phase_stats(&connect_hist, connect_count),
            connections_opened: connect_count,
            requests_total: sent_total,
            reuse_ratio,
        })
    } else {
        None
    };

    let no_sample_run = split && total_count > 0 && overall_judging.is_empty_sample();
    // 스텝마다 표본별 분포를 한 번씩만 만든다: 보여 주는 표본이 기본 표본과 다를 때만 빌려서 계산하고,
    // 기본 표본(판정·속도 구간)은 소유권으로 옮겨 속도 구간 입력이 된다.
    let shown_step_p: Option<BTreeMap<String, (Percentiles, Option<LatencyStats>)>> =
        (selected != default_sample).then(|| {
            per_step
                .iter()
                .map(|(id, sh)| {
                    let resolved = sh.resolve(selected);
                    let hist = resolved.hist();
                    let p = hist.map(percentiles_of).unwrap_or_else(Percentiles::empty);
                    (id.clone(), (p, hist.and_then(latency_stats)))
                })
                .collect()
        });
    // 기본 표본은 스텝마다 한 번만 풀어(빼기 한 번) 판정용 분포와 「통과한 요청 없음」 집합을 함께 만든다.
    // 집합에는 `Empty`만 들어간다 — 계산 실패 `Broken`은 아니다. 나눌 수 있는 run에서만.
    let mut no_sample_steps: BTreeSet<String> = BTreeSet::new();
    let mut per_step_hists: BTreeMap<String, Histogram<u64>> = BTreeMap::new();
    for (id, sh) in per_step {
        match sh.into_resolved(default_sample) {
            Resolved::Hist(h) => {
                per_step_hists.insert(id, h.into_owned());
            }
            Resolved::Empty if split && per_step_count.get(&id).is_some_and(|c| c.0 > 0) => {
                no_sample_steps.insert(id);
            }
            _ => {}
        }
    }

    let mut steps: Vec<ReportStep> = per_step_count
        .into_iter()
        .map(|(step_id, (count, errors, status_counts, responded))| {
            let p = per_step_hists
                .get(&step_id)
                .map(percentiles_of)
                .unwrap_or_else(Percentiles::empty);
            let stats = per_step_hists.get(&step_id).and_then(latency_stats);
            let breakdown = loop_by_step.remove(&step_id).unwrap_or_default();
            let download = download_by_step.remove(&step_id);
            let wait = wait_by_step.remove(&step_id);
            let loop_split = split_by_step.remove(&step_id);
            // 보내지 않은 요청은 건수에만 들어가고 status 칸이 없으므로(엔진 `record_not_sent`)
            // 범위 안 값은 건수 − 응답 수다. 범위가 없으면 blank_var 오류 종류의 run 전체 합.
            let not_sent = if scope.is_some() {
                Some(count.saturating_sub(responded)).filter(|n| *n > 0)
            } else {
                not_sent_by_step.get(&step_id).copied()
            };
            ReportStep {
                step_id,
                count,
                error_count: errors,
                status_counts,
                p50_ms: p.p50_ms,
                p95_ms: p.p95_ms,
                p99_ms: p.p99_ms,
                stats,
                loop_breakdown: breakdown,
                download,
                wait,
                loop_split,
                not_sent,
            }
        })
        .collect();
    steps.sort_by(|a, b| a.step_id.cmp(&b.step_id));
    let shown_steps: Option<Vec<ReportStep>> = shown_step_p.map(|m| {
        steps
            .iter()
            .map(|s| {
                let (p, stats) = m
                    .get(&s.step_id)
                    .copied()
                    .unwrap_or_else(|| (Percentiles::empty(), None));
                ReportStep {
                    p50_ms: p.p50_ms,
                    p95_ms: p.p95_ms,
                    p99_ms: p.p99_ms,
                    stats,
                    ..s.clone()
                }
            })
            .collect()
    });
    let speed_bands =
        crate::speed_bands::build(overall_h, &per_step_hists, run.profile.criteria.as_ref());

    let summary = ReportSummary {
        count: total_count,
        errors: total_errors,
        rps,
        duration_seconds,
        mean_ms: (overall_h.mean() / 1_000.0).round() as u64,
        p50_ms: overall_p.p50_ms,
        p95_ms: overall_p.p95_ms,
        p99_ms: overall_p.p99_ms,
        stats: latency_stats(overall_h),
    };
    let shown_summary: Option<ReportSummary> = overall_shown.as_ref().map(|r| {
        let h = r.hist().unwrap_or(&no_samples);
        let p = percentiles_of(h);
        ReportSummary {
            mean_ms: (h.mean() / 1_000.0).round() as u64,
            p50_ms: p.p50_ms,
            p95_ms: p.p95_ms,
            p99_ms: p.p99_ms,
            stats: latency_stats(h),
            ..summary.clone()
        }
    });
    // completed + 활성 criteria일 때만 verdict (spec §6). RunStatus는 Copy.
    // 범위가 있으면 판정·인사이트가 보는 창 목록은 범위 안의 연속 구간(windows는 (ts, step) 오름차순).
    // 점유 창(모든 요청 표본): `evaluate_criteria`는 건수만, `derive_insights`는 `latency_rose`가 응답 시간을 읽는다.
    let scoped_windows: &[ReportWindow] = match scope {
        Some(s) => {
            let from = occupancy.partition_point(|w| w.ts_second < s.lo);
            let to = occupancy.partition_point(|w| w.ts_second < s.hi);
            &occupancy[from..to]
        }
        None => occupancy,
    };
    let verdict = match (run.status, run.profile.criteria.as_ref()) {
        (RunStatus::Completed, Some(c)) if c.has_any() => {
            // 판정은 보여 주는 표본과 무관하게 기본 표본 분포(`overall_judging`·`per_step_hists`)로(R14).
            let v = evaluate_criteria(
                c,
                &JudgeInput {
                    summary: &summary,
                    status_dist: &status_dist,
                    windows: scoped_windows,
                    steps: &steps,
                    warmup_override: scope.map(|s| s.warmup_seconds),
                    no_sample: &NoSample {
                        run: no_sample_run,
                        steps: &no_sample_steps,
                    },
                    latency_rule: run.latency_rule,
                    overall_hist: overall_judging.hist(),
                    step_hists: &per_step_hists,
                },
            );
            if v.criteria.is_empty() { None } else { Some(v) }
        }
        _ => None,
    };
    let open = scope.and_then(|s| s.open_loop.as_ref().map(|o| (s, o)));
    let (insight_dropped, insight_target, insight_scheduled) = match open {
        Some((_, o)) => (
            o.dropped.unwrap_or(0),
            Some(o.target),
            Some(f64::from(o.target) * scoped_seconds.unwrap_or(0) as f64),
        ),
        None => (
            run.dropped as u64,
            run.profile.target_rps.or_else(|| {
                run.profile
                    .stages
                    .as_ref()
                    .and_then(|s| s.iter().map(|st| st.target).max())
            }),
            crate::insights::scheduled_arrivals(
                run.profile.target_rps,
                run.profile.stages.as_deref(),
                summary.duration_seconds as f64,
            ),
        ),
    };
    let mut insights = crate::insights::derive_insights(
        &summary,
        &steps,
        scoped_windows,
        &status_dist,
        verdict.as_ref(),
        scenario_yaml,
        insight_dropped,
        run.profile.max_in_flight,
        insight_target,
        insight_scheduled,
        &error_kinds_rolled,
        &no_sample_steps,
    );
    crate::insights::refine_saturation_stall(
        &mut insights,
        match (scope, open) {
            (_, Some((_, o))) => o.totals,
            (Some(_), None) => &[],
            (None, None) => open_loop_totals,
        },
        run.profile.max_in_flight,
    );
    if let (Some(first_scoped), Some(first_all)) = (scoped_windows.first(), occupancy.first()) {
        // 인사이트의 시점은 넘겨받은 창의 첫 초부터 센다 — 그림(run 전체)과 같은 축으로 옮긴다.
        let shift = first_scoped.ts_second - first_all.ts_second;
        if shift != 0 {
            for ins in insights.iter_mut() {
                ins.onset_second = ins.onset_second.map(|n| n + shift);
            }
        }
    }
    // 초 단위 계수가 없는 워커가 섞여 창 안 버림을 다시 셀 수 없으면 전체 구간의 포화 판정을 가져온다.
    if let Some((s, o)) = open
        && o.dropped.is_none()
    {
        crate::insights::adopt_whole_saturation(&mut insights, &s.whole.insights);
    }
    let report_dropped = match open {
        Some((s, o)) => o.dropped.unwrap_or(s.whole.dropped),
        None => run.dropped as u64,
    };

    // Group (page-load) latency: a SEPARATE accumulator keyed by (parallel node id, branch).
    // branch="" = the page (whole parallel block), else the branch name.
    // Deliberately NOT merged into `overall`/`total_count`/`per_step`/`windows` —
    // a page load is the max of children already counted there, so folding it in would
    // double-count latency and inflate rps (spec §2.1).
    let mut group_acc: BTreeMap<(String, String), (Histogram<u64>, u64)> = BTreeMap::new();
    for g in groups {
        let e = group_acc
            .entry((g.step_id.clone(), g.branch.clone()))
            .or_insert_with(|| (fresh_hist(), 0));
        if let Ok(Some(h)) = decode_hdr(&g.hdr_histogram) {
            merge_into(&mut e.0, &h); // fail-soft: bad blob -> count kept, distribution skips it
        }
        e.1 += g.count as u64;
    }
    // Branch rows (branch != "") nest under their parallel node's page (branch == "").
    // BTreeMap orders "" before any branch name within each step_id, so branches sort
    // by name. A bad branch HDR blob keeps the count but skips the distribution (same
    // fail-soft as the page). Branch rows without a page row are silently dropped —
    // unreachable today because the engine records page+branches under one clean-block
    // gate (both emitted or neither).
    let mut branches_by_step: BTreeMap<String, Vec<BranchLatency>> = BTreeMap::new();
    for ((step_id, branch), (h, count)) in &group_acc {
        if branch.is_empty() {
            continue;
        }
        let p = percentiles_of(h);
        branches_by_step
            .entry(step_id.clone())
            .or_default()
            .push(BranchLatency {
                branch: branch.clone(),
                count: *count,
                p50_ms: p.p50_ms,
                p95_ms: p.p95_ms,
                p99_ms: p.p99_ms,
                max_ms: h.max() / 1_000,
            });
    }
    let group_latency: Vec<GroupLatency> = group_acc
        .iter()
        .filter(|((_, branch), _)| branch.is_empty())
        .map(|((step_id, _), (h, count))| {
            let p = percentiles_of(h);
            GroupLatency {
                step_id: step_id.clone(),
                count: *count,
                p50_ms: p.p50_ms,
                p95_ms: p.p95_ms,
                p99_ms: p.p99_ms,
                max_ms: h.max() / 1_000,
                branches: branches_by_step.remove(step_id).unwrap_or_default(),
            }
        })
        .collect();

    // Active-VU gauge: independent per-second series. NOT merged into summary/windows/
    // overall/rps (group_latency/download-phase와 동형 — 독립 게이지).
    let active_vu_series: Vec<ActiveVuSample> = active_vu
        .iter()
        .map(|r| ActiveVuSample {
            ts_second: r.ts_second,
            desired: r.desired as u32,
            actual: r.actual as u32,
        })
        .collect();

    // Per-worker active-VU series. Curve fan-out only (caller passes &[] for non-curve);
    // populate ONLY when ≥2 distinct non-empty workers so single-worker stays byte-identical.
    // BTreeMap key = worker_id => deterministic sorted output (ordinal labels in UI).
    let worker_vu: Vec<WorkerActiveVuSeries> = {
        let mut by: BTreeMap<String, Vec<ActiveVuSample>> = BTreeMap::new();
        for r in active_vu_by_worker {
            if r.worker_id.is_empty() {
                continue; // defensive — query already excludes '' legacy rows.
            }
            by.entry(r.worker_id.clone())
                .or_default()
                .push(ActiveVuSample {
                    ts_second: r.ts_second,
                    desired: r.desired as u32,
                    actual: r.actual as u32,
                });
        }
        if by.len() >= 2 {
            by.into_iter()
                .map(|(worker_id, samples)| WorkerActiveVuSeries { worker_id, samples })
                .collect()
        } else {
            Vec::new()
        }
    };

    // BTreeMap -> worker_id ascending (UI renders ordinal labels in this order).
    let worker_breakdown: Vec<WorkerBreakdown> = worker_acc
        .into_iter()
        .map(|(worker_id, w)| {
            let resolved = w.hist.resolve(selected);
            let hist = resolved.hist();
            let p = hist.map(percentiles_of).unwrap_or_else(Percentiles::empty);
            WorkerBreakdown {
                worker_id,
                count: w.count,
                errors: w.errors,
                p50_ms: p.p50_ms,
                p95_ms: p.p95_ms,
                p99_ms: p.p99_ms,
                stats: hist.and_then(latency_stats),
            }
        })
        .collect();

    // Soft validity + narrative (A11): any status — no new terminal gate. Always recompute.
    let has_active = run.profile.criteria.as_ref().is_some_and(|c| c.has_any());
    // 계단 집계는 validity보다 먼저: dropped가 전부 무너진 계단에서 났으면 load_not_delivered를 빼야 한다(§5.7).
    let stair = crate::stair::build_stair_report(
        &run.profile,
        run.dropped.max(0) as u64,
        rows,
        stair_inputs,
    );
    let validity = crate::validity::derive_validity(
        &summary,
        &status_dist,
        scenario_yaml,
        has_active,
        &insights,
        stair.as_ref().is_some_and(|s| s.dropped_explained),
        run.status_rule,
        &steps,
        setup,
    );
    let narrative = crate::validity::derive_narrative(&validity, &summary, has_active, &insights);

    ReportJson {
        run: ReportRun {
            id: run.id.clone(),
            scenario_id: run.scenario_id.clone(),
            status: run.status.as_str().to_string(),
            profile: profile_val,
            env: env_val,
            started_at: run.started_at,
            ended_at: run.ended_at,
            created_at: run.created_at,
            label: run.label.clone(),
            status_rule: run.status_rule,
            latency_rule: run.latency_rule,
        },
        scenario_yaml: scenario_yaml.to_string(),
        summary: shown_summary.unwrap_or(summary),
        windows,
        steps: shown_steps.unwrap_or(steps),
        status_distribution: status_dist,
        if_breakdown,
        error_kinds: error_kinds_rolled,
        loop_exits: loop_exits_rolled,
        verdict,
        insights,
        dropped: report_dropped,
        latency,
        group_latency,
        active_vu_series,
        active_vu_by_worker: worker_vu,
        worker_breakdown,
        connection,
        validity,
        narrative,
        stair,
        speed_bands,
        basis: None,
        setup: setup.cloned(),
        sample: crate::sample::SampleBlock {
            selected,
            default: default_sample,
            split,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::runs::{Criteria, Criterion, Profile, RunStatus};
    use hdrhistogram::serialization::{Serializer, V2Serializer};

    fn make_hdr_bytes(samples_us: &[u64]) -> Vec<u8> {
        let mut h = fresh_hist();
        for &v in samples_us {
            h.record(v).unwrap();
        }
        let mut buf = Vec::new();
        V2Serializer::new().serialize(&h, &mut buf).unwrap();
        buf
    }

    fn run_row() -> RunRow {
        RunRow {
            id: "R1".into(),
            scenario_id: "S1".into(),
            scenario_yaml: "version: 1\nname: x\nsteps: []\n".into(),
            profile: Profile {
                vus: 1,
                ramp_up_seconds: 0,
                duration_seconds: 2,
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
            },
            env: serde_json::Value::Object(serde_json::Map::new()),
            status: RunStatus::Completed,
            // ms wall-clock — a 2-second run (now_ms semantics from store/runs.rs).
            started_at: Some(100_000),
            ended_at: Some(102_000),
            created_at: 99_000,
            message: None,
            dropped: 0,
            verdict: None,
            label: None,
            auto_stop: None,
            status_rule: crate::store::runs::STATUS_RULE_LEGACY,
            latency_rule: crate::store::runs::LATENCY_RULE_LEGACY,
        }
    }

    fn win(
        ts: i64,
        step: &str,
        count: i64,
        errors: i64,
        sc: &str,
        samples: &[u64],
    ) -> WindowWithHdr {
        WindowWithHdr {
            failed_hdr_histogram: None,
            ts_second: ts,
            step_id: step.into(),
            worker_id: "w-0".into(),
            count,
            error_count: errors,
            status_counts: sc.into(),
            hdr_histogram: make_hdr_bytes(samples),
        }
    }

    /// 전체 구간 리포트 골든 입력: 스텝 2·워커 2·초 100..=119, open-loop 프로필, 모든 보조 입력이 비어 있지 않다.
    struct GoldenInputs {
        run: RunRow,
        rows: Vec<WindowWithHdr>,
        loops: Vec<LoopMetricRow>,
        branches: Vec<IfBranchRow>,
        groups: Vec<GroupMetricRow>,
        phases: Vec<PhaseMetricRow>,
        error_kinds: Vec<crate::store::metrics::ErrorKindRow>,
        loop_exits: Vec<crate::store::metrics::LoopExitRow>,
        open_loop_totals: Vec<crate::store::open_loop::OpenLoopTotal>,
    }

    fn golden_inputs() -> GoldenInputs {
        let mut run = run_row();
        run.profile.target_rps = Some(10);
        run.profile.max_in_flight = Some(5);
        run.profile.criteria = Some(Criteria {
            max_p95_ms: Some(100),
            ..Criteria::default()
        });
        run.started_at = Some(100_000);
        run.ended_at = Some(120_000);
        run.dropped = 30;
        let mut rows = Vec::new();
        for ts in 100..=119i64 {
            for (step, base_us) in [("a", 20_000u64), ("b", 60_000u64)] {
                for (wid, n) in [("w-0", 3i64), ("w-1", 2i64)] {
                    let late = ts >= 110;
                    let errors = if late && wid == "w-1" { 1 } else { 0 };
                    let sc = if errors == 1 {
                        format!(r#"{{"200":{},"500":1}}"#, n - 1)
                    } else {
                        format!(r#"{{"200":{n}}}"#)
                    };
                    let lat = base_us + (ts as u64 - 100) * 1_000;
                    let samples: Vec<u64> = (0..n as u64).map(|i| lat + i * 5_000).collect();
                    rows.push(WindowWithHdr {
                        failed_hdr_histogram: None,
                        ts_second: ts,
                        step_id: step.into(),
                        worker_id: wid.into(),
                        count: n,
                        error_count: errors,
                        status_counts: sc,
                        hdr_histogram: make_hdr_bytes(&samples),
                    });
                }
            }
        }
        let loops = vec![
            LoopMetricRow {
                run_id: "R1".into(),
                step_id: "a".into(),
                loop_index: 0,
                count: 40,
                error_count: 2,
            },
            LoopMetricRow {
                run_id: "R1".into(),
                step_id: "a".into(),
                loop_index: 1,
                count: 30,
                error_count: 1,
            },
        ];
        let branches = vec![
            IfBranchRow {
                run_id: "R1".into(),
                step_id: "if1".into(),
                branch: "then".into(),
                count: 60,
            },
            IfBranchRow {
                run_id: "R1".into(),
                step_id: "if1".into(),
                branch: "else".into(),
                count: 20,
            },
        ];
        let groups = vec![
            GroupMetricRow {
                run_id: "R1".into(),
                step_id: "par".into(),
                branch: "".into(),
                hdr_histogram: make_hdr_bytes(&[30_000, 40_000, 50_000]),
                count: 3,
            },
            GroupMetricRow {
                run_id: "R1".into(),
                step_id: "par".into(),
                branch: "left".into(),
                hdr_histogram: make_hdr_bytes(&[20_000, 25_000, 30_000]),
                count: 3,
            },
        ];
        let phase = |step: &str, name: &str, samples: &[u64]| PhaseMetricRow {
            run_id: "R1".into(),
            step_id: step.into(),
            phase: name.into(),
            hdr_histogram: make_hdr_bytes(samples),
            count: samples.len() as i64,
        };
        let phases = vec![
            phase("a", "download", &[3_000, 4_000, 5_000]),
            phase("a", "wait", &[15_000, 16_000]),
            phase("b", "wait", &[50_000]),
            phase("a", "connect", &[2_000, 3_000]),
            phase("a", "dns", &[1_000]),
        ];
        let error_kinds = vec![
            crate::store::metrics::ErrorKindRow {
                run_id: "R1".into(),
                step_id: "a".into(),
                kind: "connect_refused".into(),
                count: 4,
            },
            crate::store::metrics::ErrorKindRow {
                run_id: "R1".into(),
                step_id: "b".into(),
                kind: "blank_var".into(),
                count: 2,
            },
        ];
        let loop_exits = vec![crate::store::metrics::LoopExitRow {
            run_id: "R1".into(),
            step_id: "lp".into(),
            pass_bucket: 2,
            outcome: 0,
            count: 5,
            pass_sum: 10,
        }];
        let open_loop_totals = (100..=119i64)
            .map(|ts| crate::store::open_loop::OpenLoopTotal {
                ts_second: ts,
                launched: 10,
                completed: 9,
                dropped: if ts < 110 { 3 } else { 0 },
            })
            .collect();
        GoldenInputs {
            run,
            rows,
            loops,
            branches,
            groups,
            phases,
            error_kinds,
            loop_exits,
            open_loop_totals,
        }
    }

    #[test]
    fn whole_report_matches_golden() {
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../testdata/report_whole_golden.json"
        );
        let g = golden_inputs();
        let rep = build_report(
            &g.run,
            &g.run.scenario_yaml,
            &g.rows,
            &g.loops,
            &g.branches,
            &g.groups,
            &g.phases,
            &[],
            &[],
            &g.error_kinds,
            &g.loop_exits,
            &crate::stair::StairInputs::default(),
            &g.open_loop_totals,
            None,
            None,
            None,
        );
        let got = serde_json::to_string_pretty(&rep).unwrap();
        if std::env::var_os("REPORT_WHOLE_GOLDEN_UPDATE").is_some() {
            std::fs::write(path, format!("{got}\n")).unwrap();
        }
        let want = std::fs::read_to_string(path).unwrap();
        assert_eq!(
            got,
            want.trim_end(),
            "전체 구간 리포트가 steady 도입 전과 같아야 한다"
        );
    }

    // ---- steady(유지 구간) 범위 계산 ----

    fn steady_row(
        ts: i64,
        step: &str,
        worker: &str,
        n: i64,
        err: i64,
        sc: &str,
        lat_us: u64,
    ) -> WindowWithHdr {
        WindowWithHdr {
            failed_hdr_histogram: None,
            ts_second: ts,
            step_id: step.into(),
            worker_id: worker.into(),
            count: n,
            error_count: err,
            status_counts: sc.into(),
            hdr_histogram: make_hdr_bytes(&vec![lat_us; n as usize]),
        }
    }

    /// 초 100..=109 상승(2건·500ms·오류 1), 110..=129 유지(10건·20ms).
    fn rows_ramp_then_steady() -> Vec<WindowWithHdr> {
        let mut v = Vec::new();
        for ts in 100..=109 {
            v.push(steady_row(
                ts,
                "a",
                "w",
                2,
                1,
                r#"{"500":1,"200":1}"#,
                500_000,
            ));
        }
        for ts in 110..=129 {
            v.push(steady_row(ts, "a", "w", 10, 0, r#"{"200":10}"#, 20_000));
        }
        v
    }

    /// 초 100..=109 초당 100건·20ms, 110..=129 초당 1건·500ms.
    fn rows_fast_ramp_slow_steady() -> Vec<WindowWithHdr> {
        let mut v = Vec::new();
        for ts in 100..=109 {
            v.push(steady_row(ts, "a", "w", 100, 0, r#"{"200":100}"#, 20_000));
        }
        for ts in 110..=129 {
            v.push(steady_row(ts, "a", "w", 1, 0, r#"{"200":1}"#, 500_000));
        }
        v
    }

    fn steady_run(end_s: i64) -> RunRow {
        let mut r = run_row();
        r.started_at = Some(100_000);
        r.ended_at = Some(end_s * 1_000);
        r
    }

    #[allow(clippy::too_many_arguments)]
    fn build_steady(
        run: &RunRow,
        rows: &[WindowWithHdr],
        loops: &[LoopMetricRow],
        phases: &[PhaseMetricRow],
        error_kinds: &[crate::store::metrics::ErrorKindRow],
        scope: Option<&SteadyScope<'_>>,
    ) -> ReportJson {
        build_report(
            run,
            &run.scenario_yaml,
            rows,
            loops,
            &[],
            &[],
            phases,
            &[],
            &[],
            error_kinds,
            &[],
            &crate::stair::StairInputs::default(),
            &[],
            None,
            scope,
            None,
        )
    }

    fn build_whole(run: &RunRow, rows: &[WindowWithHdr]) -> ReportJson {
        build_steady(run, rows, &[], &[], &[], None)
    }

    fn closed_scope(whole: &ReportJson, lo: i64, hi: i64, warmup_seconds: u32) -> SteadyScope<'_> {
        SteadyScope {
            lo,
            hi,
            warmup_seconds,
            open_loop: None,
            whole,
        }
    }

    fn with_criteria(mut run: RunRow, c: Criteria) -> RunRow {
        run.profile.criteria = Some(c);
        run
    }

    const YAML_A_ANY: &str = "version: 1\nname: t\nsteps:\n  - type: http\n    id: a\n    name: a\n    request: { method: GET, url: \"http://x/\" }\n    assert:\n      - status: any\n";

    #[test]
    fn rule2_no_assert_no_criteria_has_no_no_response_validation() {
        // 규칙 1 짝(build_report_attaches_validity_unchecked_limited)은 사유가 있다 — 규칙 2는 없다.
        let mut run = run_row();
        run.status_rule = crate::store::runs::STATUS_RULE_CURRENT;
        let rows = vec![win(100, "step_a", 10, 0, r#"{"200":10}"#, &[10_000; 10])];
        let rep = build_report(
            &run,
            YAML_NO_ASSERT,
            &rows,
            &[],
            &[],
            &[],
            &[],
            &[],
            &[],
            &[],
            &[],
            &crate::stair::StairInputs::default(),
            &[],
            None,
            None,
            None,
        );
        assert!(
            !rep.validity
                .reasons
                .iter()
                .any(|r| r.kind == "no_response_validation")
        );
    }

    #[test]
    fn rule2_unchecked_errors_use_scoped_steps_not_whole() {
        let mut run = steady_run(130);
        run.status_rule = crate::store::runs::STATUS_RULE_CURRENT;
        run.scenario_yaml = YAML_A_ANY.into();
        let rows = rows_ramp_then_steady();
        let whole = build_whole(&run, &rows);
        let whole_r = whole
            .validity
            .reasons
            .iter()
            .find(|r| r.kind == "status_unchecked_errors")
            .expect("전체 구간엔 램프의 500이 보인다");
        assert_eq!(whole_r.count, Some(10));
        let sc = closed_scope(&whole, 110, 130, 0);
        let rep = build_steady(&run, &rows, &[], &[], &[], Some(&sc));
        assert!(
            !rep.validity
                .reasons
                .iter()
                .any(|r| r.kind == "status_unchecked_errors"),
            "유지 구간(110..130)엔 오류 응답이 없다"
        );
    }

    #[test]
    fn steady_summary_uses_window_only() {
        let run = steady_run(130);
        let rows = rows_ramp_then_steady();
        let whole = build_whole(&run, &rows);
        let sc = closed_scope(&whole, 110, 130, 0);
        let rep = build_steady(&run, &rows, &[], &[], &[], Some(&sc));
        assert_eq!(rep.summary.count, 200);
        assert_eq!(rep.summary.duration_seconds, 20);
        assert_eq!(rep.summary.rps, 10.0);
        assert_eq!(rep.summary.errors, 0);
        assert_eq!(rep.summary.p95_ms, 20);
        assert_eq!(whole.summary.count, 220);
        assert_eq!(whole.summary.errors, 10);
        assert!(whole.summary.p95_ms >= 100);
    }

    #[test]
    fn steady_steps_and_status_use_window_only() {
        let run = steady_run(130);
        let rows = rows_ramp_then_steady();
        let whole = build_whole(&run, &rows);
        let sc = closed_scope(&whole, 110, 130, 0);
        let rep = build_steady(&run, &rows, &[], &[], &[], Some(&sc));
        assert_eq!(rep.steps[0].count, 200);
        assert_eq!(rep.steps[0].error_count, 0);
        let want: BTreeMap<String, u64> = [("200".to_string(), 200u64)].into();
        assert_eq!(rep.steps[0].status_counts, want);
        assert_eq!(rep.status_distribution, want);
        assert!(rep.latency.is_some());
        assert!(rep.speed_bands.is_some());
    }

    #[test]
    fn steady_windows_keep_whole_run() {
        let run = steady_run(130);
        let rows = rows_ramp_then_steady();
        let whole = build_whole(&run, &rows);
        let sc = closed_scope(&whole, 110, 130, 0);
        let rep = build_steady(&run, &rows, &[], &[], &[], Some(&sc));
        assert_eq!(rep.windows.len(), 30);
    }

    #[test]
    fn steady_verdict_follows_window() {
        let c = Criteria {
            max_p95_ms: Some(100),
            ..Criteria::default()
        };
        let run = with_criteria(steady_run(130), c.clone());
        let rows = rows_ramp_then_steady();
        let whole = build_whole(&run, &rows);
        let sc = closed_scope(&whole, 110, 130, 0);
        let rep = build_steady(&run, &rows, &[], &[], &[], Some(&sc));
        assert!(rep.verdict.as_ref().unwrap().passed);
        assert!(!whole.verdict.as_ref().unwrap().passed);

        let rows = rows_fast_ramp_slow_steady();
        let whole = build_whole(&run, &rows);
        let sc = closed_scope(&whole, 110, 130, 0);
        let rep = build_steady(&run, &rows, &[], &[], &[], Some(&sc));
        assert!(!rep.verdict.as_ref().unwrap().passed);
        assert!(whole.verdict.as_ref().unwrap().passed);
    }

    #[test]
    fn steady_step_criterion_follows_window() {
        let c = Criteria {
            step_criteria: vec![Criterion {
                metric: "error_rate".into(),
                op: "max".into(),
                threshold: 0.01,
                target: "a".into(),
            }],
            ..Criteria::default()
        };
        let run = with_criteria(steady_run(130), c);
        let rows = rows_ramp_then_steady();
        let whole = build_whole(&run, &rows);
        let sc = closed_scope(&whole, 110, 130, 0);
        let rep = build_steady(&run, &rows, &[], &[], &[], Some(&sc));
        assert!(rep.verdict.as_ref().unwrap().passed);
        assert!(!whole.verdict.as_ref().unwrap().passed);
    }

    #[test]
    fn warmup_equal_to_ramp_removes_nothing_extra() {
        let c = Criteria {
            min_window_rps: Some(5.0),
            rps_warmup_seconds: Some(30),
            ..Criteria::default()
        };
        let run = with_criteria(steady_run(150), c);
        let mut rows = Vec::new();
        for ts in 100..=129 {
            rows.push(steady_row(ts, "a", "w", 1, 0, r#"{"200":1}"#, 20_000));
        }
        for ts in 130..=149 {
            rows.push(steady_row(ts, "a", "w", 10, 0, r#"{"200":10}"#, 20_000));
        }
        let whole = build_whole(&run, &rows);
        let sc = closed_scope(&whole, 130, 150, 0);
        let rep = build_steady(&run, &rows, &[], &[], &[], Some(&sc));
        let row = rep
            .verdict
            .as_ref()
            .unwrap()
            .criteria
            .iter()
            .find(|r| r.metric == "min_window_rps")
            .expect("min_window_rps 행이 있어야 한다");
        assert_eq!(row.actual, 10.0);
    }

    #[test]
    fn warmup_larger_than_ramp_removes_the_difference() {
        let c = Criteria {
            min_window_rps: Some(5.0),
            ..Criteria::default()
        };
        let run = with_criteria(steady_run(130), c);
        let mut rows = Vec::new();
        for ts in 100..=109 {
            rows.push(steady_row(ts, "a", "w", 1, 0, r#"{"200":1}"#, 20_000));
        }
        for ts in 110..=113 {
            rows.push(steady_row(ts, "a", "w", 1, 0, r#"{"200":1}"#, 20_000));
        }
        for ts in 114..=129 {
            rows.push(steady_row(ts, "a", "w", 10, 0, r#"{"200":10}"#, 20_000));
        }
        let whole = build_whole(&run, &rows);
        let actual = |warmup: u32| {
            let sc = closed_scope(&whole, 110, 130, warmup);
            let rep = build_steady(&run, &rows, &[], &[], &[], Some(&sc));
            rep.verdict
                .unwrap()
                .criteria
                .iter()
                .find(|r| r.metric == "min_window_rps")
                .unwrap()
                .actual
        };
        assert_eq!(actual(4), 10.0);
        assert_eq!(actual(0), 1.0);
    }

    fn insight_of<'a>(rep: &'a ReportJson, kind: &str) -> Option<&'a crate::insights::Insight> {
        rep.insights.iter().find(|i| i.kind == kind)
    }

    #[test]
    fn steady_insights_do_not_read_the_ramp_boundary_as_onset() {
        let run = steady_run(135);
        let mut rows = Vec::new();
        for ts in 100..=114 {
            rows.push(steady_row(ts, "a", "w", 10, 0, r#"{"200":10}"#, 20_000));
        }
        for ts in 115..=134 {
            rows.push(steady_row(
                ts,
                "a",
                "w",
                10,
                5,
                r#"{"500":5,"200":5}"#,
                20_000,
            ));
        }
        let whole = build_whole(&run, &rows);
        let on = insight_of(&whole, "midrun_error_onset").expect("전체 리포트는 onset을 낸다");
        assert_eq!(on.onset_second, Some(15));
        let sc = closed_scope(&whole, 115, 135, 0);
        let rep = build_steady(&run, &rows, &[], &[], &[], Some(&sc));
        assert!(insight_of(&rep, "midrun_error_onset").is_none());
    }

    #[test]
    fn steady_onset_second_counts_from_run_start() {
        let run = steady_run(140);
        let mk = |skip: &[i64]| {
            let mut rows = Vec::new();
            for ts in 100..=124 {
                if skip.contains(&ts) {
                    continue;
                }
                rows.push(steady_row(ts, "a", "w", 10, 0, r#"{"200":10}"#, 20_000));
            }
            for ts in 125..=139 {
                rows.push(steady_row(
                    ts,
                    "a",
                    "w",
                    10,
                    5,
                    r#"{"500":5,"200":5}"#,
                    20_000,
                ));
            }
            rows
        };
        for skip in [&[][..], &[110, 111][..]] {
            let rows = mk(skip);
            let whole = build_whole(&run, &rows);
            let sc = closed_scope(&whole, 110, 140, 0);
            let rep = build_steady(&run, &rows, &[], &[], &[], Some(&sc));
            let on = insight_of(&rep, "midrun_error_onset").expect("창 안 onset");
            assert_eq!(on.onset_second, Some(25), "skip={skip:?}");
        }
    }

    fn open_totals(lo: i64, hi: i64) -> Vec<crate::store::open_loop::OpenLoopTotal> {
        (lo..hi)
            .map(|ts| crate::store::open_loop::OpenLoopTotal {
                ts_second: ts,
                launched: 10,
                completed: 10,
                dropped: 0,
            })
            .collect()
    }

    fn open_run() -> RunRow {
        let mut run = steady_run(130);
        run.profile.target_rps = Some(10);
        run.profile.max_in_flight = Some(5);
        run.dropped = 50;
        run
    }

    #[test]
    fn steady_open_loop_recounts_dropped() {
        let run = open_run();
        let rows = rows_ramp_then_steady();
        let whole = build_whole(&run, &rows);
        assert!(insight_of(&whole, "load_gen_saturated").is_some());
        let totals = open_totals(110, 130);
        let sc = SteadyScope {
            lo: 110,
            hi: 130,
            warmup_seconds: 0,
            open_loop: Some(ScopedOpenLoop {
                target: 10,
                dropped: Some(0),
                totals: &totals,
            }),
            whole: &whole,
        };
        let rep = build_steady(&run, &rows, &[], &[], &[], Some(&sc));
        assert_eq!(rep.dropped, 0);
        assert!(insight_of(&rep, "load_gen_saturated").is_none());
    }

    #[test]
    fn steady_open_loop_scheduled_uses_target_times_window() {
        use handicap_engine::Stage;
        let mut run = open_run();
        run.profile.target_rps = None;
        run.profile.stages = Some(vec![
            Stage {
                target: 10,
                duration_seconds: 10,
            },
            Stage {
                target: 10,
                duration_seconds: 20,
            },
        ]);
        let rows = rows_ramp_then_steady();
        let whole = build_whole(&run, &rows);
        let totals = open_totals(110, 130);
        let sc = SteadyScope {
            lo: 110,
            hi: 130,
            warmup_seconds: 0,
            open_loop: Some(ScopedOpenLoop {
                target: 10,
                dropped: Some(100),
                totals: &totals,
            }),
            whole: &whole,
        };
        let rep = build_steady(&run, &rows, &[], &[], &[], Some(&sc));
        let sat = insight_of(&rep, "load_gen_saturated").expect("창 안 포화");
        // 예정 200 (= 10 × 20초), 버림 100 → 달성 5/s → 필요 슬롯 ceil(10 × 5 ÷ 5) = 10
        assert_eq!(sat.achieved_per_sec, Some(5.0));
        assert_eq!(sat.recommended, Some(10.0));
    }

    #[test]
    fn steady_open_loop_dropped_whole_run_adopts_whole() {
        let run = open_run();
        let rows = rows_ramp_then_steady();
        let whole = build_whole(&run, &rows);
        let sat = insight_of(&whole, "load_gen_saturated").expect("전체 리포트의 포화");
        let sc = SteadyScope {
            lo: 110,
            hi: 130,
            warmup_seconds: 0,
            open_loop: Some(ScopedOpenLoop {
                target: 10,
                dropped: None,
                totals: &[],
            }),
            whole: &whole,
        };
        let rep = build_steady(&run, &rows, &[], &[], &[], Some(&sc));
        assert_eq!(rep.dropped, 50);
        assert_eq!(insight_of(&rep, "load_gen_saturated"), Some(sat));
        let reasons = |r: &ReportJson| serde_json::to_value(&r.validity.reasons).unwrap();
        assert!(
            rep.validity
                .reasons
                .iter()
                .any(|r| r.kind == "load_not_delivered")
        );
        assert_eq!(reasons(&rep), reasons(&whole));
    }

    fn connect_phase(n: usize) -> PhaseMetricRow {
        PhaseMetricRow {
            run_id: "R1".into(),
            step_id: "a".into(),
            phase: "connect".into(),
            hdr_histogram: make_hdr_bytes(&vec![2_000; n]),
            count: n as i64,
        }
    }

    #[test]
    fn steady_connection_is_copied_from_whole() {
        let run = steady_run(130);
        let rows = rows_ramp_then_steady();
        let phases = [connect_phase(5)];
        let whole = build_steady(&run, &rows, &[], &phases, &[], None);
        let sc = closed_scope(&whole, 110, 130, 0);
        let rep = build_steady(&run, &rows, &[], &phases, &[], Some(&sc));
        assert!(whole.connection.is_some());
        assert_eq!(rep.connection, whole.connection);
        assert!(rep.connection.as_ref().unwrap().reuse_ratio >= 0.0);
    }

    #[test]
    fn steady_unsplittable_step_fields_match_whole() {
        let run = steady_run(130);
        let rows = rows_ramp_then_steady();
        let loops = [LoopMetricRow {
            run_id: "R1".into(),
            step_id: "a".into(),
            loop_index: 0,
            count: 7,
            error_count: 1,
        }];
        let phases = [PhaseMetricRow {
            run_id: "R1".into(),
            step_id: "a".into(),
            phase: "download".into(),
            hdr_histogram: make_hdr_bytes(&[3_000, 4_000]),
            count: 2,
        }];
        let kinds = [crate::store::metrics::ErrorKindRow {
            run_id: "R1".into(),
            step_id: "a".into(),
            kind: "blank_var".into(),
            count: 3,
        }];
        let whole = build_steady(&run, &rows, &loops, &phases, &kinds, None);
        let sc = closed_scope(&whole, 110, 130, 0);
        let rep = build_steady(&run, &rows, &loops, &phases, &kinds, Some(&sc));
        let j = |r: &ReportJson| serde_json::to_value(&r.steps[0]).unwrap();
        let (a, b) = (j(&rep), j(&whole));
        assert!(!a["loop_breakdown"].as_array().unwrap().is_empty());
        for k in ["loop_breakdown", "download"] {
            assert!(!a[k].is_null(), "{k}");
            assert_eq!(a[k], b[k], "{k}");
        }
    }

    /// 초 100..=109는 초당 10건 중 `ramp_200`건 응답, 110..=129는 초당 10건 중 `window_200`건 응답.
    /// 응답 없는 건(보내지 않음)은 건수·오류에만 들어간다.
    fn rows_not_sent(ramp_200: i64, window_200: i64) -> Vec<WindowWithHdr> {
        let mut v = Vec::new();
        for ts in 100..=109 {
            let sc = format!(r#"{{"200":{ramp_200}}}"#);
            v.push(steady_row(ts, "a", "w", 10, 10 - ramp_200, &sc, 20_000));
        }
        for ts in 110..=129 {
            let sc = format!(r#"{{"200":{window_200}}}"#);
            v.push(steady_row(ts, "a", "w", 10, 10 - window_200, &sc, 20_000));
        }
        v
    }

    fn blank_var(count: i64) -> [crate::store::metrics::ErrorKindRow; 1] {
        [crate::store::metrics::ErrorKindRow {
            run_id: "R1".into(),
            step_id: "a".into(),
            kind: "blank_var".into(),
            count,
        }]
    }

    #[test]
    fn steady_not_sent_counts_window_only() {
        let run = steady_run(130);
        let rows = rows_not_sent(4, 9);
        let kinds = blank_var(80);
        let whole = build_steady(&run, &rows, &[], &[], &kinds, None);
        let sc = closed_scope(&whole, 110, 130, 0);
        let rep = build_steady(&run, &rows, &[], &[], &kinds, Some(&sc));
        assert_eq!(rep.steps[0].count, 200);
        assert_eq!(rep.steps[0].not_sent, Some(20));
        assert_eq!(whole.steps[0].not_sent, Some(80));
    }

    #[test]
    fn steady_not_sent_absent_when_window_has_none() {
        let run = steady_run(130);
        let rows = rows_not_sent(4, 10);
        let kinds = blank_var(60);
        let whole = build_steady(&run, &rows, &[], &[], &kinds, None);
        let sc = closed_scope(&whole, 110, 130, 0);
        let rep = build_steady(&run, &rows, &[], &[], &kinds, Some(&sc));
        assert_eq!(rep.steps[0].not_sent, None);
        assert_eq!(whole.steps[0].not_sent, Some(60));
        let j = serde_json::to_value(&rep.steps[0]).unwrap();
        assert!(!j.as_object().unwrap().contains_key("not_sent"));
    }

    #[test]
    fn steady_multi_worker_breakdown_uses_window() {
        let run = steady_run(130);
        let mut rows = Vec::new();
        for w in ["w1", "w2"] {
            for ts in 100..=109 {
                rows.push(steady_row(ts, "a", w, 1, 0, r#"{"200":1}"#, 500_000));
            }
            for ts in 110..=129 {
                rows.push(steady_row(ts, "a", w, 5, 0, r#"{"200":5}"#, 20_000));
            }
        }
        let whole = build_whole(&run, &rows);
        let sc = closed_scope(&whole, 110, 130, 0);
        let rep = build_steady(&run, &rows, &[], &[], &[], Some(&sc));
        assert_eq!(rep.worker_breakdown.len(), 2);
        assert_eq!(
            rep.worker_breakdown.iter().map(|w| w.count).sum::<u64>(),
            200
        );
    }

    #[test]
    fn build_report_merges_worker_windows() {
        let r = run_row();
        // Same (ts_second=100, step_id="s"), two workers, distinct latency samples.
        // A3a keep-first would drop one row -> undercount + half the histogram.
        let rows = vec![
            WindowWithHdr {
                failed_hdr_histogram: None,
                ts_second: 100,
                step_id: "s".into(),
                worker_id: "w-a".into(),
                count: 3,
                error_count: 0,
                status_counts: r#"{"200":3}"#.into(),
                hdr_histogram: make_hdr_bytes(&[10_000, 10_000, 10_000]),
            },
            WindowWithHdr {
                failed_hdr_histogram: None,
                ts_second: 100,
                step_id: "s".into(),
                worker_id: "w-b".into(),
                count: 5,
                error_count: 1,
                status_counts: r#"{"200":4,"500":1}"#.into(),
                hdr_histogram: make_hdr_bytes(&[40_000, 40_000, 40_000, 40_000, 40_000]),
            },
        ];
        let yaml = r.scenario_yaml.clone();
        let rep = build_report(
            &r,
            &yaml,
            &rows,
            &[],
            &[],
            &[],
            &[],
            &[],
            &[],
            &[],
            &[],
            &crate::stair::StairInputs::default(),
            &[],
            None,
            None,
            None,
        );

        // One collapsed window per (ts_second, step_id), counts summed.
        assert_eq!(rep.windows.len(), 1, "worker rows collapse to one window");
        assert_eq!(rep.windows[0].count, 8);
        assert_eq!(rep.windows[0].error_count, 1);
        assert_eq!(rep.windows[0].status_counts.get("200").copied(), Some(7));
        assert_eq!(rep.windows[0].status_counts.get("500").copied(), Some(1));
        // Window percentiles come from the MERGED histogram (both workers' samples):
        // p99 must reflect the 40ms tail, not just w-a's 10ms.
        // NOTE: of the 8 merged samples [10,10,10,40,40,40,40,40]ms, FIVE are 40ms, so
        // p50 is ALSO 40 here (the 4th sample). Do not assert p50==10 — only the tail
        // (p99) distinguishes "merged" from "w-a only". Under A3a keep-first, w-b's row
        // is dropped -> count 3, p99 10 -> this test goes RED. That is the gate.
        assert_eq!(
            rep.windows[0].p99_ms, 40,
            "merged HDR keeps both workers' tail"
        );

        // Totals + overall percentiles also reflect both workers.
        assert_eq!(rep.summary.count, 8);
        assert_eq!(rep.summary.errors, 1);
        assert_eq!(rep.summary.p99_ms, 40);
        // Step-level rollup sums both workers too.
        let s = rep.steps.iter().find(|s| s.step_id == "s").unwrap();
        assert_eq!(s.count, 8);

        // typed round-trip.
        let v = serde_json::to_value(&rep).unwrap();
        let _back: ReportJson = serde_json::from_value(v).unwrap();
    }

    #[test]
    fn build_report_aggregates_totals() {
        let r = run_row();
        let rows = vec![
            win(
                100,
                "stepA",
                10,
                1,
                r#"{"200":9,"500":1}"#,
                &[10_000, 20_000],
            ),
            win(101, "stepA", 5, 0, r#"{"200":5}"#, &[15_000]),
            win(101, "stepB", 3, 1, r#"{"200":2,"500":1}"#, &[25_000]),
        ];
        let yaml = r.scenario_yaml.clone();
        let rpt = build_report(
            &r,
            &yaml,
            &rows,
            &[],
            &[],
            &[],
            &[],
            &[],
            &[],
            &[],
            &[],
            &crate::stair::StairInputs::default(),
            &[],
            None,
            None,
            None,
        );
        assert_eq!(rpt.summary.count, 18);
        assert_eq!(rpt.summary.errors, 2);
        assert_eq!(rpt.summary.duration_seconds, 2);
        assert!(rpt.summary.rps > 8.9 && rpt.summary.rps < 9.1);
        assert_eq!(rpt.windows.len(), 3);
        assert_eq!(rpt.steps.len(), 2);
        assert_eq!(rpt.status_distribution.get("200").copied(), Some(16));
        assert_eq!(rpt.status_distribution.get("500").copied(), Some(2));
        assert!(rpt.summary.p95_ms > 0);
    }

    const SETUP_YAML: &str = "version: 1
name: s
setup:
  steps:
    - type: http
      id: 01HX0000000000000000000A01
      name: login
      request: { method: POST, url: \"http://x/login\" }
    - type: http
      id: 01HX0000000000000000000A02
      name: profile
      request: { method: GET, url: \"http://x/me\" }
steps:
  - type: http
    id: 01HX0000000000000000000B01
    name: main
    request: { method: GET, url: \"http://x/\" }
";

    fn sec_step(
        worker: &str,
        step: &str,
        count: i64,
        errors: i64,
        status: &str,
        kinds: &str,
        samples_us: &[u64],
    ) -> crate::store::section::SectionStepRow {
        crate::store::section::SectionStepRow {
            run_id: "R1".into(),
            worker_id: worker.into(),
            section: "setup".into(),
            step_id: step.into(),
            count,
            error_count: errors,
            status_counts: status.into(),
            failure_kinds: kinds.into(),
            hdr_histogram: make_hdr_bytes(samples_us),
        }
    }

    fn sec_outcome(
        worker: &str,
        ok: i64,
        failed: i64,
        interrupted: i64,
    ) -> crate::store::section::SectionOutcomeRow {
        crate::store::section::SectionOutcomeRow {
            run_id: "R1".into(),
            worker_id: worker.into(),
            section: "setup".into(),
            ok,
            failed,
            interrupted,
            last_done_ms: 0,
        }
    }

    #[test]
    fn setup_report_none_without_setup() {
        let yaml = "version: 1\nname: s\nsteps:\n  - type: http\n    id: 01HX0000000000000000000B01\n    name: m\n    request: { method: GET, url: \"http://x/\" }\n";
        assert!(setup_report_of(yaml, &[], &[]).is_none());
        let rep = build_whole(&run_row(), &[]);
        let v = serde_json::to_value(&rep).unwrap();
        assert!(!v.as_object().unwrap().contains_key("setup"));
    }

    #[test]
    fn setup_report_merges_rows() {
        let a = "01HX0000000000000000000A01";
        let steps = [
            sec_step(
                "w1",
                a,
                3,
                1,
                r#"{"200":2,"401":1}"#,
                r#"{"status_assert":1}"#,
                &[10_000, 10_000, 10_000],
            ),
            sec_step(
                "w2",
                a,
                2,
                1,
                r#"{"200":1,"401":1}"#,
                r#"{"status_assert":1,"read_body":1}"#,
                &[40_000, 90_000],
            ),
        ];
        let outcomes = [
            sec_outcome("w1", 2, 1, 0),
            sec_outcome("w2", 1, 0, 1),
            sec_outcome("w2", 3, 1, 2),
        ];
        let r = setup_report_of(SETUP_YAML, &steps, &outcomes).unwrap();
        assert_eq!((r.ok, r.failed, r.interrupted), (6, 2, 3));
        let s = &r.steps[0];
        assert_eq!(s.step_id, a);
        assert_eq!((s.count, s.errors), (5, 2));
        assert_eq!(s.status_counts["200"], 3);
        assert_eq!(s.status_counts["401"], 2);
        assert_eq!(s.failure_kinds["status_assert"], 2);
        assert_eq!(s.failure_kinds["read_body"], 1);
        let mut h = fresh_hist();
        for v in [10_000u64, 10_000, 10_000, 40_000, 90_000] {
            h.record(v).unwrap();
        }
        let p = percentiles_of(&h);
        assert_eq!((s.p50_ms, s.p95_ms), (p.p50_ms, p.p95_ms));
        assert_eq!(s.p50_ms, 10);
        assert_eq!(s.max_ms, h.max() / 1_000);
        assert_eq!(s.max_ms, 90);
    }

    #[test]
    fn setup_report_order_follows_scenario() {
        let steps = [
            sec_step(
                "w1",
                "01HX0000000000000000000A02",
                1,
                0,
                "{}",
                "{}",
                &[1_000],
            ),
            sec_step(
                "w1",
                "01HX0000000000000000000A01",
                1,
                0,
                "{}",
                "{}",
                &[1_000],
            ),
        ];
        let r = setup_report_of(SETUP_YAML, &steps, &[]).unwrap();
        let ids: Vec<&str> = r.steps.iter().map(|s| s.step_id.as_str()).collect();
        assert_eq!(
            ids,
            ["01HX0000000000000000000A01", "01HX0000000000000000000A02"]
        );
    }

    #[test]
    fn setup_report_zero_row_for_step_without_stats() {
        let steps = [sec_step(
            "w1",
            "01HX0000000000000000000A01",
            4,
            0,
            "{}",
            "{}",
            &[2_000],
        )];
        let r = setup_report_of(SETUP_YAML, &steps, &[]).unwrap();
        assert_eq!((r.ok, r.failed, r.interrupted), (0, 0, 0));
        assert_eq!(r.steps.len(), 2);
        let z = &r.steps[1];
        assert_eq!(z.step_id, "01HX0000000000000000000A02");
        assert_eq!(
            (z.count, z.errors, z.p50_ms, z.p95_ms, z.max_ms),
            (0, 0, 0, 0, 0)
        );
        assert!(z.status_counts.is_empty() && z.failure_kinds.is_empty());
    }

    #[test]
    fn setup_report_none_on_bad_yaml() {
        assert!(setup_report_of("{{{ not yaml", &[], &[]).is_none());
    }

    #[test]
    fn setup_report_tolerates_bad_hdr_blob() {
        let mut bad = sec_step("w1", "01HX0000000000000000000A01", 2, 0, "{}", "{}", &[]);
        bad.hdr_histogram = vec![0xff, 0xff, 0xff, 0xff];
        let r = setup_report_of(SETUP_YAML, &[bad], &[]).unwrap();
        assert_eq!(r.steps[0].count, 2);
        assert_eq!(r.steps[0].p50_ms, 0);
    }

    #[test]
    fn setup_report_ignores_other_sections() {
        let a = "01HX0000000000000000000A01";
        let mut other_step = sec_step("w1", a, 7, 7, "{}", "{}", &[5_000]);
        other_step.section = "teardown".into();
        let mut other_outcome = sec_outcome("w1", 9, 9, 9);
        other_outcome.section = "teardown".into();
        let own_step = sec_step("w1", a, 1, 0, "{}", "{}", &[1_000]);
        let own_outcome = sec_outcome("w1", 2, 1, 0);
        let r = setup_report_of(
            SETUP_YAML,
            &[other_step, own_step],
            &[other_outcome, own_outcome],
        )
        .unwrap();
        assert_eq!((r.ok, r.failed, r.interrupted), (2, 1, 0));
        assert_eq!((r.steps[0].count, r.steps[0].errors), (1, 0));
    }

    fn setup_report_of(
        yaml: &str,
        steps: &[crate::store::section::SectionStepRow],
        outcomes: &[crate::store::section::SectionOutcomeRow],
    ) -> Option<SetupReport> {
        let sc = handicap_engine::Scenario::from_yaml(yaml).ok()?;
        build_setup_report(sc.setup_steps(), steps, outcomes)
    }

    #[test]
    fn build_report_tolerates_bad_hdr_blob() {
        let r = run_row();
        let bad = WindowWithHdr {
            failed_hdr_histogram: None,
            ts_second: 100,
            step_id: "stepA".into(),
            worker_id: "w-0".into(),
            count: 5,
            error_count: 0,
            status_counts: r#"{"200":5}"#.into(),
            hdr_histogram: vec![0xff, 0xff, 0xff, 0xff],
        };
        let yaml = r.scenario_yaml.clone();
        let rpt = build_report(
            &r,
            &yaml,
            &[bad],
            &[],
            &[],
            &[],
            &[],
            &[],
            &[],
            &[],
            &[],
            &crate::stair::StairInputs::default(),
            &[],
            None,
            None,
            None,
        );
        assert_eq!(rpt.summary.count, 5);
        assert_eq!(rpt.status_distribution.get("200").copied(), Some(5));
        assert_eq!(rpt.windows[0].p95_ms, 0);
        assert_eq!(rpt.summary.p95_ms, 0);
    }

    fn report_for_duration(r: &RunRow, rows: &[WindowWithHdr]) -> ReportJson {
        let yaml = r.scenario_yaml.clone();
        build_report(
            r,
            &yaml,
            rows,
            &[],
            &[],
            &[],
            &[],
            &[],
            &[],
            &[],
            &[],
            &crate::stair::StairInputs::default(),
            &[],
            None,
            None,
            None,
        )
    }

    #[test]
    fn duration_no_start_no_windows_is_zero() {
        let mut r = run_row();
        r.started_at = None;
        let rpt = report_for_duration(&r, &[]);
        assert_eq!(rpt.summary.duration_seconds, 0);
        assert_eq!(rpt.summary.rps, 0.0);
    }

    #[test]
    fn duration_no_start_uses_window_span() {
        let mut r = run_row();
        r.started_at = None;
        let rows = vec![
            win(102, "s", 100, 0, r#"{"200":100}"#, &[10_000]),
            win(100, "s", 100, 0, r#"{"200":100}"#, &[10_000]),
            win(101, "s", 100, 0, r#"{"200":100}"#, &[10_000]),
        ];
        let rpt = report_for_duration(&r, &rows);
        assert_eq!(rpt.summary.duration_seconds, 3);
        assert!((rpt.summary.rps - 100.0).abs() < 1e-9);
    }

    #[test]
    fn duration_single_window_is_one_second() {
        let mut r = run_row();
        r.started_at = None;
        let rows = vec![win(100, "s", 50, 0, r#"{"200":50}"#, &[10_000])];
        let rpt = report_for_duration(&r, &rows);
        assert_eq!(rpt.summary.duration_seconds, 1);
        assert!((rpt.summary.rps - 50.0).abs() < 1e-9);
    }

    #[test]
    fn duration_end_before_start_is_zero() {
        let mut r = run_row();
        r.started_at = Some(102_000);
        r.ended_at = Some(100_000);
        let rows = vec![win(100, "s", 50, 0, r#"{"200":50}"#, &[10_000])];
        let rpt = report_for_duration(&r, &rows);
        assert_eq!(rpt.summary.duration_seconds, 0);
        assert_eq!(rpt.summary.rps, 0.0);
    }

    #[test]
    fn duration_no_start_extreme_span_does_not_overflow() {
        let mut r = run_row();
        r.started_at = None;
        let rows = vec![
            win(i64::MIN + 1, "s", 1, 0, r#"{"200":1}"#, &[10_000]),
            win(i64::MAX - 1, "s", 1, 0, r#"{"200":1}"#, &[10_000]),
        ];
        let rpt = report_for_duration(&r, &rows);
        assert!(rpt.summary.duration_seconds >= 0);
    }

    #[test]
    fn duration_running_run_is_zero_not_negative() {
        let mut r = run_row();
        r.ended_at = None;
        let rows = vec![win(100, "s", 50, 0, r#"{"200":50}"#, &[10_000])];
        let rpt = report_for_duration(&r, &rows);
        assert_eq!(rpt.summary.duration_seconds, 0);
        assert_eq!(rpt.summary.rps, 0.0);
    }

    #[test]
    fn build_report_attaches_loop_breakdown() {
        use crate::store::metrics::LoopMetricRow;
        let r = run_row();
        let rows = vec![win(
            100,
            "s",
            6,
            0,
            r#"{"200":6}"#,
            &[10_000, 20_000, 15_000],
        )];
        let loops = vec![
            LoopMetricRow {
                run_id: "r".into(),
                step_id: "s".into(),
                loop_index: 0,
                count: 3,
                error_count: 0,
            },
            LoopMetricRow {
                run_id: "r".into(),
                step_id: "s".into(),
                loop_index: 1,
                count: 2,
                error_count: 0,
            },
            LoopMetricRow {
                run_id: "r".into(),
                step_id: "s".into(),
                loop_index: 4_294_967_295,
                count: 1,
                error_count: 0,
            },
        ];
        let yaml = r.scenario_yaml.clone();
        let rep = build_report(
            &r,
            &yaml,
            &rows,
            &loops,
            &[],
            &[],
            &[],
            &[],
            &[],
            &[],
            &[],
            &crate::stair::StairInputs::default(),
            &[],
            None,
            None,
            None,
        );
        let step = rep.steps.iter().find(|s| s.step_id == "s").unwrap();
        assert_eq!(step.loop_breakdown.len(), 3);
        assert_eq!(step.loop_breakdown[0].loop_index, Some(0));
        assert_eq!(step.loop_breakdown[1].loop_index, Some(1));
        assert_eq!(
            step.loop_breakdown[2].loop_index, None,
            "overflow bucket should map to None"
        );
        assert_eq!(step.loop_breakdown[2].count, 1);
        // typed round-trip: Serialize then Deserialize
        let v = serde_json::to_value(&rep).unwrap();
        let _back: ReportJson = serde_json::from_value(v).unwrap();
    }

    #[test]
    fn build_report_attaches_if_breakdown() {
        use crate::store::metrics::IfBranchRow;
        let r = run_row();
        let rows = vec![win(100, "s", 6, 0, r#"{"200":6}"#, &[10_000])];
        // `build_report` preserves input order (no re-sort — the UI's branchRank
        // re-sorts for display). The controller passes rows already `ORDER BY branch`
        // (TEXT), so simulate that here: "else" < "then" lexicographically.
        let branches = vec![
            IfBranchRow {
                run_id: "r".into(),
                step_id: "if1".into(),
                branch: "else".into(),
                count: 2,
            },
            IfBranchRow {
                run_id: "r".into(),
                step_id: "if1".into(),
                branch: "then".into(),
                count: 4,
            },
            IfBranchRow {
                run_id: "r".into(),
                step_id: "if2".into(),
                branch: "none".into(),
                count: 9,
            },
        ];
        let yaml = r.scenario_yaml.clone();
        let rep = build_report(
            &r,
            &yaml,
            &rows,
            &[],
            &branches,
            &[],
            &[],
            &[],
            &[],
            &[],
            &[],
            &crate::stair::StairInputs::default(),
            &[],
            None,
            None,
            None,
        );
        assert_eq!(rep.if_breakdown.len(), 2);
        let if1 = rep
            .if_breakdown
            .iter()
            .find(|b| b.step_id == "if1")
            .unwrap();
        // Order is preserved from the (SQL-sorted) input: "else" then "then".
        assert_eq!(if1.branches.len(), 2);
        assert_eq!(if1.branches[0].branch, "else");
        assert_eq!(if1.branches[0].count, 2);
        assert_eq!(if1.branches[1].branch, "then");
        let if2 = rep
            .if_breakdown
            .iter()
            .find(|b| b.step_id == "if2")
            .unwrap();
        assert_eq!(if2.branches[0].branch, "none");
        assert_eq!(if2.branches[0].count, 9);
        // typed round-trip (report types require Deserialize too).
        let v = serde_json::to_value(&rep).unwrap();
        let _back: ReportJson = serde_json::from_value(v).unwrap();
    }

    fn summary(count: u64, errors: u64, rps: f64, p95: u64, p99: u64) -> ReportSummary {
        ReportSummary {
            stats: None,
            count,
            errors,
            rps,
            duration_seconds: 1,
            mean_ms: 0,
            p50_ms: 0,
            p95_ms: p95,
            p99_ms: p99,
        }
    }

    fn rstep(id: &str, count: u64, errors: u64, p95: u64, status: &[(&str, u64)]) -> ReportStep {
        ReportStep {
            stats: None,
            step_id: id.into(),
            count,
            error_count: errors,
            status_counts: status.iter().map(|(k, v)| (k.to_string(), *v)).collect(),
            p50_ms: 0,
            p95_ms: p95,
            p99_ms: 0,
            loop_breakdown: vec![],
            download: None,
            wait: None,
            loop_split: None,
            not_sent: None,
        }
    }

    /// 규칙 1 판정(기존 테스트용) — 분포 없음.
    fn judge(
        c: &Criteria,
        s: &ReportSummary,
        dist: &BTreeMap<String, u64>,
        windows: &[ReportWindow],
        steps: &[ReportStep],
        warmup: Option<u32>,
        no_sample: &NoSample<'_>,
    ) -> Verdict {
        let hists = BTreeMap::new();
        evaluate_criteria(
            c,
            &JudgeInput {
                summary: s,
                status_dist: dist,
                windows,
                steps,
                warmup_override: warmup,
                no_sample,
                latency_rule: crate::store::runs::LATENCY_RULE_LEGACY,
                overall_hist: None,
                step_hists: &hists,
            },
        )
    }

    /// 규칙 2 판정 — 빈 상태 코드 분포·창 없음.
    fn judge2(
        c: &Criteria,
        s: &ReportSummary,
        steps: &[ReportStep],
        overall: Option<&Histogram<u64>>,
        step_hists: &BTreeMap<String, Histogram<u64>>,
    ) -> Verdict {
        evaluate_criteria(
            c,
            &JudgeInput {
                summary: s,
                status_dist: &BTreeMap::new(),
                windows: &[],
                steps,
                warmup_override: None,
                no_sample: &NoSample::none(),
                latency_rule: crate::store::runs::LATENCY_RULE_CURRENT,
                overall_hist: overall,
                step_hists,
            },
        )
    }

    fn hist_of(vals: &[u64]) -> Histogram<u64> {
        let mut h = fresh_hist();
        for &v in vals {
            h.record(v).unwrap();
        }
        h
    }

    fn step_crit(metric: &str, op: &str, threshold: f64, target: &str) -> Criterion {
        Criterion {
            metric: metric.into(),
            op: op.into(),
            threshold,
            target: target.into(),
        }
    }

    fn row<'a>(v: &'a Verdict, metric: &str, target: Option<&str>) -> &'a CriterionResult {
        v.criteria
            .iter()
            .find(|r| r.metric == metric && r.target.as_deref() == target)
            .unwrap_or_else(|| panic!("row {metric} {target:?}"))
    }

    #[test]
    fn rule2_exact_compare() {
        let h = hist_of(&[43_900]);
        assert_eq!(h.highest_equivalent(43_900), 43_903);
        let c = Criteria {
            max_p95_ms: Some(43),
            ..Default::default()
        };
        let s = summary(1, 0, 1.0, 43, 43);
        let v = judge2(&c, &s, &[], Some(&h), &BTreeMap::new());
        assert_eq!(v.criteria.len(), 1);
        assert!(!v.criteria[0].passed);
        assert_eq!(v.criteria[0].actual, 43.903);
        assert!(!v.passed);
        let v1 = judge(&c, &s, &BTreeMap::new(), &[], &[], None, &NoSample::none());
        assert!(v1.criteria[0].passed);
        assert_eq!(v1.criteria[0].actual, 43.0);
        // op min도 µs로: 스텝 p95 ≥ 43.903 통과, ≥ 43.904 실패.
        let steps = vec![rstep("A", 1, 0, 43, &[("200", 1)])];
        let hs: BTreeMap<String, Histogram<u64>> = [("A".to_string(), h.clone())].into();
        let c = Criteria {
            step_criteria: vec![
                step_crit("p95_ms", "min", 43.903, "A"),
                step_crit("p95_ms", "min", 43.904, "A"),
            ],
            ..Default::default()
        };
        let v = judge2(&c, &s, &steps, Some(&h), &hs);
        assert!(v.criteria[0].passed);
        assert!(!v.criteria[1].passed);
        assert_eq!(v.criteria[1].actual, 43.903);
    }

    #[test]
    fn rule2_sub_ms() {
        let h = hist_of(&[350]);
        let s = summary(1, 0, 1.0, 0, 0);
        for (t, pass) in [(0.5, true), (0.35, true), (0.3, false)] {
            let c = Criteria {
                max_mean_ms: Some(t),
                ..Default::default()
            };
            let v = judge2(&c, &s, &[], Some(&h), &BTreeMap::new());
            assert_eq!(v.criteria.len(), 1, "t={t}");
            assert_eq!(v.criteria[0].metric, "mean_ms");
            assert_eq!(v.criteria[0].actual, 0.35, "t={t}");
            assert_eq!(v.criteria[0].passed, pass, "t={t}");
        }
    }

    #[test]
    fn rule2_new_metrics() {
        use crate::latency_stats::{latency_stats, value_at_milli};
        let overall = hist_of(&(1..=1000).map(|i| i * 100).collect::<Vec<_>>());
        let step_a = hist_of(&(1..=200).map(|i| i * 1_000).collect::<Vec<_>>());
        let os = latency_stats(&overall).unwrap();
        let ss = latency_stats(&step_a).unwrap();
        let c = Criteria {
            max_mean_ms: Some(60_000.0),
            max_max_ms: Some(60_000.0),
            max_percentiles_ms: vec![
                crate::store::runs::PercentileLimit {
                    percentile: 90.0,
                    max_ms: 60_000.0,
                },
                crate::store::runs::PercentileLimit {
                    percentile: 99.9,
                    max_ms: 60_000.0,
                },
            ],
            step_criteria: vec![
                step_crit("mean_ms", "max", 60_000.0, "A"),
                step_crit("max_ms", "max", 60_000.0, "A"),
                step_crit("p90_ms", "max", 60_000.0, "A"),
                step_crit("p90_ms", "min", 150.0, "A"),
            ],
            ..Default::default()
        };
        let steps = vec![rstep("A", 200, 0, 0, &[("200", 200)])];
        let hs: BTreeMap<String, Histogram<u64>> = [("A".to_string(), step_a.clone())].into();
        let v = judge2(
            &c,
            &summary(1000, 0, 1.0, 0, 0),
            &steps,
            Some(&overall),
            &hs,
        );
        let ms = |us: u64| us as f64 / 1000.0;
        assert_eq!(row(&v, "mean_ms", None).actual, ms(os.mean_us));
        assert_eq!(row(&v, "max_ms", None).actual, ms(os.max_us));
        assert_eq!(row(&v, "p90_ms", None).actual, ms(os.p90_us));
        assert_eq!(
            row(&v, "p99.9_ms", None).actual,
            ms(value_at_milli(&overall, 99_900).unwrap())
        );
        assert_eq!(row(&v, "mean_ms", Some("A")).actual, ms(ss.mean_us));
        assert_eq!(row(&v, "max_ms", Some("A")).actual, ms(ss.max_us));
        let p90: Vec<&CriterionResult> = v
            .criteria
            .iter()
            .filter(|r| r.metric == "p90_ms" && r.target.as_deref() == Some("A"))
            .collect();
        assert_eq!(p90.len(), 2);
        assert!(p90.iter().all(|r| r.actual == ms(ss.p90_us)));
        assert_eq!(p90[1].direction, "min");
        assert!(p90[1].passed, "p90 {} ≥ 150", p90[1].actual);
        assert!(
            v.criteria
                .iter()
                .all(|r| r.passed && !r.no_sample && !r.capped)
        );
    }

    #[test]
    fn rule2_order() {
        let h = hist_of(&[1_000, 2_000, 3_000]);
        let steps = vec![rstep("A", 3, 0, 0, &[("200", 3)])];
        let hs: BTreeMap<String, Histogram<u64>> = [("A".to_string(), h.clone())].into();
        let c = Criteria {
            max_mean_ms: Some(100.0),
            max_p99_ms: Some(100),
            max_p50_ms: Some(100),
            max_percentiles_ms: vec![
                crate::store::runs::PercentileLimit {
                    percentile: 99.9,
                    max_ms: 100.0,
                },
                crate::store::runs::PercentileLimit {
                    percentile: 90.0,
                    max_ms: 100.0,
                },
            ],
            max_max_ms: Some(100.0),
            max_error_rate: Some(1.0),
            step_criteria: vec![step_crit("mean_ms", "max", 100.0, "A")],
            ..Default::default()
        };
        let s = summary(3, 0, 3.0, 2, 3);
        let v = judge2(&c, &s, &steps, Some(&h), &hs);
        let metrics: Vec<&str> = v.criteria.iter().map(|r| r.metric.as_str()).collect();
        assert_eq!(
            metrics,
            vec![
                "mean_ms",
                "p50_ms",
                "p90_ms",
                "p99_ms",
                "p99.9_ms",
                "max_ms",
                "error_rate",
                "mean_ms"
            ]
        );
        assert_eq!(v.criteria[7].target.as_deref(), Some("A"));
        let c = Criteria {
            max_p99_ms: Some(100),
            max_p50_ms: Some(100),
            max_p95_ms: Some(100),
            ..Default::default()
        };
        let v = judge2(&c, &s, &steps, Some(&h), &hs);
        let metrics: Vec<&str> = v.criteria.iter().map(|r| r.metric.as_str()).collect();
        assert_eq!(metrics, vec!["p50_ms", "p95_ms", "p99_ms"]);
    }

    #[test]
    fn rule2_capped() {
        let h = hist_of(&[1_000, 2_000, 60_000_000]);
        let steps = vec![rstep("A", 3, 0, 0, &[("200", 3)])];
        let hs: BTreeMap<String, Histogram<u64>> = [("A".to_string(), h.clone())].into();
        let c = Criteria {
            max_max_ms: Some(60_000.0),
            max_mean_ms: Some(60_000.0),
            max_p50_ms: Some(60_000),
            max_percentiles_ms: vec![crate::store::runs::PercentileLimit {
                percentile: 99.9,
                max_ms: 60_000.0,
            }],
            step_criteria: vec![
                step_crit("max_ms", "min", 1_000.0, "A"),
                step_crit("max_ms", "max", 60_000.0, "A"),
            ],
            ..Default::default()
        };
        let v = judge2(&c, &summary(3, 0, 3.0, 0, 0), &steps, Some(&h), &hs);
        let max = row(&v, "max_ms", None);
        assert!(max.capped && !max.passed);
        assert_eq!(max.actual, 60_000.0);
        let mean = row(&v, "mean_ms", None);
        assert!(mean.capped && !mean.passed);
        assert!(mean.actual < 60_000.0, "mean {}", mean.actual);
        let p999 = row(&v, "p99.9_ms", None);
        assert!(p999.capped && !p999.passed);
        assert_eq!(p999.actual, 60_000.0);
        let p50 = row(&v, "p50_ms", None);
        assert!(!p50.capped && p50.passed);
        let step_rows: Vec<&CriterionResult> = v
            .criteria
            .iter()
            .filter(|r| r.target.as_deref() == Some("A"))
            .collect();
        assert!(step_rows[0].capped && step_rows[0].passed); // op min: 하한 ≥ 기준
        assert!(step_rows[1].capped && !step_rows[1].passed); // op max: 기준과 상관없이 실패
        let json = serde_json::to_value(max).unwrap();
        assert_eq!(json["capped"], serde_json::Value::Bool(true));
        let json = serde_json::to_value(p50).unwrap();
        assert!(!json.as_object().unwrap().contains_key("capped"));
    }

    #[test]
    fn rule2_no_usable_hist() {
        let c = Criteria {
            max_p95_ms: Some(3000),
            max_mean_ms: Some(3000.0),
            max_max_ms: Some(3000.0),
            max_percentiles_ms: vec![crate::store::runs::PercentileLimit {
                percentile: 90.0,
                max_ms: 3000.0,
            }],
            max_error_rate: Some(1.0),
            step_criteria: vec![
                step_crit("p95_ms", "max", 3000.0, "A"),
                step_crit("mean_ms", "max", 3000.0, "A"),
                step_crit("p95_ms", "max", 3000.0, "Z"),
            ],
            ..Default::default()
        };
        let steps = vec![
            rstep("A", 5, 0, 0, &[("200", 5)]),
            rstep("Z", 0, 0, 0, &[]), // 실행 0회 → 건너뜀
        ];
        let empty = fresh_hist();
        for overall in [None, Some(&empty)] {
            let v = judge2(
                &c,
                &summary(5, 0, 5.0, 0, 0),
                &steps,
                overall,
                &BTreeMap::new(),
            );
            let time_rows: Vec<&CriterionResult> = v
                .criteria
                .iter()
                .filter(|r| r.metric != "error_rate")
                .collect();
            assert_eq!(time_rows.len(), 6, "{:?}", v.criteria);
            for r in &time_rows {
                assert!(r.no_sample && !r.passed, "{} {:?}", r.metric, r.target);
                assert_eq!(r.actual, 0.0);
            }
            assert!(row(&v, "error_rate", None).passed);
            assert!(!v.passed);
        }
        // 요청 0건 run: 시간 행 없음.
        let only_time = Criteria {
            max_p95_ms: Some(3000),
            max_mean_ms: Some(3000.0),
            ..Default::default()
        };
        let v = judge2(
            &only_time,
            &summary(0, 0, 0.0, 0, 0),
            &[],
            None,
            &BTreeMap::new(),
        );
        assert!(v.criteria.is_empty(), "{:?}", v.criteria);
    }

    #[test]
    fn rule1_defensive_new_items() {
        use crate::latency_stats::latency_stats;
        let h = hist_of(&[43_900, 60_000_000]);
        let c = Criteria {
            max_p95_ms: Some(60_000),
            max_mean_ms: Some(60_000.0),
            ..Default::default()
        };
        let s = summary(2, 0, 2.0, 43, 43);
        let hists = BTreeMap::new();
        let v = evaluate_criteria(
            &c,
            &JudgeInput {
                summary: &s,
                status_dist: &BTreeMap::new(),
                windows: &[],
                steps: &[],
                warmup_override: None,
                no_sample: &NoSample::none(),
                latency_rule: crate::store::runs::LATENCY_RULE_LEGACY,
                overall_hist: Some(&h),
                step_hists: &hists,
            },
        );
        let metrics: Vec<&str> = v.criteria.iter().map(|r| r.metric.as_str()).collect();
        assert_eq!(metrics, vec!["mean_ms", "p95_ms"]);
        let mean = &v.criteria[0];
        assert_eq!(
            mean.actual,
            latency_stats(&h).unwrap().mean_us as f64 / 1000.0
        );
        assert!(mean.capped && !mean.passed);
        let p95 = &v.criteria[1];
        assert_eq!(p95.actual, 43.0); // 규칙 1: 내린 정수
        assert!(p95.passed && !p95.capped);
    }

    fn rule2_split_rows() -> Vec<WindowWithHdr> {
        vec![
            step_win(
                100,
                "a",
                2,
                &[2_000, 2_000, 3_000, 40_000, 50_000],
                &[40_000, 50_000],
            ),
            step_win(101, "a", 0, &[1_500, 2_500, 2_500, 3_500, 4_500], &[]),
        ]
    }

    fn rule2_run() -> RunRow {
        let mut run = run_row();
        run.latency_rule = crate::store::runs::LATENCY_RULE_CURRENT;
        run.profile.criteria = Some(Criteria {
            max_mean_ms: Some(60_000.0),
            max_max_ms: Some(60_000.0),
            max_p50_ms: Some(60_000),
            max_p95_ms: Some(60_000),
            max_p99_ms: Some(60_000),
            max_percentiles_ms: vec![crate::store::runs::PercentileLimit {
                percentile: 90.0,
                max_ms: 60_000.0,
            }],
            step_criteria: ["mean_ms", "max_ms", "p50_ms", "p90_ms", "p95_ms", "p99_ms"]
                .iter()
                .map(|m| step_crit(m, "max", 60_000.0, "a"))
                .collect(),
            ..Default::default()
        });
        run
    }

    #[test]
    fn verdict_ignores_shown_sample() {
        use crate::sample::Sample;
        let run = rule2_run();
        let rows = rule2_split_rows();
        let base = report_with_run(&run, &rows, None);
        let v = base.verdict.clone().expect("verdict");
        for s in [Sample::All, Sample::Failed] {
            let rep = report_with_run(&run, &rows, Some(s));
            assert_ne!(
                rep.summary.stats, base.summary.stats,
                "{s:?} 표본이 달라야 의미가 있다"
            );
            assert_eq!(rep.verdict.as_ref(), Some(&v), "{s:?}");
        }
    }

    #[test]
    fn rule2_summary_stats_equal_actual() {
        let rep = report_with_run(&rule2_run(), &rule2_split_rows(), None);
        let v = rep.verdict.expect("verdict");
        let ms = |us: u64| us as f64 / 1000.0;
        let st = rep.summary.stats.expect("summary stats");
        for (metric, us) in [
            ("mean_ms", st.mean_us),
            ("max_ms", st.max_us),
            ("p50_ms", st.p50_us),
            ("p90_ms", st.p90_us),
            ("p95_ms", st.p95_us),
            ("p99_ms", st.p99_us),
        ] {
            assert_eq!(row(&v, metric, None).actual, ms(us), "{metric}");
        }
        let a = rep.steps.iter().find(|s| s.step_id == "a").unwrap();
        let st = a.stats.expect("step stats");
        for (metric, us) in [
            ("mean_ms", st.mean_us),
            ("max_ms", st.max_us),
            ("p50_ms", st.p50_us),
            ("p90_ms", st.p90_us),
            ("p95_ms", st.p95_us),
            ("p99_ms", st.p99_us),
        ] {
            assert_eq!(row(&v, metric, Some("a")).actual, ms(us), "step {metric}");
        }
    }

    #[test]
    fn step_criteria_pass_fail_skip_and_order() {
        let c = Criteria {
            max_p95_ms: Some(500), // fixed-field 1개(target=None, 먼저 나온다)
            step_criteria: vec![
                Criterion {
                    metric: "p95_ms".into(),
                    op: "max".into(),
                    threshold: 200.0,
                    target: "A".into(),
                }, // PASS(150<=200)
                Criterion {
                    metric: "error_rate".into(),
                    op: "max".into(),
                    threshold: 0.1,
                    target: "B".into(),
                }, // FAIL(0.5>0.1)
                Criterion {
                    metric: "p95_ms".into(),
                    op: "max".into(),
                    threshold: 50.0,
                    target: "MISSING".into(),
                }, // skip
            ],
            ..Default::default()
        };
        let steps = vec![
            rstep("A", 10, 0, 150, &[("200", 10)]),
            rstep("B", 10, 5, 9, &[("200", 5), ("500", 5)]),
        ];
        let v = judge(
            &c,
            &summary(20, 5, 20.0, 9, 150),
            &BTreeMap::new(),
            &[],
            &steps,
            None,
            &NoSample::none(),
        );
        // fixed-field p95(target None) 먼저, 그 뒤 step 행 입력 순서(A, B) — MISSING은 skip.
        assert_eq!(v.criteria.len(), 3);
        assert_eq!(v.criteria[0].target, None);
        assert_eq!(v.criteria[1].target.as_deref(), Some("A"));
        assert!(v.criteria[1].passed);
        assert_eq!(v.criteria[2].target.as_deref(), Some("B"));
        assert!(!v.criteria[2].passed);
        assert!(!v.passed); // B FAIL → 전체 FAIL
    }

    #[test]
    fn step_criteria_status_class_rate_denominator_excludes_transport_zero() {
        // 4xx_rate 분모 = http 응답(1..=5), transport "0" 제외 (run-level과 동일).
        let c = Criteria {
            step_criteria: vec![Criterion {
                metric: "4xx_rate".into(),
                op: "max".into(),
                threshold: 0.5,
                target: "A".into(),
            }],
            ..Default::default()
        };
        let steps = vec![rstep("A", 4, 0, 1, &[("404", 2), ("200", 2), ("0", 100)])];
        let v = judge(
            &c,
            &summary(4, 0, 4.0, 1, 1),
            &BTreeMap::new(),
            &[],
            &steps,
            None,
            &NoSample::none(),
        );
        assert_eq!(v.criteria.len(), 1);
        assert_eq!(v.criteria[0].actual, 0.5); // 2/(2+2), "0"=100 제외
        assert!(v.criteria[0].passed); // 0.5 <= 0.5
    }

    #[test]
    fn step_criteria_zero_count_step_is_skipped() {
        let c = Criteria {
            step_criteria: vec![Criterion {
                metric: "p95_ms".into(),
                op: "max".into(),
                threshold: 1.0,
                target: "A".into(),
            }],
            ..Default::default()
        };
        let steps = vec![rstep("A", 0, 0, 0, &[])]; // count==0 → 미실행 → skip
        let v = judge(
            &c,
            &summary(0, 0, 0.0, 0, 0),
            &BTreeMap::new(),
            &[],
            &steps,
            None,
            &NoSample::none(),
        );
        assert!(v.criteria.is_empty()); // 행 0개 → build_report가 verdict None으로
    }

    #[test]
    fn step_criteria_min_direction_pass_and_fail() {
        // op:"min" → actual >= threshold PASS, actual < threshold FAIL.
        // (min branch와 direction:"min" 출력 전파를 커버 — 기존 step 테스트는 전부 max.)
        let c = Criteria {
            step_criteria: vec![
                Criterion {
                    metric: "p95_ms".into(),
                    op: "min".into(),
                    threshold: 100.0,
                    target: "A".into(),
                }, // 150 >= 100 → PASS
                Criterion {
                    metric: "p95_ms".into(),
                    op: "min".into(),
                    threshold: 300.0,
                    target: "B".into(),
                }, // 150 < 300 → FAIL
            ],
            ..Default::default()
        };
        let steps = vec![
            rstep("A", 10, 0, 150, &[("200", 10)]),
            rstep("B", 10, 0, 150, &[("200", 10)]),
        ];
        let v = judge(
            &c,
            &summary(20, 0, 20.0, 150, 150),
            &BTreeMap::new(),
            &[],
            &steps,
            None,
            &NoSample::none(),
        );
        assert_eq!(v.criteria.len(), 2);
        // A: min PASS + direction/target 출력 전파
        assert_eq!(v.criteria[0].target.as_deref(), Some("A"));
        assert_eq!(v.criteria[0].direction, "min");
        assert_eq!(v.criteria[0].threshold, 100.0);
        assert!(v.criteria[0].passed); // 150 >= 100
        // B: min FAIL
        assert_eq!(v.criteria[1].target.as_deref(), Some("B"));
        assert_eq!(v.criteria[1].direction, "min");
        assert!(!v.criteria[1].passed); // 150 < 300
        assert!(!v.passed); // B FAIL → 전체 FAIL
    }

    #[test]
    fn evaluate_all_pass() {
        let c = Criteria {
            max_p95_ms: Some(500),
            max_error_rate: Some(0.05),
            min_rps: Some(100.0),
            ..Default::default()
        };
        let v = judge(
            &c,
            &summary(1000, 10, 200.0, 300, 400),
            &BTreeMap::new(),
            &[],
            &[],
            None,
            &NoSample::none(),
        );
        assert!(v.passed);
        assert_eq!(v.criteria.len(), 3);
    }

    #[test]
    fn evaluate_fails_when_one_breaches() {
        let c = Criteria {
            max_p95_ms: Some(200),
            ..Default::default()
        };
        let v = judge(
            &c,
            &summary(100, 0, 50.0, 300, 400),
            &BTreeMap::new(),
            &[],
            &[],
            None,
            &NoSample::none(),
        );
        assert!(!v.passed);
        assert_eq!(v.criteria[0].metric, "p95_ms");
        assert_eq!(v.criteria[0].direction, "max");
        assert!(!v.criteria[0].passed);
    }

    #[test]
    fn evaluate_error_rate_count_zero_is_zero() {
        let c = Criteria {
            max_error_rate: Some(0.0),
            ..Default::default()
        };
        // 0 errors / 0 count => 0.0 <= 0.0 → pass
        assert!(
            judge(
                &c,
                &summary(0, 0, 0.0, 0, 0),
                &BTreeMap::new(),
                &[],
                &[],
                None,
                &NoSample::none()
            )
            .passed
        );
    }

    #[test]
    fn evaluate_min_rps_zero_fails() {
        let c = Criteria {
            min_rps: Some(1.0),
            ..Default::default()
        };
        // rps 0.0 < 1.0 → fail (degenerate 0-throughput completed run)
        assert!(
            !judge(
                &c,
                &summary(0, 0, 0.0, 0, 0),
                &BTreeMap::new(),
                &[],
                &[],
                None,
                &NoSample::none()
            )
            .passed
        );
    }

    #[test]
    fn build_report_attaches_verdict_for_completed_with_criteria() {
        let mut run = run_row(); // status = Completed
        run.profile.criteria = Some(Criteria {
            max_p95_ms: Some(1000),
            ..Default::default()
        });
        let rep = build_report(
            &run,
            "",
            &[],
            &[],
            &[],
            &[],
            &[],
            &[],
            &[],
            &[],
            &[],
            &crate::stair::StairInputs::default(),
            &[],
            None,
            None,
            None,
        );
        let v = rep.verdict.expect("verdict present");
        assert_eq!(v.criteria.len(), 1);
        assert!(v.passed); // 빈 윈도 → p95 0 <= 1000
    }

    #[test]
    fn build_report_no_verdict_when_not_completed() {
        let mut run = run_row();
        run.status = RunStatus::Aborted;
        run.profile.criteria = Some(Criteria {
            max_p95_ms: Some(1000),
            ..Default::default()
        });
        assert!(
            build_report(
                &run,
                "",
                &[],
                &[],
                &[],
                &[],
                &[],
                &[],
                &[],
                &[],
                &[],
                &crate::stair::StairInputs::default(),
                &[],
                None,
                None,
                None,
            )
            .verdict
            .is_none()
        );
    }

    #[test]
    fn build_report_no_verdict_when_criteria_all_none() {
        let mut run = run_row();
        run.profile.criteria = Some(Criteria::default()); // 활성 0개
        assert!(
            build_report(
                &run,
                "",
                &[],
                &[],
                &[],
                &[],
                &[],
                &[],
                &[],
                &[],
                &[],
                &crate::stair::StairInputs::default(),
                &[],
                None,
                None,
                None,
            )
            .verdict
            .is_none()
        );
    }

    #[test]
    fn build_report_surfaces_dropped() {
        let mut run = run_row();
        run.dropped = 7;
        let rep = build_report(
            &run,
            "",
            &[],
            &[],
            &[],
            &[],
            &[],
            &[],
            &[],
            &[],
            &[],
            &crate::stair::StairInputs::default(),
            &[],
            None,
            None,
            None,
        );
        assert_eq!(
            rep.dropped, 7,
            "ReportJson.dropped must reflect RunRow.dropped"
        );
    }

    #[test]
    fn build_report_emits_speed_bands_and_keeps_rest() {
        let r = run_row();
        let rows = vec![win(
            100,
            "s",
            3,
            0,
            r#"{"200":3}"#,
            &[10_000, 20_000, 30_000],
        )];
        let yaml = r.scenario_yaml.clone();
        let rep = build_report(
            &r,
            &yaml,
            &rows,
            &[],
            &[],
            &[],
            &[],
            &[],
            &[],
            &[],
            &[],
            &crate::stair::StairInputs::default(),
            &[],
            None,
            None,
            None,
        );
        let v = serde_json::to_value(&rep).unwrap();
        let mut keys: Vec<&str> = v.as_object().unwrap().keys().map(|k| k.as_str()).collect();
        keys.sort();
        let sb = rep.speed_bands.as_ref().expect("speed_bands present");
        assert_eq!(sb.overall.basis, "default");
        assert_eq!(sb.overall.slow_ms, 3000);
        assert_eq!(sb.steps.len(), 1);
        assert!(keys.contains(&"speed_bands"));
        keys.retain(|k| *k != "speed_bands");
        assert_eq!(
            keys,
            [
                "active_vu_series",
                "dropped",
                "group_latency",
                "if_breakdown",
                "insights",
                "latency",
                "narrative",
                "run",
                "sample",
                "scenario_yaml",
                "status_distribution",
                "steps",
                "summary",
                "validity",
                "windows"
            ]
        );
    }

    fn split_win(ts: i64, all: &[u64], failed: Option<&[u64]>) -> WindowWithHdr {
        WindowWithHdr {
            failed_hdr_histogram: failed.map(make_hdr_bytes),
            ..win(ts, "s", all.len() as i64, 0, r#"{"200":5}"#, all)
        }
    }

    fn report_with(rows: &[WindowWithHdr], sample: Option<crate::sample::Sample>) -> ReportJson {
        report_with_run(&run_row(), rows, sample)
    }

    fn report_with_run(
        r: &RunRow,
        rows: &[WindowWithHdr],
        sample: Option<crate::sample::Sample>,
    ) -> ReportJson {
        let yaml = r.scenario_yaml.clone();
        build_report(
            r,
            &yaml,
            rows,
            &[],
            &[],
            &[],
            &[],
            &[],
            &[],
            &[],
            &[],
            &crate::stair::StairInputs::default(),
            &[],
            None,
            None,
            sample,
        )
    }

    fn p95_step_criterion(target: &str) -> Criterion {
        Criterion {
            metric: "p95_ms".into(),
            op: "max".into(),
            threshold: 3000.0,
            target: target.into(),
        }
    }

    #[test]
    fn run_latency_criterion_fails_when_nothing_passed() {
        let c = Criteria {
            max_p95_ms: Some(3000),
            ..Default::default()
        };
        let steps = BTreeSet::new();
        let ns = NoSample {
            run: true,
            steps: &steps,
        };
        let v = judge(
            &c,
            &summary(5, 5, 5.0, 0, 0),
            &BTreeMap::new(),
            &[],
            &[],
            None,
            &ns,
        );
        assert_eq!(v.criteria.len(), 1);
        assert!(!v.criteria[0].passed);
        assert!(v.criteria[0].no_sample);
        assert_eq!(v.criteria[0].actual, 0.0);
        assert!(!v.passed);
    }

    #[test]
    fn step_latency_criterion_fails_when_step_has_no_passed() {
        let c = Criteria {
            step_criteria: vec![p95_step_criterion("a"), p95_step_criterion("b")],
            ..Default::default()
        };
        let steps = vec![
            rstep("a", 5, 5, 0, &[("500", 5)]),
            rstep("b", 5, 0, 40, &[("200", 5)]),
        ];
        let set: BTreeSet<String> = ["a".to_string()].into();
        let ns = NoSample {
            run: false,
            steps: &set,
        };
        let v = judge(
            &c,
            &summary(10, 5, 10.0, 40, 40),
            &BTreeMap::new(),
            &[],
            &steps,
            None,
            &ns,
        );
        assert_eq!(v.criteria.len(), 2);
        assert!(v.criteria[0].no_sample && !v.criteria[0].passed);
        assert!(!v.criteria[1].no_sample && v.criteria[1].passed);
    }

    #[test]
    fn no_sample_flag_is_omitted_when_false() {
        let c = Criteria {
            max_p95_ms: Some(3000),
            ..Default::default()
        };
        let v = judge(
            &c,
            &summary(5, 0, 5.0, 40, 40),
            &BTreeMap::new(),
            &[],
            &[],
            None,
            &NoSample::none(),
        );
        let json = serde_json::to_value(&v.criteria[0]).unwrap();
        assert!(!json.as_object().unwrap().contains_key("no_sample"));
    }

    fn step_win(ts: i64, step: &str, errors: i64, all: &[u64], failed: &[u64]) -> WindowWithHdr {
        WindowWithHdr {
            step_id: step.into(),
            error_count: errors,
            count: 5,
            failed_hdr_histogram: Some(make_hdr_bytes(failed)),
            ..win(ts, step, 5, errors, r#"{"200":5}"#, all)
        }
    }

    fn verdict_run() -> RunRow {
        let mut run = run_row();
        run.profile.criteria = Some(Criteria {
            max_p95_ms: Some(3000),
            step_criteria: vec![
                p95_step_criterion("a"),
                p95_step_criterion("b"),
                p95_step_criterion("c"),
            ],
            ..Default::default()
        });
        run
    }

    fn criterion_row<'a>(v: &'a Verdict, target: Option<&str>) -> &'a CriterionResult {
        v.criteria
            .iter()
            .find(|r| r.target.as_deref() == target)
            .expect("criterion row")
    }

    #[test]
    fn build_report_marks_all_failed_and_all_not_sent() {
        let rows = vec![
            step_win(100, "a", 5, &[2_000; 5], &[2_000; 5]),
            step_win(100, "b", 5, &[], &[]),
            step_win(100, "c", 0, &[40_000; 5], &[]),
        ];
        let rep = report_with_run(&verdict_run(), &rows, None);
        let v = rep.verdict.expect("verdict");
        for id in ["a", "b"] {
            let r = criterion_row(&v, Some(id));
            assert!(r.no_sample && !r.passed, "step {id}");
            assert_eq!(r.actual, 0.0, "step {id}");
        }
        let c = criterion_row(&v, Some("c"));
        assert!(!c.no_sample && c.passed);
        let run_row = criterion_row(&v, None);
        assert!(!run_row.no_sample && run_row.passed);
        assert!(!v.passed);
    }

    #[test]
    fn broken_step_gets_no_no_sample() {
        // 실패한 요청(40ms)이 전체 분포(2ms)에 없다 — 합쳐서도 행마다도 빼기가 안 돼 `Broken`.
        let rows = vec![
            step_win(100, "a", 5, &[2_000; 5], &[40_000; 5]),
            step_win(100, "c", 0, &[40_000; 5], &[]),
        ];
        let rep = report_with_run(&verdict_run(), &rows, None);
        let v = rep.verdict.expect("verdict");
        let a = criterion_row(&v, Some("a"));
        assert!(!a.no_sample);
        assert_eq!(a.actual, 0.0);
        let json = serde_json::to_value(a).unwrap();
        assert!(!json.as_object().unwrap().contains_key("no_sample"));
    }

    #[test]
    fn build_report_every_request_failed_fails_run_latency_criterion() {
        let rows = vec![
            step_win(100, "a", 5, &[2_000; 5], &[2_000; 5]),
            step_win(100, "b", 5, &[], &[]),
        ];
        let mut run = run_row();
        run.profile.criteria = Some(Criteria {
            max_p95_ms: Some(3000),
            ..Default::default()
        });
        let rep = report_with_run(&run, &rows, None);
        let v = rep.verdict.expect("verdict");
        let r = criterion_row(&v, None);
        assert!(r.no_sample && !r.passed);
        assert_eq!(r.actual, 0.0);
        assert!(!v.passed);
    }

    #[test]
    fn non_split_all_failed_run_keeps_todays_verdict() {
        let rows = vec![WindowWithHdr {
            failed_hdr_histogram: None,
            ..step_win(100, "a", 5, &[2_000; 5], &[])
        }];
        let rep = report_with_run(&verdict_run(), &rows, None);
        assert!(!rep.sample.split);
        let v = rep.verdict.expect("verdict");
        let a = criterion_row(&v, Some("a"));
        assert!(!a.no_sample);
        assert_eq!(a.actual, 2.0);
        assert!(a.passed);
        assert!(!criterion_row(&v, None).no_sample);
    }

    #[test]
    fn passed_sample_is_default_for_split_run() {
        use crate::sample::{Sample, SampleBlock};
        let all = [40_000, 40_000, 2_000, 2_000, 2_000];
        let failed = [2_000, 2_000, 2_000];
        let rows = vec![
            split_win(100, &all, Some(&failed)),
            split_win(101, &all, Some(&failed)),
        ];
        let by_default = report_with(&rows, None);
        assert_eq!(
            by_default.sample,
            SampleBlock {
                selected: Sample::Passed,
                default: Sample::Passed,
                split: true
            }
        );
        assert_eq!(by_default.summary.p50_ms, 40);
        assert_eq!(by_default.summary.mean_ms, 40);
        assert_eq!(by_default.steps[0].p50_ms, 40);
        assert_eq!(by_default.windows.len(), 2);
        assert!(by_default.windows.iter().all(|w| w.p50_ms == 40));

        let all_req = report_with(&rows, Some(Sample::All));
        assert_eq!(all_req.sample.selected, Sample::All);
        assert_eq!(all_req.sample.default, Sample::Passed);
        assert_eq!(all_req.summary.p50_ms, 2);
        // 모든 요청: 40ms 4개 + 2ms 6개. 실패한 요청: 2ms 6개.
        assert_eq!(all_req.summary.mean_ms, 17);
        assert_eq!(all_req.summary.p99_ms, 40);
        let failed_req = report_with(&rows, Some(Sample::Failed));
        assert_eq!(failed_req.sample.selected, Sample::Failed);
        assert_eq!(failed_req.summary.p50_ms, 2);
        assert_eq!(failed_req.summary.mean_ms, 2);
        assert_eq!(failed_req.summary.p99_ms, 2);

        for r in [&all_req, &failed_req] {
            assert_eq!(r.summary.count, by_default.summary.count);
            assert_eq!(r.summary.errors, by_default.summary.errors);
            assert_eq!(r.summary.rps, by_default.summary.rps);
            assert_eq!(r.steps[0].count, by_default.steps[0].count);
            assert_eq!(r.steps[0].error_count, by_default.steps[0].error_count);
        }
    }

    #[test]
    fn non_split_run_is_unchanged_and_ignores_failed_column() {
        use crate::sample::{Sample, SampleBlock};
        let all = [40_000, 40_000, 2_000, 2_000, 2_000];
        let mixed = vec![
            split_win(100, &all, Some(&[2_000, 2_000, 2_000])),
            WindowWithHdr {
                failed_hdr_histogram: Some(vec![0xff, 0xff, 0xff, 0xff]),
                ..split_win(101, &all, None)
            },
            split_win(102, &all, None),
        ];
        let plain = vec![
            split_win(100, &all, None),
            split_win(101, &all, None),
            split_win(102, &all, None),
        ];
        let got = report_with(&mixed, None);
        assert_eq!(
            got.sample,
            SampleBlock {
                selected: Sample::All,
                default: Sample::All,
                split: false
            }
        );
        let want = serde_json::to_value(report_with(&plain, None)).unwrap();
        assert_eq!(serde_json::to_value(&got).unwrap(), want);
        for s in [Sample::Passed, Sample::Failed] {
            assert_eq!(
                serde_json::to_value(report_with(&mixed, Some(s))).unwrap(),
                want
            );
        }
    }

    #[test]
    fn worker_breakdown_follows_selected_sample() {
        use crate::sample::Sample;
        let on = |w: &str, all: &[u64], failed: &[u64]| WindowWithHdr {
            worker_id: w.into(),
            ..split_win(100, all, Some(failed))
        };
        let rows = vec![
            on("w-a", &[40_000, 40_000, 2_000, 2_000, 2_000], &[2_000; 3]),
            on("w-b", &[50_000, 50_000, 2_000, 2_000], &[2_000, 2_000]),
        ];
        let pick = |s: Option<Sample>| -> Vec<(u64, u64)> {
            let rep = report_with(&rows, s);
            assert_eq!(rep.worker_breakdown.len(), 2);
            rep.worker_breakdown
                .iter()
                .map(|w| (w.p50_ms, w.p95_ms))
                .collect()
        };
        assert_eq!(pick(None), [(40, 40), (50, 50)]);
        assert_eq!(pick(Some(Sample::All)), [(2, 40), (2, 50)]);
        assert_eq!(pick(Some(Sample::Failed)), [(2, 2), (2, 2)]);
    }

    #[test]
    fn stats_follow_sample() {
        use crate::sample::Sample;
        let all = [40_000, 40_000, 2_000, 2_000, 2_000];
        let failed = [2_000, 2_000, 2_000];
        let rows = vec![
            split_win(100, &all, Some(&failed)),
            split_win(101, &all, Some(&failed)),
        ];
        let h = fresh_hist();
        let (ms2, ms40) = (h.highest_equivalent(2_000), h.highest_equivalent(40_000));
        let by_default = report_with(&rows, None);
        assert_eq!(by_default.summary.stats.unwrap().p50_us, ms40);
        assert_eq!(by_default.steps[0].stats.unwrap().p50_us, ms40);
        let failed_req = report_with(&rows, Some(Sample::Failed));
        assert_eq!(failed_req.summary.stats.unwrap().p50_us, ms2);
        assert_eq!(failed_req.summary.stats.unwrap().max_us, ms2);
        assert_eq!(failed_req.steps[0].stats.unwrap().p50_us, ms2);
        assert_eq!(failed_req.steps[0].stats.unwrap().max_us, ms2);
        let all_req = report_with(&rows, Some(Sample::All));
        // 40ms 4개 + 2ms 6개 → p50은 2ms, 최대는 40ms
        assert_eq!(all_req.summary.stats.unwrap().p50_us, ms2);
        assert_eq!(all_req.summary.stats.unwrap().max_us, ms40);
        assert_eq!(all_req.steps[0].stats.unwrap().p50_us, ms2);
        assert_eq!(all_req.steps[0].stats.unwrap().max_us, ms40);
    }

    #[test]
    fn worker_stats_follow_sample() {
        use crate::sample::Sample;
        let on = |w: &str, all: &[u64], failed: &[u64]| WindowWithHdr {
            worker_id: w.into(),
            ..split_win(100, all, Some(failed))
        };
        let rows = vec![
            on("w-a", &[40_000, 40_000, 2_000, 2_000, 2_000], &[2_000; 3]),
            on("w-b", &[50_000, 50_000, 2_000, 2_000], &[2_000, 2_000]),
        ];
        let pick = |s: Option<Sample>| -> Vec<(u64, u64)> {
            let rep = report_with(&rows, s);
            assert_eq!(rep.worker_breakdown.len(), 2);
            rep.worker_breakdown
                .iter()
                .map(|w| {
                    let st = w.stats.expect("stats");
                    (st.p50_us / 1_000, st.p95_us / 1_000)
                })
                .collect()
        };
        assert_eq!(pick(None), [(40, 40), (50, 50)]);
        assert_eq!(pick(Some(Sample::All)), [(2, 40), (2, 50)]);
        assert_eq!(pick(Some(Sample::Failed)), [(2, 2), (2, 2)]);
    }

    #[test]
    fn stats_follow_basis() {
        let run = steady_run(130);
        let rows = rows_ramp_then_steady();
        let whole = build_whole(&run, &rows);
        let sc = closed_scope(&whole, 110, 130, 0);
        let steady = build_steady(&run, &rows, &[], &[], &[], Some(&sc));
        let w = whole.summary.stats.expect("whole stats");
        let s = steady.summary.stats.expect("steady stats");
        assert_ne!(w.mean_us, s.mean_us);
        let mut h = fresh_hist();
        for _ in 0..200 {
            h.record(20_000).unwrap();
        }
        assert_eq!(s, crate::latency_stats::latency_stats(&h).unwrap());
        assert!(w.max_us >= 400_000);
    }

    #[test]
    fn stats_absent_without_samples() {
        let rep = report_with(&[], None);
        assert!(rep.summary.stats.is_none());
        let v = serde_json::to_string(&rep.summary).unwrap();
        assert!(!v.contains("\"stats\""), "{v}");
        let rows = vec![win(100, "a", 3, 0, r#"{"200":3}"#, &[])];
        let rep = report_with(&rows, None);
        assert!(rep.steps[0].stats.is_none());
        let v = serde_json::to_string(&rep.steps[0]).unwrap();
        assert!(!v.contains("\"stats\""), "{v}");
    }

    /// 성능 비교용(단언 없음): 50스텝 × 600초 행의 `build_report` 10회 평균.
    #[test]
    #[ignore]
    fn bench_build_report_many_steps() {
        let mut rows = Vec::new();
        for ts in 100..700 {
            for s in 0..50 {
                let samples: Vec<u64> = (0..20)
                    .map(|i| 1_000 + (i * 997 + s * 31) % 90_000)
                    .collect();
                rows.push(WindowWithHdr {
                    failed_hdr_histogram: Some(make_hdr_bytes(&samples[..2])),
                    ..win(ts, &format!("s{s:02}"), 20, 0, r#"{"200":20}"#, &samples)
                });
            }
        }
        let run = run_row();
        report_with_run(&run, &rows, None);
        let t = std::time::Instant::now();
        for _ in 0..10 {
            report_with_run(&run, &rows, None);
        }
        eprintln!("BENCH build_report avg {:?}", t.elapsed() / 10);
    }

    #[test]
    fn inconsistent_row_keeps_clean_rows_passed_value() {
        // 둘째 행은 실패한 요청(2ms 3개)이 전체 분포에 없다 — 합쳐서도 빼기가 안 된다.
        let rows = vec![
            split_win(100, &[40_000, 40_000], Some(&[])),
            split_win(101, &[40_000, 40_000], Some(&[2_000, 2_000, 2_000])),
            split_win(102, &[40_000, 40_000], Some(&[])),
        ];
        let rep = report_with(&rows, None);
        assert!(rep.sample.split);
        assert_eq!(rep.summary.p50_ms, 40);
        assert_eq!(rep.summary.p99_ms, 40);
    }

    #[test]
    fn judging_values_ignore_requested_sample() {
        use crate::sample::Sample;
        let all = [40_000, 40_000, 2_000, 2_000, 2_000];
        let failed = [2_000, 2_000, 2_000];
        let rows = vec![
            split_win(100, &all, Some(&failed)),
            split_win(101, &all, Some(&failed)),
        ];
        let mut run = run_row();
        run.profile.criteria = Some(Criteria {
            max_p50_ms: Some(10),
            ..Criteria::default()
        });
        let by_default = report_with_run(&run, &rows, None);
        let all_req = report_with_run(&run, &rows, Some(Sample::All));
        let failed_req = report_with_run(&run, &rows, Some(Sample::Failed));

        // 보여 주는 값은 요청한 표본을 따른다.
        assert_eq!(by_default.summary.p50_ms, 40);
        assert_eq!(all_req.summary.p50_ms, 2);
        assert_eq!(failed_req.summary.p50_ms, 2);
        assert_eq!(all_req.steps[0].p50_ms, 2);

        // 판정·속도 구간·인사이트는 기본 표본(통과한 요청, p50 40 > 10 → 실패)으로 같다.
        let v = by_default.verdict.as_ref().expect("verdict");
        assert!(!v.passed, "p50 실측 40ms는 기준 10ms 초과");
        for r in [&all_req, &failed_req] {
            assert_eq!(
                serde_json::to_value(&r.verdict).unwrap(),
                serde_json::to_value(&by_default.verdict).unwrap()
            );
            assert_eq!(
                serde_json::to_value(&r.speed_bands).unwrap(),
                serde_json::to_value(&by_default.speed_bands).unwrap()
            );
            assert_eq!(
                serde_json::to_value(&r.insights).unwrap(),
                serde_json::to_value(&by_default.insights).unwrap()
            );
        }
    }

    #[test]
    fn slowest_step_insight_ignores_requested_sample() {
        use crate::sample::Sample;
        // 스텝 a: 통과한 요청 40ms 1개 + 실패 2ms 39개, 스텝 b: 평평한 15ms.
        // 통과한 요청 기준 p95는 a 40 / b 15(격차 25, 2.67배 → 발행),
        // 모든 요청·실패한 요청 기준 p95는 a 2 / b 15(→ 미발행).
        let mut all_a = vec![40_000];
        all_a.extend([2_000; 39]);
        let on = |step: &str, all: &[u64], failed: &[u64]| WindowWithHdr {
            step_id: step.into(),
            ..split_win(100, all, Some(failed))
        };
        let rows = vec![on("a", &all_a, &[2_000; 39]), on("b", &[15_000; 5], &[])];
        let by_default = report_with(&rows, None);
        let slow = by_default
            .insights
            .iter()
            .find(|i| i.kind == "slowest_step")
            .expect("통과한 요청 기준 느린 스텝 인사이트");
        assert_eq!(slow.step_id.as_deref(), Some("a"));
        assert_eq!(slow.value, Some(40.0));
        for s in [Sample::All, Sample::Failed] {
            let rep = report_with(&rows, Some(s));
            assert_eq!(
                serde_json::to_value(&rep.insights).unwrap(),
                serde_json::to_value(&by_default.insights).unwrap(),
                "sample={s:?}"
            );
        }
        // 보여 주는 스텝 p95는 요청한 표본을 따른다(판정과 다르다).
        assert_eq!(report_with(&rows, Some(Sample::All)).steps[0].p95_ms, 2);
    }

    #[test]
    fn occupancy_signal_uses_all_sample() {
        use crate::sample::Sample;
        // open-loop 포화(dropped > 0, 슬롯 충분): 뒤쪽 3분의 1의 초에 시간 초과(실패 30초)가 늘고
        // 통과한 요청의 p95는 평평하며 5xx는 없다.
        let mut run = run_row();
        run.profile.target_rps = Some(10);
        run.profile.max_in_flight = Some(5);
        run.dropped = 20;
        run.started_at = Some(100_000);
        run.ended_at = Some(112_000);
        let rows: Vec<WindowWithHdr> = (100..112)
            .map(|ts| {
                if ts < 108 {
                    split_win(ts, &[40_000, 40_000, 40_000, 40_000, 2_000], Some(&[2_000]))
                } else {
                    let mut all = vec![40_000; 4];
                    all.extend([30_000_000; 6]);
                    split_win(ts, &all, Some(&[30_000_000; 6]))
                }
            })
            .collect();
        for s in [
            None,
            Some(Sample::All),
            Some(Sample::Passed),
            Some(Sample::Failed),
        ] {
            let rep = report_with_run(&run, &rows, s);
            let sat = rep
                .insights
                .iter()
                .find(|i| i.kind == "load_gen_saturated")
                .expect("포화 인사이트");
            assert_eq!(sat.cause.as_deref(), Some("sut"), "sample={s:?}");
        }
    }

    #[test]
    fn broken_failed_blob_keeps_other_rows() {
        let rows = vec![
            WindowWithHdr {
                failed_hdr_histogram: Some(vec![0xff, 0xff, 0xff, 0xff]),
                ..split_win(100, &[2_000], None)
            },
            split_win(101, &[41_000], Some(&[])),
        ];
        let rep = report_with(&rows, None);
        assert!(rep.sample.split);
        assert_eq!(rep.summary.p50_ms, 41);
    }

    #[test]
    fn build_report_emits_latency_distribution() {
        let r = run_row();
        let rows = vec![
            win(100, "s", 3, 0, r#"{"200":3}"#, &[10_000, 20_000, 30_000]),
            win(101, "s", 2, 0, r#"{"200":2}"#, &[40_000, 50_000]),
        ];
        let yaml = r.scenario_yaml.clone();
        let rep = build_report(
            &r,
            &yaml,
            &rows,
            &[],
            &[],
            &[],
            &[],
            &[],
            &[],
            &[],
            &[],
            &crate::stair::StairInputs::default(),
            &[],
            None,
            None,
            None,
        );

        let latency = rep.latency.as_ref().expect("latency present with samples");
        assert_eq!(latency.percentile_curve.len(), CURVE_QUANTILES.len());
        for (i, p) in latency.percentile_curve.iter().enumerate() {
            assert_eq!(p.quantile, CURVE_QUANTILES[i]);
        }
        for w in latency.percentile_curve.windows(2) {
            assert!(w[1].value_us >= w[0].value_us, "curve non-decreasing");
        }
        let total: u64 = latency.histogram.iter().map(|b| b.count).sum();
        assert_eq!(total, 5, "histogram partitions all 5 samples");

        // typed round-trip survives the new field.
        let v = serde_json::to_value(&rep).unwrap();
        let back: ReportJson = serde_json::from_value(v).unwrap();
        assert!(back.latency.is_some());
    }

    #[test]
    fn build_report_no_latency_without_samples() {
        let r = run_row();
        assert!(
            build_report(
                &r,
                "",
                &[],
                &[],
                &[],
                &[],
                &[],
                &[],
                &[],
                &[],
                &[],
                &crate::stair::StairInputs::default(),
                &[],
                None,
                None,
                None,
            )
            .latency
            .is_none()
        );
    }

    // ReportWindow 빌더(per-window RPS 테스트용). 이름은 `rwin` — 기존 `win`은
    // 6-인자 `WindowWithHdr` 빌더라 같은 이름이면 E0428(중복 정의). 절대 `win`으로 쓰지 말 것.
    fn rwin(ts: i64, count: u64) -> ReportWindow {
        ReportWindow {
            ts_second: ts,
            step_id: "s".to_string(),
            count,
            error_count: 0,
            status_counts: BTreeMap::new(),
            p50_ms: 0,
            p95_ms: 0,
            p99_ms: 0,
        }
    }
    fn dist(pairs: &[(&str, u64)]) -> BTreeMap<String, u64> {
        pairs.iter().map(|(k, v)| (k.to_string(), *v)).collect()
    }

    #[test]
    fn http_response_total_excludes_transport_zero() {
        let d = dist(&[("0", 5), ("200", 10), ("301", 2), ("404", 3), ("500", 1)]);
        assert_eq!(http_response_total(&d), 16); // 10+2+3+1, "0" 제외
        assert_eq!(status_class_count(&d, '4'), 3);
        assert_eq!(status_class_count(&d, '5'), 1);
    }

    #[test]
    fn status_class_rate_uses_http_total_denominator() {
        // 5xx rate = 10 / (90+10) = 0.1 > 0.05 → fail
        let c = Criteria {
            max_5xx_rate: Some(0.05),
            ..Default::default()
        };
        let d = dist(&[("200", 90), ("500", 10)]);
        let v = judge(
            &c,
            &summary(100, 0, 100.0, 5, 5),
            &d,
            &[],
            &[],
            None,
            &NoSample::none(),
        );
        assert_eq!(v.criteria[0].metric, "5xx_rate");
        assert!((v.criteria[0].actual - 0.1).abs() < 1e-9);
        assert!(!v.criteria[0].passed);
    }

    #[test]
    fn status_class_rate_zero_http_is_zero() {
        // transport 실패만 → http_total 0 → rate 0.0 → max_5xx_rate:0.0 통과
        let c = Criteria {
            max_5xx_rate: Some(0.0),
            ..Default::default()
        };
        let d = dist(&[("0", 5)]);
        let v = judge(
            &c,
            &summary(5, 5, 5.0, 0, 0),
            &d,
            &[],
            &[],
            None,
            &NoSample::none(),
        );
        assert!(v.criteria[0].passed);
        assert_eq!(v.criteria[0].actual, 0.0);
    }

    #[test]
    fn status_class_count_strict_zero_fails_on_any() {
        let c = Criteria {
            max_5xx_count: Some(0),
            ..Default::default()
        };
        let d = dist(&[("200", 10), ("500", 1)]);
        let v = judge(
            &c,
            &summary(11, 1, 11.0, 5, 5),
            &d,
            &[],
            &[],
            None,
            &NoSample::none(),
        );
        assert_eq!(v.criteria[0].metric, "5xx_count");
        assert_eq!(v.criteria[0].actual, 1.0);
        assert!(!v.criteria[0].passed);
    }

    #[test]
    fn min_window_rps_excludes_boundaries_and_sums_steps() {
        // 경계초(0,3) 제외, sec1의 두 step(40+60=100), sec2=200 → min 100.
        let w = vec![
            rwin(0, 999),
            rwin(1, 40),
            rwin(1, 60),
            rwin(2, 200),
            rwin(3, 999),
        ];
        assert_eq!(super::min_window_rps(&w, 0), Some(100.0));
    }

    #[test]
    fn min_window_rps_warmup_skips_leading_seconds() {
        // secs 0..5. 경계 0,5 제외. warmup 2 → ts>=2.
        let w = vec![
            rwin(0, 100),
            rwin(1, 10),
            rwin(2, 20),
            rwin(3, 30),
            rwin(4, 40),
            rwin(5, 100),
        ];
        assert_eq!(super::min_window_rps(&w, 0), Some(10.0)); // {1,2,3,4}
        assert_eq!(super::min_window_rps(&w, 2), Some(20.0)); // {2,3,4}
    }

    #[test]
    fn min_window_rps_insufficient_windows_is_none() {
        assert_eq!(super::min_window_rps(&[], 0), None);
        assert_eq!(super::min_window_rps(&[rwin(5, 100)], 0), None); // 1초
        assert_eq!(super::min_window_rps(&[rwin(0, 100), rwin(1, 50)], 0), None); // 2초(경계만)
    }

    #[test]
    fn min_window_rps_criterion_skipped_when_insufficient() {
        let c = Criteria {
            min_window_rps: Some(1.0),
            ..Default::default()
        };
        let v = judge(
            &c,
            &summary(0, 0, 0.0, 0, 0),
            &BTreeMap::new(),
            &[],
            &[],
            None,
            &NoSample::none(),
        );
        assert!(v.criteria.is_empty());
    }

    /// 규칙 1 run의 판정 결과는 규칙 2 도입 전과 바이트가 같다(R9·US6). 리터럴은 도입 전 코드로 뽑았다.
    #[test]
    fn rule1_bytes_unchanged() {
        let c = Criteria {
            max_p50_ms: Some(100),
            max_p95_ms: Some(200),
            max_p99_ms: Some(300),
            max_error_rate: Some(0.1),
            max_4xx_rate: Some(0.5),
            max_5xx_count: Some(3),
            min_rps: Some(5.0),
            step_criteria: vec![
                Criterion {
                    metric: "p95_ms".into(),
                    op: "max".into(),
                    threshold: 100.0,
                    target: "A".into(),
                },
                Criterion {
                    metric: "error_rate".into(),
                    op: "max".into(),
                    threshold: 0.1,
                    target: "B".into(),
                },
                Criterion {
                    metric: "p99_ms".into(),
                    op: "min".into(),
                    threshold: 1.0,
                    target: "C".into(),
                },
            ],
            ..Default::default()
        };
        let mut s = summary(20, 5, 20.0, 150, 400);
        s.p50_ms = 90;
        let steps = vec![
            rstep("A", 10, 0, 150, &[("200", 10)]),
            rstep("B", 8, 5, 9, &[("200", 3), ("500", 5)]),
            rstep("C", 2, 0, 0, &[("404", 2)]),
        ];
        let d = dist(&[("200", 13), ("404", 2), ("500", 5)]);
        let ns_steps: BTreeSet<String> = ["C".to_string()].into();
        let v1 = judge(
            &c,
            &s,
            &d,
            &[],
            &steps,
            None,
            &NoSample {
                run: false,
                steps: &ns_steps,
            },
        );
        let v2 = judge(
            &c,
            &s,
            &d,
            &[],
            &steps,
            None,
            &NoSample {
                run: true,
                steps: &ns_steps,
            },
        );
        assert_eq!(
            serde_json::to_string(&(v1, v2)).unwrap(),
            r#"[{"passed":false,"criteria":[{"metric":"p50_ms","direction":"max","threshold":100.0,"actual":90.0,"passed":true},{"metric":"p95_ms","direction":"max","threshold":200.0,"actual":150.0,"passed":true},{"metric":"p99_ms","direction":"max","threshold":300.0,"actual":400.0,"passed":false},{"metric":"error_rate","direction":"max","threshold":0.1,"actual":0.25,"passed":false},{"metric":"4xx_rate","direction":"max","threshold":0.5,"actual":0.1,"passed":true},{"metric":"5xx_count","direction":"max","threshold":3.0,"actual":5.0,"passed":false},{"metric":"rps","direction":"min","threshold":5.0,"actual":20.0,"passed":true},{"metric":"p95_ms","direction":"max","threshold":100.0,"actual":150.0,"passed":false,"target":"A"},{"metric":"error_rate","direction":"max","threshold":0.1,"actual":0.625,"passed":false,"target":"B"},{"metric":"p99_ms","direction":"min","threshold":1.0,"actual":0.0,"passed":false,"target":"C","no_sample":true}]},{"passed":false,"criteria":[{"metric":"p50_ms","direction":"max","threshold":100.0,"actual":90.0,"passed":false,"no_sample":true},{"metric":"p95_ms","direction":"max","threshold":200.0,"actual":150.0,"passed":false,"no_sample":true},{"metric":"p99_ms","direction":"max","threshold":300.0,"actual":400.0,"passed":false,"no_sample":true},{"metric":"error_rate","direction":"max","threshold":0.1,"actual":0.25,"passed":false},{"metric":"4xx_rate","direction":"max","threshold":0.5,"actual":0.1,"passed":true},{"metric":"5xx_count","direction":"max","threshold":3.0,"actual":5.0,"passed":false},{"metric":"rps","direction":"min","threshold":5.0,"actual":20.0,"passed":true},{"metric":"p95_ms","direction":"max","threshold":100.0,"actual":150.0,"passed":false,"target":"A"},{"metric":"error_rate","direction":"max","threshold":0.1,"actual":0.625,"passed":false,"target":"B"},{"metric":"p99_ms","direction":"min","threshold":1.0,"actual":0.0,"passed":false,"target":"C","no_sample":true}]}]"#
        );
    }

    #[test]
    fn evaluate_criteria_output_order_is_fixed() {
        let c = Criteria {
            max_p50_ms: Some(1000),
            max_error_rate: Some(1.0),
            max_4xx_rate: Some(1.0),
            max_5xx_rate: Some(1.0),
            max_4xx_count: Some(999),
            max_5xx_count: Some(999),
            min_rps: Some(0.0),
            min_window_rps: Some(0.0),
            ..Default::default()
        };
        let d = dist(&[("200", 30)]);
        let w = vec![rwin(0, 10), rwin(1, 20), rwin(2, 30)]; // eligible {1}=20
        let v = judge(
            &c,
            &summary(30, 0, 30.0, 1, 1),
            &d,
            &w,
            &[],
            None,
            &NoSample::none(),
        );
        let metrics: Vec<&str> = v.criteria.iter().map(|r| r.metric.as_str()).collect();
        assert_eq!(
            metrics,
            vec![
                "p50_ms",
                "error_rate",
                "4xx_rate",
                "5xx_rate",
                "4xx_count",
                "5xx_count",
                "rps",
                "min_window_rps"
            ]
        );
    }

    #[test]
    fn build_report_verdict_none_when_only_window_rps_and_short_run() {
        let mut run = run_row(); // Completed
        run.profile.criteria = Some(Criteria {
            min_window_rps: Some(1.0),
            ..Default::default()
        });
        assert!(
            build_report(
                &run,
                "",
                &[],
                &[],
                &[],
                &[],
                &[],
                &[],
                &[],
                &[],
                &[],
                &crate::stair::StairInputs::default(),
                &[],
                None,
                None,
                None,
            )
            .verdict
            .is_none()
        );
    }

    #[test]
    fn build_report_attaches_group_latency_without_polluting_summary() {
        use crate::store::metrics::GroupMetricRow;
        let r = run_row();
        // One http window (count=10) so summary reflects only real requests, not pages.
        let rows = vec![win(
            100,
            "01HX0000000000000000000011",
            10,
            0,
            r#"{"200":10}"#,
            &[5_000],
        )];
        // One group delta for the parallel node: 3 page loads ~300 ms each.
        let groups = vec![GroupMetricRow {
            run_id: r.id.clone(),
            step_id: "01HX0000000000000000000010".into(),
            branch: "".into(),
            hdr_histogram: make_hdr_bytes(&[300_000, 305_000, 295_000]),
            count: 3,
        }];
        let yaml = r.scenario_yaml.clone();

        let rep = build_report(
            &r,
            &yaml,
            &rows,
            &[],
            &[],
            &groups,
            &[],
            &[],
            &[],
            &[],
            &[],
            &crate::stair::StairInputs::default(),
            &[],
            None,
            None,
            None,
        );

        // summary/overall reflect ONLY the http window (10 reqs), NOT the 3 page loads.
        assert_eq!(
            rep.summary.count, 10,
            "group samples excluded from summary count"
        );
        assert!(
            rep.steps
                .iter()
                .all(|s| s.step_id != "01HX0000000000000000000010"),
            "parallel node id not in per-step rows"
        );
        // group_latency carries the parallel node distribution.
        assert_eq!(rep.group_latency.len(), 1);
        let g = &rep.group_latency[0];
        assert_eq!(g.step_id, "01HX0000000000000000000010");
        assert_eq!(g.count, 3);
        assert!(
            g.p50_ms >= 290 && g.max_ms >= 300,
            "p50~300ms max~305ms, got {g:?}"
        );
        assert!(
            rep.group_latency[0].branches.is_empty(),
            "no branch rows → empty branches"
        );
        // typed round-trip (report types require Deserialize too).
        let v = serde_json::to_value(&rep).unwrap();
        let _back: ReportJson = serde_json::from_value(v).unwrap();
    }

    #[test]
    fn build_report_attaches_active_vu_series_without_polluting_summary() {
        use crate::store::metrics::ActiveVuRow;
        let r = run_row();
        let rows = vec![win(
            100,
            "01HX0000000000000000000011",
            5,
            0,
            r#"{"200":5}"#,
            &[5_000],
        )];
        let yaml = r.scenario_yaml.clone();
        let active = vec![
            ActiveVuRow {
                run_id: r.id.clone(),
                ts_second: 100,
                desired: 3,
                actual: 2,
                worker_id: "".into(),
            },
            ActiveVuRow {
                run_id: r.id.clone(),
                ts_second: 101,
                desired: 5,
                actual: 5,
                worker_id: "".into(),
            },
        ];
        let rep = build_report(
            &r,
            &yaml,
            &rows,
            &[],
            &[],
            &[],
            &[],
            &active,
            &[],
            &[],
            &[],
            &crate::stair::StairInputs::default(),
            &[],
            None,
            None,
            None,
        );
        assert_eq!(rep.active_vu_series.len(), 2);
        assert_eq!(
            (
                rep.active_vu_series[0].ts_second,
                rep.active_vu_series[0].desired,
                rep.active_vu_series[0].actual
            ),
            (100, 3, 2)
        );
        let baseline = build_report(
            &r,
            &yaml,
            &rows,
            &[],
            &[],
            &[],
            &[],
            &[],
            &[],
            &[],
            &[],
            &crate::stair::StairInputs::default(),
            &[],
            None,
            None,
            None,
        );
        assert_eq!(rep.summary.count, baseline.summary.count);
        assert_eq!(rep.summary.rps, baseline.summary.rps);
        assert_eq!(rep.windows.len(), baseline.windows.len());
        assert!(baseline.active_vu_series.is_empty());
    }

    #[test]
    fn build_report_attaches_active_vu_by_worker_for_multiworker() {
        use crate::store::metrics::ActiveVuRow;
        let r = run_row();
        let yaml = r.scenario_yaml.clone();
        // Two workers; rows intentionally out of worker order to verify sorting.
        let by_worker = vec![
            ActiveVuRow {
                run_id: r.id.clone(),
                ts_second: 100,
                desired: 2,
                actual: 2,
                worker_id: "w-1".into(),
            },
            ActiveVuRow {
                run_id: r.id.clone(),
                ts_second: 100,
                desired: 3,
                actual: 1,
                worker_id: "w-0".into(),
            },
            ActiveVuRow {
                run_id: r.id.clone(),
                ts_second: 101,
                desired: 3,
                actual: 3,
                worker_id: "w-0".into(),
            },
        ];
        let rep = build_report(
            &r,
            &yaml,
            &[],
            &[],
            &[],
            &[],
            &[],
            &[],
            &by_worker,
            &[],
            &[],
            &crate::stair::StairInputs::default(),
            &[],
            None,
            None,
            None,
        );
        assert_eq!(rep.active_vu_by_worker.len(), 2);
        assert_eq!(rep.active_vu_by_worker[0].worker_id, "w-0"); // sorted
        assert_eq!(rep.active_vu_by_worker[0].samples.len(), 2);
        assert_eq!(
            (
                rep.active_vu_by_worker[0].samples[0].desired,
                rep.active_vu_by_worker[0].samples[0].actual
            ),
            (3, 1)
        );
        assert_eq!(rep.active_vu_by_worker[1].worker_id, "w-1");
    }

    #[test]
    fn build_report_no_active_vu_by_worker_for_single_or_none() {
        use crate::store::metrics::ActiveVuRow;
        let r = run_row();
        // Single worker -> distinct < 2 -> empty.
        let one = vec![ActiveVuRow {
            run_id: r.id.clone(),
            ts_second: 100,
            desired: 1,
            actual: 1,
            worker_id: "w-0".into(),
        }];
        let rep = build_report(
            &r,
            "",
            &[],
            &[],
            &[],
            &[],
            &[],
            &[],
            &one,
            &[],
            &[],
            &crate::stair::StairInputs::default(),
            &[],
            None,
            None,
            None,
        );
        assert!(rep.active_vu_by_worker.is_empty());
        // No rows (non-curve caller passes &[]) -> empty (byte-identical default).
        let none = build_report(
            &r,
            "",
            &[],
            &[],
            &[],
            &[],
            &[],
            &[],
            &[],
            &[],
            &[],
            &crate::stair::StairInputs::default(),
            &[],
            None,
            None,
            None,
        );
        assert!(none.active_vu_by_worker.is_empty());
    }

    #[test]
    fn build_report_empty_groups_yields_empty_group_latency() {
        let r = run_row();
        let rep = build_report(
            &r,
            "",
            &[],
            &[],
            &[],
            &[],
            &[],
            &[],
            &[],
            &[],
            &[],
            &crate::stair::StairInputs::default(),
            &[],
            None,
            None,
            None,
        );
        assert!(rep.group_latency.is_empty());
    }

    #[test]
    fn build_report_nests_branch_latency_under_page() {
        use crate::store::metrics::GroupMetricRow;
        let r = run_row();
        let rows = vec![win(
            100,
            "01HX0000000000000000000011",
            10,
            0,
            r#"{"200":10}"#,
            &[5_000],
        )];
        let par = "01HX0000000000000000000010";
        let groups = vec![
            GroupMetricRow {
                run_id: r.id.clone(),
                step_id: par.into(),
                branch: "".into(),
                hdr_histogram: make_hdr_bytes(&[300_000, 300_000]),
                count: 2,
            },
            GroupMetricRow {
                run_id: r.id.clone(),
                step_id: par.into(),
                branch: "a".into(),
                hdr_histogram: make_hdr_bytes(&[300_000, 300_000]),
                count: 2,
            },
            GroupMetricRow {
                run_id: r.id.clone(),
                step_id: par.into(),
                branch: "b".into(),
                hdr_histogram: make_hdr_bytes(&[50_000, 50_000]),
                count: 2,
            },
        ];
        let yaml = r.scenario_yaml.clone();
        let rep = build_report(
            &r,
            &yaml,
            &rows,
            &[],
            &[],
            &groups,
            &[],
            &[],
            &[],
            &[],
            &[],
            &crate::stair::StairInputs::default(),
            &[],
            None,
            None,
            None,
        );

        assert_eq!(
            rep.group_latency.len(),
            1,
            "one parallel node → one page entry"
        );
        let g = &rep.group_latency[0];
        assert_eq!(g.step_id, par);
        assert_eq!(
            g.count, 2,
            "page count = clean iterations, not summed branches"
        );
        assert_eq!(g.branches.len(), 2, "two branches nested");
        assert_eq!(g.branches[0].branch, "a", "branches sorted by name");
        assert_eq!(g.branches[1].branch, "b");
        assert_eq!(
            g.branches[0].count, 2,
            "each branch fires once per clean page"
        );
        assert!(
            g.branches[0].p50_ms >= 290,
            "branch a ~300ms (bottleneck), got {}",
            g.branches[0].p50_ms
        );
        assert!(
            g.branches[1].p50_ms <= 60,
            "branch b ~50ms (fast), got {}",
            g.branches[1].p50_ms
        );
        assert_eq!(
            rep.summary.count, 10,
            "branches+page excluded from summary count"
        );
        // typed round-trip (report types require Deserialize too).
        let v = serde_json::to_value(&rep).unwrap();
        let _back: ReportJson = serde_json::from_value(v).unwrap();
    }

    #[test]
    fn build_report_attaches_download_phase_to_step() {
        use crate::store::metrics::PhaseMetricRow;
        let r = run_row();
        let yaml = "version: 1\nname: t\nsteps: []\n";
        // One http window for step "s1" so a ReportStep row exists.
        let rows = vec![win(100, "s1", 5, 0, r#"{"200":5}"#, &[10_000])];
        let phases = vec![PhaseMetricRow {
            run_id: r.id.clone(),
            step_id: "s1".into(),
            phase: "download".into(),
            hdr_histogram: make_hdr_bytes(&[5_000, 9_000]),
            count: 2,
        }];
        let rep = build_report(
            &r,
            yaml,
            &rows,
            &[],
            &[],
            &[],
            &phases,
            &[],
            &[],
            &[],
            &[],
            &crate::stair::StairInputs::default(),
            &[],
            None,
            None,
            None,
        );
        // download samples must NOT pollute the TTFB summary count (isolation invariant).
        // The window row has count=5, so summary reflects 5 TTFB requests, not the 2 download samples.
        assert_eq!(
            rep.summary.count, 5,
            "download samples excluded from TTFB summary count"
        );
        let s = rep.steps.iter().find(|s| s.step_id == "s1").unwrap();
        let d = s.download.as_ref().expect("download phase attached");
        assert_eq!(d.count, 2);
        // samples are [5_000, 9_000] µs → max = 9_000 µs / 1_000 = 9 ms (deterministic)
        assert_eq!(d.max_ms, 9, "max ms = 9000µs/1000");
    }

    #[test]
    fn build_report_no_download_without_phases() {
        let r = run_row();
        let rows = vec![win(100, "s1", 5, 0, r#"{"200":5}"#, &[10_000])];
        let rep = build_report(
            &r,
            "version: 1\nname: t\nsteps: []\n",
            &rows,
            &[],
            &[],
            &[],
            &[],
            &[],
            &[],
            &[],
            &[],
            &crate::stair::StairInputs::default(),
            &[],
            None,
            None,
            None,
        );
        assert!(
            rep.steps.iter().all(|s| s.download.is_none()),
            "no download when phases empty (byte-identical)"
        );
    }

    fn ph(
        step: &str,
        phase: &str,
        samples_us: &[u64],
        count: i64,
    ) -> crate::store::metrics::PhaseMetricRow {
        crate::store::metrics::PhaseMetricRow {
            run_id: run_row().id.clone(),
            step_id: step.into(),
            phase: phase.into(),
            hdr_histogram: if samples_us.is_empty() {
                Vec::new()
            } else {
                make_hdr_bytes(samples_us)
            },
            count,
        }
    }

    fn split_report(phases: &[crate::store::metrics::PhaseMetricRow]) -> ReportJson {
        let r = run_row();
        let rows = vec![win(100, "s1", 5, 0, r#"{"200":5}"#, &[10_000])];
        build_report(
            &r,
            "version: 1\nname: t\nsteps: []\n",
            &rows,
            &[],
            &[],
            &[],
            phases,
            &[],
            &[],
            &[],
            &[],
            &crate::stair::StairInputs::default(),
            &[],
            None,
            None,
            None,
        )
    }

    #[test]
    fn loop_split_rolls_up_final_and_retry() {
        use handicap_engine::{PHASE_LOOP_FINAL, PHASE_LOOP_RETRY, PHASE_LOOP_RETRY_ERR};
        let phases = vec![
            ph("s1", PHASE_LOOP_FINAL, &[180_000, 180_000], 2),
            ph("s1", PHASE_LOOP_FINAL, &[180_000, 180_000], 2),
            ph("s1", PHASE_LOOP_RETRY, &[12_000, 12_000, 12_000], 3),
            ph("s1", PHASE_LOOP_RETRY_ERR, &[], 1),
        ];
        let rep = split_report(&phases);
        let ls = rep.steps[0].loop_split.as_ref().expect("loop_split");
        assert_eq!(ls.ended.count, 4);
        assert_eq!(ls.ended.p50_ms, 180);
        assert_eq!(ls.ended.error_count, 0);
        assert_eq!(ls.retry.count, 3);
        assert_eq!(ls.retry.error_count, 1);
        assert_eq!(ls.retry.p50_ms, 12);
        let v = serde_json::to_value(&rep).unwrap();
        assert_eq!(v["steps"][0]["loop_split"]["final"]["count"], 4);
        let keys = |o: &serde_json::Value| {
            let mut k: Vec<String> = o.as_object().unwrap().keys().cloned().collect();
            k.sort();
            k
        };
        assert_eq!(keys(&v["steps"][0]["loop_split"]), vec!["final", "retry"]);
        assert_eq!(
            keys(&v["steps"][0]["loop_split"]["retry"]),
            vec!["count", "error_count", "p50_ms", "p95_ms", "p99_ms"]
        );
        let _back: ReportJson = serde_json::from_value(v).unwrap();
    }

    #[test]
    fn loop_split_omitted_without_continued_passes() {
        use handicap_engine::{PHASE_LOOP_CUT, PHASE_LOOP_FINAL, PHASE_LOOP_RETRY};
        let cases = vec![
            vec![ph("s1", PHASE_LOOP_FINAL, &[1_000], 1)],
            vec![
                ph("s1", PHASE_LOOP_FINAL, &[1_000], 1),
                ph("s1", PHASE_LOOP_CUT, &[1_000], 1),
            ],
            vec![
                ph("s1", PHASE_LOOP_FINAL, &[1_000], 1),
                ph("s1", PHASE_LOOP_RETRY, &[], 0),
            ],
        ];
        for phases in cases {
            let rep = split_report(&phases);
            assert!(rep.steps[0].loop_split.is_none());
            assert!(
                !serde_json::to_string(&rep)
                    .unwrap()
                    .contains("\"loop_split\"")
            );
        }
    }

    #[test]
    fn loop_split_retry_includes_cut() {
        use handicap_engine::{PHASE_LOOP_CUT, PHASE_LOOP_CUT_ERR, PHASE_LOOP_RETRY};
        let phases = vec![
            ph("s1", PHASE_LOOP_RETRY, &[1_000], 1),
            ph("s1", PHASE_LOOP_CUT, &[2_000, 2_000], 2),
            ph("s1", PHASE_LOOP_CUT_ERR, &[], 2),
        ];
        let rep = split_report(&phases);
        let ls = rep.steps[0].loop_split.as_ref().unwrap();
        assert_eq!(ls.retry.count, 3);
        assert_eq!(ls.retry.error_count, 2);
    }

    #[test]
    fn loop_split_without_final_keeps_both_sides() {
        use handicap_engine::PHASE_LOOP_RETRY;
        let phases = vec![ph("s1", PHASE_LOOP_RETRY, &[1_000; 5], 5)];
        let rep = split_report(&phases);
        let ls = rep.steps[0].loop_split.as_ref().unwrap();
        assert_eq!(ls.ended.count, 0);
        assert_eq!(ls.ended.p50_ms, 0);
        assert_eq!(ls.retry.count, 5);
    }

    #[test]
    fn loop_split_sanitizes_worker_input() {
        use handicap_engine::{PHASE_LOOP_FINAL, PHASE_LOOP_RETRY, PHASE_LOOP_RETRY_ERR};
        let mut bad = ph("s1", PHASE_LOOP_RETRY, &[], 4);
        bad.hdr_histogram = vec![1, 2, 3];
        let phases = vec![
            ph("s1", PHASE_LOOP_RETRY, &[1_000, 1_000], 2),
            ph("s1", PHASE_LOOP_RETRY_ERR, &[], 9),
            ph("s1", PHASE_LOOP_FINAL, &[1_000], -3),
            bad,
        ];
        let rep = split_report(&phases);
        let ls = rep.steps[0].loop_split.as_ref().unwrap();
        assert_eq!(ls.retry.count, 6);
        assert_eq!(ls.retry.error_count, 6);
        assert_eq!(ls.ended.count, 0);
        // 건수 0인 갈래는 샘플이 있어도 백분위 0.
        assert_eq!(ls.ended.p50_ms, 0);
        assert_eq!(ls.ended.p95_ms, 0);
        assert_eq!(ls.ended.p99_ms, 0);
        // 깨진 BLOB 행은 히스토그램에서만 빠지고 백분위는 유효 행 샘플(1ms)에서 나온다.
        assert_eq!(ls.retry.p50_ms, 1);
    }

    #[test]
    fn loop_split_count_sums_saturate() {
        use handicap_engine::PHASE_LOOP_RETRY;
        let phases = vec![
            ph("s1", PHASE_LOOP_RETRY, &[1_000], i64::MAX),
            ph("s1", PHASE_LOOP_RETRY, &[1_000], i64::MAX),
            ph("s1", PHASE_LOOP_RETRY, &[1_000], i64::MAX),
        ];
        let rep = split_report(&phases);
        let ls = rep.steps[0].loop_split.as_ref().unwrap();
        assert_eq!(ls.retry.count, u64::MAX);
    }

    #[test]
    fn loop_split_rows_do_not_touch_download_wait_connection() {
        use handicap_engine::{
            PHASE_LOOP_CUT, PHASE_LOOP_CUT_ERR, PHASE_LOOP_FINAL, PHASE_LOOP_FINAL_ERR,
            PHASE_LOOP_RETRY, PHASE_LOOP_RETRY_ERR,
        };
        let base = vec![
            ph("s1", "download", &[5_000, 9_000], 2),
            ph("s1", "wait", &[3_000], 1),
            ph("s1", "dns", &[1_000], 1),
            ph("s1", "connect", &[2_000], 1),
        ];
        let mut with = base.clone();
        with.extend(vec![
            ph("s1", PHASE_LOOP_FINAL, &[1_000], 1),
            ph("s1", PHASE_LOOP_RETRY, &[1_000], 1),
            ph("s1", PHASE_LOOP_CUT, &[1_000], 1),
            ph("s1", PHASE_LOOP_FINAL_ERR, &[], 1),
            ph("s1", PHASE_LOOP_RETRY_ERR, &[], 1),
            ph("s1", PHASE_LOOP_CUT_ERR, &[], 1),
            ph("ghost", PHASE_LOOP_RETRY, &[1_000], 1),
        ]);
        let a = split_report(&base);
        let b = split_report(&with);
        assert_eq!(a.steps.len(), b.steps.len());
        assert_eq!(a.steps[0].download, b.steps[0].download);
        assert_eq!(a.steps[0].wait, b.steps[0].wait);
        assert_eq!(a.connection, b.connection);
        assert!(a.steps[0].download.is_some() && a.connection.is_some());
        assert!(
            !serde_json::to_string(&a)
                .unwrap()
                .contains("\"loop_split\"")
        );
    }

    #[test]
    fn build_report_surfaces_saturation_insight() {
        // dropped>0 -> load_gen_saturated. value = peak per-second(=두 번째 초 9), count = dropped.
        let mut run = run_row();
        run.dropped = 7;
        let rows = vec![
            win(
                100,
                "s",
                4,
                0,
                r#"{"200":4}"#,
                &[10_000, 10_000, 10_000, 10_000],
            ),
            win(101, "s", 9, 0, r#"{"200":9}"#, &[10_000; 9]),
        ];
        let rep = build_report(
            &run,
            "",
            &rows,
            &[],
            &[],
            &[],
            &[],
            &[],
            &[],
            &[],
            &[],
            &crate::stair::StairInputs::default(),
            &[],
            None,
            None,
            None,
        );
        let sat = rep
            .insights
            .iter()
            .find(|i| i.kind == "load_gen_saturated")
            .expect("load_gen_saturated present when dropped>0");
        assert_eq!(sat.value, Some(9.0)); // 두 번째 초가 peak (4가 아니라 9)
        assert_eq!(sat.count, Some(7));
    }

    #[test]
    fn build_report_no_saturation_when_not_dropped() {
        let run = run_row(); // dropped: 0
        let rows = vec![win(100, "s", 5, 0, r#"{"200":5}"#, &[10_000; 5])];
        let rep = build_report(
            &run,
            "",
            &rows,
            &[],
            &[],
            &[],
            &[],
            &[],
            &[],
            &[],
            &[],
            &crate::stair::StairInputs::default(),
            &[],
            None,
            None,
            None,
        );
        assert!(rep.insights.iter().all(|i| i.kind != "load_gen_saturated"));
    }

    #[test]
    fn build_report_sizing_slots_recommendation() {
        // open-loop: target 10_000, M=100, dropped=200, dur=2(run_row 100_000→102_000) →
        // scheduled=target×dur=20_000 → achieved=(20_000-200)/2=9_900 →
        // recommended=ceil(10_000×100/9_900)=ceil(101.0101)=102.
        let mut run = run_row();
        run.profile.target_rps = Some(10_000);
        run.profile.max_in_flight = Some(100);
        run.dropped = 200;
        // 50ms(=50_000µs) 샘플 100개 → overall p50_ms ≈ 50.
        let rows = vec![win(100, "s", 100, 0, r#"{"200":100}"#, &[50_000; 100])];
        let rep = build_report(
            &run,
            "",
            &rows,
            &[],
            &[],
            &[],
            &[],
            &[],
            &[],
            &[],
            &[],
            &crate::stair::StairInputs::default(),
            &[],
            None,
            None,
            None,
        );
        let ins = rep
            .insights
            .iter()
            .find(|i| i.kind == "load_gen_saturated")
            .expect("saturation insight");
        assert_eq!(ins.cause.as_deref(), Some("slots"));
        assert_eq!(ins.recommended, Some(102.0));
        assert_eq!(ins.count, Some(200));
        assert!(ins.achieved_per_sec.is_some());
        assert_eq!(ins.target_per_sec, Some(10_000.0));
    }

    #[test]
    fn build_report_sizing_uses_stages_peak() {
        // target_rps 없음, stages=[{4000,10},{12000,10}], dur=2(절단, 첫 stage 안) →
        // scheduled=(0+800)/2×2=800 → achieved=(800-50)/2=375 → target_eff(peak)=12_000
        // (유효목표 산출=report.rs 책임) → recommended=ceil(12_000×100/375)=3200.
        let mut run = run_row();
        run.profile.target_rps = None;
        run.profile.stages = Some(vec![
            handicap_engine::Stage {
                target: 4000,
                duration_seconds: 10,
            },
            handicap_engine::Stage {
                target: 12000,
                duration_seconds: 10,
            },
        ]);
        run.profile.max_in_flight = Some(100);
        run.dropped = 50;
        let rows = vec![win(100, "s", 100, 0, r#"{"200":100}"#, &[50_000; 100])];
        let rep = build_report(
            &run,
            "",
            &rows,
            &[],
            &[],
            &[],
            &[],
            &[],
            &[],
            &[],
            &[],
            &crate::stair::StairInputs::default(),
            &[],
            None,
            None,
            None,
        );
        let ins = rep
            .insights
            .iter()
            .find(|i| i.kind == "load_gen_saturated")
            .expect("saturation insight");
        assert_eq!(ins.recommended, Some(3200.0));
        assert_eq!(ins.cause.as_deref(), Some("slots"));
        assert_eq!(ins.target_per_sec, Some(12_000.0));
    }

    #[test]
    fn evaluate_5xx_rate_matches_insights_status_class_pct() {
        // 같은 status_distribution에서 evaluate_criteria의 5xx_rate actual과
        // insights status_class의 pct(5xx)가 동일해야 한다(공유 헬퍼).
        let d = dist(&[("0", 7), ("200", 80), ("404", 5), ("500", 15)]);
        let c = Criteria {
            max_5xx_rate: Some(1.0),
            ..Default::default()
        };
        let v = judge(
            &c,
            &summary(107, 22, 107.0, 5, 5),
            &d,
            &[],
            &[],
            None,
            &NoSample::none(),
        );
        let rate = v
            .criteria
            .iter()
            .find(|r| r.metric == "5xx_rate")
            .unwrap()
            .actual;

        // insights status_class 분모/분자와 동일: 15 / (80+5+15) = 15/100
        let total = http_response_total(&d);
        let cls = status_class_count(&d, '5');
        assert_eq!(total, 100);
        assert!((rate - cls as f64 / total as f64).abs() < 1e-9);
    }

    #[test]
    fn build_report_summary_mean_ms() {
        // R1: ReportSummary.mean_ms = overall.mean() 반올림.
        // 샘플 4개: 10_000µs, 20_000µs, 30_000µs, 40_000µs → mean = 25_000µs = 25ms.
        let r = run_row();
        let rows = vec![win(
            100,
            "s",
            4,
            0,
            r#"{"200":4}"#,
            &[10_000, 20_000, 30_000, 40_000],
        )];
        let rep = build_report(
            &r,
            "",
            &rows,
            &[],
            &[],
            &[],
            &[],
            &[],
            &[],
            &[],
            &[],
            &crate::stair::StairInputs::default(),
            &[],
            None,
            None,
            None,
        );
        assert_eq!(rep.summary.mean_ms, 25);
    }

    #[test]
    fn build_report_rolls_up_connection_phases_and_attaches_wait() {
        use crate::store::metrics::PhaseMetricRow;
        let r = run_row();
        let yaml = "version: 1\nname: t\nsteps: []\n";
        // one http window: step "s1", count=10 → requests_total=10
        let rows = vec![win(100, "s1", 10, 0, r#"{"200":10}"#, &[10_000])];
        let phases = vec![
            PhaseMetricRow {
                run_id: r.id.clone(),
                step_id: "s1".into(),
                phase: "wait".into(),
                hdr_histogram: make_hdr_bytes(&[50_000]),
                count: 10,
            },
            PhaseMetricRow {
                run_id: r.id.clone(),
                step_id: "s1".into(),
                phase: "dns".into(),
                hdr_histogram: make_hdr_bytes(&[2_000]),
                count: 2,
            },
            PhaseMetricRow {
                run_id: r.id.clone(),
                step_id: "s1".into(),
                phase: "connect".into(),
                hdr_histogram: make_hdr_bytes(&[15_000]),
                count: 2,
            },
        ];
        let rep = build_report(
            &r,
            yaml,
            &rows,
            &[],
            &[],
            &[],
            &phases,
            &[],
            &[],
            &[],
            &[],
            &crate::stair::StairInputs::default(),
            &[],
            None,
            None,
            None,
        );
        // wait attaches per-step
        let s = rep.steps.iter().find(|s| s.step_id == "s1").unwrap();
        assert!(s.wait.is_some(), "wait phase attaches to step");
        // dns/connect roll up to run-level connection block (NOT per-step)
        let c = rep.connection.as_ref().expect("connection rollup present");
        assert_eq!(c.connections_opened, 2, "= connect sample count");
        assert_eq!(c.requests_total, 10);
        assert!((c.reuse_ratio - 0.8).abs() < 1e-9, "1 - 2/10 = 0.8");
        assert!(c.dns.p50_ms <= 3 && c.connect.p50_ms >= 14);
        // no connection rows → None (byte-identical)
        let rep2 = build_report(
            &r,
            yaml,
            &rows,
            &[],
            &[],
            &[],
            &[],
            &[],
            &[],
            &[],
            &[],
            &crate::stair::StairInputs::default(),
            &[],
            None,
            None,
            None,
        );
        assert!(rep2.connection.is_none());
    }

    #[test]
    fn build_report_attaches_worker_breakdown_for_multiworker() {
        let r = run_row();
        // Same (ts,step), two workers, distinct counts + latencies; rows out of worker order.
        let rows = vec![
            WindowWithHdr {
                failed_hdr_histogram: None,
                ts_second: 100,
                step_id: "s".into(),
                worker_id: "w-1".into(),
                count: 5,
                error_count: 1,
                status_counts: r#"{"200":4,"500":1}"#.into(),
                hdr_histogram: make_hdr_bytes(&[40_000, 40_000, 40_000, 40_000, 40_000]),
            },
            WindowWithHdr {
                failed_hdr_histogram: None,
                ts_second: 100,
                step_id: "s".into(),
                worker_id: "w-0".into(),
                count: 3,
                error_count: 0,
                status_counts: r#"{"200":3}"#.into(),
                hdr_histogram: make_hdr_bytes(&[10_000, 10_000, 10_000]),
            },
        ];
        let yaml = r.scenario_yaml.clone();
        let rep = build_report(
            &r,
            &yaml,
            &rows,
            &[],
            &[],
            &[],
            &[],
            &[],
            &[],
            &[],
            &[],
            &crate::stair::StairInputs::default(),
            &[],
            None,
            None,
            None,
        );
        assert_eq!(rep.worker_breakdown.len(), 2);
        // sorted by worker_id ascending
        assert_eq!(rep.worker_breakdown[0].worker_id, "w-0");
        assert_eq!(rep.worker_breakdown[0].count, 3);
        assert_eq!(rep.worker_breakdown[0].errors, 0);
        assert_eq!(rep.worker_breakdown[0].p99_ms, 10); // w-0 only saw 10ms
        assert_eq!(rep.worker_breakdown[1].worker_id, "w-1");
        assert_eq!(rep.worker_breakdown[1].count, 5);
        assert_eq!(rep.worker_breakdown[1].errors, 1);
        assert_eq!(rep.worker_breakdown[1].p99_ms, 40); // w-1 saw 40ms
        // aggregate summary still merges across workers (byte-identical behavior)
        assert_eq!(rep.summary.count, 8);
        assert_eq!(rep.summary.errors, 1);
        // typed round-trip
        let v = serde_json::to_value(&rep).unwrap();
        let _back: ReportJson = serde_json::from_value(v).unwrap();
    }

    #[test]
    fn build_report_omits_worker_breakdown_for_single_worker() {
        let r = run_row();
        // win() uses worker_id "w-0" -> single distinct worker.
        let rows = vec![
            win(100, "s", 3, 0, r#"{"200":3}"#, &[10_000, 10_000, 10_000]),
            win(101, "s", 2, 0, r#"{"200":2}"#, &[20_000, 20_000]),
        ];
        let yaml = r.scenario_yaml.clone();
        let rep = build_report(
            &r,
            &yaml,
            &rows,
            &[],
            &[],
            &[],
            &[],
            &[],
            &[],
            &[],
            &[],
            &crate::stair::StairInputs::default(),
            &[],
            None,
            None,
            None,
        );
        assert!(rep.worker_breakdown.is_empty());
        // skip_serializing_if -> field absent (byte-identical)
        let v = serde_json::to_value(&rep).unwrap();
        assert!(v.get("worker_breakdown").is_none());
    }

    #[test]
    fn build_report_excludes_legacy_empty_worker_id_from_breakdown() {
        let r = run_row();
        // legacy '' sentinel only -> 0 distinct non-empty -> no breakdown.
        let rows = vec![WindowWithHdr {
            failed_hdr_histogram: None,
            ts_second: 100,
            step_id: "s".into(),
            worker_id: "".into(),
            count: 4,
            error_count: 0,
            status_counts: r#"{"200":4}"#.into(),
            hdr_histogram: make_hdr_bytes(&[15_000, 15_000, 15_000, 15_000]),
        }];
        let yaml = r.scenario_yaml.clone();
        let rep = build_report(
            &r,
            &yaml,
            &rows,
            &[],
            &[],
            &[],
            &[],
            &[],
            &[],
            &[],
            &[],
            &crate::stair::StairInputs::default(),
            &[],
            None,
            None,
            None,
        );
        assert!(rep.worker_breakdown.is_empty());
    }

    #[test]
    fn build_report_worker_breakdown_tolerates_bad_hdr_blob() {
        let r = run_row();
        let rows = vec![
            WindowWithHdr {
                failed_hdr_histogram: None,
                ts_second: 100,
                step_id: "s".into(),
                worker_id: "w-0".into(),
                count: 2,
                error_count: 0,
                status_counts: r#"{"200":2}"#.into(),
                hdr_histogram: vec![0xff, 0xff, 0xff, 0xff], // undecodable
            },
            WindowWithHdr {
                failed_hdr_histogram: None,
                ts_second: 100,
                step_id: "s".into(),
                worker_id: "w-1".into(),
                count: 3,
                error_count: 0,
                status_counts: r#"{"200":3}"#.into(),
                hdr_histogram: make_hdr_bytes(&[30_000, 30_000, 30_000]),
            },
        ];
        let yaml = r.scenario_yaml.clone();
        let rep = build_report(
            &r,
            &yaml,
            &rows,
            &[],
            &[],
            &[],
            &[],
            &[],
            &[],
            &[],
            &[],
            &crate::stair::StairInputs::default(),
            &[],
            None,
            None,
            None,
        );
        assert_eq!(rep.worker_breakdown.len(), 2);
        // w-0: count counted despite bad blob, latency falls back to 0 (fail-soft)
        assert_eq!(rep.worker_breakdown[0].worker_id, "w-0");
        assert_eq!(rep.worker_breakdown[0].count, 2);
        assert_eq!(rep.worker_breakdown[0].p50_ms, 0);
        // w-1: normal
        assert_eq!(rep.worker_breakdown[1].count, 3);
        assert_eq!(rep.worker_breakdown[1].p50_ms, 30);
    }

    /// Scenario with Status assert — avoids no_response_validation so transport is isolated.
    const YAML_WITH_ASSERT: &str = r#"
version: 1
name: t
steps:
  - type: http
    id: step_a
    name: a
    request: { method: GET, url: "http://x/" }
    assert:
      - status: 200
"#;

    /// Unconditional http, no assert — triggers no_response_validation when no criteria.
    const YAML_NO_ASSERT: &str = r#"
version: 1
name: t
steps:
  - type: http
    id: step_a
    name: a
    request: { method: GET, url: "http://x/" }
"#;

    #[test]
    fn build_report_attaches_validity_transport_suspect() {
        // n0=80, n_http=20 → pct=0.8 critical → suspect; assert yaml isolates transport_heavy.
        let run = run_row();
        let rows = vec![win(
            100,
            "step_a",
            100,
            80,
            r#"{"0":80,"200":20}"#,
            &[10_000; 100],
        )];
        let rep = build_report(
            &run,
            YAML_WITH_ASSERT,
            &rows,
            &[],
            &[],
            &[],
            &[],
            &[],
            &[],
            &[],
            &[],
            &crate::stair::StairInputs::default(),
            &[],
            None,
            None,
            None,
        );
        assert_eq!(rep.validity.level, "suspect");
        assert!(
            rep.validity
                .reasons
                .iter()
                .any(|r| r.kind == "transport_heavy"),
            "transport_heavy reason attached"
        );
        assert!(
            rep.narrative
                .cannot_claim
                .iter()
                .any(|c| c == "sut_capacity")
        );
        assert!(
            rep.narrative
                .cannot_claim
                .iter()
                .any(|c| c == "production_identity"),
            "always production_identity"
        );
    }

    #[test]
    fn build_report_attaches_validity_unchecked_limited() {
        // 200-only, no assert, no criteria → no_response_validation → limited.
        let run = run_row();
        let rows = vec![win(100, "step_a", 10, 0, r#"{"200":10}"#, &[10_000; 10])];
        let rep = build_report(
            &run,
            YAML_NO_ASSERT,
            &rows,
            &[],
            &[],
            &[],
            &[],
            &[],
            &[],
            &[],
            &[],
            &crate::stair::StairInputs::default(),
            &[],
            None,
            None,
            None,
        );
        assert_eq!(rep.validity.level, "limited");
        assert!(
            rep.validity
                .reasons
                .iter()
                .any(|r| r.kind == "no_response_validation")
        );
        assert!(
            rep.narrative
                .can_claim
                .iter()
                .any(|c| c == "throughput_measured")
        );
        assert!(
            rep.narrative
                .cannot_claim
                .iter()
                .any(|c| c == "functional_correctness")
        );
        assert!(rep.narrative.cannot_claim.iter().any(|c| c == "slo_gate"));
    }

    #[test]
    fn build_report_attaches_validity_clean_ok() {
        // Assert present, all 200, no bad reasons → ok + production_identity only (cannot).
        let run = run_row();
        let rows = vec![win(100, "step_a", 10, 0, r#"{"200":10}"#, &[10_000; 10])];
        let rep = build_report(
            &run,
            YAML_WITH_ASSERT,
            &rows,
            &[],
            &[],
            &[],
            &[],
            &[],
            &[],
            &[],
            &[],
            &crate::stair::StairInputs::default(),
            &[],
            None,
            None,
            None,
        );
        assert_eq!(rep.validity.level, "ok");
        assert!(
            rep.validity.reasons.is_empty(),
            "clean run has no validity reasons"
        );
        assert!(
            rep.narrative
                .cannot_claim
                .iter()
                .any(|c| c == "production_identity")
        );
        // No active criteria → cannot claim slo_gate even when clean.
        assert!(rep.narrative.cannot_claim.iter().any(|c| c == "slo_gate"));
    }

    /// Mirrors the minimal `build_report` call sites above (`run_row()` + all-empty
    /// slices) but plugs `rows` into the new `error_kinds` argument.
    fn minimal_report_with_error_kinds(rows: &[crate::store::metrics::ErrorKindRow]) -> ReportJson {
        let run = run_row();
        build_report(
            &run,
            "",
            &[],
            &[],
            &[],
            &[],
            &[],
            &[],
            &[],
            rows,
            &[],
            &crate::stair::StairInputs::default(),
            &[],
            None,
            None,
            None,
        )
    }

    #[test]
    fn error_kinds_rollup_sorts_and_omits_when_empty() {
        // per-step rows → kind별 SUM, count desc → kind asc.
        let ek_row = |step: &str, kind: &str, count: i64| crate::store::metrics::ErrorKindRow {
            run_id: "r1".into(),
            step_id: step.into(),
            kind: kind.into(),
            count,
        };
        let rows = vec![
            ek_row("s1", "timeout", 5),
            ek_row("s2", "timeout", 5),          // 합산 10
            ek_row("s1", "connect_refused", 10), // 동률 kind asc는 BTreeMap 순회가 이미 보장(+ sort의 .then()이 map 타입 무관 방어) — 이 단언은 그 결과를 고정할 뿐 tie-break 코드 경로를 단독 검증하지 못한다
            ek_row("s1", "connection_reset", 1),
        ];
        let report = minimal_report_with_error_kinds(&rows);
        assert_eq!(
            report
                .error_kinds
                .iter()
                .map(|e| (e.kind.as_str(), e.count))
                .collect::<Vec<_>>(),
            vec![
                ("connect_refused", 10),
                ("timeout", 10),
                ("connection_reset", 1)
            ]
        );
        // 빈 입력 → 필드 자체가 JSON에서 생략 (byte-identical 축).
        let empty = minimal_report_with_error_kinds(&[]);
        let json = serde_json::to_string(&empty).unwrap();
        assert!(
            !json.contains("error_kinds"),
            "empty must be omitted: {json}"
        );
    }

    fn blank_ek(step: &str, kind: &str, count: i64) -> crate::store::metrics::ErrorKindRow {
        crate::store::metrics::ErrorKindRow {
            run_id: "r1".into(),
            step_id: step.into(),
            kind: kind.into(),
            count,
        }
    }

    #[test]
    fn report_not_sent_per_step() {
        let r = run_row();
        let rows = vec![
            win(100, "a", 10, 4, r#"{"200":6}"#, &[10_000]),
            win(100, "b", 5, 2, r#"{"200":3}"#, &[10_000]),
        ];
        let eks = vec![blank_ek("a", "blank_var", 4), blank_ek("b", "timeout", 2)];
        let rep = build_report(
            &r,
            "",
            &rows,
            &[],
            &[],
            &[],
            &[],
            &[],
            &[],
            &eks,
            &[],
            &crate::stair::StairInputs::default(),
            &[],
            None,
            None,
            None,
        );
        let a = rep.steps.iter().find(|s| s.step_id == "a").unwrap();
        let b = rep.steps.iter().find(|s| s.step_id == "b").unwrap();
        assert_eq!(a.not_sent, Some(4));
        assert_eq!(b.not_sent, None);
        let v = serde_json::to_value(&rep).unwrap();
        let steps = v["steps"].as_array().unwrap();
        let ja = steps.iter().find(|s| s["step_id"] == "a").unwrap();
        let jb = steps.iter().find(|s| s["step_id"] == "b").unwrap();
        assert!(ja.as_object().unwrap().contains_key("not_sent"));
        assert!(!jb.as_object().unwrap().contains_key("not_sent"));
        assert!(
            rep.error_kinds
                .iter()
                .any(|e| e.kind == "blank_var" && e.count == 4)
        );
        assert_eq!(rep.summary.count, 15, "summary count untouched");
    }

    #[test]
    fn reuse_ratio_excludes_not_sent() {
        use crate::store::metrics::PhaseMetricRow;
        let r = run_row();
        let rows = vec![win(100, "a", 10, 4, r#"{"200":6}"#, &[10_000])];
        let eks = vec![blank_ek("a", "blank_var", 4)];
        let phases = vec![PhaseMetricRow {
            run_id: r.id.clone(),
            step_id: "a".into(),
            phase: "connect".into(),
            hdr_histogram: make_hdr_bytes(&[15_000]),
            count: 3,
        }];
        let rep = build_report(
            &r,
            "",
            &rows,
            &[],
            &[],
            &[],
            &phases,
            &[],
            &[],
            &eks,
            &[],
            &crate::stair::StairInputs::default(),
            &[],
            None,
            None,
            None,
        );
        let c = rep.connection.as_ref().expect("connection present");
        assert_eq!(c.requests_total, 6);
        assert!((c.reuse_ratio - 0.5).abs() < 1e-9);
        assert_eq!(rep.summary.count, 10);
    }

    fn minimal_report_with_loop_exits(rows: &[crate::store::metrics::LoopExitRow]) -> ReportJson {
        let run = run_row();
        build_report(
            &run,
            "",
            &[],
            &[],
            &[],
            &[],
            &[],
            &[],
            &[],
            &[],
            rows,
            &crate::stair::StairInputs::default(),
            &[],
            None,
            None,
            None,
        )
    }

    #[test]
    fn loop_exits_rollup_buckets_totals_and_omits_when_empty() {
        let row = |step: &str, bucket: i64, outcome: i64, count: i64, sum: i64| {
            crate::store::metrics::LoopExitRow {
                run_id: "r1".into(),
                step_id: step.into(),
                pass_bucket: bucket,
                outcome,
                count,
                pass_sum: sum,
            }
        };
        // SQL 순서(step_id, pass_bucket, outcome)대로.
        let rows = vec![
            row("la", 1, 0, 816, 816),
            row("la", 1, 2, 1, 1),
            row("la", 5, 0, 12, 60),
            row("la", 5, 1, 12, 60),
            row("la", 21, 0, 3, 90),
            row("la", 21, 2, 2, 80),
            row("lb", 1, 0, 4, 4),
        ];
        let rep = minimal_report_with_loop_exits(&rows);
        assert_eq!(rep.loop_exits.len(), 2);
        let la = &rep.loop_exits[0];
        assert_eq!(
            (
                la.step_id.as_str(),
                la.entered,
                la.passes,
                la.exhausted,
                la.truncated
            ),
            ("la", 846, 1107, 12, 3)
        );
        assert_eq!(
            la.buckets
                .iter()
                .map(|b| (b.pass, b.completed, b.exhausted, b.truncated))
                .collect::<Vec<_>>(),
            vec![(Some(1), 816, 0, 1), (Some(5), 12, 12, 0), (None, 3, 0, 2)]
        );
        assert_eq!(rep.loop_exits[1].step_id, "lb");

        let json = serde_json::to_value(&rep).unwrap();
        let last = &json["loop_exits"][0]["buckets"][2];
        assert!(
            last.as_object().unwrap().contains_key("pass") && last["pass"].is_null(),
            "21번째 이후는 pass: null로 직렬화: {last}"
        );

        let empty = minimal_report_with_loop_exits(&[]);
        let s = serde_json::to_string(&empty).unwrap();
        assert!(!s.contains("loop_exits"), "empty must be omitted: {s}");
        // typed round-trip: 키가 없어도 역직렬화된다.
        let back: ReportJson = serde_json::from_str(&s).unwrap();
        assert!(back.loop_exits.is_empty());
    }

    #[test]
    fn report_run_status_rule_default() {
        let json = r#"{"id":"r","scenario_id":"s","status":"completed","profile":null,"env":null,"started_at":null,"ended_at":null,"created_at":0}"#;
        let rr: ReportRun = serde_json::from_str(json).unwrap();
        assert_eq!(rr.status_rule, crate::store::runs::STATUS_RULE_LEGACY);
    }

    #[test]
    fn report_json_always_has_status_rule() {
        let mut run = run_row();
        run.status_rule = crate::store::runs::STATUS_RULE_CURRENT;
        let rep = build_report(
            &run,
            "",
            &[],
            &[],
            &[],
            &[],
            &[],
            &[],
            &[],
            &[],
            &[],
            &crate::stair::StairInputs::default(),
            &[],
            None,
            None,
            None,
        );
        let v = serde_json::to_value(&rep).unwrap();
        let obj = v["run"].as_object().unwrap();
        assert!(
            obj.contains_key("status_rule"),
            "키가 빠지면 새 run이 옛 규칙으로 읽힌다"
        );
        assert_eq!(obj["status_rule"], 2);
    }

    #[test]
    fn report_json_always_has_latency_rule() {
        let mut run = run_row();
        run.latency_rule = crate::store::runs::LATENCY_RULE_CURRENT;
        let rep = build_report(
            &run,
            "",
            &[],
            &[],
            &[],
            &[],
            &[],
            &[],
            &[],
            &[],
            &[],
            &crate::stair::StairInputs::default(),
            &[],
            None,
            None,
            None,
        );
        let v = serde_json::to_value(&rep).unwrap();
        let obj = v["run"].as_object().unwrap();
        assert!(
            obj.contains_key("latency_rule"),
            "키가 빠지면 새 run이 옛 규칙으로 읽힌다"
        );
        assert_eq!(obj["latency_rule"], 2);
        let json = r#"{"id":"r","scenario_id":"s","status":"completed","profile":null,"env":null,"started_at":null,"ended_at":null,"created_at":0}"#;
        let rr: ReportRun = serde_json::from_str(json).unwrap();
        assert_eq!(rr.latency_rule, crate::store::runs::LATENCY_RULE_LEGACY);
    }

    #[test]
    fn report_run_label_serialization_two_states() {
        let mut rr = ReportRun {
            id: "r".into(),
            scenario_id: "s".into(),
            status: "completed".into(),
            profile: serde_json::Value::Null,
            env: serde_json::Value::Null,
            started_at: None,
            ended_at: None,
            created_at: 0,
            label: None,
            status_rule: crate::store::runs::STATUS_RULE_LEGACY,
            latency_rule: crate::store::runs::LATENCY_RULE_LEGACY,
        };
        let v = serde_json::to_value(&rr).unwrap();
        assert!(
            v.get("label").is_none(),
            "무라벨은 키 자체가 없어야(byte-identical)"
        );
        rr.label = Some("라벨".into());
        assert_eq!(serde_json::to_value(&rr).unwrap()["label"], "라벨");
    }

    // ── 계단 시험 리포트 (stage-saturation-table, spec §5.1–§5.7) ─────────────
    mod stair_report {
        use super::*;
        use crate::stair::{
            BandKind, HeadlineKind, ReasonKind, StairConfig, StairInputs, StairReport, StepState,
            build_stair_report, expand_stair,
        };
        use crate::store::open_loop::{OpenLoopSecondRow, WorkerStartRow};

        /// 초 경계에 딱 맞는 t0(ms) = ts 1000.
        const T0: i64 = 1_000_000;

        fn scfg(targets: &[u32], ramp: u32, hold: u32, discard: u32) -> StairConfig {
            StairConfig {
                targets: targets.to_vec(),
                hold_seconds: hold,
                ramp_seconds: ramp,
                discard_seconds: discard,
                p99_cap_ms: None,
                auto_stop: None,
            }
        }

        fn sprofile(c: &StairConfig) -> Profile {
            let mut p = run_row().profile;
            p.duration_seconds = 0;
            p.max_in_flight = Some(50);
            p.stages = Some(expand_stair(c));
            p.stair = Some(c.clone());
            p
        }

        fn hist(pairs: &[(u64, u64)]) -> Histogram<u64> {
            let mut h = fresh_hist();
            for &(v, n) in pairs {
                if n > 0 {
                    h.record_n(v, n).unwrap();
                }
            }
            h
        }

        fn hdr(pairs: &[(u64, u64)]) -> Vec<u8> {
            let mut buf = Vec::new();
            V2Serializer::new()
                .serialize(&hist(pairs), &mut buf)
                .unwrap();
            buf
        }

        fn mrow(
            w: &str,
            ts: i64,
            step: &str,
            count: u64,
            errors: u64,
            pairs: &[(u64, u64)],
        ) -> WindowWithHdr {
            WindowWithHdr {
                failed_hdr_histogram: None,
                ts_second: ts,
                step_id: step.into(),
                worker_id: w.into(),
                count: count as i64,
                error_count: errors as i64,
                status_counts: format!(r#"{{"200":{count}}}"#),
                hdr_histogram: hdr(pairs),
            }
        }

        fn ol(w: &str, ts: i64, launched: u64, completed: u64, dropped: u64) -> OpenLoopSecondRow {
            OpenLoopSecondRow {
                worker_id: w.into(),
                ts_second: ts,
                launched: launched as i64,
                completed: completed as i64,
                dropped: dropped as i64,
            }
        }

        fn start(w: &str, ms: i64) -> WorkerStartRow {
            WorkerStartRow {
                worker_id: w.into(),
                started_at_ms: ms,
            }
        }

        /// 한 초의 모양. 반복당 요청 1개라 요청 수 = completed.
        #[derive(Clone, Copy)]
        struct Sec {
            launched: u64,
            completed: u64,
            dropped: u64,
            errors: u64,
            lat_us: u64,
        }

        fn sec(completed: u64, lat_us: u64) -> Sec {
            Sec {
                launched: completed,
                completed,
                dropped: 0,
                errors: 0,
                lat_us,
            }
        }

        #[derive(Default)]
        struct Fx {
            rows: Vec<WindowWithHdr>,
            inp: StairInputs,
        }

        impl Fx {
            /// 워커 `w`의 ts `t0_s + o`(o = 0..len)를 `f(o)`로 채운다. None = 그 초 행 없음.
            fn fill(&mut self, w: &str, t0_s: i64, len: i64, f: impl Fn(i64) -> Option<Sec>) {
                for o in 0..len {
                    if let Some(s) = f(o) {
                        let ts = t0_s + o;
                        self.inp
                            .open_loop
                            .push(ol(w, ts, s.launched, s.completed, s.dropped));
                        if s.completed > 0 {
                            self.rows.push(mrow(
                                w,
                                ts,
                                "s",
                                s.completed,
                                s.errors,
                                &[(s.lat_us, s.completed)],
                            ));
                        }
                    }
                }
            }

            fn dropped(&self) -> u64 {
                self.inp
                    .open_loop
                    .iter()
                    .map(|r| r.dropped.max(0) as u64)
                    .sum()
            }

            fn report(&self, c: &StairConfig) -> StairReport {
                build_stair_report(&sprofile(c), self.dropped(), &self.rows, &self.inp)
                    .expect("stair run → Some")
            }

            fn full(&self, c: &StairConfig) -> ReportJson {
                let mut run = run_row();
                run.profile = sprofile(c);
                run.dropped = self.dropped() as i64;
                build_report(
                    &run,
                    "",
                    &self.rows,
                    &[],
                    &[],
                    &[],
                    &[],
                    &[],
                    &[],
                    &[],
                    &[],
                    &self.inp,
                    &[],
                    None,
                    None,
                    None,
                )
            }
        }

        fn has_reason(r: &ReportJson, kind: &str) -> bool {
            r.validity.reasons.iter().any(|x| x.kind == kind)
        }

        /// 공유 누적기(계단 시험 b §4.3): 리포트(DB 행) ↔ 감시(받은 순서가 섞인 배치) 비트 동일성.
        mod accumulator {
            use super::*;
            use crate::stair::{Bound, StairAccumulator};

            fn xorshift(s: &mut u64) -> u64 {
                *s ^= *s << 13;
                *s ^= *s >> 7;
                *s ^= *s << 17;
                *s
            }

            fn shuffle<T>(v: &mut [T], seed: u64) {
                let mut s = seed;
                for i in (1..v.len()).rev() {
                    let j = (xorshift(&mut s) % (i as u64 + 1)) as usize;
                    v.swap(i, j);
                }
            }

            enum Ev<'a> {
                Ol(&'a OpenLoopSecondRow),
                M(&'a WindowWithHdr),
            }

            /// ramp 1 + hold 12(버림 2) = 계단 13초, 측정 10초.
            fn cfg3() -> StairConfig {
                scfg(&[1, 1, 1], 1, 12, 2)
            }

            /// (워커, t0 ms) — 서로 다른 t0, 하나는 초 경계 + 300 ms(측정 초 9).
            const WORKERS: [(&str, i64); 3] =
                [("w1", T0), ("w2", T0 + 2_000), ("w3", T0 + 5_000 + 300)];

            /// 계단별 측정 구간에서 워커가 한 초에 낸 완료 수(나머지 측정 초는 0).
            /// 워커별 달성율 = 4/10·5/10·6/9처럼 f64 합 순서에 민감한 값이 된다.
            const PULSE: [[u64; 3]; 3] = [[4, 5, 6], [600, 500, 400], [5, 6, 4]];

            fn fixture() -> Fx {
                let mut fx = Fx::default();
                for (k, (w, t0)) in WORKERS.iter().enumerate() {
                    fx.inp.starts.push(start(w, *t0));
                    fx.fill(w, t0.div_euclid(1000), 39, |o| {
                        let (i, pos) = ((o / 13) as usize, o % 13);
                        // 상승·버림 초는 5(측정에 섞이면 값이 바뀐다), 측정 초는 5번째만 펄스.
                        let completed = match pos {
                            0..=2 => 5,
                            5 => PULSE[i][k],
                            _ => 0,
                        };
                        let mut s = sec(completed, 1_000 * (k as u64 + 1) + 100 * i as u64);
                        // 스케줄러는 매 초 도착을 만든다(마지막 초가 측정 구간 끝을 정한다).
                        s.launched = s.launched.max(1);
                        if i == 1 && k == 0 && pos == 5 {
                            s.errors = 1;
                        }
                        Some(s)
                    });
                }
                fx
            }

            fn feed(c: &StairConfig, fx: &Fx, seed: u64) -> StairAccumulator {
                let mut acc = StairAccumulator::new(c, false);
                let mut ws: Vec<(&str, i64)> = WORKERS.to_vec();
                shuffle(&mut ws, seed);
                for (w, t0) in ws {
                    acc.set_worker(w, t0, Bound::Open);
                }
                let mut evs: Vec<Ev> = fx
                    .inp
                    .open_loop
                    .iter()
                    .map(Ev::Ol)
                    .chain(fx.rows.iter().map(Ev::M))
                    .collect();
                shuffle(&mut evs, seed ^ 0x9E37_79B9_7F4A_7C15);
                for e in &evs {
                    match e {
                        Ev::Ol(r) => acc.push_open_loop(
                            &r.worker_id,
                            r.ts_second,
                            r.launched,
                            r.completed,
                            r.dropped,
                        ),
                        Ev::M(r) => {
                            let h = handicap_engine::percentiles::decode_hdr(&r.hdr_histogram)
                                .ok()
                                .flatten();
                            acc.push_metric(
                                &r.worker_id,
                                r.ts_second,
                                r.count,
                                r.error_count,
                                h.as_ref(),
                            );
                        }
                    }
                }
                acc
            }

            #[test]
            fn accumulator_matches_report_bitwise_shuffled() {
                let c = cfg3();
                let fx = fixture();
                let rep = fx.report(&c);
                // 전 계단이 판정된 정상 계단(리포트가 숫자를 가리지 않음).
                assert!(rep.steps.iter().all(|s| s.state == StepState::Ok));
                // 계단 0 달성 = 워커별 (펄스 ÷ 측정 초) 를 worker_id 순으로 더한 손계산.
                assert_eq!(
                    rep.steps[0].achieved.unwrap().to_bits(),
                    (4.0 / 10.0 + 5.0 / 10.0 + 6.0 / 9.0_f64).to_bits()
                );
                for seed in 1..=8u64 {
                    let acc = feed(&c, &fx, seed);
                    let nums = acc.numbers(&[true, true, true], false);
                    assert_eq!(nums.len(), 3);
                    for (i, n) in nums.iter().enumerate() {
                        let s = &rep.steps[i];
                        assert_eq!(
                            n.achieved.map(f64::to_bits),
                            s.achieved.map(f64::to_bits),
                            "achieved seed {seed} step {i}"
                        );
                        assert_eq!(n.dropped, s.dropped, "dropped seed {seed} step {i}");
                        assert_eq!(
                            n.error_rate.to_bits(),
                            s.error_rate.to_bits(),
                            "error_rate seed {seed} step {i}"
                        );
                        assert_eq!(n.p99_us, s.p99_us, "p99 seed {seed} step {i}");
                        assert_eq!(n.measured, s.measured_seconds * 2 >= 10);
                        assert!(n.measured);
                    }
                    // 계단 1에 오류 1건이 들어갔다(이빨: 오류율이 0이 아님).
                    assert!(nums[1].error_rate > 0.0);
                }
            }

            #[test]
            fn accumulator_open_bound_counts_full_window() {
                let c = cfg3();
                let mut acc = StairAccumulator::new(&c, false);
                acc.set_worker("a", T0, Bound::Open);
                acc.set_worker("b", T0, Bound::Upto(1005));
                // 행이 하나도 없어도 Open은 측정 구간 끝까지.
                assert_eq!(acc.window("a", 0), Some((1003, 1013)));
                assert_eq!(acc.window("a", 2), Some((1029, 1039)));
                // Upto(last)는 last+1초에서 자른다.
                assert_eq!(acc.window("b", 0), Some((1003, 1006)));
                assert_eq!(acc.window("nope", 0), None);
            }
        }

        #[test]
        fn stair_aligned_t0_counts_measure_seconds() {
            let c = scfg(&[100, 200], 1, 20, 5);
            let mut fx = Fx::default();
            fx.inp.starts.push(start("w", T0));
            // 측정 초(offset 6..21, 27..42)만 목표만큼, 상승·버림 초는 50 — 섞이면 달성이 바뀐다.
            fx.fill("w", 1000, 42, |o| {
                let measure = (6..21).contains(&o) || (27..42).contains(&o);
                let t = if o < 21 { 100 } else { 200 };
                Some(sec(if measure { t } else { 50 }, 2_000))
            });
            let r = fx.report(&c);
            assert_eq!(r.steps[0].measured_seconds, 15);
            assert_eq!(r.steps[0].achieved, Some(100.0));
            assert_eq!(r.steps[1].measured_seconds, 15);
            assert_eq!(r.steps[1].achieved, Some(200.0));
            assert_eq!(
                r.steps[0].head_p99_ratio, None,
                "측정 20초 미만은 ⚠ 계산 안 함"
            );
            assert!(!r.notes.t0_estimated && !r.notes.open_loop_unknown);
            assert_eq!(r.steps[0].state, StepState::Ok);
            assert_eq!(r.headline.kind, HeadlineKind::AllOk);
            assert_eq!(r.headline.through_target, Some(200));
        }

        #[test]
        fn stair_offset_t0_excludes_partial_edges() {
            let c = scfg(&[100, 200], 1, 20, 5);
            let mut fx = Fx::default();
            fx.inp.starts.push(start("w", T0 + 300));
            // t0 = 1000.3s → 계단0 측정 = ts 1007..1021(14초). 1006은 부분 초라 빠진다.
            fx.fill("w", 1000, 43, |o| {
                let measure = (7..21).contains(&o) || (28..42).contains(&o);
                let t = if o < 21 { 100 } else { 200 };
                Some(sec(if measure { t } else { 50 }, 2_000))
            });
            let r = fx.report(&c);
            assert_eq!(r.steps[0].measured_seconds, 14);
            assert_eq!(r.steps[0].achieved, Some(100.0));
            assert_eq!(r.steps[1].measured_seconds, 14);
            assert_eq!(r.steps[1].achieved, Some(200.0));
        }

        #[test]
        fn stair_stalled_system_is_saturated_not_unmeasured() {
            let c = scfg(&[100, 200], 1, 20, 5);
            let mut fx = Fx::default();
            fx.inp.starts.push(start("w", T0));
            // 계단1: 완료 0 → run_metrics 행 없음, 초 단위 계수만 launched·dropped > 0.
            fx.fill("w", 1000, 42, |o| {
                if o < 21 {
                    Some(sec(100, 2_000))
                } else {
                    Some(Sec {
                        launched: 50,
                        completed: 0,
                        dropped: 150,
                        errors: 0,
                        lat_us: 0,
                    })
                }
            });
            let r = fx.report(&c);
            assert_eq!(r.steps[1].measured_seconds, 15);
            assert_eq!(r.steps[1].achieved, Some(0.0));
            assert_eq!(r.steps[1].state, StepState::Saturated);
            assert_eq!(r.steps[0].state, StepState::Ok);
        }

        #[test]
        fn stair_scheduler_ended_early_is_not_measured() {
            let c = scfg(&[100, 200], 1, 20, 5);
            let mut fx = Fx::default();
            fx.inp.starts.push(start("w", T0));
            // 계단1 측정 = offset 27..42. 스케줄러는 offset 31(측정 1/3 지점)에서 멈추고,
            // 그 뒤는 진행 중 요청이 끝나는 completed-only 꼬리.
            fx.fill("w", 1000, 42, |o| {
                if o < 21 {
                    Some(sec(100, 2_000))
                } else if o <= 31 {
                    Some(sec(200, 2_000))
                } else {
                    Some(Sec {
                        launched: 0,
                        completed: 5,
                        dropped: 0,
                        errors: 0,
                        lat_us: 2_000,
                    })
                }
            });
            let r = fx.report(&c);
            assert_eq!(r.steps[1].measured_seconds, 5);
            assert_eq!(r.steps[1].state, StepState::NotMeasured);
            assert_eq!(r.steps[0].state, StepState::Ok);
            assert_eq!(r.headline.kind, HeadlineKind::OkThenUnmeasured);
        }

        /// 워커별로 측정 초는 목표의 절반, 상승·버림 초는 10.
        fn half_worker(fx: &mut Fx, w: &str, t0_s: i64) {
            fx.fill(w, t0_s, 42, |o| {
                let measure = (6..21).contains(&o) || (27..42).contains(&o);
                let t = if o < 21 { 50 } else { 100 };
                Some(sec(if measure { t } else { 10 }, 2_000))
            });
        }

        #[test]
        fn stair_two_workers_align_per_worker_t0() {
            let c = scfg(&[100, 200], 1, 20, 5);
            let mut fx = Fx::default();
            fx.inp.starts.push(start("a", 1_000_000));
            fx.inp.starts.push(start("b", 1_003_000));
            half_worker(&mut fx, "a", 1000);
            half_worker(&mut fx, "b", 1003);
            let r = fx.report(&c);
            assert_eq!(r.steps[0].measured_seconds, 15);
            assert_eq!(r.steps[0].achieved, Some(100.0));
            assert_eq!(r.steps[0].throughput_rps, 100.0);
            assert_eq!(r.steps[1].achieved, Some(200.0));
            assert_eq!(r.steps[1].dropped, Some(0));
            assert_eq!(r.headline.kind, HeadlineKind::AllOk);
        }

        #[test]
        fn stair_idle_worker_excluded() {
            let c = scfg(&[100, 200], 1, 20, 5);
            let mut fx = Fx::default();
            fx.inp.starts.push(start("a", T0));
            fx.inp.starts.push(start("c", T0));
            fx.fill("a", 1000, 42, |o| {
                Some(sec(if o < 21 { 100 } else { 200 }, 2_000))
            });
            // 워커 C: 몫이 0이라 0만 담긴 행.
            fx.fill("c", 1000, 42, |_| Some(sec(0, 0)));
            let r = fx.report(&c);
            assert_eq!(r.steps[0].measured_seconds, 15);
            assert_eq!(r.steps[1].measured_seconds, 15);
            assert_eq!(r.steps[1].state, StepState::Ok);
        }

        #[test]
        fn stair_t0_fallback_sets_note() {
            let c = scfg(&[100, 200], 1, 20, 5);
            let mut fx = Fx::default();
            fx.fill("w", 1000, 42, |o| {
                Some(sec(if o < 21 { 100 } else { 200 }, 2_000))
            });
            let r = fx.report(&c);
            assert!(r.notes.t0_estimated);
            // 폴백 t0 = run_metrics 최소 ts × 1000 = 1_000_000 (초 경계) → 15초.
            assert_eq!(r.steps[0].measured_seconds, 15);
            assert_eq!(r.steps[0].measure_start_ms, 1_006_000);
        }

        #[test]
        fn stair_no_open_loop_rows_unknown() {
            let c = scfg(&[100, 200], 1, 20, 5);
            let mut fx = Fx::default();
            fx.inp.starts.push(start("w", T0));
            fx.fill("w", 1000, 42, |o| {
                let mut s = sec(if o < 21 { 100 } else { 200 }, 2_000);
                s.dropped = 3;
                Some(s)
            });
            fx.inp.open_loop.clear();
            let r = build_stair_report(&sprofile(&c), 126, &fx.rows, &fx.inp).unwrap();
            assert!(r.notes.open_loop_unknown);
            assert_eq!(r.steps[0].achieved, None);
            assert_eq!(r.steps[0].dropped, None);
            assert_eq!(r.steps[0].launched_rate, None);
            assert_eq!(r.steps[0].measured_seconds, 15);
            assert!(!r.dropped_explained);
            assert_eq!(r.steps[1].state, StepState::Ok, "지연·오류로만 판정");
            assert!(
                r.seconds
                    .iter()
                    .all(|s| s.launched.is_none() && s.completed.is_none() && s.dropped.is_none())
            );
        }

        #[test]
        fn stair_no_open_loop_rows_zero_requests_is_not_measured() {
            // 예전 부하기 + 측정 구간 요청 0 → 달성을 모르니 정상으로 넘기지 않는다.
            let c = scfg(&[100, 200], 1, 20, 5);
            let mut fx = Fx::default();
            fx.inp.starts.push(start("w", T0));
            // 측정 = offset 27..42; offset 42(측정 뒤)에 행이 있어 run 끝은 측정 구간 뒤다.
            fx.fill("w", 1000, 43, |o| {
                if (27..42).contains(&o) {
                    None
                } else {
                    Some(sec(if o < 21 { 100 } else { 200 }, 2_000))
                }
            });
            fx.inp.open_loop.clear();
            let r = fx.report(&c);
            assert!(r.notes.open_loop_unknown);
            assert_eq!(r.steps[1].measured_seconds, 15);
            assert_eq!(r.steps[1].state, StepState::NotMeasured);
            assert_eq!(r.steps[0].state, StepState::Ok);
        }

        #[test]
        fn stair_p99_is_merged_hdr_not_average() {
            let c = scfg(&[100, 200], 1, 20, 5);
            let mut fx = Fx::default();
            fx.inp.starts.push(start("w", T0));
            fx.fill("w", 1000, 42, |o| {
                let t = if o < 21 { 100 } else { 200 };
                Some(Sec {
                    launched: t,
                    completed: 0,
                    dropped: 0,
                    errors: 0,
                    lat_us: 0,
                })
            });
            let a = [(1_000, 99)];
            let b = [(100_000, 1)];
            fx.rows.push(mrow("w", 1006, "s", 99, 0, &a));
            fx.rows.push(mrow("w", 1007, "s", 1, 0, &b));
            let mut merged = hist(&a);
            merge_into(&mut merged, &hist(&b));
            let want = merged.value_at_quantile(0.99);
            let avg = (hist(&a).value_at_quantile(0.99) + hist(&b).value_at_quantile(0.99)) / 2;
            assert_ne!(want, avg);
            let r = fx.report(&c);
            assert_eq!(r.steps[0].p99_us, want);
            assert_eq!(r.steps[0].p50_us, merged.value_at_quantile(0.50));
            assert_eq!(r.steps[0].p95_us, merged.value_at_quantile(0.95));
        }

        #[test]
        fn stair_two_requests_per_iteration() {
            let c = scfg(&[100, 200], 1, 20, 5);
            let mut fx = Fx::default();
            fx.inp.starts.push(start("w", T0));
            for o in 0..42 {
                let t: u64 = if o < 21 { 100 } else { 200 };
                fx.inp.open_loop.push(ol("w", 1000 + o, t, t, 0));
                fx.rows.push(mrow("w", 1000 + o, "a", t, 0, &[(2_000, t)]));
                fx.rows.push(mrow("w", 1000 + o, "b", t, 0, &[(2_000, t)]));
            }
            let r = fx.report(&c);
            assert_eq!(r.steps[0].achieved, Some(100.0));
            assert_eq!(r.steps[0].throughput_rps, 200.0);
            assert_eq!(
                r.steps[1].throughput_rps,
                2.0 * r.steps[1].achieved.unwrap()
            );
        }

        #[test]
        fn stair_head_ratio_warns() {
            let c = scfg(&[100, 200], 1, 35, 5);
            let mut fx = Fx::default();
            fx.inp.starts.push(start("w", T0));
            // 계단0 측정 = offset 6..36(30초): 첫 10초 10ms, 나머지 4ms. 계단1은 고르게 4ms.
            fx.fill("w", 1000, 72, |o| {
                let lat = if (6..16).contains(&o) { 10_000 } else { 4_000 };
                Some(sec(if o < 36 { 100 } else { 200 }, lat))
            });
            let r = fx.report(&c);
            assert_eq!(r.steps[0].measured_seconds, 30);
            let ratio = r.steps[0].head_p99_ratio.expect("측정 20초 이상");
            assert!(ratio >= 2.0, "ratio = {ratio}");
            assert!(r.steps[0].discard_warning);
            assert!(!r.steps[1].discard_warning);
            assert!(r.steps[1].head_p99_ratio.expect("측정 30초") < 1.01);
        }

        /// 계단0 정상, 계단1 = `step1` 모양.
        fn two_step(step1: Sec) -> (StairConfig, Fx) {
            let c = scfg(&[100, 200], 1, 20, 5);
            let mut fx = Fx::default();
            fx.inp.starts.push(start("w", T0));
            fx.fill("w", 1000, 42, |o| {
                if o < 21 {
                    Some(sec(100, 2_000))
                } else {
                    Some(step1)
                }
            });
            (c, fx)
        }

        #[test]
        fn stair_dropped_in_latency_failed_step_is_explained() {
            let (c, fx) = two_step(Sec {
                launched: 190,
                completed: 190,
                dropped: 10,
                errors: 0,
                lat_us: 20_000,
            });
            let r = fx.report(&c);
            assert_eq!(r.steps[1].state, StepState::Saturated);
            let kinds: Vec<ReasonKind> = r.steps[1].reasons.iter().map(|x| x.kind).collect();
            assert!(kinds.contains(&ReasonKind::Dropped));
            assert!(kinds.contains(&ReasonKind::P99Relative));
            assert!(!r.steps[1].slot_limited);
            assert!(r.dropped_explained);
            assert!(r.slot_limited_targets.is_empty());

            let full = fx.full(&c);
            assert!(full.stair.is_some());
            assert!(
                full.insights.iter().any(|i| i.kind == "load_gen_saturated"),
                "인사이트 자체는 그대로"
            );
            assert!(!has_reason(&full, "load_not_delivered"));
        }

        #[test]
        fn stair_slot_limited_keeps_banner() {
            let (c, fx) = two_step(Sec {
                launched: 190,
                completed: 190,
                dropped: 10,
                errors: 0,
                lat_us: 2_000,
            });
            let r = fx.report(&c);
            assert_eq!(r.steps[1].state, StepState::Saturated);
            assert!(r.steps[1].slot_limited);
            assert_eq!(r.slot_limited_targets, vec![200]);
            assert!(!r.dropped_explained);
            assert_eq!(r.max_in_flight, Some(50));
            assert_eq!(r.dropped_total, Some(fx.dropped()));

            let full = fx.full(&c);
            assert!(full.insights.iter().any(|i| i.kind == "load_gen_saturated"));
            assert!(has_reason(&full, "load_not_delivered"));
        }

        #[test]
        fn non_stair_report_has_no_stair_key() {
            let rows = vec![win(100, "s", 5, 0, r#"{"200":5}"#, &[10_000; 5])];
            let rep = build_report(
                &run_row(),
                "",
                &rows,
                &[],
                &[],
                &[],
                &[],
                &[],
                &[],
                &[],
                &[],
                &StairInputs::default(),
                &[],
                None,
                None,
                None,
            );
            assert!(rep.stair.is_none());
            let v = serde_json::to_value(&rep).unwrap();
            assert!(v.get("stair").is_none());
        }

        #[test]
        fn stair_bands_and_target_line_shape() {
            let c = scfg(&[100, 200], 2, 20, 5);
            let r = build_stair_report(&sprofile(&c), 0, &[], &StairInputs::default()).unwrap();
            let bands: Vec<(u32, BandKind, u64, u64)> = r
                .bands
                .iter()
                .map(|b| (b.index, b.kind, b.start_s, b.end_s))
                .collect();
            assert_eq!(
                bands,
                vec![
                    (0, BandKind::Ramp, 0, 2),
                    (0, BandKind::Discard, 2, 7),
                    (0, BandKind::Measure, 7, 22),
                    (1, BandKind::Ramp, 22, 24),
                    (1, BandKind::Discard, 24, 29),
                    (1, BandKind::Measure, 29, 44),
                ]
            );
            let line: Vec<(u64, u32)> = r
                .target_line
                .iter()
                .map(|p| (p.offset_s, p.target))
                .collect();
            assert_eq!(
                line,
                vec![(0, 0), (2, 100), (22, 100), (24, 200), (44, 200)]
            );
            // 꼭짓점 = 펼친 stages의 누적 끝 시각·목표.
            let mut acc = 0u64;
            let from_stages: Vec<(u64, u32)> = std::iter::once((0, 0))
                .chain(expand_stair(&c).iter().map(|s| {
                    acc += u64::from(s.duration_seconds);
                    (acc, s.target)
                }))
                .collect();
            assert_eq!(line, from_stages);
            // 데이터가 없으면 판정할 수 없음.
            assert_eq!(r.headline.kind, HeadlineKind::NoData);
            assert!(r.steps.iter().all(|s| s.state == StepState::NotMeasured));
        }

        #[test]
        fn stair_seconds_align_two_workers() {
            let c = scfg(&[100, 200], 1, 20, 5);
            let mut fx = Fx::default();
            fx.inp.starts.push(start("a", 1_000_000));
            fx.inp.starts.push(start("b", 1_003_000));
            fx.inp.open_loop.push(ol("a", 1010, 3, 3, 0));
            fx.inp.open_loop.push(ol("b", 1013, 1, 1, 0));
            fx.rows.push(mrow("a", 1010, "s", 3, 0, &[(1_000, 3)]));
            fx.rows.push(mrow("b", 1013, "s", 1, 0, &[(50_000, 1)]));
            let r = fx.report(&c);
            assert_eq!(r.seconds.len(), 1, "{:?}", r.seconds);
            let s = &r.seconds[0];
            assert_eq!(s.offset_s, 10);
            assert_eq!(s.count, 4);
            assert_eq!(s.launched, Some(4));
            assert_eq!(s.completed, Some(4));
            assert_eq!(s.dropped, Some(0));
            let mut merged = hist(&[(1_000, 3)]);
            merge_into(&mut merged, &hist(&[(50_000, 1)]));
            assert_eq!(s.p99_us, merged.value_at_quantile(0.99));
        }

        #[test]
        fn stair_measure_times_and_launched_rate() {
            let c = scfg(&[100, 200], 1, 20, 5);
            let mut fx = Fx::default();
            fx.inp.starts.push(start("a", T0 + 300));
            fx.inp.starts.push(start("b", 1_002_000));
            fx.fill("a", 1000, 43, |_| {
                Some(Sec {
                    launched: 110,
                    completed: 100,
                    dropped: 0,
                    errors: 0,
                    lat_us: 2_000,
                })
            });
            fx.fill("b", 1002, 42, |_| Some(sec(20, 2_000)));
            let r = fx.report(&c);
            // 가장 이른 t0 = 워커 a(1000.3s): 계단0 포함 초 1007..1021.
            assert_eq!(r.steps[0].measure_start_ms, 1_007_000);
            assert_eq!(r.steps[0].measure_end_ms, 1_021_000);
            assert_eq!(r.steps[1].measure_start_ms, 1_028_000);
            assert_eq!(r.steps[1].measure_end_ms, 1_042_000);
            assert_eq!(r.steps[0].launched_rate, Some(130.0));
            assert_eq!(r.steps[0].achieved, Some(120.0));
            assert_eq!(r.steps[0].measured_seconds, 14, "워커별 측정 초의 최솟값");
        }

        /// 계단0·1 정상, 계단2 = 지연으로도 무너지며 dropped(설명됨).
        fn three_step() -> (StairConfig, Fx) {
            let c = scfg(&[100, 200, 300], 1, 20, 5);
            let mut fx = Fx::default();
            fx.inp.starts.push(start("w", T0));
            fx.fill("w", 1000, 63, |o| {
                if o < 21 {
                    Some(sec(100, 2_000))
                } else if o < 42 {
                    Some(sec(200, 2_000))
                } else {
                    Some(Sec {
                        launched: 285,
                        completed: 285,
                        dropped: 15,
                        errors: 0,
                        lat_us: 20_000,
                    })
                }
            });
            (c, fx)
        }

        #[test]
        fn stair_dropped_in_ramp_segment_not_explained() {
            let (c, mut fx) = three_step();
            assert!(
                fx.report(&c).dropped_explained,
                "대조: 계단2 dropped만이면 설명됨"
            );
            // 계단1 상승 구간(offset 21)에 dropped.
            let row = fx
                .inp
                .open_loop
                .iter_mut()
                .find(|r| r.ts_second == 1021)
                .unwrap();
            row.dropped = 3;
            let r = fx.report(&c);
            assert_eq!(r.steps[1].state, StepState::Ok);
            assert_eq!(r.steps[1].dropped, Some(0), "측정 구간 밖");
            assert!(!r.dropped_explained);
        }

        #[test]
        fn stair_dropped_before_first_step_not_explained() {
            // 첫 계단부터 오류로 무너져(슬롯 부족 아님) 계단 안 dropped는 설명된다.
            let c = scfg(&[100, 200], 1, 20, 5);
            let mut fx = Fx::default();
            fx.inp.starts.push(start("w", T0));
            fx.fill("w", 1000, 42, |o| {
                let t = if o < 21 { 100 } else { 200 };
                Some(Sec {
                    launched: t - 5,
                    completed: t - 5,
                    dropped: 5,
                    errors: t / 2,
                    lat_us: 2_000,
                })
            });
            let r = fx.report(&c);
            assert_eq!(r.steps[0].state, StepState::Saturated);
            assert!(r.dropped_explained, "대조: 계단 안 dropped만이면 설명됨");
            // t0 이전 초(계단 0 시작 전)의 dropped는 어느 계단에도 속하지 않는다.
            fx.inp.open_loop.push(ol("w", 999, 0, 0, 2));
            assert!(!fx.report(&c).dropped_explained);
        }

        #[test]
        fn stair_mixed_legacy_worker_dropped_not_explained() {
            // 워커 a(새 부하기)는 지연으로 무너진 계단1에서 dropped, 워커 b(예전 부하기)는 run_metrics만.
            let (c, mut fx) = two_step(Sec {
                launched: 190,
                completed: 190,
                dropped: 10,
                errors: 0,
                lat_us: 20_000,
            });
            assert!(fx.report(&c).dropped_explained, "대조: 워커 a만이면 설명됨");
            fx.inp.starts.push(start("b", T0));
            for o in 0..42 {
                let lat = if o < 21 { 2_000 } else { 20_000 };
                fx.rows.push(mrow("b", 1000 + o, "s", 50, 0, &[(lat, 50)]));
            }
            let r = fx.report(&c);
            assert!(r.notes.open_loop_unknown);
            assert_eq!(r.steps[1].state, StepState::Saturated);
            assert!(!r.steps[1].slot_limited);
            assert!(
                !r.dropped_explained,
                "초 단위 귀속을 모르는 워커가 섞이면 배너 유지(§5.7)"
            );
        }

        /// 계단 수 `targets`, `sat_from`부터 지연+dropped로 무너짐, 마지막 계단은
        /// 스케줄러가 앞 5초만 돌고 멈춰(dropped 포함) 측정 안 됨.
        fn partial_tail(targets: &[u32], sat_from: i64) -> (StairConfig, Fx) {
            let c = scfg(targets, 1, 20, 5);
            let last = targets.len() as i64 - 1;
            let tg: Vec<u64> = targets.iter().map(|&t| u64::from(t)).collect();
            let mut fx = Fx::default();
            fx.inp.starts.push(start("w", T0));
            fx.fill("w", 1000, last * 21 + 5, |o| {
                let i = o / 21;
                let t = tg[i as usize];
                if i == last || i >= sat_from {
                    Some(Sec {
                        launched: t - 10,
                        completed: t - 10,
                        dropped: 10,
                        errors: 0,
                        lat_us: 20_000,
                    })
                } else {
                    Some(sec(t, 2_000))
                }
            });
            (c, fx)
        }

        #[test]
        fn stair_dropped_in_unmeasured_step_after_saturation_explained() {
            let (c, fx) = partial_tail(&[100, 200, 300, 400], 1);
            let r = fx.report(&c);
            let states: Vec<StepState> = r.steps.iter().map(|s| s.state).collect();
            use StepState::*;
            assert_eq!(states, vec![Ok, Saturated, Saturated, NotMeasured]);
            assert!(
                r.dropped_explained,
                "포화 뒤 측정 안 된 계단의 dropped는 판정 밖"
            );
        }

        #[test]
        fn stair_dropped_in_unmeasured_tail_without_saturation_not_explained() {
            // 포화 없이 run이 끝난 미측정 계단의 dropped는 설명 안 됨(배너 유지).
            let (c, fx) = partial_tail(&[100, 200, 300], 9);
            let r = fx.report(&c);
            let states: Vec<StepState> = r.steps.iter().map(|s| s.state).collect();
            use StepState::*;
            assert_eq!(states, vec![Ok, Ok, NotMeasured]);
            assert_eq!(r.headline.kind, HeadlineKind::OkThenUnmeasured);
            assert!(!r.dropped_explained);
        }

        #[test]
        fn stair_dropped_straddling_into_ok_step_not_explained() {
            // t0 = 1000.3s라 초가 계단 경계에 걸친다. 계단1은 튐(지연+dropped, 설명됨), 계단2 정상.
            let c = scfg(&[100, 200, 300], 1, 20, 5);
            let mut fx = Fx::default();
            fx.inp.starts.push(start("w", T0 + 300));
            fx.fill("w", 1000, 64, |o| match o {
                0..21 => Some(sec(100, 2_000)),
                21 => Some(sec(200, 20_000)),
                22..42 => Some(Sec {
                    launched: 200,
                    completed: 200,
                    dropped: 5,
                    errors: 0,
                    lat_us: 20_000,
                }),
                _ => Some(sec(300, 3_000)),
            });
            let r = fx.report(&c);
            let states: Vec<StepState> = r.steps.iter().map(|s| s.state).collect();
            assert_eq!(states, vec![StepState::Ok, StepState::Spike, StepState::Ok]);
            assert!(r.dropped_explained, "대조: 튄 계단 안 dropped만이면 설명됨");
            // ts 1042 = 계단 상대 [41.7s, 42.7s) — 계단1 끝과 계단2(정상) 시작에 걸친 초.
            let row = fx
                .inp
                .open_loop
                .iter_mut()
                .find(|r| r.ts_second == 1042)
                .unwrap();
            row.dropped = 3;
            assert!(
                !fx.report(&c).dropped_explained,
                "걸친 계단 중 정상 계단이 있으면 설명 안 됨"
            );
        }

        /// 대표 계단 run: 정상 → knee(⚠) → 튐 → 정상 → 포화(멈춤, ratio null) →
        /// 확인 계단(지연·오류 정상, 달성 94.96% → 슬롯 부족 의심).
        fn golden_fixture() -> (StairConfig, Fx) {
            let c = scfg(&[100, 200, 300, 400, 500, 600, 1000], 1, 25, 5);
            let mut fx = Fx::default();
            fx.inp.starts.push(start("w", T0));
            fx.fill("w", 1000, 182, |o| {
                let i = o / 26;
                let in_step = o % 26;
                let head = (6..16).contains(&in_step);
                let t = 100 * (i as u64 + 1);
                match i {
                    // knee: 4ms → 10ms(2.5×, 3× 미만이라 정상). 앞 10초만 10ms라 ⚠도 뜬다.
                    0 | 1 => Some(sec(t, 4_000)),
                    2 => Some(sec(t, if head { 10_000 } else { 4_500 })),
                    3 => Some(sec(t, 40_000)),
                    4 => Some(sec(t, 8_000)),
                    // 측정 20초 완료 합 = 950×12 + 949×8 = 18,992 → 달성 949.6/s = 목표의 94.96%.
                    6 => Some(Sec {
                        launched: 1000,
                        completed: if in_step < 18 { 950 } else { 949 },
                        dropped: 0,
                        errors: 0,
                        lat_us: 8_000,
                    }),
                    _ if in_step < 6 => Some(sec(t, 50_000)),
                    _ if head => Some(Sec {
                        launched: 300,
                        completed: 300,
                        dropped: 300,
                        errors: 0,
                        lat_us: 100_000,
                    }),
                    _ => Some(Sec {
                        launched: 50,
                        completed: 0,
                        dropped: 550,
                        errors: 0,
                        lat_us: 0,
                    }),
                }
            });
            (c, fx)
        }

        #[test]
        fn stair_golden_fixture_shape() {
            let (c, fx) = golden_fixture();
            let r = fx.report(&c);
            let states: Vec<StepState> = r.steps.iter().map(|s| s.state).collect();
            use StepState::*;
            assert_eq!(states, vec![Ok, Ok, Ok, Spike, Ok, Saturated, Saturated]);
            assert_eq!(r.headline.kind, HeadlineKind::Saturated);
            assert_eq!(r.headline.saturated_target, Some(600));
            assert_eq!(r.headline.last_ok_target, Some(500));
            assert_eq!(r.headline.through_target, None);
            assert!(!r.headline.first_fail_hint);
            assert_eq!(r.knee_target, Some(300));
            assert!(r.steps[2].knee && r.steps[2].discard_warning);
            assert_eq!(r.spike_targets, vec![400]);
            assert_eq!(r.steps[5].head_p99_ratio, None, "나머지 p99 0 → null");
            assert!(r.dropped_explained);
            assert_eq!(r.dropped_total, Some(8_500));
            // 확인 계단: 달성만 실패 → 슬롯 부족 의심, 비율은 내림 표시 경계(94.96%).
            let last = &r.steps[6];
            assert!(last.slot_limited);
            assert_eq!(r.slot_limited_targets, vec![1000]);
            assert_eq!(last.reasons.len(), 1);
            assert_eq!(last.reasons[0].kind, ReasonKind::Achieved);
            assert!((last.reasons[0].value - 0.9496).abs() < 1e-12);
        }

        /// 화면(`stairFormat.ts`)과 내보내기(`export.rs`)가 같은 글자를 내는지 — UI 테스트
        /// `stairExportParity.test.ts`가 같은 파일을 읽어 `headlineText`·`reasonTexts`와 비교한다.
        /// 변형(`*_variant`·`reasons_all_kinds`·`reasons_fast_ref`)의 수정 내용은 UI 테스트에도 똑같이 있다.
        fn export_text_golden(r: &StairReport) -> serde_json::Value {
            use crate::export::{stair_headline_lines, stair_reasons_text};
            use crate::stair::Reason;
            let mut variant = r.clone();
            variant.notes.t0_estimated = true;
            variant.notes.open_loop_unknown = true;
            variant.max_in_flight = None;
            variant.headline.saturated_target = Some(100);
            variant.headline.last_ok_target = None;
            variant.headline.first_fail_hint = true;
            let mut all = r.clone();
            all.steps[5].reasons = [
                (ReasonKind::Achieved, 0.9496),
                (ReasonKind::Dropped, 1234.0),
                (ReasonKind::Errors, 0.0234),
                (ReasonKind::P99Cap, 25.0),
                (ReasonKind::P99Relative, 2.25),
            ]
            .into_iter()
            .map(|(kind, value)| Reason { kind, value })
            .collect();
            all.steps[5].slot_limited = true;
            let mut fast = r.clone();
            fast.steps[4].p99_us = 900;
            serde_json::json!({
                "headline_lines": stair_headline_lines(r),
                "headline_lines_variant": stair_headline_lines(&variant),
                "reasons": (0..r.steps.len())
                    .map(|i| stair_reasons_text(r, i))
                    .collect::<Vec<_>>(),
                "reasons_all_kinds": stair_reasons_text(&all, 5),
                "reasons_fast_ref": stair_reasons_text(&fast, 5),
            })
        }

        #[test]
        fn stair_export_text_matches_golden() {
            let path = concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/../../testdata/stair_export_text_golden.json"
            );
            let (c, fx) = golden_fixture();
            let got = serde_json::to_string_pretty(&export_text_golden(&fx.report(&c))).unwrap();
            if std::env::var_os("STAIR_GOLDEN_UPDATE").is_some() {
                std::fs::write(path, format!("{got}\n")).unwrap();
            }
            let want = std::fs::read_to_string(path).unwrap();
            assert_eq!(got, want.trim_end(), "골든이 바뀌면 의도적으로 갱신");
            let v: serde_json::Value = serde_json::from_str(&got).unwrap();
            assert_eq!(v["reasons"][6], "달성 94.9% · 슬롯 부족 의심");
            assert!(
                v["headline_lines"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|l| l.as_str().unwrap().starts_with("계단 1000 iter/s은(는)"))
            );

            // CSV 첫 줄들 = 머리말 줄 전부(슬롯 부족 줄 포함), 그다음 빈 줄.
            let csv = String::from_utf8(crate::export::report_to_stairs_csv(&fx.full(&c)).unwrap())
                .unwrap();
            let lines = crate::export::stair_headline_lines(&fx.report(&c));
            let mut rd = csv::ReaderBuilder::new()
                .has_headers(false)
                .flexible(true)
                .from_reader(csv.as_bytes());
            let recs: Vec<String> = rd
                .records()
                .take(lines.len())
                .map(|r| r.unwrap()[0].to_string())
                .collect();
            assert_eq!(recs, lines);
            assert_eq!(csv.lines().nth(lines.len()), Some(""));
        }

        #[test]
        fn stair_not_measured_step_numbers_are_blank_in_report_and_csv() {
            // run이 계단1 측정 구간 1/3 지점에서 중단 → 측정 안 됨. 부분 구간에도 완료·dropped가 있다.
            let c = scfg(&[100, 200], 1, 20, 5);
            let mut fx = Fx::default();
            fx.inp.starts.push(start("w", T0));
            fx.fill("w", 1000, 32, |o| {
                if o < 21 {
                    Some(sec(100, 2_000))
                } else {
                    Some(Sec {
                        launched: 200,
                        completed: 197,
                        dropped: 3,
                        errors: 0,
                        lat_us: 2_000,
                    })
                }
            });
            let r = fx.report(&c);
            assert_eq!(r.steps[1].measured_seconds, 5);
            assert_eq!(r.steps[1].state, StepState::NotMeasured);
            assert_eq!(
                (
                    r.steps[1].achieved,
                    r.steps[1].launched_rate,
                    r.steps[1].dropped
                ),
                (None, None, None)
            );
            assert_eq!(
                r.steps[0].achieved,
                Some(100.0),
                "대조: 측정된 계단은 그대로"
            );
            assert_eq!(r.steps[0].dropped, Some(0));

            let csv = String::from_utf8(crate::export::report_to_stairs_csv(&fx.full(&c)).unwrap())
                .unwrap();
            let row = csv.lines().find(|l| l.starts_with("1,200,")).unwrap();
            assert_eq!(row, "1,200,,,,,,,,,,not_measured,");
        }

        #[test]
        fn stair_discard_warning_not_on_unmeasured_step() {
            // 유지 60·버림 0 → 측정 60초, 절반 30초. 계단1은 25초 측정 뒤 중단(≥ 20초라 ⚠ 계산 대상이던 경우).
            let c = scfg(&[100, 200], 1, 60, 0);
            let mut fx = Fx::default();
            fx.inp.starts.push(start("w", T0));
            fx.fill("w", 1000, 87, |o| {
                let lat = if (62..72).contains(&o) { 10_000 } else { 4_000 };
                Some(sec(if o < 61 { 100 } else { 200 }, lat))
            });
            let r = fx.report(&c);
            assert_eq!(r.steps[1].measured_seconds, 25);
            assert_eq!(r.steps[1].state, StepState::NotMeasured);
            assert_eq!(r.steps[1].head_p99_ratio, None);
            assert!(!r.steps[1].discard_warning);
        }

        #[test]
        fn stair_dropped_in_unmeasured_step_after_unconfirmed_explained() {
            // 계단1이 지연+dropped로 실패, 확인할 계단2는 측정 전에 run이 끝남 → 확인 못 한 실패.
            let (c, fx) = partial_tail(&[100, 200, 300], 1);
            let r = fx.report(&c);
            let states: Vec<StepState> = r.steps.iter().map(|s| s.state).collect();
            use StepState::*;
            assert_eq!(states, vec![Ok, Unconfirmed, NotMeasured]);
            assert!(!r.steps[1].slot_limited);
            assert!(
                fx.inp
                    .open_loop
                    .iter()
                    .any(|row| row.ts_second >= 1042 && row.dropped > 0),
                "계단2 구간(offset 42~)에도 dropped가 있다"
            );
            assert!(
                r.dropped_explained,
                "확인 못 한 실패 뒤 측정 안 된 계단의 dropped는 판정 밖"
            );
        }

        #[test]
        fn stair_report_survives_absurd_stored_times_and_counts() {
            let c = scfg(&[100, 200], 1, 20, 5);
            let mut fx = Fx::default();
            // a: t0가 i64 끝, 시각·계수도 끝값.
            fx.inp.starts.push(start("a", i64::MAX));
            for ts in [i64::MAX, i64::MAX / 2, i64::MIN, 0] {
                fx.inp.open_loop.push(OpenLoopSecondRow {
                    worker_id: "a".into(),
                    ts_second: ts,
                    launched: i64::MAX,
                    completed: i64::MAX,
                    dropped: i64::MAX,
                });
                fx.rows.push(mrow("a", ts, "s", 1, 0, &[(2_000, 1)]));
            }
            // b: 시작 행 없음 → t0 = 최소 ts × 1000 폴백.
            fx.rows
                .push(mrow("b", i64::MAX / 2, "s", 1, 0, &[(2_000, 1)]));
            // c: t0가 i64 시작, dropped 초는 끝.
            fx.inp.starts.push(start("c", i64::MIN));
            fx.inp.open_loop.push(OpenLoopSecondRow {
                worker_id: "c".into(),
                ts_second: i64::MAX,
                launched: 1,
                completed: 1,
                dropped: 1,
            });
            let r = build_stair_report(&sprofile(&c), u64::MAX, &fx.rows, &fx.inp).unwrap();
            assert_eq!(r.steps.len(), 2);
        }

        #[test]
        fn stair_report_matches_golden() {
            let path = concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/../../testdata/stair_report_golden.json"
            );
            let (c, fx) = golden_fixture();
            let got = serde_json::to_string_pretty(&fx.report(&c)).unwrap();
            // 의도적 갱신: `STAIR_GOLDEN_UPDATE=1 cargo nextest run -p handicap-controller stair_`.
            if std::env::var_os("STAIR_GOLDEN_UPDATE").is_some() {
                std::fs::write(path, format!("{got}\n")).unwrap();
            }
            let golden = std::fs::read_to_string(path).unwrap();
            assert_eq!(got, golden.trim_end(), "골든이 바뀌면 의도적으로 갱신");
            // typed round-trip: 골든은 ReportJson.stair로 역직렬화된다.
            let back: StairReport = serde_json::from_str(&golden).unwrap();
            assert_eq!(back, fx.report(&c));
        }

        /// 자동 정지 리포트(계단 시험 b §5.1·§5.2): 기록의 `judged_through` 뒤는 판정 밖, 행 상태 셋.
        mod auto_stop {
            use super::*;
            use crate::auto_stop::{AutoStopRecord, EmergencyStats, StopInfo, StopKind};
            use crate::stair::{PartialRun, SaturationStopMode};

            fn bad(completed: u64) -> Sec {
                Sec {
                    errors: completed / 2,
                    ..sec(completed, 2_000)
                }
            }

            fn rec(
                kind: StopKind,
                decided: u32,
                judged: i64,
                stopped_at_ms: i64,
            ) -> AutoStopRecord {
                let em = kind == StopKind::Emergency;
                AutoStopRecord {
                    stop: Some(StopInfo {
                        kind,
                        mode: Some(SaturationStopMode::FirstFail),
                        failed_steps: if em { vec![] } else { vec![decided] },
                        decided_step: decided,
                        judged_through: judged,
                        phase: em.then_some(BandKind::Measure),
                        decided_at_ms: stopped_at_ms - 500,
                        stopped_at_ms,
                        emergency: em.then_some(EmergencyStats {
                            max_error_rate: 0.5,
                            max_p99_us: 2_000,
                            seconds: 3,
                            error_hit: true,
                            p99_hit: false,
                        }),
                        slot_limited: false,
                    }),
                    suspended_seconds: 0,
                }
            }

            fn states(r: &StairReport) -> Vec<StepState> {
                r.steps.iter().map(|s| s.state).collect()
            }

            fn blank(r: &StairReport, i: usize) -> bool {
                let s = &r.steps[i];
                s.achieved.is_none() && s.launched_rate.is_none() && s.dropped.is_none()
            }

            /// 상승 1·유지 10·버림 0 = 계단 11초, 측정 10초(절반 5초).
            fn c11(targets: &[u32]) -> StairConfig {
                scfg(targets, 1, 10, 0)
            }

            #[test]
            fn forced_boundary_ramp1_discard0() {
                let c = c11(&[100, 200, 300]);
                let mut fx = Fx::default();
                fx.inp.starts.push(start("w", T0));
                // 계단1 실패(오류), 정지 지연으로 계단2 측정 초가 7초(절반 넘게) 쌓였다.
                fx.fill("w", 1000, 30, |o| match o {
                    0..11 => Some(sec(100, 2_000)),
                    11..22 => Some(bad(200)),
                    _ => Some(sec(300, 2_000)),
                });
                let free = fx.report(&c);
                assert_eq!(
                    states(&free),
                    vec![StepState::Ok, StepState::Spike, StepState::Ok]
                );
                assert_eq!(free.headline.kind, HeadlineKind::AllOk);

                let r0 = rec(StopKind::Saturation, 1, 1, 1_022_000 + 7_500);
                fx.inp.auto_stop = Some(r0.clone());
                let r = fx.report(&c);
                assert_eq!(
                    states(&r),
                    vec![StepState::Ok, StepState::Unconfirmed, StepState::Partial]
                );
                assert_eq!(r.headline.kind, HeadlineKind::Unconfirmed);
                assert_ne!(r.headline, free.headline);
                assert_eq!(r.headline.saturated_target, Some(200));
                assert_eq!(r.headline.last_ok_target, Some(100));
                assert_eq!(
                    r.steps[2].partial,
                    Some(PartialRun {
                        seconds: 8,
                        phase: BandKind::Measure
                    })
                );
                assert!(blank(&r, 2));
                assert!(r.steps[2].reasons.is_empty());
                assert_eq!(r.auto_stop, Some(r0));
            }

            #[test]
            fn forced_boundary_skewed_t0_emergency() {
                let c = c11(&[100, 200, 300]);
                let mut fx = Fx::default();
                // 워커 b는 4초 늦게 시작 — 즉시 정지 순간 b의 계단1은 아직 측정 중(완결 전).
                fx.inp.starts.push(start("a", T0));
                fx.inp.starts.push(start("b", T0 + 4_000));
                fx.fill("a", 1000, 22, |o| {
                    Some(if o < 11 { sec(100, 2_000) } else { bad(100) })
                });
                fx.fill("b", 1004, 18, |o| {
                    Some(if o < 11 { sec(100, 2_000) } else { bad(100) })
                });
                let free = fx.report(&c);
                // 대조: 강제 없으면 b의 계단1 측정 6초(≥ 5)가 판정에 들어간다.
                assert_eq!(free.steps[1].measured_seconds, 6);
                assert_eq!(free.steps[1].state, StepState::Unconfirmed);
                assert_eq!(free.headline.kind, HeadlineKind::Unconfirmed);

                fx.inp.auto_stop = Some(rec(StopKind::Emergency, 1, 0, 1_022_000));
                let r = fx.report(&c);
                assert_eq!(
                    states(&r),
                    vec![
                        StepState::Ok,
                        StepState::EmergencyStopped,
                        StepState::Skipped
                    ]
                );
                assert!(blank(&r, 1));
                assert!(r.steps[1].reasons.is_empty(), "판정 입력 밖");
                assert_eq!(r.steps[1].partial, None);
                assert_eq!(r.headline.kind, HeadlineKind::OkThenUnmeasured);
                assert_eq!(r.headline.saturated_target, None);
                assert_eq!(r.headline.last_ok_target, Some(100));
            }

            #[test]
            fn emergency_judged_through_at_or_past_decided() {
                // 뒤처진 워커가 나쁜 초와 같은 메시지로 계단을 완결 → judged_through ≥ decided_step.
                let c = c11(&[100, 200, 300]);
                let mut fx = Fx::default();
                fx.inp.starts.push(start("w", T0));
                fx.fill("w", 1000, 30, |o| match o {
                    0..11 => Some(sec(100, 2_000)),
                    11..22 => Some(bad(200)),
                    _ => Some(sec(300, 2_000)),
                });
                fx.inp.auto_stop = Some(rec(StopKind::Emergency, 1, 1, 1_022_000 + 3_000));
                let r = fx.report(&c);
                assert_eq!(
                    states(&r),
                    vec![StepState::Ok, StepState::Unconfirmed, StepState::Partial]
                );
                assert!(
                    !r.steps
                        .iter()
                        .any(|s| s.state == StepState::EmergencyStopped)
                );
                assert!(!blank(&r, 1), "판정된 계단은 숫자를 보인다");
                assert!(!r.steps[1].reasons.is_empty());
                // 판정 경계 뒤 계단2는 측정 7초가 쌓였어도 판정 밖.
                assert!(blank(&r, 2));
                assert_eq!(r.headline.kind, HeadlineKind::Unconfirmed);

                // judged_through가 판정 계단보다 뒤여도 판정 계단 행은 실제 판정 그대로.
                fx.inp.auto_stop = Some(rec(StopKind::Emergency, 0, 1, 1_022_000 + 3_000));
                let r = fx.report(&c);
                assert_eq!(
                    states(&r),
                    vec![StepState::Ok, StepState::Unconfirmed, StepState::Partial]
                );
            }

            #[test]
            fn first_fail_headline_unconfirmed() {
                let c = c11(&[100, 200, 300]);
                let mut fx = Fx::default();
                fx.inp.starts.push(start("w", T0));
                fx.fill("w", 1000, 22, |o| {
                    Some(if o < 11 { bad(100) } else { sec(200, 2_000) })
                });
                let free = fx.report(&c);
                assert_eq!(free.headline.kind, HeadlineKind::Saturated, "대조");

                fx.inp.auto_stop = Some(rec(StopKind::Saturation, 0, 0, 1_011_000 + 2_000));
                let r = fx.report(&c);
                assert_eq!(
                    states(&r),
                    vec![
                        StepState::Unconfirmed,
                        StepState::Partial,
                        StepState::Skipped
                    ]
                );
                assert_eq!(r.headline.kind, HeadlineKind::Unconfirmed);
                assert_eq!(r.headline.saturated_target, Some(100));
                assert_eq!(r.headline.last_ok_target, None);
                assert!(!r.headline.first_fail_hint);
            }

            /// 계단0·1 정상(완전 측정), 계단2 지연·오류.
            fn ok_ok_bad() -> (StairConfig, Fx) {
                let c = c11(&[100, 200, 300]);
                let mut fx = Fx::default();
                fx.inp.starts.push(start("w", T0));
                fx.fill("w", 1000, 30, |o| match o {
                    0..11 => Some(sec(100, 2_000)),
                    11..22 => Some(sec(200, 2_000)),
                    _ => Some(bad(300)),
                });
                (c, fx)
            }

            #[test]
            fn last_ok_target_after_forcing() {
                let (c, mut fx) = ok_ok_bad();
                assert_eq!(fx.report(&c).headline.last_ok_target, Some(200), "대조");
                fx.inp.auto_stop = Some(rec(StopKind::Emergency, 2, 0, 1_030_000));
                let r = fx.report(&c);
                assert_eq!(r.headline.last_ok_target, Some(100));
                assert_eq!(r.headline.kind, HeadlineKind::OkThenUnmeasured);
                assert_eq!(r.headline.through_target, Some(100));
            }

            #[test]
            fn emergency_between_judged_and_decided_not_measured() {
                let (c, mut fx) = ok_ok_bad();
                fx.inp.auto_stop = Some(rec(StopKind::Emergency, 2, 0, 1_030_000));
                let r = fx.report(&c);
                assert_eq!(
                    states(&r),
                    vec![
                        StepState::Ok,
                        StepState::NotMeasured,
                        StepState::EmergencyStopped
                    ]
                );
                assert!(blank(&r, 1));
                assert_eq!(r.steps[1].partial, None);
            }

            #[test]
            fn partial_seconds_and_phase() {
                // 상승 5·버림 5·유지 20 = 계단 25초. 계단1 시작 = 1,025,000 ms.
                let c = scfg(&[100, 200, 300], 5, 20, 5);
                let mut fx = Fx::default();
                fx.inp.starts.push(start("w", T0));
                fx.fill("w", 1000, 27, |o| {
                    Some(if o < 25 { bad(100) } else { sec(200, 2_000) })
                });
                for (d, seconds, phase) in [
                    (1_500, 2, BandKind::Ramp),
                    (2_000, 2, BandKind::Ramp),
                    (4_999, 5, BandKind::Ramp),
                    (5_000, 5, BandKind::Discard),
                    (9_999, 10, BandKind::Discard),
                    (10_000, 10, BandKind::Measure),
                ] {
                    fx.inp.auto_stop = Some(rec(StopKind::Saturation, 0, 0, 1_025_000 + d));
                    let r = fx.report(&c);
                    assert_eq!(r.steps[1].state, StepState::Partial, "d={d}");
                    assert_eq!(
                        r.steps[1].partial,
                        Some(PartialRun { seconds, phase }),
                        "d={d}"
                    );
                    assert_eq!(r.steps[2].state, StepState::Skipped, "d={d}");
                    assert_eq!(r.steps[2].partial, None);
                }
            }

            #[test]
            fn skipped_steps_after_stop() {
                let c = c11(&[100, 200, 300, 400, 500]);
                let mut fx = Fx::default();
                fx.inp.starts.push(start("w", T0));
                fx.fill("w", 1000, 25, |o| match o {
                    0..11 => Some(sec(100, 2_000)),
                    11..22 => Some(bad(200)),
                    _ => Some(sec(300, 2_000)),
                });
                fx.inp.auto_stop = Some(rec(StopKind::Saturation, 1, 1, 1_022_000 + 2_500));
                let r = fx.report(&c);
                use StepState::*;
                assert_eq!(states(&r), vec![Ok, Unconfirmed, Partial, Skipped, Skipped]);
                for i in 2..5 {
                    assert!(blank(&r, i), "step {i}");
                }
                assert_eq!(r.steps[3].partial, None);
                // 경계: 정지 시각 = 계단3 시작이면 계단3은 실행 안 함.
                fx.inp.auto_stop = Some(rec(StopKind::Saturation, 1, 1, 1_033_000));
                let r = fx.report(&c);
                assert_eq!(states(&r), vec![Ok, Unconfirmed, Partial, Skipped, Skipped]);
                assert_eq!(
                    r.steps[2].partial,
                    Some(PartialRun {
                        seconds: 11,
                        phase: BandKind::Measure
                    })
                );
            }

            #[test]
            fn new_states_explain_dropped() {
                // 상승 2·유지 10 = 계단 12초, 전 계단 정상. dropped는 상승 초(측정 구간 밖)에만 —
                // 기록이 없으면 정상 계단에 걸쳐 설명 안 됨(a 규칙).
                let c = scfg(&[100, 200, 300, 400], 2, 10, 0);
                let rec0 = rec(StopKind::Emergency, 1, 0, 1_024_000 + 1_000);
                // 계단1(즉시 정지)·계단2(일부 실행)·계단3(실행 안 함)의 상승 첫 초.
                for (ts, want) in [
                    (1012, StepState::EmergencyStopped),
                    (1024, StepState::Partial),
                    (1036, StepState::Skipped),
                ] {
                    let mut fx = Fx::default();
                    fx.inp.starts.push(start("w", T0));
                    fx.fill("w", 1000, 48, |o| {
                        Some(sec(100 * (o / 12 + 1) as u64, 2_000))
                    });
                    let row = fx
                        .inp
                        .open_loop
                        .iter_mut()
                        .find(|r| r.ts_second == ts)
                        .unwrap();
                    row.dropped = 3;
                    assert!(!fx.report(&c).dropped_explained, "대조 ts={ts}");
                    fx.inp.auto_stop = Some(rec0.clone());
                    let r = fx.report(&c);
                    assert_eq!(r.steps[((ts - 1000) / 12) as usize].state, want);
                    assert!(r.dropped_explained, "ts={ts}");
                }
            }

            #[test]
            fn suspended_only_record_no_forcing() {
                let (c, mut fx) = ok_ok_bad();
                let free = fx.report(&c);
                let rec0 = AutoStopRecord {
                    stop: None,
                    suspended_seconds: 3,
                };
                fx.inp.auto_stop = Some(rec0.clone());
                let r = fx.report(&c);
                assert_eq!(r.auto_stop, Some(rec0));
                let mut stripped = r.clone();
                stripped.auto_stop = None;
                assert_eq!(stripped, free);
            }

            #[test]
            fn non_autostop_stair_report_unchanged() {
                // a 골든(`stair_report_matches_golden`)이 그대로 green — 여기서는 새 키가 없음을 본다.
                let (c, fx) = golden_fixture();
                let v = serde_json::to_value(fx.report(&c)).unwrap();
                let obj = v.as_object().unwrap();
                assert!(!obj.contains_key("auto_stop"));
                for s in v["steps"].as_array().unwrap() {
                    assert!(!s.as_object().unwrap().contains_key("partial"));
                }
            }

            /// 두 실패 정지(계단2·3) + 일부 실행(계단4) + 실행 안 함(계단5).
            fn autostop_golden_fixture() -> (StairConfig, Fx) {
                let c = scfg(&[100, 200, 300, 400, 500, 600], 1, 20, 5);
                let mut fx = Fx::default();
                fx.inp.starts.push(start("w", T0));
                fx.fill("w", 1000, 88, |o| {
                    let i = o / 21;
                    let t = 100 * (i as u64 + 1);
                    Some(match i {
                        0 | 1 => sec(t, 2_000),
                        2 | 3 => Sec {
                            launched: t,
                            completed: t - 5,
                            dropped: 5,
                            errors: 0,
                            lat_us: 20_000,
                        },
                        _ => sec(t, 30_000),
                    })
                });
                fx.inp.auto_stop = Some(AutoStopRecord {
                    stop: Some(StopInfo {
                        kind: StopKind::Saturation,
                        mode: Some(SaturationStopMode::TwoFails),
                        failed_steps: vec![2, 3],
                        decided_step: 3,
                        judged_through: 3,
                        phase: None,
                        decided_at_ms: 1_084_200,
                        stopped_at_ms: 1_084_000 + 3_500,
                        emergency: None,
                        slot_limited: false,
                    }),
                    suspended_seconds: 2,
                });
                (c, fx)
            }

            #[test]
            fn stair_autostop_report_matches_golden() {
                let path = concat!(
                    env!("CARGO_MANIFEST_DIR"),
                    "/../../testdata/stair_autostop_report_golden.json"
                );
                let (c, fx) = autostop_golden_fixture();
                let r = fx.report(&c);
                use StepState::*;
                assert_eq!(
                    states(&r),
                    vec![Ok, Ok, Saturated, Saturated, Partial, Skipped]
                );
                assert_eq!(
                    r.steps[4].partial,
                    Some(PartialRun {
                        seconds: 4,
                        phase: BandKind::Discard
                    })
                );
                assert_eq!(r.headline.kind, HeadlineKind::Saturated);
                assert_eq!(r.headline.last_ok_target, Some(200));
                let got = serde_json::to_string_pretty(&r).unwrap();
                // 의도적 갱신: `STAIR_GOLDEN_UPDATE=1 cargo nextest run -p handicap-controller stair_`.
                if std::env::var_os("STAIR_GOLDEN_UPDATE").is_some() {
                    std::fs::write(path, format!("{got}\n")).unwrap();
                }
                let golden = std::fs::read_to_string(path).unwrap();
                assert_eq!(got, golden.trim_end(), "골든이 바뀌면 의도적으로 갱신");
                let back: StairReport = serde_json::from_str(&golden).unwrap();
                assert_eq!(back, r);
            }
        }
    }
}
