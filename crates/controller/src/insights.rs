//! Deterministic, rule-based actionable insights derived from a built report.
//! Pure: backend computes structured insights; the UI renders the prose.
//! Spec: docs/superpowers/specs/2026-06-03-a4c-actionable-report-summary-design.md
use crate::report::{ReportStep, ReportSummary, ReportWindow, Verdict};
use handicap_engine::{Scenario, Step};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Insight {
    pub kind: String,
    pub severity: String, // "critical" | "warning" | "info"
    #[serde(skip_serializing_if = "Option::is_none")]
    pub step_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metric: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub value: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pct: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub count: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status_class: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub window_seconds: Option<i64>,
    /// 권장 max_in_flight (slot-bound일 때만 Some, 정수값).
    /// ceil(target_eff × M ÷ achieved_arrival_rate). (ADR-0046)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub recommended: Option<f64>,
    /// 사이징/포화 원인: "slots"(max_in_flight 부족) | "sut"(대상 서버 한계, 슬롯 증설 무익).
    /// None = 판별 불가. (ADR-0046: 2-way — loadgen arm 제거)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cause: Option<String>,
    /// DEPRECATED(ADR-0046): 사후 산출 제거 — 항상 None. 워커 텔레메트리 도입 시 재사용(roadmap §B20).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub recommended_workers: Option<f64>,
    /// 포화 도달 시점(run-relative seconds). ramp run에서만 Some(= t_peak − min_ts).
    /// flat/고정-레이트·windows 부재면 None. spec R6.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub onset_second: Option<i64>,
    /// 달성 도착률(반복/초) — open-loop 포화 인사이트에서 계산 가능할 때만 Some. (ADR-0046 R5)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub achieved_per_sec: Option<f64>,
    /// 목표 도착률(반복/초, 곡선이면 peak) — 위와 동일 조건. (ADR-0046 R5)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target_per_sec: Option<f64>,
}

impl Insight {
    fn new(kind: &str, severity: &str) -> Self {
        Insight {
            kind: kind.to_string(),
            severity: severity.to_string(),
            step_id: None,
            metric: None,
            value: None,
            pct: None,
            count: None,
            status_class: None,
            window_seconds: None,
            recommended: None,
            cause: None,
            recommended_workers: None,
            onset_second: None,
            achieved_per_sec: None,
            target_per_sec: None,
        }
    }
}

/// Global emit order = the spec §5 table row index (already severity-sorted).
/// status_class is split: 5xx (critical) sorts with slo_failure, 4xx (warning)
/// with the warnings. Lower rank first.
fn order_rank(i: &Insight) -> u8 {
    match (i.kind.as_str(), i.status_class.as_deref()) {
        ("slo_failure", _) => 1,
        ("status_class", Some("5xx")) => 2,
        ("load_gen_saturated", _) => 3,
        ("no_request_step", _) => 4,
        ("error_hotspot", _) => 5,
        ("status_class", Some("4xx")) => 6,
        ("status_temporal", _) => 7,
        ("slowest_step", _) => 8,
        ("slo_pass", _) => 9,
        _ => 99,
    }
}

/// Open-loop run이 `duration_actual`초 동안 스케줄한 도착(반복) 총수. 고정 rate =
/// target × duration; 곡선 = 0-start piecewise-linear 램프(엔진 runner.rs::rate_at 미러 —
/// private라 재구현, 테스트 fixture가 의미 고정)의 사다리꼴 적분을 duration_actual에서
/// 절단(끝을 지나면 마지막 target 유지). 어느 쪽도 없으면(비-open-loop) None. (ADR-0046 R2)
pub(crate) fn scheduled_arrivals(
    target_rps: Option<u32>,
    stages: Option<&[handicap_engine::Stage]>,
    duration_actual: f64,
) -> Option<f64> {
    if let Some(stages) = stages.filter(|s| !s.is_empty()) {
        let mut total = 0.0f64;
        let mut seg_start = 0.0f64;
        let mut prev = 0.0f64;
        for st in stages {
            let span = f64::from(st.duration_seconds);
            let target = f64::from(st.target);
            let seg_end = seg_start + span;
            if duration_actual >= seg_end {
                total += (prev + target) / 2.0 * span; // 전체 stage
            } else if duration_actual > seg_start && span > 0.0 {
                let t = duration_actual - seg_start; // 부분 stage: t 지점 rate까지 선형 적분
                let rate_at_t = prev + (target - prev) * (t / span);
                return Some(total + (prev + rate_at_t) / 2.0 * t);
            } else {
                return Some(total);
            }
            seg_start = seg_end;
            prev = target;
        }
        if duration_actual > seg_start {
            total += prev * (duration_actual - seg_start); // 곡선 끝 이후: 마지막 target 유지
        }
        return Some(total);
    }
    target_rps.map(|t| f64::from(t) * duration_actual)
}

