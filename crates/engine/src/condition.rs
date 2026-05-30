//! Condition evaluation for `type: if` steps (spec §3). Uses the **lenient**
//! template resolver (`render_lenient`) so unresolved variables become `""` and
//! evaluation can never kill a run. Numeric comparisons parse both sides as f64;
//! an unparseable side → false. A bad regex compiles to a lenient `false`.

use crate::scenario::{CompareOp, Condition};
use crate::template::{TemplateContext, render_lenient};

/// Evaluate a condition tree to a boolean.
/// - `All` over an empty group → `true` (vacuous); `Any` over empty → `false`.
pub fn eval_condition(cond: &Condition, ctx: &TemplateContext) -> bool {
    match cond {
        Condition::All(v) => v.iter().all(|c| eval_condition(c, ctx)),
        Condition::Any(v) => v.iter().any(|c| eval_condition(c, ctx)),
        Condition::Compare { left, op, right } => eval_compare(left, *op, right.as_deref(), ctx),
    }
}

fn eval_compare(left: &str, op: CompareOp, right: Option<&str>, ctx: &TemplateContext) -> bool {
    let l = render_lenient(left, ctx);
    match op {
        CompareOp::Exists => !l.is_empty(),
        CompareOp::Empty => l.is_empty(),
        _ => {
            // For all other ops, a missing `right` renders to "" (lenient).
            let r = right.map(|r| render_lenient(r, ctx)).unwrap_or_default();
            match op {
                CompareOp::Eq => l == r,
                CompareOp::Ne => l != r,
                CompareOp::Contains => l.contains(&r),
                CompareOp::Matches => {
                    // Compiled per-eval, not cached: `matches` is a rare op and `r` is the
                    // *rendered* right operand (may contain ${ENV}/{{var}}), so it is not a
                    // compile-time constant — a static/once_cell cache would be incorrect.
                    match regex::Regex::new(&r) {
                        Ok(re) => re.is_match(&l),
                        Err(e) => {
                            // Runtime safety net (spec §3.3): bad regex → lenient false.
                            // The authoring guard is UI 9b (`new RegExp` smoke check).
                            tracing::warn!(pattern = %r, error = %e, "invalid regex in condition; treating as false");
                            false
                        }
                    }
                }
                CompareOp::Lt | CompareOp::Gt | CompareOp::Lte | CompareOp::Gte => {
                    match (l.parse::<f64>(), r.parse::<f64>()) {
                        (Ok(a), Ok(b)) => match op {
                            CompareOp::Lt => a < b,
                            CompareOp::Gt => a > b,
                            CompareOp::Lte => a <= b,
                            CompareOp::Gte => a >= b,
                            _ => unreachable!("only lt/gt/lte/gte reach here"),
                        },
                        // one side unparseable → false (string "200" < "30" must not lie)
                        _ => false,
                    }
                }
                CompareOp::Exists | CompareOp::Empty => unreachable!("handled above"),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

    fn ctx_with<'a>(
        vars: &'a BTreeMap<String, String>,
        env: &'a BTreeMap<String, String>,
    ) -> TemplateContext<'a> {
        TemplateContext {
            vars,
            env,
            vu_id: 0,
            iter_id: 0,
            loop_index: None,
        }
    }

    fn vars(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
        pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect()
    }

    fn cmp(left: &str, op: CompareOp, right: Option<&str>) -> Condition {
        Condition::Compare {
            left: left.to_string(),
            op,
            right: right.map(str::to_string),
        }
    }

    #[test]
    fn eq_ne_are_string_equality() {
        let v = vars(&[("code", "200")]);
        let e = BTreeMap::new();
        let ctx = ctx_with(&v, &e);
        assert!(eval_condition(
            &cmp("{{code}}", CompareOp::Eq, Some("200")),
            &ctx
        ));
        assert!(!eval_condition(
            &cmp("{{code}}", CompareOp::Eq, Some("200.0")),
            &ctx
        ));
        assert!(eval_condition(
            &cmp("{{code}}", CompareOp::Ne, Some("404")),
            &ctx
        ));
    }

    #[test]
    fn contains_substring() {
        let v = vars(&[("body", "all ok here")]);
        let e = BTreeMap::new();
        let ctx = ctx_with(&v, &e);
        assert!(eval_condition(
            &cmp("{{body}}", CompareOp::Contains, Some("ok")),
            &ctx
        ));
        assert!(!eval_condition(
            &cmp("{{body}}", CompareOp::Contains, Some("nope")),
            &ctx
        ));
    }

    #[test]
    fn matches_regex_unanchored() {
        let v = vars(&[("s", "abc123")]);
        let e = BTreeMap::new();
        let ctx = ctx_with(&v, &e);
        assert!(eval_condition(
            &cmp("{{s}}", CompareOp::Matches, Some("[0-9]+")),
            &ctx
        ));
        assert!(!eval_condition(
            &cmp("{{s}}", CompareOp::Matches, Some("^[0-9]+$")),
            &ctx
        ));
    }

    #[test]
    fn bad_regex_is_lenient_false() {
        let v = vars(&[("s", "x")]);
        let e = BTreeMap::new();
        let ctx = ctx_with(&v, &e);
        // unbalanced bracket — Regex::new errors → false, no panic.
        assert!(!eval_condition(
            &cmp("{{s}}", CompareOp::Matches, Some("[")),
            &ctx
        ));
    }

    #[test]
    fn numeric_ops_parse_both_sides() {
        let v = vars(&[("n", "200")]);
        let e = BTreeMap::new();
        let ctx = ctx_with(&v, &e);
        // "200" vs "30": numeric 200 > 30 (string compare would be false).
        assert!(eval_condition(
            &cmp("{{n}}", CompareOp::Gt, Some("30")),
            &ctx
        ));
        assert!(eval_condition(
            &cmp("{{n}}", CompareOp::Gte, Some("200")),
            &ctx
        ));
        assert!(eval_condition(
            &cmp("{{n}}", CompareOp::Lte, Some("200")),
            &ctx
        ));
        assert!(!eval_condition(
            &cmp("{{n}}", CompareOp::Lt, Some("200")),
            &ctx
        ));
    }

    #[test]
    fn numeric_unparseable_side_is_false() {
        let v = vars(&[("n", "notnum")]);
        let e = BTreeMap::new();
        let ctx = ctx_with(&v, &e);
        assert!(!eval_condition(
            &cmp("{{n}}", CompareOp::Lt, Some("5")),
            &ctx
        ));
        assert!(!eval_condition(
            &cmp("{{n}}", CompareOp::Gt, Some("5")),
            &ctx
        ));
    }

    #[test]
    fn exists_empty_treat_unbound_as_empty() {
        let v = BTreeMap::new(); // {{token}} unbound → lenient ""
        let e = BTreeMap::new();
        let ctx = ctx_with(&v, &e);
        assert!(!eval_condition(
            &cmp("{{token}}", CompareOp::Exists, None),
            &ctx
        ));
        assert!(eval_condition(
            &cmp("{{token}}", CompareOp::Empty, None),
            &ctx
        ));

        let v2 = vars(&[("token", "abc")]);
        let ctx2 = ctx_with(&v2, &e);
        assert!(eval_condition(
            &cmp("{{token}}", CompareOp::Exists, None),
            &ctx2
        ));
        assert!(!eval_condition(
            &cmp("{{token}}", CompareOp::Empty, None),
            &ctx2
        ));
    }

    #[test]
    fn all_any_short_circuit_and_empty_groups() {
        let v = vars(&[("a", "1"), ("b", "2")]);
        let e = BTreeMap::new();
        let ctx = ctx_with(&v, &e);
        let t = cmp("{{a}}", CompareOp::Eq, Some("1"));
        let f = cmp("{{b}}", CompareOp::Eq, Some("9"));
        assert!(eval_condition(
            &Condition::All(vec![t.clone(), t.clone()]),
            &ctx
        ));
        assert!(!eval_condition(
            &Condition::All(vec![t.clone(), f.clone()]),
            &ctx
        ));
        assert!(eval_condition(
            &Condition::Any(vec![f.clone(), t.clone()]),
            &ctx
        ));
        assert!(!eval_condition(
            &Condition::Any(vec![f.clone(), f.clone()]),
            &ctx
        ));
        // Empty groups: All → true (vacuous), Any → false.
        assert!(eval_condition(&Condition::All(vec![]), &ctx));
        assert!(!eval_condition(&Condition::Any(vec![]), &ctx));
    }

    #[test]
    fn missing_right_for_non_exists_op_treated_as_empty() {
        let v = vars(&[("x", "")]);
        let e = BTreeMap::new();
        let ctx = ctx_with(&v, &e);
        // left renders "" , right None → "" , eq → true
        assert!(eval_condition(&cmp("{{x}}", CompareOp::Eq, None), &ctx));
    }

    #[test]
    fn nested_tree_depth_two() {
        // Any( All(a==1, b==2), c==9 ) — exercises recursion deeper than one level.
        let v = vars(&[("a", "1"), ("b", "2"), ("c", "3")]);
        let e = BTreeMap::new();
        let ctx = ctx_with(&v, &e);
        let inner_all = Condition::All(vec![
            cmp("{{a}}", CompareOp::Eq, Some("1")),
            cmp("{{b}}", CompareOp::Eq, Some("2")),
        ]);
        let cond = Condition::Any(vec![
            inner_all.clone(),
            cmp("{{c}}", CompareOp::Eq, Some("9")),
        ]);
        assert!(eval_condition(&cond, &ctx)); // inner_all true → Any true

        // Now break the inner All so the whole Any is false.
        let v2 = vars(&[("a", "0"), ("b", "2"), ("c", "3")]);
        let ctx2 = ctx_with(&v2, &e);
        assert!(!eval_condition(&cond, &ctx2));
    }

    #[test]
    fn ne_with_unbound_left_is_true() {
        // unbound {{ghost}} → lenient "" , "" != "x" → true.
        let v = BTreeMap::new();
        let e = BTreeMap::new();
        let ctx = ctx_with(&v, &e);
        assert!(eval_condition(
            &cmp("{{ghost}}", CompareOp::Ne, Some("x")),
            &ctx
        ));
    }

    #[test]
    fn right_operand_is_templated() {
        // The right operand is rendered too: a ${ENV} pattern resolves before matching.
        let v = vars(&[("s", "abc123")]);
        let e: BTreeMap<String, String> = [("PAT".to_string(), "[0-9]+".to_string())]
            .into_iter()
            .collect();
        let ctx = ctx_with(&v, &e);
        assert!(eval_condition(
            &cmp("{{s}}", CompareOp::Matches, Some("${PAT}")),
            &ctx
        ));
        // and an eq against a templated right operand.
        let e2: BTreeMap<String, String> = [("WANT".to_string(), "abc123".to_string())]
            .into_iter()
            .collect();
        let ctx2 = ctx_with(&v, &e2);
        assert!(eval_condition(
            &cmp("{{s}}", CompareOp::Eq, Some("${WANT}")),
            &ctx2
        ));
    }
}
