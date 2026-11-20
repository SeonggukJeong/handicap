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
use std::collections::BTreeMap;

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
    /// 응답 속도 구간 건수(인쇄 보고서 3절). 표본이 없으면 키 자체를 내지 않는다.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub speed_bands: Option<crate::speed_bands::SpeedBands>,
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
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ReportSummary {
    pub count: u64,
    pub errors: u64,
    pub rps: f64,
    pub duration_seconds: i64,
    pub mean_ms: u64,
    pub p50_ms: u64,
    pub p95_ms: u64,
    pub p99_ms: u64,
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

#[derive(Debug, Serialize, Deserialize)]
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

#[derive(Debug, Serialize, Deserialize)]
pub struct ReportStep {
    pub step_id: String,
    pub count: u64,
    pub error_count: u64,
    pub status_counts: BTreeMap<String, u64>,
    pub p50_ms: u64,
    pub p95_ms: u64,
    pub p99_ms: u64,
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

#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct LoopSplitStats {
    pub count: u64,
    pub error_count: u64,
    pub p50_ms: u64,
    pub p95_ms: u64,
    pub p99_ms: u64,
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct LoopSplit {
    #[serde(rename = "final")]
    pub ended: LoopSplitStats,
    pub retry: LoopSplitStats,
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
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

#[derive(Debug, Serialize, Deserialize, PartialEq)]
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

/// 순수: 입력만으로 결정적. 활성(Some) 기준만 결과 행을 만든다.
pub fn evaluate_criteria(
    c: &crate::store::runs::Criteria,
    s: &ReportSummary,
    status_dist: &BTreeMap<String, u64>,
    windows: &[ReportWindow],
    steps: &[ReportStep],
) -> Verdict {
    let mut criteria = Vec::new();

    {
        let mut push_max = |metric: &str, threshold: Option<u64>, actual: u64| {
            if let Some(t) = threshold {
                let (threshold, actual) = (t as f64, actual as f64);
                criteria.push(CriterionResult {
                    metric: metric.to_string(),
                    direction: "max".to_string(),
                    threshold,
                    actual,
                    passed: actual <= threshold,
                    target: None,
                });
            }
        };
        push_max("p50_ms", c.max_p50_ms, s.p50_ms);
        push_max("p95_ms", c.max_p95_ms, s.p95_ms);
        push_max("p99_ms", c.max_p99_ms, s.p99_ms);
    } // push_max dropped here, releasing mutable borrow of criteria

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
        });
    }
    // status-class rate(분모=HTTP 응답 수, transport "0" 제외) — 4xx, 5xx 순.
    let http_total = http_response_total(status_dist);
    for (first, rate_t, metric) in [
        ('4', c.max_4xx_rate, "4xx_rate"),
        ('5', c.max_5xx_rate, "5xx_rate"),
    ] {
        if let Some(t) = rate_t {
            let class = status_class_count(status_dist, first);
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
            });
        }
    }
    // status-class count — 4xx, 5xx 순.
    for (first, count_t, metric) in [
        ('4', c.max_4xx_count, "4xx_count"),
        ('5', c.max_5xx_count, "5xx_count"),
    ] {
        if let Some(t) = count_t {
            let (threshold, actual) = (t as f64, status_class_count(status_dist, first) as f64);
            criteria.push(CriterionResult {
                metric: metric.to_string(),
                direction: "max".to_string(),
                threshold,
                actual,
                passed: actual <= threshold,
                target: None,
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
        });
    }
    // per-window 최소 RPS: 정상상태 윈도의 최소 RPS ≥ threshold. eligible 부족이면 skip(행 미생성).
    if let Some(t) = c.min_window_rps {
        let warmup = c.rps_warmup_seconds.unwrap_or(0);
        if let Some(actual) = min_window_rps(windows, warmup) {
            criteria.push(CriterionResult {
                metric: "min_window_rps".to_string(),
                direction: "min".to_string(),
                threshold: t,
                actual,
                passed: actual >= t,
                target: None,
            });
        }
    }

    // step-level criteria (spec §3.3) — fixed-field 행 뒤에 입력 순서대로 append.
    for sc in &c.step_criteria {
        let Some(step) = steps.iter().find(|s| s.step_id == sc.target) else {
            continue; // 미존재 스텝 → skip (거짓 FAIL 금지)
        };
        if step.count == 0 {
            continue; // 실행 0회 → skip
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
        let passed = if sc.op == "min" {
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
    // blank_var(보내지 않은 요청)은 스텝별로도 모아 ReportStep.not_sent에 싣는다.
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
    struct WindowAcc {
        count: u64,
        error_count: u64,
        status: BTreeMap<String, u64>,
        hist: Option<Histogram<u64>>, // None until the first decodable HDR blob
    }
    let mut window_acc: BTreeMap<(i64, String), WindowAcc> = BTreeMap::new();
    let mut overall = fresh_hist();
    let mut per_step: BTreeMap<String, Histogram<u64>> = BTreeMap::new();
    // (count, error_count, status_counts)
    let mut per_step_count: BTreeMap<String, (u64, u64, BTreeMap<String, u64>)> = BTreeMap::new();
    let mut status_dist: BTreeMap<String, u64> = BTreeMap::new();
    let mut total_count: u64 = 0;
    let mut total_errors: u64 = 0;

    // Per-worker breakdown (ALL fan-out: closed/open/curve). Pre-scan distinct non-empty
    // worker_ids so single-worker runs do ZERO extra per-worker work (byte-identical build
    // cost); only >=2 -> accumulate below in the SAME loop (reuse the decoded `h`, no extra decode).
    let multi_worker = {
        let mut seen = std::collections::HashSet::new();
        for r in rows {
            if !r.worker_id.is_empty() {
                seen.insert(r.worker_id.as_str());
            }
        }
        seen.len() >= 2
    };
    struct WorkerAcc {
        count: u64,
        errors: u64,
        hist: Option<Histogram<u64>>, // None until the first decodable HDR blob
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
                hist: None,
            });
        acc.count += r.count as u64;
        acc.error_count += r.error_count as u64;
        add_status(&mut acc.status, &sc);
        // NEW: per-worker count/errors (multi-worker fan-out only; '' legacy excluded)
        if multi_worker && !r.worker_id.is_empty() {
            let w = worker_acc
                .entry(r.worker_id.clone())
                .or_insert_with(|| WorkerAcc {
                    count: 0,
                    errors: 0,
                    hist: None,
                });
            w.count += r.count as u64;
            w.errors += r.error_count as u64;
        }
        if let Ok(Some(h)) = decode_hdr(&r.hdr_histogram) {
            merge_into(&mut overall, &h);
            let step_h = per_step.entry(r.step_id.clone()).or_insert_with(fresh_hist);
            merge_into(step_h, &h);
            let win_h = acc.hist.get_or_insert_with(fresh_hist);
            merge_into(win_h, &h);
            // NEW: per-worker latency (reuse already-decoded `h`; tiny map -> 2nd .entry is cheap)
            if multi_worker && !r.worker_id.is_empty() {
                let w = worker_acc
                    .entry(r.worker_id.clone())
                    .or_insert_with(|| WorkerAcc {
                        count: 0,
                        errors: 0,
                        hist: None,
                    });
                let wh = w.hist.get_or_insert_with(fresh_hist);
                merge_into(wh, &h);
            }
        }
        total_count += r.count as u64;
        total_errors += r.error_count as u64;
        add_status(&mut status_dist, &sc);
        let step_acc = per_step_count.entry(r.step_id.clone()).or_default();
        step_acc.0 += r.count as u64;
        step_acc.1 += r.error_count as u64;
        add_status(&mut step_acc.2, &sc);
    }

    // Emit one window per (ts_second, step_id) — BTreeMap iterates sorted by (ts, step),
    // matching the previous SQL ORDER BY. Percentiles come from the merged histogram.
    let windows: Vec<ReportWindow> = window_acc
        .into_iter()
        .map(|((ts_second, step_id), acc)| {
            let wp = acc
                .hist
                .as_ref()
                .map(percentiles_of)
                .unwrap_or_else(Percentiles::empty);
            ReportWindow {
                ts_second,
                step_id,
                count: acc.count,
                error_count: acc.error_count,
                status_counts: acc.status,
                p50_ms: wp.p50_ms,
                p95_ms: wp.p95_ms,
                p99_ms: wp.p99_ms,
            }
        })
        .collect();

    let speed_bands = crate::speed_bands::build(&overall, &per_step, run.profile.criteria.as_ref());
    let overall_p = percentiles_of(&overall);
    let latency = if !overall.is_empty() {
        Some(LatencyDistribution {
            percentile_curve: percentile_curve(&overall, &CURVE_QUANTILES)
                .into_iter()
                .map(|(quantile, value_us)| PercentilePoint { quantile, value_us })
                .collect(),
            histogram: log_buckets(&overall, HISTOGRAM_BINS)
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
    let duration_ms = run
        .ended_at
        .unwrap_or(0)
        .saturating_sub(run.started_at.unwrap_or(0));
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
    for p in phases {
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
    let connection = if connect_count > 0 || dns_count > 0 {
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

    let mut steps: Vec<ReportStep> = per_step_count
        .into_iter()
        .map(|(step_id, (count, errors, status_counts))| {
            let p = per_step
                .get(&step_id)
                .map(percentiles_of)
                .unwrap_or_else(Percentiles::empty);
            let breakdown = loop_by_step.remove(&step_id).unwrap_or_default();
            let download = download_by_step.remove(&step_id);
            let wait = wait_by_step.remove(&step_id);
            let loop_split = split_by_step.remove(&step_id);
            let not_sent = not_sent_by_step.get(&step_id).copied();
            ReportStep {
                step_id,
                count,
                error_count: errors,
                status_counts,
                p50_ms: p.p50_ms,
                p95_ms: p.p95_ms,
                p99_ms: p.p99_ms,
                loop_breakdown: breakdown,
                download,
                wait,
                loop_split,
                not_sent,
            }
        })
        .collect();
    steps.sort_by(|a, b| a.step_id.cmp(&b.step_id));

    let summary = ReportSummary {
        count: total_count,
        errors: total_errors,
        rps,
        duration_seconds,
        mean_ms: (overall.mean() / 1_000.0).round() as u64,
        p50_ms: overall_p.p50_ms,
        p95_ms: overall_p.p95_ms,
        p99_ms: overall_p.p99_ms,
    };
    // completed + 활성 criteria일 때만 verdict (spec §6). RunStatus는 Copy.
    let verdict = match (run.status, run.profile.criteria.as_ref()) {
        (RunStatus::Completed, Some(c)) if c.has_any() => {
            let v = evaluate_criteria(c, &summary, &status_dist, &windows, &steps);
            if v.criteria.is_empty() { None } else { Some(v) }
        }
        _ => None,
    };
    let mut insights = crate::insights::derive_insights(
        &summary,
        &steps,
        &windows,
        &status_dist,
        verdict.as_ref(),
        scenario_yaml,
        run.dropped as u64,
        run.profile.max_in_flight,
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
        &error_kinds_rolled,
    );
    crate::insights::refine_saturation_stall(
        &mut insights,
        open_loop_totals,
        run.profile.max_in_flight,
    );

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
            let p = w
                .hist
                .as_ref()
                .map(percentiles_of)
                .unwrap_or_else(Percentiles::empty);
            WorkerBreakdown {
                worker_id,
                count: w.count,
                errors: w.errors,
                p50_ms: p.p50_ms,
                p95_ms: p.p95_ms,
                p99_ms: p.p99_ms,
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
        },
        scenario_yaml: scenario_yaml.to_string(),
        summary,
        windows,
        steps,
        status_distribution: status_dist,
        if_breakdown,
        error_kinds: error_kinds_rolled,
        loop_exits: loop_exits_rolled,
        verdict,
        insights,
        dropped: run.dropped as u64,
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
            ts_second: ts,
            step_id: step.into(),
            worker_id: "w-0".into(),
            count,
            error_count: errors,
            status_counts: sc.into(),
            hdr_histogram: make_hdr_bytes(samples),
        }
    }

    #[test]
    fn build_report_merges_worker_windows() {
        let r = run_row();
        // Same (ts_second=100, step_id="s"), two workers, distinct latency samples.
        // A3a keep-first would drop one row -> undercount + half the histogram.
        let rows = vec![
            WindowWithHdr {
                ts_second: 100,
                step_id: "s".into(),
                worker_id: "w-a".into(),
                count: 3,
                error_count: 0,
                status_counts: r#"{"200":3}"#.into(),
                hdr_histogram: make_hdr_bytes(&[10_000, 10_000, 10_000]),
            },
            WindowWithHdr {
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

    #[test]
    fn build_report_tolerates_bad_hdr_blob() {
        let r = run_row();
        let bad = WindowWithHdr {
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
        );
        assert_eq!(rpt.summary.count, 5);
        assert_eq!(rpt.status_distribution.get("200").copied(), Some(5));
        assert_eq!(rpt.windows[0].p95_ms, 0);
        assert_eq!(rpt.summary.p95_ms, 0);
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
        let v = evaluate_criteria(
            &c,
            &summary(20, 5, 20.0, 9, 150),
            &BTreeMap::new(),
            &[],
            &steps,
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
        let v = evaluate_criteria(&c, &summary(4, 0, 4.0, 1, 1), &BTreeMap::new(), &[], &steps);
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
        let v = evaluate_criteria(&c, &summary(0, 0, 0.0, 0, 0), &BTreeMap::new(), &[], &steps);
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
        let v = evaluate_criteria(
            &c,
            &summary(20, 0, 20.0, 150, 150),
            &BTreeMap::new(),
            &[],
            &steps,
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
        let v = evaluate_criteria(
            &c,
            &summary(1000, 10, 200.0, 300, 400),
            &BTreeMap::new(),
            &[],
            &[],
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
        let v = evaluate_criteria(
            &c,
            &summary(100, 0, 50.0, 300, 400),
            &BTreeMap::new(),
            &[],
            &[],
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
            evaluate_criteria(&c, &summary(0, 0, 0.0, 0, 0), &BTreeMap::new(), &[], &[]).passed
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
            !evaluate_criteria(&c, &summary(0, 0, 0.0, 0, 0), &BTreeMap::new(), &[], &[]).passed
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
                "scenario_yaml",
                "status_distribution",
                "steps",
                "summary",
                "validity",
                "windows"
            ]
        );
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
        let v = evaluate_criteria(&c, &summary(100, 0, 100.0, 5, 5), &d, &[], &[]);
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
        let v = evaluate_criteria(&c, &summary(5, 5, 5.0, 0, 0), &d, &[], &[]);
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
        let v = evaluate_criteria(&c, &summary(11, 1, 11.0, 5, 5), &d, &[], &[]);
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
        let v = evaluate_criteria(&c, &summary(0, 0, 0.0, 0, 0), &BTreeMap::new(), &[], &[]);
        assert!(v.criteria.is_empty());
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
        let v = evaluate_criteria(&c, &summary(30, 0, 30.0, 1, 1), &d, &w, &[]);
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
        let v = evaluate_criteria(&c, &summary(107, 22, 107.0, 5, 5), &d, &[], &[]);
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
        );
        assert!(rep2.connection.is_none());
    }

    #[test]
    fn build_report_attaches_worker_breakdown_for_multiworker() {
        let r = run_row();
        // Same (ts,step), two workers, distinct counts + latencies; rows out of worker order.
        let rows = vec![
            WindowWithHdr {
                ts_second: 100,
                step_id: "s".into(),
                worker_id: "w-1".into(),
                count: 5,
                error_count: 1,
                status_counts: r#"{"200":4,"500":1}"#.into(),
                hdr_histogram: make_hdr_bytes(&[40_000, 40_000, 40_000, 40_000, 40_000]),
            },
            WindowWithHdr {
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
        );
        assert!(rep.worker_breakdown.is_empty());
    }

    #[test]
    fn build_report_worker_breakdown_tolerates_bad_hdr_blob() {
        let r = run_row();
        let rows = vec![
            WindowWithHdr {
                ts_second: 100,
                step_id: "s".into(),
                worker_id: "w-0".into(),
                count: 2,
                error_count: 0,
                status_counts: r#"{"200":2}"#.into(),
                hdr_histogram: vec![0xff, 0xff, 0xff, 0xff], // undecodable
            },
            WindowWithHdr {
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
                    .any(|l| l.as_str().unwrap().starts_with("계단 1000 req/s은(는)"))
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