// 10 인자: A9 사이징(max_in_flight/target_rps/scheduled_arrivals)이 기존 7 인자에
// 더해져 clippy 임계(7)를 넘는다.
// 모두 별개 read-only 컨텍스트라 struct 묶음은 호출부만 번잡해진다(단일 prod 호출부 + 테스트).
#[allow(clippy::too_many_arguments)]
pub fn derive_insights(
    summary: &ReportSummary,
    steps: &[ReportStep],
    windows: &[ReportWindow],
    status_distribution: &BTreeMap<String, u64>,
    verdict: Option<&Verdict>,
    scenario_yaml: &str,
    dropped: u64,
    max_in_flight: Option<u32>,
    target_rps: Option<u32>,
    scheduled_arrivals: Option<f64>,
) -> Vec<Insight> {
    let mut out: Vec<Insight> = Vec::new();

    // slowest_step: step with max p95 (first on tie — steps are sorted by step_id).
    let mut slowest: Option<&ReportStep> = None;
    for s in steps {
        if slowest.is_none_or(|cur| s.p95_ms > cur.p95_ms) {
            slowest = Some(s);
        }
    }
    if let Some(s) = slowest {
        let mut ins = Insight::new("slowest_step", "info");
        ins.step_id = Some(s.step_id.clone());
        ins.metric = Some("p95_ms".to_string());
        ins.value = Some(s.p95_ms as f64);
        out.push(ins);
    }

    // slo_failure / slo_pass
    if let Some(v) = verdict {
        if v.passed {
            out.push(Insight::new("slo_pass", "info"));
        } else {
            let failed = v.criteria.iter().filter(|c| !c.passed).count() as u64;
            let mut ins = Insight::new("slo_failure", "critical");
            ins.count = Some(failed);
            out.push(ins);
        }
    }

    // error_hotspot: step holding the largest share of engine errors.
    // NOTE: error_count counts engine failures (failed assert / extract / transport),
    // NOT raw 4xx/5xx. Independent of status_class.
    if summary.errors > 0 {
        let mut top: Option<&ReportStep> = None;
        for s in steps {
            if s.error_count > 0 && top.is_none_or(|cur| s.error_count > cur.error_count) {
                top = Some(s);
            }
        }
        if let Some(s) = top {
            let mut ins = Insight::new("error_hotspot", "warning");
            ins.step_id = Some(s.step_id.clone());
            ins.pct = Some(s.error_count as f64 / summary.errors as f64);
            ins.count = Some(s.error_count);
            out.push(ins);
        }
    }

    // status_class: HTTP 4xx/5xx share. Denominator = HTTP responses only
    // (keys starting 1..5); the "0" transport-failure bucket is excluded from
    // both classification and denominator (engine failures are error_count's job).
    // Shared helpers ensure this denominator == evaluate_criteria's 4xx/5xx_rate denominator.
    let total_http = crate::report::http_response_total(status_distribution);
    if total_http > 0 {
        for (class, first, sev) in [("4xx", '4', "warning"), ("5xx", '5', "critical")] {
            let class_count = crate::report::status_class_count(status_distribution, first);
            if class_count > 0 {
                let mut ins = Insight::new("status_class", sev);
                ins.status_class = Some(class.to_string());
                ins.pct = Some(class_count as f64 / total_http as f64);
                ins.count = Some(class_count);
                out.push(ins);
            }
        }
    }

    // status_temporal: 5xx that appears late. Interval = [min_ts, max_ts] over
    // windows that actually have data. Emit only when the first 5xx second is
    // strictly past the midpoint (early 5xx is already covered by status_class).
    {
        let mut sec_5xx: BTreeMap<i64, u64> = BTreeMap::new();
        let mut min_ts = i64::MAX;
        let mut max_ts = i64::MIN;
        for w in windows {
            min_ts = min_ts.min(w.ts_second);
            max_ts = max_ts.max(w.ts_second);
            let c: u64 = w
                .status_counts
                .iter()
                .filter(|(k, _)| k.starts_with('5'))
                .map(|(_, v)| *v)
                .sum();
            if c > 0 {
                *sec_5xx.entry(w.ts_second).or_insert(0) += c;
            }
        }
        if !sec_5xx.is_empty() && max_ts > min_ts {
            let t_first = *sec_5xx.keys().next().expect("non-empty");
            let midpoint = min_ts as f64 + (max_ts - min_ts) as f64 / 2.0;
            if (t_first as f64) > midpoint {
                let mut ins = Insight::new("status_temporal", "warning");
                ins.status_class = Some("5xx".to_string());
                ins.window_seconds = Some(max_ts - t_first + 1);
                out.push(ins);
            }
        }
    }

    // no_request_step: unconditionally-reached http steps that recorded nothing.
    // Fail-soft: empty/invalid scenario_yaml just skips this kind.
    if let Ok(sc) = Scenario::from_yaml(scenario_yaml) {
        let present: BTreeSet<&str> = steps.iter().map(|s| s.step_id.as_str()).collect();
        let mut expected: Vec<String> = Vec::new();
        collect_unconditional(&sc.steps, false, &mut expected);
        expected.sort();
        expected.dedup();
        for id in expected {
            if !present.contains(id.as_str()) {
                let mut ins = Insight::new("no_request_step", "warning");
                ins.step_id = Some(id);
                out.push(ins);
            }
        }
    }

    // load_gen_saturated: open-loop run이 요청한 도착률을 못 냈다(슬롯 부족으로
    // 발사 못한 반복 = dropped). dropped는 open-loop 스케줄러만 증가시키므로
    // (closed-loop은 항상 0) `dropped > 0`이 자동으로 open-loop에 한정된다.
    // 사이징(ADR-0046): 포화 중엔 M개 슬롯이 상시 사용 중이므로 반복 점유시간이
    // hold = M ÷ 달성 도착률로 자기측정된다(think·멀티스텝·분기 자동 반영).
    // required = ceil(target × hold). 관측 천장 value = peak 초당 요청 수(기존 의미 유지).
    if dropped > 0 {
        let mut by_sec: BTreeMap<i64, u64> = BTreeMap::new();
        for w in windows {
            *by_sec.entry(w.ts_second).or_insert(0) += w.count;
        }
        let peak = by_sec
            .values()
            .copied()
            .max()
            .unwrap_or_else(|| summary.rps.round() as u64);
        let mut ins = Insight::new("load_gen_saturated", "warning");
        ins.value = Some(peak as f64);
        ins.count = Some(dropped);
        ins.onset_second = saturation_onset(&by_sec, peak);

        // fallback(target/M/scheduled 중 하나라도 None — 구식 run/profile 부재, 테스트 fixture
        // 포함): 인사이트는 emit하되 cause/recommended/신규 필드 전부 None (기존 `_ => {}` 폴백 계승).
        if let (Some(target), Some(m), Some(scheduled)) =
            (target_rps, max_in_flight, scheduled_arrivals)
        {
            let duration = summary.duration_seconds.max(1) as f64;
            let achieved = ((scheduled - dropped as f64) / duration).max(0.0);
            ins.target_per_sec = Some(f64::from(target));
            ins.achieved_per_sec = Some(achieved);
            // sut 판정이 우선(R3·R13): 서버 열화면 슬롯 증설 권장 자체가 유해.
            if sut_stress(status_distribution, windows) {
                ins.cause = Some("sut".to_string());
            } else {
                ins.cause = Some("slots".to_string());
                // achieved 0(dropped ≥ scheduled)이면 validate 상한(10_000,
                // api/runs.rs:290)으로 클램프 — "권장 불능"이 아니라 상한 신호.
                let required = if achieved > 0.0 {
                    (f64::from(target) * f64::from(m) / achieved).ceil()
                } else {
                    10_000.0
                };
                ins.recommended = Some(required.clamp(1.0, 10_000.0));
            }
        }
        out.push(ins);
    }

    out.sort_by_key(order_rank);
    out
}

