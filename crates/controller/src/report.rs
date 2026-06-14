use crate::store::metrics::{
    GroupMetricRow, IfBranchRow, LoopMetricRow, PhaseMetricRow, WindowWithHdr,
};
use crate::store::runs::{RunRow, RunStatus};
use handicap_engine::percentiles::{
    CURVE_QUANTILES, HISTOGRAM_BINS, Percentiles, decode_hdr, log_buckets, merge_into,
    percentile_curve, percentiles_of,
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
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ReportSummary {
    pub count: u64,
    pub errors: u64,
    pub rps: f64,
    pub duration_seconds: i64,
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
            });
        }
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

fn fresh_hist() -> Histogram<u64> {
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
        if let Ok(Some(h)) = decode_hdr(&r.hdr_histogram) {
            merge_into(&mut overall, &h);
            let step_h = per_step.entry(r.step_id.clone()).or_insert_with(fresh_hist);
            merge_into(step_h, &h);
            let win_h = acc.hist.get_or_insert_with(fresh_hist);
            merge_into(win_h, &h);
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

    let mut steps: Vec<ReportStep> = per_step_count
        .into_iter()
        .map(|(step_id, (count, errors, status_counts))| {
            let p = per_step
                .get(&step_id)
                .map(percentiles_of)
                .unwrap_or_else(Percentiles::empty);
            let breakdown = loop_by_step.remove(&step_id).unwrap_or_default();
            let download = download_by_step.remove(&step_id);
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
            }
        })
        .collect();
    steps.sort_by(|a, b| a.step_id.cmp(&b.step_id));

    let summary = ReportSummary {
        count: total_count,
        errors: total_errors,
        rps,
        duration_seconds,
        p50_ms: overall_p.p50_ms,
        p95_ms: overall_p.p95_ms,
        p99_ms: overall_p.p99_ms,
    };
    // completed + 활성 criteria일 때만 verdict (spec §6). RunStatus는 Copy.
    let verdict = match (run.status, run.profile.criteria.as_ref()) {
        (RunStatus::Completed, Some(c)) if c.has_any() => {
            let v = evaluate_criteria(c, &summary, &status_dist, &windows);
            if v.criteria.is_empty() { None } else { Some(v) }
        }
        _ => None,
    };
    let insights = crate::insights::derive_insights(
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
        },
        scenario_yaml: scenario_yaml.to_string(),
        summary,
        windows,
        steps,
        status_distribution: status_dist,
        if_breakdown,
        verdict,
        insights,
        dropped: run.dropped as u64,
        latency,
        group_latency,
        active_vu_series,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::runs::{Criteria, Profile, RunStatus};
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
                criteria: None,
                think_time: None,
                think_seed: None,
                target_rps: None,
                max_in_flight: None,
                stages: None,
                measure_phases: false,
                vu_stages: None,
                ramp_down: None,
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
        let rep = build_report(&r, &yaml, &rows, &[], &[], &[], &[], &[]);

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
        let rpt = build_report(&r, &yaml, &rows, &[], &[], &[], &[], &[]);
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
        let rpt = build_report(&r, &yaml, &[bad], &[], &[], &[], &[], &[]);
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
        let rep = build_report(&r, &yaml, &rows, &loops, &[], &[], &[], &[]);
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
        let rep = build_report(&r, &yaml, &rows, &[], &branches, &[], &[], &[]);
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
            p50_ms: 0,
            p95_ms: p95,
            p99_ms: p99,
        }
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
        let v = evaluate_criteria(&c, &summary(100, 0, 50.0, 300, 400), &BTreeMap::new(), &[]);
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
        assert!(evaluate_criteria(&c, &summary(0, 0, 0.0, 0, 0), &BTreeMap::new(), &[]).passed);
    }

    #[test]
    fn evaluate_min_rps_zero_fails() {
        let c = Criteria {
            min_rps: Some(1.0),
            ..Default::default()
        };
        // rps 0.0 < 1.0 → fail (degenerate 0-throughput completed run)
        assert!(!evaluate_criteria(&c, &summary(0, 0, 0.0, 0, 0), &BTreeMap::new(), &[]).passed);
    }

    #[test]
    fn build_report_attaches_verdict_for_completed_with_criteria() {
        let mut run = run_row(); // status = Completed
        run.profile.criteria = Some(Criteria {
            max_p95_ms: Some(1000),
            ..Default::default()
        });
        let rep = build_report(&run, "", &[], &[], &[], &[], &[], &[]);
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
            build_report(&run, "", &[], &[], &[], &[], &[], &[])
                .verdict
                .is_none()
        );
    }

    #[test]
    fn build_report_no_verdict_when_criteria_all_none() {
        let mut run = run_row();
        run.profile.criteria = Some(Criteria::default()); // 활성 0개
        assert!(
            build_report(&run, "", &[], &[], &[], &[], &[], &[])
                .verdict
                .is_none()
        );
    }

    #[test]
    fn build_report_surfaces_dropped() {
        let mut run = run_row();
        run.dropped = 7;
        let rep = build_report(&run, "", &[], &[], &[], &[], &[], &[]);
        assert_eq!(
            rep.dropped, 7,
            "ReportJson.dropped must reflect RunRow.dropped"
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
        let rep = build_report(&r, &yaml, &rows, &[], &[], &[], &[], &[]);

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
            build_report(&r, "", &[], &[], &[], &[], &[], &[])
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
        let v = evaluate_criteria(&c, &summary(100, 0, 100.0, 5, 5), &d, &[]);
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
        let v = evaluate_criteria(&c, &summary(5, 5, 5.0, 0, 0), &d, &[]);
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
        let v = evaluate_criteria(&c, &summary(11, 1, 11.0, 5, 5), &d, &[]);
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
        let v = evaluate_criteria(&c, &summary(0, 0, 0.0, 0, 0), &BTreeMap::new(), &[]);
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
        let v = evaluate_criteria(&c, &summary(30, 0, 30.0, 1, 1), &d, &w);
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
            build_report(&run, "", &[], &[], &[], &[], &[], &[])
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

        let rep = build_report(&r, &yaml, &rows, &[], &[], &groups, &[], &[]);

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
            },
            ActiveVuRow {
                run_id: r.id.clone(),
                ts_second: 101,
                desired: 5,
                actual: 5,
            },
        ];
        let rep = build_report(&r, &yaml, &rows, &[], &[], &[], &[], &active);
        assert_eq!(rep.active_vu_series.len(), 2);
        assert_eq!(
            (
                rep.active_vu_series[0].ts_second,
                rep.active_vu_series[0].desired,
                rep.active_vu_series[0].actual
            ),
            (100, 3, 2)
        );
        let baseline = build_report(&r, &yaml, &rows, &[], &[], &[], &[], &[]);
        assert_eq!(rep.summary.count, baseline.summary.count);
        assert_eq!(rep.summary.rps, baseline.summary.rps);
        assert_eq!(rep.windows.len(), baseline.windows.len());
        assert!(baseline.active_vu_series.is_empty());
    }

    #[test]
    fn build_report_empty_groups_yields_empty_group_latency() {
        let r = run_row();
        let rep = build_report(&r, "", &[], &[], &[], &[], &[], &[]);
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
        let rep = build_report(&r, &yaml, &rows, &[], &[], &groups, &[], &[]);

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
        let rep = build_report(&r, yaml, &rows, &[], &[], &[], &phases, &[]);
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
        );
        assert!(
            rep.steps.iter().all(|s| s.download.is_none()),
            "no download when phases empty (byte-identical)"
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
        let rep = build_report(&run, "", &rows, &[], &[], &[], &[], &[]);
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
        let rep = build_report(&run, "", &rows, &[], &[], &[], &[], &[]);
        assert!(rep.insights.iter().all(|i| i.kind != "load_gen_saturated"));
    }

    #[test]
    fn build_report_sizing_slots_recommendation() {
        // open-loop: target 10000, max_in_flight=100(<500 needed at p50=50ms), dropped>0
        // → load_gen_saturated에 cause="slots", recommended=500.
        let mut run = run_row();
        run.profile.target_rps = Some(10_000);
        run.profile.max_in_flight = Some(100);
        run.dropped = 200;
        // 50ms(=50_000µs) 샘플 100개 → overall p50_ms ≈ 50.
        let rows = vec![win(100, "s", 100, 0, r#"{"200":100}"#, &[50_000; 100])];
        let rep = build_report(&run, "", &rows, &[], &[], &[], &[], &[]);
        let ins = rep
            .insights
            .iter()
            .find(|i| i.kind == "load_gen_saturated")
            .expect("saturation insight");
        assert_eq!(ins.cause.as_deref(), Some("slots"));
        assert_eq!(ins.recommended, Some(500.0));
        assert_eq!(ins.count, Some(200));
    }

    #[test]
    fn build_report_sizing_uses_stages_peak() {
        // target_rps 없음, stages-peak=12000 주입 → required=ceil(12000*0.05)=600.
        // max_in_flight=100 < 600 → slots, recommended=600. (유효목표 산출=report.rs 책임.)
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
        let rep = build_report(&run, "", &rows, &[], &[], &[], &[], &[]);
        let ins = rep
            .insights
            .iter()
            .find(|i| i.kind == "load_gen_saturated")
            .expect("saturation insight");
        assert_eq!(ins.recommended, Some(600.0));
        assert_eq!(ins.cause.as_deref(), Some("slots"));
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
        let v = evaluate_criteria(&c, &summary(107, 22, 107.0, 5, 5), &d, &[]);
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
}
