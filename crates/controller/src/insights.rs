//! Deterministic, rule-based actionable insights derived from a built report.
//! Pure: backend computes structured insights; the UI renders the prose.
//! Spec: docs/superpowers/specs/2026-06-03-a4c-actionable-report-summary-design.md
use crate::report::{ReportStep, ReportSummary, ReportWindow, Verdict};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
// NOTE: `use handicap_engine::{Scenario, Step};` 와 `use std::collections::BTreeSet;`
// 는 Task 6(no_request_step)에서야 처음 쓰인다 — 여기 넣으면 Task 1~5 커밋이
// pre-commit `clippy --workspace -- -D warnings`(unused-imports)로 거부된다.
// 그 두 import는 Task 6 Step 3에서 함께 추가한다.

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
        ("no_request_step", _) => 3,
        ("error_hotspot", _) => 4,
        ("status_class", Some("4xx")) => 5,
        ("status_temporal", _) => 6,
        ("slowest_step", _) => 7,
        ("slo_pass", _) => 8,
        _ => 99,
    }
}

pub fn derive_insights(
    summary: &ReportSummary,
    steps: &[ReportStep],
    windows: &[ReportWindow],
    status_distribution: &BTreeMap<String, u64>,
    verdict: Option<&Verdict>,
    scenario_yaml: &str,
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
    let total_http: u64 = status_distribution
        .iter()
        .filter(|(k, _)| matches!(k.chars().next(), Some('1'..='5')))
        .map(|(_, v)| *v)
        .sum();
    if total_http > 0 {
        for (class, first, sev) in [("4xx", '4', "warning"), ("5xx", '5', "critical")] {
            let class_count: u64 = status_distribution
                .iter()
                .filter(|(k, _)| k.starts_with(first))
                .map(|(_, v)| *v)
                .sum();
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

    let _ = scenario_yaml;

    out.sort_by_key(order_rank);
    out
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
        }
    }
    fn summary() -> ReportSummary {
        ReportSummary {
            count: 0,
            errors: 0,
            rps: 0.0,
            duration_seconds: 1,
            p50_ms: 0,
            p95_ms: 0,
            p99_ms: 0,
        }
    }

    #[test]
    fn empty_when_no_signal() {
        let got = derive_insights(&summary(), &[], &[], &BTreeMap::new(), None, "");
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
            });
        }
        Verdict { passed, criteria }
    }

    #[test]
    fn slo_failure_counts_failed_criteria() {
        let v = verdict(false, 2);
        let got = derive_insights(&summary(), &[], &[], &BTreeMap::new(), Some(&v), "");
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
        let got = derive_insights(&summary(), &[], &[], &BTreeMap::new(), Some(&v), "");
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
        let got = derive_insights(&s, &steps, &[], &BTreeMap::new(), None, "");
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
        );
        assert!(got.iter().all(|i| i.kind != "error_hotspot"));
    }

    #[test]
    fn slowest_step_picks_max_p95() {
        let steps = vec![step("a", 50), step("b", 120), step("c", 90)];
        let got = derive_insights(&summary(), &steps, &[], &BTreeMap::new(), None, "");
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
        let got = derive_insights(&summary(), &[], &windows, &BTreeMap::new(), None, "");
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
        let got = derive_insights(&summary(), &[], &windows, &BTreeMap::new(), None, "");
        assert!(got.iter().all(|i| i.kind != "status_temporal"));
    }

    #[test]
    fn no_status_temporal_single_second() {
        let windows = vec![win(7, &[("500", 5)])]; // max_ts == min_ts
        let got = derive_insights(&summary(), &[], &windows, &BTreeMap::new(), None, "");
        assert!(got.iter().all(|i| i.kind != "status_temporal"));
    }

    fn dist(pairs: &[(&str, u64)]) -> BTreeMap<String, u64> {
        pairs.iter().map(|(k, v)| (k.to_string(), *v)).collect()
    }

    #[test]
    fn status_class_emits_4xx_and_5xx() {
        let d = dist(&[("200", 800), ("404", 100), ("500", 100)]);
        let got = derive_insights(&summary(), &[], &[], &d, None, "");
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
        let got = derive_insights(&summary(), &[], &[], &d, None, "");
        let five = got
            .iter()
            .find(|i| i.status_class.as_deref() == Some("5xx"))
            .unwrap();
        // pct over HTTP responses (100), not all attempts (1000): 50/100 = 0.5.
        assert!((five.pct.unwrap() - 0.5).abs() < 1e-9);
    }
}