/// SUT-stress 휴리스틱 임계값 (spec §4.1, named const).
const TAU_5XX: f64 = 0.01; // 5xx률 1% 이상이면 SUT-bound
const TAU_LAT: f64 = 1.5; // late p95 중앙값이 early의 1.5배 이상이면 SUT-bound
const TAU_SPAN: i64 = 6; // 지연상승은 run span >= 6초일 때만 평가

/// 정렬 후 중앙값(짝수 길이는 두 중앙값 평균). 빈 슬라이스는 0.0.
fn median(vals: &[u64]) -> f64 {
    if vals.is_empty() {
        return 0.0;
    }
    let mut v = vals.to_vec();
    v.sort_unstable();
    let n = v.len();
    if n % 2 == 1 {
        v[n / 2] as f64
    } else {
        (v[n / 2 - 1] + v[n / 2]) as f64 / 2.0
    }
}

/// 지연상승 신호(spec R2): distinct 초 L개에서 k=⌊L/3⌋초씩 early/late third로 나눠
/// "초별 최악-스텝 p95"의 중앙값을 비교. late ≥ TAU_LAT × early면 true.
/// k<1 또는 span<TAU_SPAN이면 false(짧은 run은 추세 판단 불가).
fn latency_rose(windows: &[ReportWindow]) -> bool {
    let mut by_sec: BTreeMap<i64, u64> = BTreeMap::new();
    for w in windows {
        let e = by_sec.entry(w.ts_second).or_insert(0);
        *e = (*e).max(w.p95_ms);
    }
    let secs: Vec<i64> = by_sec.keys().copied().collect();
    let l = secs.len();
    let k = l / 3;
    if k < 1 || secs[l - 1] - secs[0] < TAU_SPAN {
        return false;
    }
    let early: Vec<u64> = secs[..k].iter().map(|s| by_sec[s]).collect();
    let late: Vec<u64> = secs[l - k..].iter().map(|s| by_sec[s]).collect();
    let em = median(&early);
    em > 0.0 && median(&late) >= TAU_LAT * em
}

/// SUT-stress(spec R2): 5xx률 ≥ TAU_5XX(ground-truth) OR 지연상승(약한 신호).
/// sut 판정이 항상 선평가(ADR-0046) — target/M/scheduled 셋 다 있을 때 cause 분기 전에 먼저 호출.
fn sut_stress(dist: &BTreeMap<String, u64>, windows: &[ReportWindow]) -> bool {
    let total = crate::report::http_response_total(dist);
    if total > 0 {
        let c5 = crate::report::status_class_count(dist, '5');
        if (c5 as f64) / (total as f64) >= TAU_5XX {
            return true;
        }
    }
    latency_rose(windows)
}

/// 포화 도달 시점(spec R6): ramp run에서만 Some(t_peak − min_ts).
/// ramp 판정 = early-third(앞 ⌊L/3⌋초) 처리량 중앙값 < 0.5×peak(단일 warmup-dip 무시).
/// L<3 또는 peak==0(windows 부재)면 None. flat이면 None.
fn saturation_onset(by_sec: &BTreeMap<i64, u64>, peak: u64) -> Option<i64> {
    let secs: Vec<i64> = by_sec.keys().copied().collect();
    let l = secs.len();
    let k = l / 3;
    if l < 3 || peak == 0 || k < 1 {
        return None;
    }
    let early: Vec<u64> = secs[..k].iter().map(|s| by_sec[s]).collect();
    if median(&early) >= 0.5 * peak as f64 {
        return None; // flat → onset 무의미
    }
    let t_peak = *secs.iter().find(|s| by_sec[s] == peak)?;
    Some(t_peak - secs[0])
}

/// Collect ids of http steps that ALWAYS run: top-level + loop bodies (repeat>=1).
/// if/elif/else branch steps are excluded — 0 requests there is expected (branch
/// not taken), not a defect.
///
/// Shared with `validity` for `no_response_validation` (same walk rules — H6).
pub(crate) fn collect_unconditional(steps: &[Step], conditional: bool, out: &mut Vec<String>) {
    for s in steps {
        match s {
            Step::Http(h) => {
                if !conditional {
                    out.push(h.id.clone());
                }
            }
            Step::Loop(l) => {
                let cond = conditional || l.repeat == 0;
                collect_unconditional(&l.do_, cond, out);
            }
            Step::If(i) => {
                collect_unconditional(&i.then_, true, out);
                for e in &i.elif {
                    collect_unconditional(&e.then_, true, out);
                }
                collect_unconditional(&i.else_, true, out);
            }
            Step::Parallel(p) => {
                // All branches always run → unconditional (pass the flag through,
                // like the loop arm). ADR-0033.
                for b in &p.branches {
                    collect_unconditional(&b.steps, conditional, out);
                }
            }
        }
    }
}

