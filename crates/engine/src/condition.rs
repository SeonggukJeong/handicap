//! Condition evaluation for `type: if` steps (spec §3). Uses the **lenient**
//! template resolver (`render_lenient`) so unresolved variables become `""` and
//! evaluation can never kill a run. Numeric comparisons parse both sides as f64;
//! an unparseable side → false. A bad regex compiles to a lenient `false`.

use crate::scenario::{CompareOp, Condition, IfStep};
use crate::template::{TemplateContext, render_collecting, render_lenient};
use serde::{Deserialize, Serialize};

/// Evaluate a condition tree to a boolean.
/// - `All` over an empty group → `true` (vacuous); `Any` over empty → `false`.
pub fn eval_condition(cond: &Condition, ctx: &TemplateContext) -> bool {
    match cond {
        Condition::All(v) => v.iter().all(|c| eval_condition(c, ctx)),
        Condition::Any(v) => v.iter().any(|c| eval_condition(c, ctx)),
        Condition::Compare { left, op, right } => eval_compare(left, *op, right.as_deref(), ctx),
    }
}

/// 한 비교 잎의 판정 근거(trace 전용). 원문에 `${`가 있는 쪽은 렌더 값을 저장하지 않는다
/// (환경 값이 시험 실행·기록 응답으로 새지 않게).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct LeafEval {
    pub left: String,
    pub op: CompareOp,
    pub right: Option<String>,
    pub left_value: Option<String>,
    pub right_value: Option<String>,
    pub left_unbound: bool,
}

/// 평가한 분기 조건 하나(`then`/`elif_{j}`)의 결과와 결정 잎.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct BranchEval {
    pub branch: String,
    pub passed: bool,
    pub leaf: Option<LeafEval>,
}

const EVAL_VALUE_CAP: usize = 200;

fn captured(raw: &str, ctx: &TemplateContext) -> Option<String> {
    if raw.contains("${") {
        None
    } else {
        Some(
            render_lenient(raw, ctx)
                .chars()
                .take(EVAL_VALUE_CAP)
                .collect(),
        )
    }
}

fn leaf_eval(left: &str, op: CompareOp, right: Option<&str>, ctx: &TemplateContext) -> LeafEval {
    let mut unbound = Vec::new();
    let _ = render_collecting(left, ctx, &mut unbound);
    let uses_right = !matches!(op, CompareOp::Exists | CompareOp::Empty);
    LeafEval {
        left: left.to_string(),
        op,
        right: right.map(str::to_string),
        left_value: captured(left, ctx),
        right_value: if uses_right {
            right.and_then(|r| captured(r, ctx))
        } else {
            None
        },
        left_unbound: !unbound.is_empty(),
    }
}

/// 결정 잎: Compare=그 잎 / all 거짓→처음 거짓 잎, 참→첫 잎 / any 참→처음 참 잎,
/// 거짓→첫 잎 / 하위 그룹 재귀 / 빈 그룹→None.
fn deciding_leaf(cond: &Condition, ctx: &TemplateContext) -> Option<LeafEval> {
    match cond {
        Condition::Compare { left, op, right } => Some(leaf_eval(left, *op, right.as_deref(), ctx)),
        Condition::All(v) => {
            let pick = v.iter().find(|c| !eval_condition(c, ctx)).or(v.first())?;
            deciding_leaf(pick, ctx)
        }
        Condition::Any(v) => {
            let pick = v.iter().find(|c| eval_condition(c, ctx)).or(v.first())?;
            deciding_leaf(pick, ctx)
        }
    }
}

