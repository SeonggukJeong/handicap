//! Soft validity + narrative derived from a built report (A11 trustworthy open test).
//! Pure: orthogonal to run status and SLO verdict. Spec §4–§5.
use crate::insights::{
    Insight, collect_status_unchecked, collect_unconditional, http_step_has_status_assert,
    http_step_status_unchecked,
};
use crate::report::{
    ReportStep, ReportSummary, SetupReport, http_response_total, status_class_count,
};
use crate::store::runs::STATUS_RULE_LEGACY;
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
///
/// `status_rule`: 규칙 1(`STATUS_RULE_LEGACY`)은 옛 갈래 그대로, 그 밖은 규칙 2 갈래다.
/// `steps`는 범위가 적용된 스텝 통계, `setup`은 준비 구간 보고(`status_unchecked_errors`와
/// `setup_failed`의 원천).
#[allow(clippy::too_many_arguments)]
pub fn derive_validity(
    summary: &ReportSummary,
    status_distribution: &BTreeMap<String, u64>,
    scenario_yaml: &str,
    has_active_criteria: bool,
    insights: &[Insight],
    stair_dropped_explained: bool,
    status_rule: u8,
    steps: &[ReportStep],
    setup: Option<&SetupReport>,
) -> Validity {
    let setup_failed = setup.map(|s| s.failed).unwrap_or(0);
    let legacy = status_rule == STATUS_RULE_LEGACY;
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
    if legacy && silent_n > 0 && summary.errors == 0 {
        let mut r = reason_base("silent_http_errors", "warning");
        r.count = Some(silent_n);
        if n_http > 0 {
            r.pct = Some(silent_n as f64 / n_http as f64);
        }
        reasons.push(r);
    }

    // 규칙 2 — 3'. status_unchecked_errors: 상태 코드를 보지 않는 스텝이 받은 4xx·5xx
    // (준비 스텝 먼저·시나리오 순서로 모아 건수 내림차순 안정 정렬). fail-soft on YAML parse.
    let parsed = Scenario::from_yaml(scenario_yaml).ok();
    if !legacy && let Some(sc) = &parsed {
        let mut setup_ids: Vec<String> = Vec::new();
        collect_status_unchecked(sc.setup_steps(), &mut setup_ids);
        let mut main_ids: Vec<String> = Vec::new();
        collect_status_unchecked(&sc.steps, &mut main_ids);
        let err_count = |counts: &BTreeMap<String, u64>| -> u64 {
            counts
                .iter()
                .filter(|(k, _)| k.starts_with('4') || k.starts_with('5'))
                .map(|(_, v)| *v)
                .sum()
        };
        let mut found: Vec<(String, u64)> = Vec::new();
        if let Some(setup) = setup {
            for id in &setup_ids {
                if let Some(s) = setup.steps.iter().find(|s| &s.step_id == id) {
                    found.push((id.clone(), err_count(&s.status_counts)));
                }
            }
        }
        for id in &main_ids {
            if let Some(s) = steps.iter().find(|s| &s.step_id == id) {
                found.push((id.clone(), err_count(&s.status_counts)));
            }
        }
        found.retain(|(_, n)| *n > 0);
        found.sort_by_key(|(_, n)| std::cmp::Reverse(*n));
        for (id, n) in found {
            let mut r = reason_base("status_unchecked_errors", "warning");
            r.step_id = Some(id);
            r.count = Some(n);
            reasons.push(r);
        }
    }

    // 4. no_response_validation (§4.3) — fail-soft on YAML parse
    if let Some(sc) = &parsed {
        let mut ids: Vec<String> = Vec::new();
        collect_unconditional(&sc.steps, false, &mut ids);
        if !ids.is_empty() {
            let none_checked = if legacy {
                // 규칙 1: 상태 검사 줄이 하나도 없다.
                !ids.iter()
                    .any(|id| http_step_has_status_assert(&sc.steps, id))
            } else {
                // 규칙 2: 검사 없는 스텝은 400 이상이 오류라 보는 스텝이다 — 모두 `any`일 때만.
                ids.iter()
                    .all(|id| http_step_status_unchecked(&sc.steps, id))
            };
            if none_checked && !has_active_criteria {
                reasons.push(reason_base("no_response_validation", "warning"));
            }
        }
    }

    // 5. load_not_delivered — from load_gen_saturated insight. 계단 run에서 dropped가 전부
    //    지연·오류로 무너진(또는 포화 이후) 계단에서 났으면 시스템 포화로 이미 판정됐으므로 넣지 않는다(stair §5.7).
    if let Some(ins) = insights
        .iter()
        .find(|i| i.kind == "load_gen_saturated")
        .filter(|_| !stair_dropped_explained)
    {
        let mut r = reason_base("load_not_delivered", "warning");
        r.count = ins.count;
        reasons.push(r);
    }

    // 6. loadgen_port_exhaustion — 부하 발생기 자신이 포트를 소진했다. transport_heavy의
    //    비율/건수 임계와 무관하게 이 run의 수치는 오염됐다(간헐 1건도 임박 신호이므로
    //    insights 쪽 count>=1 임계와 보조를 맞춘다). 이게 없으면 critical 인사이트와
    //    "해석 가능" 배지가 한 화면에 동시에 뜬다(F1, US4).
    if let Some(ins) = insights
        .iter()
        .find(|i| i.kind == "loadgen_port_exhaustion")
    {
        let mut r = reason_base("loadgen_port_exhaustion", "critical");
        r.count = ins.count;
        reasons.push(r);
    }

    // 7. setup_failed — 준비에 실패한 VU는 반복을 시작하지 못해 부하가 설정보다 적었다.
    if setup_failed > 0 {
        let mut r = reason_base("setup_failed", "warning");
        r.count = Some(setup_failed);
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

/// Derive narrative can_claim / cannot_claim (spec §5).
/// Insights slice is already `order_rank`-sorted by `derive_insights` — do not re-sort (H7).
pub fn derive_narrative(
    validity: &Validity,
    summary: &ReportSummary,
    has_active_criteria: bool,
    insights: &[Insight],
) -> Narrative {
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
    // 3' status_unchecked_errors (규칙 2)
    if has_reason(validity, "status_unchecked_errors") {
        push_unique(&mut cannot_claim, "unchecked_steps_error_free");
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
        let stalled = insights
            .iter()
            .any(|i| i.kind == "load_gen_saturated" && i.cause.as_deref() == Some("stall"));
        push_unique(
            &mut can_claim,
            if stalled {
                "delivery_interrupted_by_stall"
            } else {
                "delivery_ceiling_observed"
            },
        );
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
        can_claim,
        cannot_claim,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::insights::Insight;
    use crate::report::{ReportStep, ReportSummary, SetupReport, SetupStepReport};
    use crate::store::runs::{STATUS_RULE_CURRENT, STATUS_RULE_LEGACY};
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
            runner_up_ms: None,
            error_kind: None,
            typical_in_flight: None,
            max_in_flight: None,
            drop_seconds: None,
            measured_seconds: None,
        }
    }

    fn insight_count(kind: &str, count: u64) -> Insight {
        let mut i = insight(kind);
        i.count = Some(count);
        i
    }

    fn insight_sc(kind: &str, status_class: &str) -> Insight {
        let mut i = insight(kind);
        i.status_class = Some(status_class.to_string());
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
    fn validity_setup_failed_reason() {
        let d = dist(&[("200", 100)]);
        let v = derive_validity(&summary(100, 0), &d, YAML_WITH_ASSERT, true, &[], false, 2);
        let r = v
            .reasons
            .iter()
            .find(|r| r.kind == "setup_failed")
            .expect("setup_failed reason");
        assert_eq!(r.count, Some(2));
        assert_eq!(r.severity, "warning");
        assert_eq!(v.level, "limited");
        let v0 = derive_validity(&summary(100, 0), &d, YAML_WITH_ASSERT, true, &[], false, 0);
        assert!(!kinds(&v0).contains(&"setup_failed"));
    }

    #[test]
    fn zero_requests_is_suspect() {
        let v = derive_validity(&summary(0, 0), &BTreeMap::new(), "", false, &[], false, 0);
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
        let v = derive_validity(&summary(100, 80), &d, YAML_WITH_ASSERT, true, &[], false, 0);
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
        let v = derive_validity(&summary(100, 5), &d, YAML_WITH_ASSERT, true, &[], false, 0);
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
        let v = derive_validity(
            &summary(1050, 50),
            &d,
            YAML_WITH_ASSERT,
            true,
            &[],
            false,
            0,
        );
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
        let v = derive_validity(&summary(100, 4), &d, YAML_WITH_ASSERT, true, &[], false, 0);
        assert!(!kinds(&v).contains(&"transport_heavy"));
    }

    #[test]
    fn silent_4xx_only_errors_zero() {
        let d = dist(&[("200", 90), ("404", 10)]);
        let v = derive_validity(&summary(100, 0), &d, YAML_WITH_ASSERT, true, &[], false, 0);
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
        let v = derive_validity(&summary(100, 0), &d, YAML_WITH_ASSERT, true, &[], false, 0);
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
        let v = derive_validity(&summary(100, 10), &d, YAML_WITH_ASSERT, true, &[], false, 0);
        assert!(!kinds(&v).contains(&"silent_http_errors"));
    }

    #[test]
    fn no_response_validation_when_no_assert_no_criteria() {
        let d = dist(&[("200", 100)]);
        let v = derive_validity(&summary(100, 0), &d, YAML_NO_ASSERT, false, &[], false, 0);
        assert!(kinds(&v).contains(&"no_response_validation"));
        assert_eq!(v.level, "limited");
    }

    #[test]
    fn has_status_assert_suppresses_no_response() {
        let d = dist(&[("200", 100)]);
        let v = derive_validity(&summary(100, 0), &d, YAML_WITH_ASSERT, false, &[], false, 0);
        assert!(!kinds(&v).contains(&"no_response_validation"));
        // no criteria → still slo_gate in narrative, but validity level ok if no other reasons
        assert_eq!(v.level, "ok");
    }

    #[test]
    fn has_active_criteria_suppresses_no_response() {
        let d = dist(&[("200", 100)]);
        let v = derive_validity(&summary(100, 0), &d, YAML_NO_ASSERT, true, &[], false, 0);
        assert!(!kinds(&v).contains(&"no_response_validation"));
        assert_eq!(v.level, "ok");
    }

    #[test]
    fn unconditional_http_zero_skips_no_response() {
        // only if-branch http → unconditional empty → vacuous skip
        let d = dist(&[("200", 100)]);
        let v = derive_validity(&summary(100, 0), &d, YAML_ONLY_IF, false, &[], false, 0);
        assert!(!kinds(&v).contains(&"no_response_validation"));
    }

    #[test]
    fn nested_loop_body_without_assert_detected() {
        let d = dist(&[("200", 100)]);
        let v = derive_validity(&summary(100, 0), &d, YAML_NESTED_LOOP, false, &[], false, 0);
        assert!(
            kinds(&v).contains(&"no_response_validation"),
            "H6: loop body http must be walked for status assert"
        );
    }

    #[test]
    fn load_gen_saturated_insight_emits_load_not_delivered() {
        let d = dist(&[("200", 100)]);
        let ins = [insight_count("load_gen_saturated", 42)];
        let v = derive_validity(&summary(100, 0), &d, YAML_WITH_ASSERT, true, &ins, false, 0);
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
    fn stall_saturation_narrative_says_interrupted() {
        let d = dist(&[("200", 100)]);
        let mut ins = [insight_count("load_gen_saturated", 42)];
        ins[0].cause = Some("stall".to_string());
        let v = derive_validity(&summary(100, 0), &d, YAML_WITH_ASSERT, true, &ins, false, 0);
        let n = derive_narrative(&v, &summary(100, 0), true, &ins);
        assert!(
            n.can_claim
                .contains(&"delivery_interrupted_by_stall".to_string())
        );
        assert!(
            !n.can_claim
                .contains(&"delivery_ceiling_observed".to_string())
        );
        assert!(n.cannot_claim.contains(&"target_load_applied".to_string()));
        ins[0].cause = Some("slots".to_string());
        let v = derive_validity(&summary(100, 0), &d, YAML_WITH_ASSERT, true, &ins, false, 0);
        let n = derive_narrative(&v, &summary(100, 0), true, &ins);
        assert!(
            n.can_claim
                .contains(&"delivery_ceiling_observed".to_string())
        );
        assert!(
            !n.can_claim
                .contains(&"delivery_interrupted_by_stall".to_string())
        );
        assert!(n.cannot_claim.contains(&"target_load_applied".to_string()));
    }

    #[test]
    fn stair_explained_dropped_skips_load_not_delivered() {
        // 계단 run에서 dropped가 전부 무너진 계단에서 났으면(stair §5.7) 사유를 넣지 않는다.
        let d = dist(&[("200", 100)]);
        let ins = [insight_count("load_gen_saturated", 42)];
        let v = derive_validity(&summary(100, 0), &d, YAML_WITH_ASSERT, true, &ins, true, 0);
        assert!(v.reasons.iter().all(|r| r.kind != "load_not_delivered"));
        assert_eq!(v.level, "ok");
    }

    #[test]
    fn loadgen_port_exhaustion_insight_emits_critical_reason_and_suspect() {
        // F1: without this reason, at 1-49 transport_heavy events under 5%,
        // `level` could compute to "ok" ("해석 가능") while InsightPanel already
        // renders the critical loadgen_port_exhaustion insight — a contradiction
        // that undermines US4. Mirrors load_gen_saturated → load_not_delivered.
        let d = dist(&[("200", 100)]);
        let ins = [insight_count("loadgen_port_exhaustion", 3)];
        let v = derive_validity(&summary(100, 0), &d, YAML_WITH_ASSERT, true, &ins, false, 0);
        let r = v
            .reasons
            .iter()
            .find(|r| r.kind == "loadgen_port_exhaustion")
            .expect("loadgen_port_exhaustion");
        assert_eq!(r.severity, "critical");
        assert_eq!(r.count, Some(3));
        assert_eq!(v.level, "suspect");
    }

    #[test]
    fn loadgen_port_exhaustion_absent_without_the_insight() {
        let d = dist(&[("200", 100)]);
        let v = derive_validity(&summary(100, 0), &d, YAML_WITH_ASSERT, true, &[], false, 0);
        assert!(!kinds(&v).contains(&"loadgen_port_exhaustion"));
        assert_eq!(v.level, "ok");
    }

    #[test]
    fn reasons_fixed_order() {
        // Force several reasons: zero + (no transport with count=0 empty dist) +
        // load via insight. Also no_response if we use count=0 with yaml? count=0
        // already suspect. Build: transport + silent + no_response + load
        let d = dist(&[("0", 60), ("404", 20), ("200", 20)]);
        // errors=0 for silent; n0=60 → transport critical
        let ins = [insight_count("load_gen_saturated", 1)];
        let v = derive_validity(&summary(100, 0), &d, YAML_NO_ASSERT, false, &ins, false, 0);
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

    // ── can/cannot goldens (§5.2) ───────────────────────────────────────

    #[test]
    fn golden_count_zero() {
        let v = derive_validity(&summary(0, 0), &BTreeMap::new(), "", false, &[], false, 0);
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
        let v = derive_validity(&summary(100, 80), &d, YAML_WITH_ASSERT, true, &[], false, 0);
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
        let v = derive_validity(&summary(100, 0), &d, YAML_NO_ASSERT, false, &[], false, 0);
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
        let v = derive_validity(&summary(100, 0), &d, YAML_NO_ASSERT, false, &[], false, 0);
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
        let v = derive_validity(&summary(100, 0), &d, YAML_WITH_ASSERT, true, &ins, false, 0);
        let n = derive_narrative(&v, &summary(100, 0), true, &ins);
        assert_eq!(v.level, "ok");
        assert!(n.can_claim.contains(&"slo_held".to_string()));
        assert!(n.can_claim.contains(&"bottleneck_step".to_string()));
        assert_eq!(n.cannot_claim, vec!["production_identity".to_string()]);
    }

    #[test]
    fn throughput_measured_only_when_count_positive() {
        // no_response + count==0 → no throughput_measured
        let v = derive_validity(
            &summary(0, 0),
            &BTreeMap::new(),
            YAML_NO_ASSERT,
            false,
            &[],
            false,
            0,
        );
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
        let v = derive_validity(&summary(100, 0), &d, YAML_NO_ASSERT, false, &ins, false, 0);
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
        assert!(n.can_claim.is_empty() && n.cannot_claim.is_empty());
    }

    #[test]
    fn bottleneck_step_absent_when_slowest_suppressed() {
        // 게이트가 slowest_step을 안 냈으면 "병목 스텝을 식별할 수 있다"는
        // 주장도 사라져야 한다(spec §1 P4 — 게이트 도입 전엔 1ms 격차 run도 주장했다).
        let d = dist(&[("200", 100)]);
        let ins = vec![insight("slo_pass")]; // slowest_step 없음
        let v = derive_validity(&summary(100, 0), &d, YAML_WITH_ASSERT, true, &ins, false, 0);
        assert_eq!(v.level, "ok", "다른 이유가 없으면 ok — 6~8 분기가 열린다");
        let n = derive_narrative(&v, &summary(100, 0), true, &ins);
        assert!(
            !n.can_claim.contains(&"bottleneck_step".to_string()),
            "slowest_step 부재 → bottleneck_step 미주장"
        );
        assert!(
            n.can_claim.contains(&"slo_held".to_string()),
            "형제 분기는 살아 있다"
        );
    }

    #[test]
    fn ok_level_sut_errors_observed_in_can_claim() {
        // level==ok(=other 4 reasons 전부 미emit)인데 5xx status_class 인사이트가
        // 있으면 sut_errors_observed가 can_claim에 실려야 한다(validity.rs:191의
        // `if validity.level == "ok"` 블록 안, :195-200 — 이 분기는 events 테스트
        // 삭제 후 zero-execution이었다: 삭제된 `insight_sc` 헬퍼 복원).
        // errors=10(>0)이라 silent_http_errors 미emit, has_active_criteria=true +
        // YAML_WITH_ASSERT라 no_response_validation 미emit, "0" 상태 없어 transport
        // 미emit, count>0이라 zero_requests 미emit → level은 반드시 ok.
        let d = dist(&[("200", 90), ("500", 10)]);
        let ins = vec![insight_sc("status_class", "5xx")];
        let v = derive_validity(
            &summary(100, 10),
            &d,
            YAML_WITH_ASSERT,
            true,
            &ins,
            false,
            0,
        );
        assert_eq!(v.level, "ok", "다른 이유가 없으면 ok — 6~8 분기가 열린다");
        let n = derive_narrative(&v, &summary(100, 10), true, &ins);
        assert!(
            n.can_claim.contains(&"sut_errors_observed".to_string()),
            "level==ok + 5xx status_class 인사이트 → sut_errors_observed 주장 가능해야 함"
        );
    }

    // ---- 규칙 갈래 (status_rule) ----

    /// 기존(규칙 1) 테스트용 얇은 호출: 규칙 1·스텝 없음·`setup_failed`만 채운 준비 보고.
    fn derive_validity(
        summary: &ReportSummary,
        d: &BTreeMap<String, u64>,
        yaml: &str,
        crit: bool,
        ins: &[Insight],
        stair: bool,
        setup_failed: u64,
    ) -> Validity {
        let setup = (setup_failed > 0).then(|| SetupReport {
            ok: 0,
            failed: setup_failed,
            interrupted: 0,
            steps: vec![],
        });
        super::derive_validity(
            summary,
            d,
            yaml,
            crit,
            ins,
            stair,
            STATUS_RULE_LEGACY,
            &[],
            setup.as_ref(),
        )
    }

    fn rule2(
        d: &BTreeMap<String, u64>,
        yaml: &str,
        crit: bool,
        steps: &[ReportStep],
        setup: Option<&SetupReport>,
        errors: u64,
    ) -> Validity {
        super::derive_validity(
            &summary(100, errors),
            d,
            yaml,
            crit,
            &[],
            false,
            STATUS_RULE_CURRENT,
            steps,
            setup,
        )
    }

    fn rstep(id: &str, sc: &[(&str, u64)]) -> ReportStep {
        ReportStep {
            step_id: id.to_string(),
            count: sc.iter().map(|(_, n)| n).sum(),
            error_count: 0,
            status_counts: dist(sc),
            p50_ms: 0,
            p95_ms: 0,
            p99_ms: 0,
            loop_breakdown: vec![],
            download: None,
            wait: None,
            loop_split: None,
            not_sent: None,
        }
    }

    const YAML_MIXED: &str = r#"
version: 1
name: t
steps:
  - type: http
    id: A
    name: a
    request: { method: GET, url: "http://x/" }
    assert:
      - status: any
  - type: http
    id: B
    name: b
    request: { method: GET, url: "http://x/" }
    assert:
      - status: any
  - type: http
    id: C
    name: c
    request: { method: GET, url: "http://x/" }
"#;

    const YAML_ALL_ANY: &str = r#"
version: 1
name: t
steps:
  - type: http
    id: A
    name: a
    request: { method: GET, url: "http://x/" }
    assert:
      - status: any
"#;

    const YAML_SETUP_ANY: &str = r#"
version: 1
name: t
setup:
  steps:
    - type: http
      id: S
      name: s
      request: { method: GET, url: "http://x/" }
      assert:
        - status: any
steps:
  - type: http
    id: M
    name: m
    request: { method: GET, url: "http://x/" }
    assert:
      - status: 200
"#;

    #[test]
    fn rule1_unchanged_keeps_silent_http_errors_and_old_no_response() {
        let d = dist(&[("200", 90), ("404", 10)]);
        let v = derive_validity(&summary(100, 0), &d, YAML_ALL_ANY, false, &[], false, 0);
        assert!(kinds(&v).contains(&"silent_http_errors"));
        assert!(!kinds(&v).contains(&"status_unchecked_errors"));
        // 규칙 1: 상태 검사 줄이 있으면(any여도) no_response_validation 없음.
        assert!(!kinds(&v).contains(&"no_response_validation"));
    }

    #[test]
    fn rule2_no_silent_http_errors() {
        let d = dist(&[("200", 90), ("404", 10)]);
        let v = rule2(&d, YAML_WITH_ASSERT, true, &[], None, 0);
        assert!(!kinds(&v).contains(&"silent_http_errors"));
    }

    #[test]
    fn rule2_unchecked_errors_per_step() {
        let d = dist(&[("200", 50), ("404", 8), ("500", 7)]);
        let steps = vec![
            rstep("A", &[("200", 10), ("404", 3)]),
            rstep("B", &[("500", 7)]),
            rstep("C", &[("404", 5)]),
        ];
        let v = rule2(&d, YAML_MIXED, false, &steps, None, 0);
        let got: Vec<(&str, u64)> = v
            .reasons
            .iter()
            .filter(|r| r.kind == "status_unchecked_errors")
            .map(|r| (r.step_id.as_deref().unwrap(), r.count.unwrap()))
            .collect();
        assert_eq!(got, vec![("B", 7), ("A", 3)]);
        assert!(
            v.reasons
                .iter()
                .filter(|r| r.kind == "status_unchecked_errors")
                .all(|r| r.severity == "warning")
        );
    }

    #[test]
    fn rule2_unchecked_ties_keep_scenario_order() {
        let d = dist(&[("404", 8)]);
        let steps = vec![rstep("B", &[("404", 4)]), rstep("A", &[("404", 4)])];
        let v = rule2(&d, YAML_MIXED, false, &steps, None, 0);
        let ids: Vec<&str> = v
            .reasons
            .iter()
            .filter(|r| r.kind == "status_unchecked_errors")
            .map(|r| r.step_id.as_deref().unwrap())
            .collect();
        assert_eq!(ids, vec!["A", "B"], "동률이면 시나리오 순서(A 먼저)");
    }

    #[test]
    fn rule2_unchecked_counts_setup() {
        let d = dist(&[("200", 5)]);
        let setup = SetupReport {
            ok: 0,
            failed: 0,
            interrupted: 0,
            steps: vec![SetupStepReport {
                step_id: "S".into(),
                count: 2,
                errors: 0,
                p50_ms: 0,
                p95_ms: 0,
                max_ms: 0,
                status_counts: dist(&[("404", 2)]),
                failure_kinds: BTreeMap::new(),
            }],
        };
        let v = rule2(&d, YAML_SETUP_ANY, true, &[], Some(&setup), 0);
        let r: Vec<_> = v
            .reasons
            .iter()
            .filter(|r| r.kind == "status_unchecked_errors")
            .collect();
        assert_eq!(r.len(), 1);
        assert_eq!(r[0].step_id.as_deref(), Some("S"));
        assert_eq!(r[0].count, Some(2));
    }

    #[test]
    fn rule2_no_response_validation_only_when_all_any() {
        let d = dist(&[("200", 100)]);
        let v = rule2(&d, YAML_NO_ASSERT, false, &[], None, 0);
        assert!(
            !kinds(&v).contains(&"no_response_validation"),
            "검사 없음 → 없음"
        );
        let v = rule2(&d, YAML_ALL_ANY, false, &[], None, 0);
        assert!(
            kinds(&v).contains(&"no_response_validation"),
            "모두 any → 있음"
        );
        let v = rule2(&d, YAML_MIXED, false, &[], None, 0);
        assert!(
            !kinds(&v).contains(&"no_response_validation"),
            "섞임 → 없음"
        );
        let v = rule2(&d, YAML_ALL_ANY, true, &[], None, 0);
        assert!(
            !kinds(&v).contains(&"no_response_validation"),
            "기준 있으면 없음"
        );
    }

    #[test]
    fn rule2_narrative_unchecked() {
        let d = dist(&[("404", 3)]);
        let steps = vec![rstep("A", &[("404", 3)])];
        let v = rule2(&d, YAML_MIXED, true, &steps, None, 0);
        let n = derive_narrative(&v, &summary(100, 0), true, &[]);
        assert!(
            n.cannot_claim
                .contains(&"unchecked_steps_error_free".to_string())
        );
        assert!(
            !n.cannot_claim
                .contains(&"zero_engine_errors_means_ok".to_string())
        );
    }
}