/// True if the http step with `id` has at least one `Assertion::Status` in its
/// assert list. Walks the full step tree (including if branches / loop bodies /
/// parallel) to locate the step — callers should only pass ids from
/// [`collect_unconditional`] so conditional-only steps are not consulted for
/// validity (plan H6).
pub(crate) fn http_step_has_status_assert(steps: &[Step], id: &str) -> bool {
    find_http_step(steps, id).is_some_and(|h| {
        h.assert
            .iter()
            .any(|a| matches!(a, handicap_engine::Assertion::Status(_)))
    })
}

fn find_http_step<'a>(steps: &'a [Step], id: &str) -> Option<&'a handicap_engine::HttpStep> {
    for s in steps {
        match s {
            Step::Http(h) if h.id == id => return Some(h),
            Step::Http(_) => {}
            Step::Loop(l) => {
                if let Some(h) = find_http_step(&l.do_, id) {
                    return Some(h);
                }
            }
            Step::If(i) => {
                if let Some(h) = find_http_step(&i.then_, id) {
                    return Some(h);
                }
                for e in &i.elif {
                    if let Some(h) = find_http_step(&e.then_, id) {
                        return Some(h);
                    }
                }
                if let Some(h) = find_http_step(&i.else_, id) {
                    return Some(h);
                }
            }
            Step::Parallel(p) => {
                for b in &p.branches {
                    if let Some(h) = find_http_step(&b.steps, id) {
                        return Some(h);
                    }
                }
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::report::ReportStep;

    fn step(id: &str, p95: u64) -> ReportStep {
        ReportStep {
            step_id: id.to_string(),
            count: 1,
            error_count: 0,
            status_counts: BTreeMap::new(),
            p50_ms: 1,
            p95_ms: p95,
            p99_ms: p95,
            loop_breakdown: vec![],
            download: None,
            wait: None,
        }
    }
    fn summary() -> ReportSummary {
        ReportSummary {
            count: 0,
            errors: 0,
            rps: 0.0,
            duration_seconds: 1,
            mean_ms: 0,
            p50_ms: 0,
            p95_ms: 0,
            p99_ms: 0,
        }
    }

    #[test]
    fn empty_when_no_signal() {
        let got = derive_insights(
            &summary(),
            &[],
            &[],
            &BTreeMap::new(),
            None,
            "",
            0,
            None,
            None,
            None,
        );
        assert!(got.is_empty());
    }

    fn verdict(passed: bool, fails: usize) -> Verdict {
        use crate::report::CriterionResult;
        let mut criteria = vec![];
        for i in 0..(fails + 1) {
            criteria.push(CriterionResult {
                metric: format!("m{i}"),
                direction: "max".to_string(),
                threshold: 1.0,
                actual: if i < fails { 2.0 } else { 0.0 },
                passed: i >= fails,
                target: None,
            });
        }
        Verdict { passed, criteria }
    }

    #[test]
    fn slo_failure_counts_failed_criteria() {
        let v = verdict(false, 2);
        let got = derive_insights(
            &summary(),
            &[],
            &[],
            &BTreeMap::new(),
            Some(&v),
            "",
            0,
            None,
            None,
            None,
        );
        let f = got
            .iter()
            .find(|i| i.kind == "slo_failure")
            .expect("slo_failure");
        assert_eq!(f.severity, "critical");
        assert_eq!(f.count, Some(2));
    }

    #[test]
    fn slo_pass_when_passed() {
        let v = verdict(true, 0);
        let got = derive_insights(
            &summary(),
            &[],
            &[],
            &BTreeMap::new(),
            Some(&v),
            "",
            0,
            None,
            None,
            None,
        );
        let p = got.iter().find(|i| i.kind == "slo_pass").expect("slo_pass");
        assert_eq!(p.severity, "info");
        assert!(got.iter().all(|i| i.kind != "slo_failure"));
    }

    fn step_err(id: &str, errors: u64) -> ReportStep {
        let mut s = step(id, 10);
        s.error_count = errors;
        s
    }

    #[test]
    fn error_hotspot_picks_top_error_share() {
        let steps = vec![step_err("a", 100), step_err("b", 900)];
        let mut s = summary();
        s.errors = 1000;
        let got = derive_insights(
            &s,
            &steps,
            &[],
            &BTreeMap::new(),
            None,
            "",
            0,
            None,
            None,
            None,
        );
        let h = got
            .iter()
            .find(|i| i.kind == "error_hotspot")
            .expect("hotspot");
        assert_eq!(h.severity, "warning");
        assert_eq!(h.step_id.as_deref(), Some("b"));
        assert_eq!(h.count, Some(900));
        assert!((h.pct.unwrap() - 0.9).abs() < 1e-9);
    }

    #[test]
    fn no_error_hotspot_when_zero_errors() {
        let got = derive_insights(
            &summary(),
            &[step("a", 10)],
            &[],
            &BTreeMap::new(),
            None,
            "",
            0,
            None,
            None,
            None,
        );
        assert!(got.iter().all(|i| i.kind != "error_hotspot"));
    }

    #[test]
    fn slowest_step_picks_max_p95() {
        let steps = vec![step("a", 50), step("b", 120), step("c", 90)];
        let got = derive_insights(
            &summary(),
            &steps,
            &[],
            &BTreeMap::new(),
            None,
            "",
            0,
            None,
            None,
            None,
        );
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].kind, "slowest_step");
        assert_eq!(got[0].step_id.as_deref(), Some("b"));
        assert_eq!(got[0].value, Some(120.0));
    }

    fn win(ts: i64, status: &[(&str, u64)]) -> ReportWindow {
        ReportWindow {
            ts_second: ts,
            step_id: "a".to_string(),
            count: 1,
            error_count: 0,
            status_counts: status.iter().map(|(k, v)| (k.to_string(), *v)).collect(),
            p50_ms: 1,
            p95_ms: 1,
            p99_ms: 1,
        }
    }

    #[test]
    fn status_temporal_emits_when_5xx_is_late() {
        // run spans ts 0..10; 5xx first at ts 9 (> midpoint 5).
        let windows = vec![
            win(0, &[("200", 5)]),
            win(9, &[("500", 3)]),
            win(10, &[("500", 2)]),
        ];
        let got = derive_insights(
            &summary(),
            &[],
            &windows,
            &BTreeMap::new(),
            None,
            "",
            0,
            None,
            None,
            None,
        );
        let t = got
            .iter()
            .find(|i| i.kind == "status_temporal")
            .expect("temporal");
        assert_eq!(t.severity, "warning");
        assert_eq!(t.status_class.as_deref(), Some("5xx"));
        assert_eq!(t.window_seconds, Some(2)); // 10 - 9 + 1
    }

    #[test]
    fn no_status_temporal_when_5xx_early() {
        let windows = vec![win(0, &[("500", 5)]), win(10, &[("200", 5)])];
        let got = derive_insights(
            &summary(),
            &[],
            &windows,
            &BTreeMap::new(),
            None,
            "",
            0,
            None,
            None,
            None,
        );
        assert!(got.iter().all(|i| i.kind != "status_temporal"));
    }

    #[test]
    fn no_status_temporal_single_second() {
        let windows = vec![win(7, &[("500", 5)])]; // max_ts == min_ts
        let got = derive_insights(
            &summary(),
            &[],
            &windows,
            &BTreeMap::new(),
            None,
            "",
            0,
            None,
            None,
            None,
        );
        assert!(got.iter().all(|i| i.kind != "status_temporal"));
    }

    const YAML_TOP_AND_IF: &str = r#"
version: 1
name: t
steps:
  - type: http
    id: top1
    name: top1
    request: { method: GET, url: "http://x/1" }
  - type: http
    id: top2
    name: top2
    request: { method: GET, url: "http://x/2" }
  - type: if
    id: if1
    name: if1
    cond: { left: "a", op: eq, right: "b" }
    then:
      - type: http
        id: only_in_then
        name: only_in_then
        request: { method: GET, url: "http://x/3" }
"#;

    #[test]
    fn no_request_step_flags_unconditional_only() {
        // metrics recorded for top1 only → top2 missing (unconditional → flagged),
        // only_in_then missing (inside if branch → NOT flagged).
        let steps = vec![step("top1", 10)];
        let got = derive_insights(
            &summary(),
            &steps,
            &[],
            &BTreeMap::new(),
            None,
            YAML_TOP_AND_IF,
            0,
            None,
            None,
            None,
        );
        let flagged: Vec<&str> = got
            .iter()
            .filter(|i| i.kind == "no_request_step")
            .map(|i| i.step_id.as_deref().unwrap())
            .collect();
        assert_eq!(flagged, vec!["top2"]);
    }

    #[test]
    fn no_request_step_skipped_on_unparseable_yaml() {
        // empty yaml errors → no_request_step silently skipped (other insights survive).
        let got = derive_insights(
            &summary(),
            &[step("a", 10)],
            &[],
            &BTreeMap::new(),
            None,
            "",
            0,
            None,
            None,
            None,
        );
        assert!(got.iter().all(|i| i.kind != "no_request_step"));
        assert!(got.iter().any(|i| i.kind == "slowest_step")); // still computed
    }

    #[test]
    fn no_data_run_flags_unconditional_steps() {
        // spec §5 edge: 0 requests recorded, no verdict → top-level steps all flagged,
        // and no slowest_step (no metrics).
        let got = derive_insights(
            &summary(),
            &[],
            &[],
            &BTreeMap::new(),
            None,
            YAML_TOP_AND_IF,
            0,
            None,
            None,
            None,
        );
        let flagged: Vec<&str> = got
            .iter()
            .filter(|i| i.kind == "no_request_step")
            .map(|i| i.step_id.as_deref().unwrap())
            .collect();
        assert_eq!(flagged, vec!["top1", "top2"]); // only_in_then excluded (if branch)
        assert!(got.iter().all(|i| i.kind != "slowest_step"));
    }

    fn dist(pairs: &[(&str, u64)]) -> BTreeMap<String, u64> {
        pairs.iter().map(|(k, v)| (k.to_string(), *v)).collect()
    }

    #[test]
    fn insights_deterministic_order() {
        // all kinds present → assert the interleaved (severity,row) order.
        let steps = vec![step_err("a", 50)];
        let mut s = summary();
        s.errors = 50;
        let d = dist(&[("200", 100), ("404", 20), ("500", 30)]);
        let windows = vec![win(0, &[("200", 1)]), win(9, &[("500", 1)])];
        let v = verdict(false, 1);
        let got = derive_insights(&s, &steps, &windows, &d, Some(&v), "", 7, None, None, None);
        let order: Vec<(&str, Option<&str>)> = got
            .iter()
            .map(|i| (i.kind.as_str(), i.status_class.as_deref()))
            .collect();
        assert_eq!(
            order,
            vec![
                ("slo_failure", None),
                ("status_class", Some("5xx")),
                ("load_gen_saturated", None),
                ("error_hotspot", None),
                ("status_class", Some("4xx")),
                ("status_temporal", Some("5xx")),
                ("slowest_step", None),
            ]
        );
    }

    #[test]
    fn error_heavy_run_yields_at_least_three() {
        // capability check: errors via failing asserts (error_count), 5xx, slow step.
        let steps = vec![step_err("a", 200)];
        let mut s = summary();
        s.errors = 200;
        let d = dist(&[("200", 800), ("500", 200)]);
        let got = derive_insights(&s, &steps, &[], &d, None, "", 0, None, None, None);
        assert!(
            got.len() >= 3,
            "error-heavy run should surface >=3 insights, got {}",
            got.len()
        );
    }

    #[test]
    fn all_pass_run_has_slowest_and_slo_pass() {
        // spec §5 edge: clean run (no errors/4xx/5xx) + passing verdict → exactly
        // slowest_step + slo_pass, NOT padded to 3.
        let steps = vec![step("a", 80)];
        let v = verdict(true, 0);
        let got = derive_insights(
            &summary(),
            &steps,
            &[],
            &BTreeMap::new(),
            Some(&v),
            "",
            0,
            None,
            None,
            None,
        );
        let kinds: Vec<&str> = got.iter().map(|i| i.kind.as_str()).collect();
        assert_eq!(kinds, vec!["slowest_step", "slo_pass"]); // order_rank 8 then 9
    }

    #[test]
    fn slowest_step_first_on_tie() {
        // invariant lock: equal p95 → first step (steps are sorted by step_id).
        let steps = vec![step("a", 100), step("b", 100)];
        let got = derive_insights(
            &summary(),
            &steps,
            &[],
            &BTreeMap::new(),
            None,
            "",
            0,
            None,
            None,
            None,
        );
        assert_eq!(got[0].step_id.as_deref(), Some("a"));
        assert_eq!(got[0].value, Some(100.0));
    }

    #[test]
    fn no_request_step_flags_live_loop_body_not_dead() {
        // invariant lock for collect_unconditional's loop arm:
        // repeat>=1 loop body is unconditional (flagged when unrecorded),
        // repeat==0 loop body never runs (excluded).
        const YAML_LOOPS: &str = r#"
version: 1
name: t
steps:
  - type: loop
    id: live
    name: live
    repeat: 2
    do:
      - type: http
        id: in_live_loop
        name: in_live_loop
        request: { method: GET, url: "http://x/1" }
  - type: loop
    id: dead
    name: dead
    repeat: 0
    do:
      - type: http
        id: in_dead_loop
        name: in_dead_loop
        request: { method: GET, url: "http://x/2" }
"#;
        let got = derive_insights(
            &summary(),
            &[],
            &[],
            &BTreeMap::new(),
            None,
            YAML_LOOPS,
            0,
            None,
            None,
            None,
        );
        let flagged: Vec<&str> = got
            .iter()
            .filter(|i| i.kind == "no_request_step")
            .map(|i| i.step_id.as_deref().unwrap())
            .collect();
        assert_eq!(flagged, vec!["in_live_loop"]);
    }

    #[test]
    fn status_class_emits_4xx_and_5xx() {
        let d = dist(&[("200", 800), ("404", 100), ("500", 100)]);
        let got = derive_insights(&summary(), &[], &[], &d, None, "", 0, None, None, None);
        let five = got
            .iter()
            .find(|i| i.kind == "status_class" && i.status_class.as_deref() == Some("5xx"))
            .unwrap();
        assert_eq!(five.severity, "critical");
        assert_eq!(five.count, Some(100));
        assert!((five.pct.unwrap() - 0.1).abs() < 1e-9); // 100/1000
        let four = got
            .iter()
            .find(|i| i.kind == "status_class" && i.status_class.as_deref() == Some("4xx"))
            .unwrap();
        assert_eq!(four.severity, "warning");
    }

    #[test]
    fn status_class_excludes_status_0_from_denominator() {
        // 900 transport failures (status 0) + 100 real responses, 50 of them 5xx.
        let d = dist(&[("0", 900), ("200", 50), ("500", 50)]);
        let got = derive_insights(&summary(), &[], &[], &d, None, "", 0, None, None, None);
        let five = got
            .iter()
            .find(|i| i.status_class.as_deref() == Some("5xx"))
            .unwrap();
        // pct over HTTP responses (100), not all attempts (1000): 50/100 = 0.5.
        assert!((five.pct.unwrap() - 0.5).abs() < 1e-9);
    }

    #[test]
    fn parallel_branch_steps_are_unconditional() {
        let mut out = Vec::new();
        let sc = handicap_engine::scenario::Scenario::from_yaml(
            r#"
version: 1
name: p
steps:
  - id: "01HX0000000000000000000010"
    name: fan
    type: parallel
    branches:
      - name: a
        steps:
          - { id: "01HX0000000000000000000011", name: ga, type: http, request: { method: GET, url: "/a" }, assert: [] }
"#,
        )
        .unwrap();
        super::collect_unconditional(&sc.steps, false, &mut out);
        assert_eq!(out, vec!["01HX0000000000000000000011".to_string()]);
    }

    fn win_count(ts: i64, step_id: &str, count: u64) -> ReportWindow {
        ReportWindow {
            ts_second: ts,
            step_id: step_id.to_string(),
            count,
            error_count: 0,
            status_counts: BTreeMap::new(),
            p50_ms: 1,
            p95_ms: 1,
            p99_ms: 1,
        }
    }

    #[test]
    fn load_gen_saturated_when_dropped() {
        // dropped>0 (open-loop 포화) -> value = peak per-second throughput,
        // count = dropped. peak = 초당 step count 합의 최대(평균 아님).
        let windows = vec![
            win_count(0, "a", 3),
            win_count(0, "b", 4),  // ts0 합 = 7
            win_count(1, "a", 10), // ts1 합 = 10 (peak)
        ];
        let got = derive_insights(
            &summary(),
            &[],
            &windows,
            &BTreeMap::new(),
            None,
            "",
            5,
            None,
            None,
            None,
        );
        let s = got
            .iter()
            .find(|i| i.kind == "load_gen_saturated")
            .expect("load_gen_saturated present");
        assert_eq!(s.severity, "warning");
        assert_eq!(s.value, Some(10.0)); // peak, not 7 not average
        assert_eq!(s.count, Some(5)); // dropped
    }

    #[test]
    fn no_saturation_when_dropped_zero() {
        let windows = vec![win_count(0, "a", 100)];
        let got = derive_insights(
            &summary(),
            &[],
            &windows,
            &BTreeMap::new(),
            None,
            "",
            0,
            None,
            None,
            None,
        );
        assert!(got.iter().all(|i| i.kind != "load_gen_saturated"));
    }

    #[test]
    fn saturation_falls_back_to_summary_rps() {
        // dropped>0 인데 windows가 비면 천장은 summary.rps(반올림)로 폴백.
        // summary() 헬퍼는 rps:0.0이라 0이 아닌 값을 명시해야 동어반복(==0) 회피.
        let mut s = summary();
        s.rps = 1234.6;
        let got = derive_insights(
            &s,
            &[],
            &[],
            &BTreeMap::new(),
            None,
            "",
            3,
            None,
            None,
            None,
        );
        let sat = got
            .iter()
            .find(|i| i.kind == "load_gen_saturated")
            .expect("load_gen_saturated present");
        assert_eq!(sat.value, Some(1235.0)); // 1234.6.round()
        assert_eq!(sat.count, Some(3));
    }

    #[test]
    fn saturated_sizing_falls_back_when_max_in_flight_absent() {
        // max_in_flight None → 분류 불가(폴백). (prod 불가 케이스지만 방어.)
        let s = summary();
        let got = derive_insights(
            &s,
            &[],
            &[],
            &BTreeMap::new(),
            None,
            "",
            7,
            None,
            Some(10_000),
            Some(10_000.0),
        );
        let ins = got.iter().find(|i| i.kind == "load_gen_saturated").unwrap();
        assert_eq!(ins.cause, None);
        assert_eq!(ins.recommended, None);
    }

    #[test]
    fn saturated_small_required_rounds_up_to_one() {
        // 하한 검증(.clamp(1.0, …) 커버): target 1·M 1·dropped 1·duration 100·scheduled
        // Some(100.0) → achieved (100-1)/100=0.99 → ceil(1×1/0.99)=2 → recommended=Some(2.0),
        // 자연히 ≥1(required가 분수로 내려가도 하한 1 밑으로는 안 떨어짐을 커버).
        let mut s = summary();
        s.duration_seconds = 100;
        let got = derive_insights(
            &s,
            &[],
            &[],
            &BTreeMap::new(),
            None,
            "",
            1,
            Some(1),
            Some(1),
            Some(100.0),
        );
        let ins = got.iter().find(|i| i.kind == "load_gen_saturated").unwrap();
        assert_eq!(ins.cause.as_deref(), Some("slots"));
        assert_eq!(ins.recommended, Some(2.0));
        assert!(ins.recommended.unwrap() >= 1.0);
    }

    fn win_p95(ts: i64, p95: u64) -> ReportWindow {
        ReportWindow {
            ts_second: ts,
            step_id: "a".to_string(),
            count: 1,
            error_count: 0,
            status_counts: BTreeMap::new(),
            p50_ms: 1,
            p95_ms: p95,
            p99_ms: p95,
        }
    }

    #[test]
    fn saturated_sut_via_5xx() {
        // sut_stress(5xx≥1%) → sut 선평가 — achieved와 무관하게 cause=sut·recommended None (ADR-0046)
        let s = summary();
        let dist = dist(&[("200", 900), ("500", 100)]);
        let got = derive_insights(
            &s,
            &[],
            &[],
            &dist,
            None,
            "",
            7,
            Some(2000),
            Some(1000),
            Some(1_000.0),
        );
        let ins = got.iter().find(|i| i.kind == "load_gen_saturated").unwrap();
        assert_eq!(ins.cause.as_deref(), Some("sut"));
        assert_eq!(ins.recommended_workers, None);
    }

    #[test]
    fn saturated_sut_via_latency_rise() {
        // sut_stress(p95 상승) → sut 선평가 — achieved와 무관하게 cause=sut·recommended None (ADR-0046)
        // 5xx 없음 + p95가 early 10 → late 100 (1.5배↑, span 8≥6) → sut 트리거.
        let s = summary();
        let mut windows = vec![];
        for ts in 0..9 {
            windows.push(win_p95(ts, if ts >= 6 { 100 } else { 10 }));
        }
        let got = derive_insights(
            &s,
            &[],
            &windows,
            &BTreeMap::new(),
            None,
            "",
            7,
            Some(2000),
            Some(1000),
            Some(1_000.0),
        );
        let ins = got.iter().find(|i| i.kind == "load_gen_saturated").unwrap();
        assert_eq!(ins.cause.as_deref(), Some("sut"));
        assert_eq!(ins.recommended_workers, None);
    }

    #[test]
    fn onset_present_on_ramp() {
        // 처리량 10→90 증가(ramp). peak=90, early-third median 20 < 45 → ramp.
        // t_peak = ts8, min_ts=0 → onset 8.
        let mut windows = vec![];
        for ts in 0..9i64 {
            windows.push(win_count(ts, "a", ((ts + 1) * 10) as u64));
        }
        let got = derive_insights(
            &summary(),
            &[],
            &windows,
            &BTreeMap::new(),
            None,
            "",
            5,
            None,
            None,
            None,
        );
        let ins = got.iter().find(|i| i.kind == "load_gen_saturated").unwrap();
        assert_eq!(ins.onset_second, Some(8));
    }

    #[test]
    fn onset_omitted_on_flat() {
        // 전 구간 처리량 100(flat) → early median 100 ≥ 50 → onset None.
        let mut windows = vec![];
        for ts in 0..9i64 {
            windows.push(win_count(ts, "a", 100));
        }
        let got = derive_insights(
            &summary(),
            &[],
            &windows,
            &BTreeMap::new(),
            None,
            "",
            5,
            None,
            None,
            None,
        );
        let ins = got.iter().find(|i| i.kind == "load_gen_saturated").unwrap();
        assert_eq!(ins.onset_second, None);
    }

    #[test]
    fn onset_omitted_on_warmup_dip() {
        // L=9, 첫 초만 10·나머지 100. early-third(ts0,1,2)=[10,100,100] median 100 ≥ 50
        // → not ramp → None. (L<9면 early-third가 dip만 잡혀 오판 — fixture L≥9 필수.)
        let mut windows = vec![win_count(0, "a", 10)];
        for ts in 1..9i64 {
            windows.push(win_count(ts, "a", 100));
        }
        let got = derive_insights(
            &summary(),
            &[],
            &windows,
            &BTreeMap::new(),
            None,
            "",
            5,
            None,
            None,
            None,
        );
        let ins = got.iter().find(|i| i.kind == "load_gen_saturated").unwrap();
        assert_eq!(ins.onset_second, None);
    }

    #[test]
    fn insight_new_fields_serialize_when_some_and_omit_when_none() {
        let mut ins = Insight::new("load_gen_saturated", "warning");
        let none_json = serde_json::to_value(&ins).unwrap();
        assert!(
            none_json.get("achieved_per_sec").is_none(),
            "None → 키 생략"
        );
        assert!(none_json.get("target_per_sec").is_none());
        ins.achieved_per_sec = Some(2.5);
        ins.target_per_sec = Some(20.0);
        let some_json = serde_json::to_value(&ins).unwrap();
        assert_eq!(some_json["achieved_per_sec"], 2.5);
        assert_eq!(some_json["target_per_sec"], 20.0);
    }

    #[test]
    fn scheduled_arrivals_fixed_curve_and_truncated() {
        use handicap_engine::Stage;
        // 고정: target × duration
        assert_eq!(scheduled_arrivals(Some(20), None, 15.0), Some(300.0));
        // 곡선(spec §4.1 fixture): 0→10 램프 10s(사다리꼴 50) + 10 유지 10s(100) = 150
        let stages = vec![
            Stage {
                target: 10,
                duration_seconds: 10,
            },
            Stage {
                target: 10,
                duration_seconds: 10,
            },
        ];
        assert_eq!(scheduled_arrivals(None, Some(&stages), 20.0), Some(150.0));
        // 절단: 15s에서 끊으면 50 + 10×5 = 100
        assert_eq!(scheduled_arrivals(None, Some(&stages), 15.0), Some(100.0));
        // open-loop 아님 → None
        assert_eq!(scheduled_arrivals(None, None, 15.0), None);
    }

    #[test]
    fn saturated_slots_uses_measured_hold() {
        // spec R1 fixture (라이브 Run C 재현): target 20·M 3·dropped 260·15s
        // scheduled 300 → achieved (300-260)/15 = 2.667/s → ceil(20×3/2.667) = 23
        let mut s = summary();
        s.duration_seconds = 15;
        let got = derive_insights(
            &s,
            &[],
            &[],
            &BTreeMap::new(),
            None,
            "",
            260,
            Some(3),
            Some(20),
            Some(300.0),
        );
        let ins = got.iter().find(|i| i.kind == "load_gen_saturated").unwrap();
        assert_eq!(ins.cause.as_deref(), Some("slots"));
        assert_eq!(ins.recommended, Some(23.0));
        assert_eq!(ins.target_per_sec, Some(20.0));
        let a = ins.achieved_per_sec.unwrap();
        assert!((a - 40.0 / 15.0).abs() < 1e-9, "achieved={a}");
        assert_eq!(ins.recommended_workers, None);
    }

    #[test]
    fn sut_takes_priority_over_slots() {
        // sut_stress(5xx≥1%)면 achieved와 무관하게 cause=sut·recommended None (R3·R13 우선순위)
        let mut s = summary();
        s.duration_seconds = 15;
        let d = dist(&[("200", 80), ("500", 20)]); // 5xx 20% ≥ 1%
        let got = derive_insights(
            &s,
            &[],
            &[],
            &d,
            None,
            "",
            260,
            Some(3),
            Some(20),
            Some(300.0),
        );
        let ins = got.iter().find(|i| i.kind == "load_gen_saturated").unwrap();
        assert_eq!(ins.cause.as_deref(), Some("sut"));
        assert_eq!(ins.recommended, None);
        assert_eq!(ins.target_per_sec, Some(20.0)); // 필드는 sut arm에도 실림
        assert!(ins.achieved_per_sec.is_some());
        assert_eq!(ins.recommended_workers, None);
    }

    #[test]
    fn saturated_clamps_recommended_when_achieved_zero() {
        // dropped ≥ scheduled → achieved 0 → recommended = 10_000 클램프 (R13)
        let mut s = summary();
        s.duration_seconds = 15;
        let got = derive_insights(
            &s,
            &[],
            &[],
            &BTreeMap::new(),
            None,
            "",
            300,
            Some(3),
            Some(20),
            Some(300.0),
        );
        let ins = got.iter().find(|i| i.kind == "load_gen_saturated").unwrap();
        assert_eq!(ins.cause.as_deref(), Some("slots"));
        assert_eq!(ins.recommended, Some(10_000.0));
    }

    #[test]
    fn saturated_falls_back_when_inputs_missing() {
        // target/M/scheduled 중 하나라도 None → emit + cause None + 신규 필드 None (fallback arm 계승)
        let got = derive_insights(
            &summary(),
            &[],
            &[],
            &BTreeMap::new(),
            None,
            "",
            5,
            None,
            None,
            None,
        );
        let ins = got.iter().find(|i| i.kind == "load_gen_saturated").unwrap();
        assert_eq!(ins.cause, None);
        assert_eq!(ins.recommended, None);
        assert_eq!(ins.achieved_per_sec, None);
        assert_eq!(ins.target_per_sec, None);
        assert_eq!(ins.recommended_workers, None);
    }

    #[test]
    fn no_cause_is_ever_loadgen() {
        // R3: loadgen 생성 경로 부재 — 대표 slots/sut/fallback 3경로에서 단언 (위 테스트들과 중복이지만 명시 가드)
        let mut s = summary();
        s.duration_seconds = 15;
        for (dropped, m, t, sch) in [
            (260u64, Some(3), Some(20), Some(300.0)),
            (5, None, None, None),
        ] {
            let got = derive_insights(&s, &[], &[], &BTreeMap::new(), None, "", dropped, m, t, sch);
            assert!(got.iter().all(|i| i.cause.as_deref() != Some("loadgen")));
        }
    }
}