/// trace 전용: `if`, 그다음 `elif`를 순서대로 평가해 참이 나온 데서 멈춘다
/// (`runner::select_branch`와 같은 순서·같은 `eval_condition` 의미론).
pub fn explain_branches(if_step: &IfStep, ctx: &TemplateContext) -> Vec<BranchEval> {
    let mut out = Vec::new();
    let conds = std::iter::once(("then".to_string(), &if_step.cond)).chain(
        if_step
            .elif
            .iter()
            .enumerate()
            .map(|(j, e)| (format!("elif_{j}"), &e.cond)),
    );
    for (branch, cond) in conds {
        let passed = eval_condition(cond, ctx);
        out.push(BranchEval {
            branch,
            passed,
            leaf: deciding_leaf(cond, ctx),
        });
        if passed {
            break;
        }
    }
    out
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
    // ---- explain_branches (trace 전용 판정 근거) ----

    use crate::scenario::{ElifBranch, IfStep};

    fn if_step(cond: Condition, elif: Vec<Condition>, has_else: bool) -> IfStep {
        let body = |id: &str| {
            vec![crate::scenario::Step::Http(crate::scenario::HttpStep {
                id: id.into(),
                name: "x".into(),
                request: crate::scenario::Request {
                    method: crate::scenario::HttpMethod::Get,
                    url: "http://x".into(),
                    headers: BTreeMap::new(),
                    body: None,
                    disabled: Default::default(),
                },
                assert: vec![],
                extract: vec![],
                timeout_seconds: None,
                think_time: None,
            })]
        };
        IfStep {
            id: "01HX0000000000000000000009".into(),
            name: "br".into(),
            cond,
            then_: body("01HX0000000000000000000010"),
            elif: elif
                .into_iter()
                .map(|c| ElifBranch {
                    cond: c,
                    then_: body("01HX0000000000000000000011"),
                })
                .collect(),
            else_: if has_else {
                body("01HX0000000000000000000012")
            } else {
                vec![]
            },
        }
    }

    fn eq(left: &str, right: &str) -> Condition {
        cmp(left, CompareOp::Eq, Some(right))
    }

    #[test]
    fn explain_matches_select_branch_table() {
        let v = vars(&[("a", "1"), ("b", "2")]);
        let e = BTreeMap::new();
        let ctx = ctx_with(&v, &e);
        let t = || eq("{{a}}", "1");
        let f = || eq("{{a}}", "9");
        let cases: Vec<IfStep> = vec![
            if_step(t(), vec![], false),
            if_step(t(), vec![t()], true),
            if_step(f(), vec![t(), t()], true),
            if_step(f(), vec![f(), t()], false),
            if_step(f(), vec![f(), f()], true),
            if_step(f(), vec![f()], false),
            if_step(Condition::All(vec![t(), f()]), vec![], true),
            if_step(Condition::Any(vec![f(), t()]), vec![], true),
            if_step(Condition::All(vec![]), vec![], true),
            if_step(Condition::Any(vec![]), vec![t()], true),
            if_step(
                Condition::All(vec![Condition::Any(vec![f(), t()]), t()]),
                vec![],
                false,
            ),
            if_step(
                Condition::All(vec![Condition::Any(vec![f(), f()]), t()]),
                vec![t()],
                false,
            ),
        ];
        for (n, c) in cases.iter().enumerate() {
            let ev = super::explain_branches(c, &ctx);
            let got = ev
                .iter()
                .find(|b| b.passed)
                .map(|b| b.branch.clone())
                .unwrap_or_else(|| if c.else_.is_empty() { "none" } else { "else" }.to_string());
            let want = crate::runner::select_branch(c, &ctx).1;
            assert_eq!(got, want, "case {n}");
            // 참이 나온 데서 멈춘다: 마지막 원소만 passed 가능
            let passed_count = ev.iter().filter(|b| b.passed).count();
            assert!(passed_count <= 1, "case {n}");
            if passed_count == 1 {
                assert!(ev.last().unwrap().passed, "case {n}");
            }
        }
    }

    fn leaf_left(cond: Condition, v: &BTreeMap<String, String>) -> Option<String> {
        let e = BTreeMap::new();
        let ctx = ctx_with(v, &e);
        let ev = super::explain_branches(&if_step(cond, vec![], false), &ctx);
        ev[0].leaf.as_ref().map(|l| l.left.clone())
    }

    fn abc() -> BTreeMap<String, String> {
        vars(&[("a", "1"), ("b", "0"), ("c", "0")])
    }

    #[test]
    fn deciding_leaf_all_false_is_first_false() {
        let c = Condition::All(vec![eq("{{a}}", "1"), eq("{{b}}", "2"), eq("{{c}}", "3")]);
        assert_eq!(leaf_left(c, &abc()).as_deref(), Some("{{b}}"));
    }

    #[test]
    fn deciding_leaf_all_true_is_first() {
        let c = Condition::All(vec![eq("{{a}}", "1"), eq("{{b}}", "0")]);
        assert_eq!(leaf_left(c, &abc()).as_deref(), Some("{{a}}"));
    }

    #[test]
    fn deciding_leaf_any_true_is_first_true() {
        let c = Condition::Any(vec![eq("{{a}}", "9"), eq("{{b}}", "0"), eq("{{c}}", "0")]);
        assert_eq!(leaf_left(c, &abc()).as_deref(), Some("{{b}}"));
    }

    #[test]
    fn deciding_leaf_any_false_is_first() {
        let c = Condition::Any(vec![eq("{{a}}", "9"), eq("{{b}}", "9")]);
        assert_eq!(leaf_left(c, &abc()).as_deref(), Some("{{a}}"));
    }

    #[test]
    fn deciding_leaf_recurses_into_nested_group() {
        let c = Condition::All(vec![
            eq("{{a}}", "1"),
            Condition::Any(vec![eq("{{b}}", "9"), eq("{{c}}", "9")]),
        ]);
        // all 거짓 → 처음 거짓 잎 = 하위 any(거짓) → 그 첫 잎 {{b}}
        assert_eq!(leaf_left(c, &abc()).as_deref(), Some("{{b}}"));
    }

    #[test]
    fn empty_group_has_no_leaf() {
        let v = BTreeMap::new();
        let e = BTreeMap::new();
        let ctx = ctx_with(&v, &e);
        let ev = super::explain_branches(&if_step(Condition::All(vec![]), vec![], false), &ctx);
        assert_eq!(ev.len(), 1);
        assert!(ev[0].passed);
        assert_eq!(ev[0].leaf, None);
        assert_eq!(ev[0].branch, "then");
    }

    #[test]
    fn left_unbound_flag() {
        let e = BTreeMap::new();
        let v = BTreeMap::new();
        let ctx = ctx_with(&v, &e);
        let ev = super::explain_branches(&if_step(eq("{{missing}}", "x"), vec![], false), &ctx);
        let l = ev[0].leaf.as_ref().unwrap();
        assert!(l.left_unbound);
        assert_eq!(l.left_value.as_deref(), Some(""));
        assert_eq!(l.right_value.as_deref(), Some("x"));

        let v2 = vars(&[("missing", "x")]);
        let ctx2 = ctx_with(&v2, &e);
        let ev = super::explain_branches(&if_step(eq("{{missing}}", "x"), vec![], false), &ctx2);
        assert!(!ev[0].leaf.as_ref().unwrap().left_unbound);
    }

    #[test]
    fn env_values_not_stored() {
        let v = BTreeMap::new();
        let e = vars(&[("RACE", "secret"), ("X", "other")]);
        let ctx = ctx_with(&v, &e);
        let ev = super::explain_branches(&if_step(eq("${RACE}", "true"), vec![], false), &ctx);
        let l = ev[0].leaf.as_ref().unwrap();
        assert_eq!(l.left_value, None);
        assert_eq!(l.right_value.as_deref(), Some("true"));
        let ev = super::explain_branches(&if_step(eq("{{a}}", "${X}"), vec![], false), &ctx);
        let l = ev[0].leaf.as_ref().unwrap();
        assert_eq!(l.right_value, None);
        assert_eq!(l.right.as_deref(), Some("${X}"));
    }

    #[test]
    fn exists_and_empty_have_no_right_value() {
        let v = vars(&[("a", "1")]);
        let e = BTreeMap::new();
        let ctx = ctx_with(&v, &e);
        let c = cmp("{{a}}", CompareOp::Exists, Some("ignored"));
        let ev = super::explain_branches(&if_step(c, vec![], false), &ctx);
        assert_eq!(ev[0].leaf.as_ref().unwrap().right_value, None);
    }

    #[test]
    fn values_capped_at_200_chars() {
        let long = "가".repeat(300);
        let v = vars(&[("a", long.as_str())]);
        let e = BTreeMap::new();
        let ctx = ctx_with(&v, &e);
        let ev = super::explain_branches(&if_step(eq("{{a}}", &long), vec![], false), &ctx);
        let l = ev[0].leaf.as_ref().unwrap();
        assert_eq!(l.left_value.as_ref().unwrap().chars().count(), 200);
        assert_eq!(l.right_value.as_ref().unwrap().chars().count(), 200);
    }
}
