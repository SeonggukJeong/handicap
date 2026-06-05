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

    out.sort_by_key(order_rank);
    out
}

/// Collect ids of http steps that ALWAYS run: top-level + loop bodies (repeat>=1).
/// if/elif/else branch steps are excluded — 0 requests there is expected (branch
/// not taken), not a defect.
fn collect_unconditional(steps: &[Step], conditional: bool, out: &mut Vec<String>) {
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
            // P-a Task 4: insights arm — implemented in the next task.
            Step::Parallel(_p) => {}
        }
    }
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
        let got = derive_insights(&s, &steps, &windows, &d, Some(&v), "");
        let order: Vec<(&str, Option<&str>)> = got
            .iter()
            .map(|i| (i.kind.as_str(), i.status_class.as_deref()))
            .collect();
        assert_eq!(
            order,
            vec![
                ("slo_failure", None),
                ("status_class", Some("5xx")),
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
        let got = derive_insights(&s, &steps, &[], &d, None, "");
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
        let got = derive_insights(&summary(), &steps, &[], &BTreeMap::new(), Some(&v), "");
        let kinds: Vec<&str> = got.iter().map(|i| i.kind.as_str()).collect();
        assert_eq!(kinds, vec!["slowest_step", "slo_pass"]); // order_rank 7 then 8
    }

    #[test]
    fn slowest_step_first_on_tie() {
        // invariant lock: equal p95 → first step (steps are sorted by step_id).
        let steps = vec![step("a", 100), step("b", 100)];
        let got = derive_insights(&summary(), &steps, &[], &BTreeMap::new(), None, "");
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
        let got = derive_insights(&summary(), &[], &[], &BTreeMap::new(), None, YAML_LOOPS);
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
