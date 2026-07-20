//! Soft validity + narrative derived from a built report (A11 trustworthy open test).
//! Pure: orthogonal to run status and SLO verdict. Spec §4–§5.
use crate::insights::{Insight, collect_unconditional, http_step_has_status_assert};
use crate::report::{ReportSummary, http_response_total, status_class_count};
use handicap_engine::Scenario;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Validity {
    /// "ok" | "limited" | "suspect"
    pub level: String,
    pub reasons: Vec<ValidityReason>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ValidityReason {
    pub kind: String,
    /// "critical" | "warning" | "info" only
    pub severity: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pct: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub count: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub step_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metric: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub value: Option<f64>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct Narrative {
    pub events: Vec<String>,
    pub can_claim: Vec<String>,
    pub cannot_claim: Vec<String>,
}

impl Default for Validity {
    fn default() -> Self {
        Validity {
            level: "ok".to_string(),
            reasons: Vec::new(),
        }
    }
}

fn reason_base(kind: &str, severity: &str) -> ValidityReason {
    ValidityReason {
        kind: kind.to_string(),
        severity: severity.to_string(),
        pct: None,
        count: None,
        step_id: None,
        metric: None,
        value: None,
    }
}

fn has_reason(v: &Validity, kind: &str) -> bool {
    v.reasons.iter().any(|r| r.kind == kind)
}

/// Derive soft validity reasons + level (spec §4). Reasons evaluated in fixed order;
/// only emitted when conditions match. Transport failures raise engine errors —
/// never gate `transport_heavy` on `errors==0` (H0).
pub fn derive_validity(
    summary: &ReportSummary,
    status_distribution: &BTreeMap<String, u64>,
    scenario_yaml: &str,
    has_active_criteria: bool,
    insights: &[Insight],
) -> Validity {
    let mut reasons: Vec<ValidityReason> = Vec::new();

    // 1. zero_requests
    if summary.count == 0 {
        reasons.push(reason_base("zero_requests", "critical"));
    }

    // 2. transport_heavy (§4.2)
    let n0 = status_distribution.get("0").copied().unwrap_or(0);
    let n_http = http_response_total(status_distribution);
    let n_all = n0 + n_http;
    if n0 > 0 && n_all > 0 {
        let pct = n0 as f64 / n_all as f64;
        if pct >= 0.05 || n0 >= 50 {
            let severity = if pct >= 0.50 { "critical" } else { "warning" };
            let mut r = reason_base("transport_heavy", severity);
            r.pct = Some(pct);
            r.count = Some(n0);
            reasons.push(r);
        }
    }

    // 3. silent_http_errors — numerator is 4xx+5xx sum (H1); never requires transport 0
    let c4 = status_class_count(status_distribution, '4');
    let c5 = status_class_count(status_distribution, '5');
    let silent_n = c4 + c5;
    if silent_n > 0 && summary.errors == 0 {
        let mut r = reason_base("silent_http_errors", "warning");
        r.count = Some(silent_n);
        if n_http > 0 {
            r.pct = Some(silent_n as f64 / n_http as f64);
        }
        reasons.push(r);
    }

    // 4. no_response_validation (§4.3) — fail-soft on YAML parse
    if let Ok(sc) = Scenario::from_yaml(scenario_yaml) {
        let mut ids: Vec<String> = Vec::new();
        collect_unconditional(&sc.steps, false, &mut ids);
        if !ids.is_empty() {
            let any_status = ids
                .iter()
                .any(|id| http_step_has_status_assert(&sc.steps, id));
            if !any_status && !has_active_criteria {
                reasons.push(reason_base("no_response_validation", "warning"));
            }
        }
    }

    // 5. load_not_delivered — from load_gen_saturated insight
    if let Some(ins) = insights.iter().find(|i| i.kind == "load_gen_saturated") {
        let mut r = reason_base("load_not_delivered", "warning");
        r.count = ins.count;
        reasons.push(r);
    }

    let level = if reasons.iter().any(|r| r.severity == "critical") {
        "suspect"
    } else if !reasons.is_empty() {
        "limited"
    } else {
        "ok"
    };

    Validity {
        level: level.to_string(),
        reasons,
    }
}

fn push_unique(out: &mut Vec<String>, code: &str) {
    if !out.iter().any(|c| c == code) {
        out.push(code.to_string());
    }
}

fn insight_event_code(i: &Insight) -> Option<String> {
    match i.kind.as_str() {
        "slo_failure" => Some("insight:slo_failure".to_string()),
        "slo_pass" => Some("insight:slo_pass".to_string()),
        "status_class" => match i.status_class.as_deref() {
            Some("5xx") => Some("insight:status_class:5xx".to_string()),
            Some("4xx") => Some("insight:status_class:4xx".to_string()),
            _ => None,
        },
        "load_gen_saturated" => Some("insight:load_gen_saturated".to_string()),
        "error_hotspot" => Some("insight:error_hotspot".to_string()),
        "status_temporal" => Some("insight:status_temporal".to_string()),
        "no_request_step" => Some("insight:no_request_step".to_string()),
        "slowest_step" => Some("insight:slowest_step".to_string()),
        _ => None,
    }
}

/// Derive narrative events / can_claim / cannot_claim (spec §5).
/// Insights slice is already `order_rank`-sorted by `derive_insights` — do not re-sort (H7).
pub fn derive_narrative(
    validity: &Validity,
    summary: &ReportSummary,
    has_active_criteria: bool,
    insights: &[Insight],
) -> Narrative {
    // §5.1 events
    let mut events: Vec<String> = Vec::new();
    for r in &validity.reasons {
        push_unique(&mut events, &format!("validity:{}", r.kind));
    }
    for i in insights {
        if let Some(code) = insight_event_code(i) {
            push_unique(&mut events, &code);
        }
    }
    events.truncate(5);

    // §5.2 can_claim / cannot_claim
    let mut can_claim: Vec<String> = Vec::new();
    let mut cannot_claim: Vec<String> = Vec::new();

    // 1 zero_requests
    if has_reason(validity, "zero_requests") {
        push_unique(&mut cannot_claim, "any_performance_claim");
    }
    // 2 transport_heavy
    if has_reason(validity, "transport_heavy") {
        push_unique(&mut can_claim, "client_reachability_issue");
        push_unique(&mut cannot_claim, "sut_capacity");
        push_unique(&mut cannot_claim, "slo_as_capacity");
    }
    // 3 silent_http_errors
    if has_reason(validity, "silent_http_errors") {
        push_unique(&mut can_claim, "http_error_statuses_seen");
        push_unique(&mut cannot_claim, "zero_engine_errors_means_ok");
    }
    // 4 no_response_validation
    if has_reason(validity, "no_response_validation") {
        if summary.count > 0 {
            push_unique(&mut can_claim, "throughput_measured");
        }
        push_unique(&mut cannot_claim, "functional_correctness");
        push_unique(&mut cannot_claim, "error_free_service");
    }
    // 5 load_not_delivered
    if has_reason(validity, "load_not_delivered") {
        push_unique(&mut can_claim, "delivery_ceiling_observed");
        push_unique(&mut cannot_claim, "target_load_applied");
    }
    // 6–8 only when level == ok
    if validity.level == "ok" {
        if insights.iter().any(|i| i.kind == "slo_pass") {
            push_unique(&mut can_claim, "slo_held");
        }
        if insights
            .iter()
            .any(|i| i.kind == "status_class" && i.status_class.as_deref() == Some("5xx"))
        {
            push_unique(&mut can_claim, "sut_errors_observed");
        }
        if insights.iter().any(|i| i.kind == "slowest_step") {
            push_unique(&mut can_claim, "bottleneck_step");
        }
    }
    // 9 !has_active_criteria
    if !has_active_criteria {
        push_unique(&mut cannot_claim, "slo_gate");
    }

    can_claim.truncate(5);
    cannot_claim.truncate(5);

    // 10 always production_identity — cap-replace if truncated away
    if !cannot_claim.iter().any(|c| c == "production_identity") {
        if cannot_claim.len() < 5 {
            cannot_claim.push("production_identity".to_string());
        } else {
            cannot_claim[4] = "production_identity".to_string();
        }
    }

    Narrative {
        events,
        can_claim,
        cannot_claim,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::insights::Insight;
    use crate::report::ReportSummary;
    use std::collections::BTreeMap;

    fn summary(count: u64, errors: u64) -> ReportSummary {
        ReportSummary {
            count,
            errors,
            rps: 0.0,
            duration_seconds: 1,
            mean_ms: 0,
            p50_ms: 0,
            p95_ms: 0,
            p99_ms: 0,
        }
    }

    fn dist(pairs: &[(&str, u64)]) -> BTreeMap<String, u64> {
        pairs.iter().map(|(k, v)| (k.to_string(), *v)).collect()
    }

    fn insight(kind: &str) -> Insight {
        Insight {
            kind: kind.to_string(),
            severity: "info".to_string(),
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

    fn insight_sc(kind: &str, status_class: &str) -> Insight {
        let mut i = insight(kind);
        i.status_class = Some(status_class.to_string());
        i
    }

    fn insight_count(kind: &str, count: u64) -> Insight {
        let mut i = insight(kind);
        i.count = Some(count);
        i
    }

    fn insight_step(kind: &str, step_id: &str) -> Insight {
        let mut i = insight(kind);
        i.step_id = Some(step_id.to_string());
        i
    }

    /// Minimal top-level http, no assert.
    const YAML_NO_ASSERT: &str = r#"
version: 1
name: t
steps:
  - type: http
    id: step_a
    name: a
    request: { method: GET, url: "http://x/" }
"#;

    /// Top-level http with Status assert.
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

    /// Nested loop body http without assert (H6 walk must still detect).
    const YAML_NESTED_LOOP: &str = r#"
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
"#;

    /// Only if-branch http (conditional) — unconditional http count == 0.
    const YAML_ONLY_IF: &str = r#"
version: 1
name: t
steps:
  - type: if
    id: branch
    name: branch
    cond: { op: eq, left: "1", right: "1" }
    then:
      - type: http
        id: in_then
        name: in_then
        request: { method: GET, url: "http://x/" }
"#;

    fn kinds(v: &Validity) -> Vec<&str> {
        v.reasons.iter().map(|r| r.kind.as_str()).collect()
    }

    #[test]
    fn zero_requests_is_suspect() {
        let v = derive_validity(&summary(0, 0), &BTreeMap::new(), "", false, &[]);
        assert_eq!(v.level, "suspect");
        assert!(kinds(&v).contains(&"zero_requests"));
        let zr = v
            .reasons
            .iter()
            .find(|r| r.kind == "zero_requests")
            .unwrap();
        assert_eq!(zr.severity, "critical");
    }

    #[test]
    fn transport_pct_0_8_is_critical_suspect() {
        // n0=80, n_http=20 → pct=0.8 ≥ 0.50 → critical → suspect
        // errors>0 (transport raises errors — H0 must still emit)
        let d = dist(&[("0", 80), ("200", 20)]);
        let v = derive_validity(&summary(100, 80), &d, YAML_WITH_ASSERT, true, &[]);
        let t = v
            .reasons
            .iter()
            .find(|r| r.kind == "transport_heavy")
            .expect("transport_heavy");
        assert_eq!(t.severity, "critical");
        assert!((t.pct.unwrap() - 0.8).abs() < 1e-9);
        assert_eq!(t.count, Some(80));
        assert_eq!(v.level, "suspect");
    }

    #[test]
    fn transport_emits_at_pct_boundary_0_05() {
        // n0=5, n_http=95 → pct exactly 0.05 → emit warning
        let d = dist(&[("0", 5), ("200", 95)]);
        let v = derive_validity(&summary(100, 5), &d, YAML_WITH_ASSERT, true, &[]);
        let t = v
            .reasons
            .iter()
            .find(|r| r.kind == "transport_heavy")
            .expect("emit at 0.05");
        assert_eq!(t.severity, "warning");
        assert!((t.pct.unwrap() - 0.05).abs() < 1e-9);
    }

    #[test]
    fn transport_emits_at_n0_50_even_low_pct() {
        // n0=50, n_http=950 → pct≈0.05 but exactly n0>=50; use larger denom so pct < 0.05
        // n0=50, n_http=1000 → pct=50/1050≈0.0476 < 0.05, but n0>=50 → emit
        let d = dist(&[("0", 50), ("200", 1000)]);
        let v = derive_validity(&summary(1050, 50), &d, YAML_WITH_ASSERT, true, &[]);
        let t = v
            .reasons
            .iter()
            .find(|r| r.kind == "transport_heavy")
            .expect("emit at n0=50");
        assert_eq!(t.count, Some(50));
        assert!(t.pct.unwrap() < 0.05);
        assert_eq!(t.severity, "warning");
    }

    #[test]
    fn transport_does_not_emit_below_thresholds() {
        // n0=4, n_http=96 → pct=0.04 < 0.05 and n0 < 50 → no emit
        let d = dist(&[("0", 4), ("200", 96)]);
        let v = derive_validity(&summary(100, 4), &d, YAML_WITH_ASSERT, true, &[]);
        assert!(!kinds(&v).contains(&"transport_heavy"));
    }

    #[test]
    fn silent_4xx_only_errors_zero() {
        let d = dist(&[("200", 90), ("404", 10)]);
        let v = derive_validity(&summary(100, 0), &d, YAML_WITH_ASSERT, true, &[]);
        let s = v
            .reasons
            .iter()
            .find(|r| r.kind == "silent_http_errors")
            .expect("silent 4xx");
        assert_eq!(s.count, Some(10));
        assert!((s.pct.unwrap() - 0.1).abs() < 1e-9);
        assert_eq!(s.severity, "warning");
        assert_eq!(v.level, "limited");
    }

    #[test]
    fn silent_5xx_only_errors_zero() {
        // R5 / H1: 5xx-only must also emit
        let d = dist(&[("200", 90), ("500", 10)]);
        let v = derive_validity(&summary(100, 0), &d, YAML_WITH_ASSERT, true, &[]);
        let s = v
            .reasons
            .iter()
            .find(|r| r.kind == "silent_http_errors")
            .expect("silent 5xx");
        assert_eq!(s.count, Some(10));
        assert_eq!(v.level, "limited");
    }

    #[test]
    fn silent_not_emitted_when_errors_nonzero() {
        let d = dist(&[("500", 10), ("200", 90)]);
        let v = derive_validity(&summary(100, 10), &d, YAML_WITH_ASSERT, true, &[]);
        assert!(!kinds(&v).contains(&"silent_http_errors"));
    }

    #[test]
    fn no_response_validation_when_no_assert_no_criteria() {
        let d = dist(&[("200", 100)]);
        let v = derive_validity(&summary(100, 0), &d, YAML_NO_ASSERT, false, &[]);
        assert!(kinds(&v).contains(&"no_response_validation"));
        assert_eq!(v.level, "limited");
    }

    #[test]
    fn has_status_assert_suppresses_no_response() {
        let d = dist(&[("200", 100)]);
        let v = derive_validity(&summary(100, 0), &d, YAML_WITH_ASSERT, false, &[]);
        assert!(!kinds(&v).contains(&"no_response_validation"));
        // no criteria → still slo_gate in narrative, but validity level ok if no other reasons
        assert_eq!(v.level, "ok");
    }

    #[test]
    fn has_active_criteria_suppresses_no_response() {
        let d = dist(&[("200", 100)]);
        let v = derive_validity(&summary(100, 0), &d, YAML_NO_ASSERT, true, &[]);
        assert!(!kinds(&v).contains(&"no_response_validation"));
        assert_eq!(v.level, "ok");
    }

    #[test]
    fn unconditional_http_zero_skips_no_response() {
        // only if-branch http → unconditional empty → vacuous skip
        let d = dist(&[("200", 100)]);
        let v = derive_validity(&summary(100, 0), &d, YAML_ONLY_IF, false, &[]);
        assert!(!kinds(&v).contains(&"no_response_validation"));
    }

    #[test]
    fn nested_loop_body_without_assert_detected() {
        let d = dist(&[("200", 100)]);
        let v = derive_validity(&summary(100, 0), &d, YAML_NESTED_LOOP, false, &[]);
        assert!(
            kinds(&v).contains(&"no_response_validation"),
            "H6: loop body http must be walked for status assert"
        );
    }

    #[test]
    fn load_gen_saturated_insight_emits_load_not_delivered() {
        let d = dist(&[("200", 100)]);
        let ins = [insight_count("load_gen_saturated", 42)];
        let v = derive_validity(&summary(100, 0), &d, YAML_WITH_ASSERT, true, &ins);
        let r = v
            .reasons
            .iter()
            .find(|r| r.kind == "load_not_delivered")
            .expect("load_not_delivered");
        assert_eq!(r.count, Some(42));
        assert_eq!(r.severity, "warning");
        assert_eq!(v.level, "limited");
    }

    #[test]
    fn reasons_fixed_order() {
        // Force several reasons: zero + (no transport with count=0 empty dist) +
        // load via insight. Also no_response if we use count=0 with yaml? count=0
        // already suspect. Build: transport + silent + no_response + load
        let d = dist(&[("0", 60), ("404", 20), ("200", 20)]);
        // errors=0 for silent; n0=60 → transport critical
        let ins = [insight_count("load_gen_saturated", 1)];
        let v = derive_validity(&summary(100, 0), &d, YAML_NO_ASSERT, false, &ins);
        assert_eq!(
            kinds(&v),
            vec![
                "transport_heavy",
                "silent_http_errors",
                "no_response_validation",
                "load_not_delivered",
            ]
        );
    }

    // ── narrative events (R7 §5.1) ──────────────────────────────────────

    #[test]
    fn events_validity_first_then_insights_max_5() {
        let d = dist(&[("0", 80), ("200", 20)]);
        // pre-sorted insight slice (order_rank order): status_class 5xx, load, no_request, slowest, slo_pass
        let ins = vec![
            insight_sc("status_class", "5xx"),
            insight("load_gen_saturated"),
            insight_step("no_request_step", "a"),
            insight("slowest_step"),
            insight("slo_pass"),
        ];
        // v has transport_heavy + load_not_delivered (from insight)
        let v = derive_validity(&summary(100, 80), &d, YAML_WITH_ASSERT, true, &ins);
        let n = derive_narrative(&v, &summary(100, 80), true, &ins);
        assert!(n.events.len() <= 5);
        // validity codes first
        assert_eq!(n.events[0], "validity:transport_heavy");
        assert_eq!(n.events[1], "validity:load_not_delivered");
        // then insights in given order
        assert_eq!(n.events[2], "insight:status_class:5xx");
        assert_eq!(n.events[3], "insight:load_gen_saturated");
        assert_eq!(n.events[4], "insight:no_request_step");
        // truncated — slo_pass / slowest dropped
        assert!(!n.events.iter().any(|e| e == "insight:slo_pass"));
    }

    #[test]
    fn events_dedup_multiple_no_request_step() {
        let v = Validity::default();
        let ins = vec![
            insight_step("no_request_step", "a"),
            insight_step("no_request_step", "b"),
            insight("slowest_step"),
        ];
        let n = derive_narrative(&v, &summary(10, 0), true, &ins);
        let nrs: Vec<_> = n
            .events
            .iter()
            .filter(|e| e.as_str() == "insight:no_request_step")
            .collect();
        assert_eq!(nrs.len(), 1);
        assert!(n.events.contains(&"insight:slowest_step".to_string()));
    }

    #[test]
    fn events_status_class_codes() {
        let v = Validity::default();
        let ins = vec![
            insight_sc("status_class", "5xx"),
            insight_sc("status_class", "4xx"),
        ];
        let n = derive_narrative(&v, &summary(10, 0), true, &ins);
        assert!(n.events.contains(&"insight:status_class:5xx".to_string()));
        assert!(n.events.contains(&"insight:status_class:4xx".to_string()));
    }

    // ── can/cannot goldens (§5.2) ───────────────────────────────────────

    #[test]
    fn golden_count_zero() {
        let v = derive_validity(&summary(0, 0), &BTreeMap::new(), "", false, &[]);
        let n = derive_narrative(&v, &summary(0, 0), false, &[]);
        assert_eq!(v.level, "suspect");
        assert!(n.can_claim.is_empty());
        assert_eq!(
            n.cannot_claim,
            vec![
                "any_performance_claim".to_string(),
                "slo_gate".to_string(),
                "production_identity".to_string(),
            ]
        );
    }

    #[test]
    fn golden_transport_heavy() {
        let d = dist(&[("0", 80), ("200", 20)]);
        let v = derive_validity(&summary(100, 80), &d, YAML_WITH_ASSERT, true, &[]);
        let n = derive_narrative(&v, &summary(100, 80), true, &[]);
        assert_eq!(v.level, "suspect");
        assert_eq!(n.can_claim, vec!["client_reachability_issue".to_string()]);
        assert_eq!(
            n.cannot_claim,
            vec![
                "sut_capacity".to_string(),
                "slo_as_capacity".to_string(),
                "production_identity".to_string(),
            ]
        );
    }

    #[test]
    fn golden_unchecked_200() {
        let d = dist(&[("200", 100)]);
        let v = derive_validity(&summary(100, 0), &d, YAML_NO_ASSERT, false, &[]);
        let n = derive_narrative(&v, &summary(100, 0), false, &[]);
        assert_eq!(v.level, "limited");
        assert_eq!(n.can_claim, vec!["throughput_measured".to_string()]);
        assert_eq!(
            n.cannot_claim,
            vec![
                "functional_correctness".to_string(),
                "error_free_service".to_string(),
                "slo_gate".to_string(),
                "production_identity".to_string(),
            ]
        );
    }

    #[test]
    fn golden_silent_plus_no_response() {
        // 5xx>0, errors=0, no assert → silent + no_response
        let d = dist(&[("500", 10), ("200", 90)]);
        let v = derive_validity(&summary(100, 0), &d, YAML_NO_ASSERT, false, &[]);
        let n = derive_narrative(&v, &summary(100, 0), false, &[]);
        assert_eq!(v.level, "limited");
        assert!(
            n.can_claim
                .contains(&"http_error_statuses_seen".to_string())
        );
        assert!(n.can_claim.contains(&"throughput_measured".to_string()));
        assert!(
            n.cannot_claim
                .contains(&"zero_engine_errors_means_ok".to_string())
        );
        assert!(
            n.cannot_claim
                .contains(&"functional_correctness".to_string())
        );
        assert!(n.cannot_claim.contains(&"production_identity".to_string()));
    }

    #[test]
    fn golden_clean_slo_pass() {
        let d = dist(&[("200", 100)]);
        let ins = vec![insight("slo_pass"), insight("slowest_step")];
        let v = derive_validity(&summary(100, 0), &d, YAML_WITH_ASSERT, true, &ins);
        let n = derive_narrative(&v, &summary(100, 0), true, &ins);
        assert_eq!(v.level, "ok");
        assert!(n.can_claim.contains(&"slo_held".to_string()));
        assert!(n.can_claim.contains(&"bottleneck_step".to_string()));
        assert_eq!(n.cannot_claim, vec!["production_identity".to_string()]);
    }

    #[test]
    fn throughput_measured_only_when_count_positive() {
        // no_response + count==0 → no throughput_measured
        let v = derive_validity(&summary(0, 0), &BTreeMap::new(), YAML_NO_ASSERT, false, &[]);
        assert!(
            kinds(&v).contains(&"no_response_validation") || kinds(&v).contains(&"zero_requests")
        );
        // Ensure no_response is present for count=0 + no assert yaml
        assert!(kinds(&v).contains(&"no_response_validation"));
        let n = derive_narrative(&v, &summary(0, 0), false, &[]);
        assert!(!n.can_claim.contains(&"throughput_measured".to_string()));
    }

    #[test]
    fn production_identity_cap_replace() {
        // Force ≥5 cannot codes before always-step, then production_identity replaces index 4.
        // transport → sut_capacity, slo_as_capacity
        // silent → zero_engine_errors_means_ok
        // no_response → functional_correctness, error_free_service  (=5)
        // load → target_load_applied (would be 6th, truncated)
        // !criteria → slo_gate (would be more)
        let d = dist(&[("0", 60), ("404", 20), ("200", 20)]);
        let ins = [insight_count("load_gen_saturated", 3)];
        let v = derive_validity(&summary(100, 0), &d, YAML_NO_ASSERT, false, &ins);
        let n = derive_narrative(&v, &summary(100, 0), false, &ins);
        assert_eq!(n.cannot_claim.len(), 5);
        assert_eq!(n.cannot_claim[4], "production_identity");
        // first four preserved from fixed order
        assert_eq!(n.cannot_claim[0], "sut_capacity");
        assert_eq!(n.cannot_claim[1], "slo_as_capacity");
        assert_eq!(n.cannot_claim[2], "zero_engine_errors_means_ok");
        assert_eq!(n.cannot_claim[3], "functional_correctness");
    }

    #[test]
    fn default_validity_is_ok_empty() {
        let v = Validity::default();
        assert_eq!(v.level, "ok");
        assert!(v.reasons.is_empty());
        let n = Narrative::default();
        assert!(n.events.is_empty() && n.can_claim.is_empty() && n.cannot_claim.is_empty());
    }
}
