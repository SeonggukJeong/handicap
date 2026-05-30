//! Property tests for engine core contracts: template render must not panic
//! on arbitrary input, scenario YAML round-trips identity, and the extract
//! evaluator is deterministic. Strategies are intentionally narrow — just
//! enough to exercise parser paths without becoming a fuzzer.

use std::collections::BTreeMap;

use handicap_engine::extract::ResponseFacts;
use handicap_engine::scenario::{
    Assertion, Body, CompareOp, Condition, CookieJarMode, ElifBranch, Extract, HttpMethod,
    HttpStep, IfStep, LoopStep, Request, Step,
};
use handicap_engine::template::{TemplateContext, render};
use handicap_engine::{Scenario, evaluate_extracts};
use proptest::collection::{btree_map, vec};
use proptest::option;
use proptest::prelude::*;

fn arb_ident() -> impl Strategy<Value = String> {
    "[a-z]{1,10}"
}

fn arb_http_method() -> impl Strategy<Value = HttpMethod> {
    prop_oneof![
        Just(HttpMethod::Get),
        Just(HttpMethod::Post),
        Just(HttpMethod::Put),
        Just(HttpMethod::Patch),
        Just(HttpMethod::Delete),
        Just(HttpMethod::Head),
        Just(HttpMethod::Options),
    ]
}

fn arb_assertion() -> impl Strategy<Value = Assertion> {
    (100u16..600u16).prop_map(Assertion::Status)
}

fn arb_extract() -> impl Strategy<Value = Extract> {
    prop_oneof![
        (arb_ident(), "[a-zA-Z_][a-zA-Z0-9_.$]{0,16}").prop_map(|(var, path)| Extract::Body {
            var,
            path: format!("${path}")
        }),
        (arb_ident(), "[A-Za-z][A-Za-z0-9-]{0,20}")
            .prop_map(|(var, name)| Extract::Header { var, name }),
        (arb_ident(), "[A-Za-z][A-Za-z0-9_]{0,20}")
            .prop_map(|(var, name)| Extract::Cookie { var, name }),
        arb_ident().prop_map(|var| Extract::Status { var }),
    ]
}

fn arb_body() -> impl Strategy<Value = Body> {
    prop_oneof![
        ".*".prop_map(Body::Raw),
        btree_map(arb_ident(), ".*", 0..3).prop_map(Body::Form),
        ".*".prop_map(|s| Body::Json(serde_json::Value::String(s))),
    ]
}

fn arb_http_step() -> impl Strategy<Value = HttpStep> {
    (
        "[0-9A-HJKMNP-TV-Z]{26}",
        arb_ident(),
        arb_http_method(),
        "(/[a-z0-9/_-]{0,20}|\\{\\{[a-z]{1,5}\\}\\}/[a-z0-9/_-]{0,10})",
        btree_map("[A-Za-z][A-Za-z0-9-]{0,10}", ".*", 0..3),
        option::of(arb_body()),
        vec(arb_assertion(), 0..3),
        vec(arb_extract(), 0..3),
    )
        .prop_map(
            |(id, name, method, url, headers, body, assert, extract)| HttpStep {
                id,
                name,
                request: Request {
                    method,
                    url,
                    headers,
                    body,
                },
                assert,
                extract,
            },
        )
}

fn arb_compare_op() -> impl Strategy<Value = CompareOp> {
    prop_oneof![
        Just(CompareOp::Eq),
        Just(CompareOp::Ne),
        Just(CompareOp::Contains),
        Just(CompareOp::Matches),
        Just(CompareOp::Lt),
        Just(CompareOp::Gt),
        Just(CompareOp::Lte),
        Just(CompareOp::Gte),
        Just(CompareOp::Exists),
        Just(CompareOp::Empty),
    ]
}

// Operand alphabet is intentionally restricted to `[a-z0-9]` (+ `{{var}}` form): this
// property pins the structural manual-serde round-trip, not YAML-special-string quoting.
// Special operands (yaml keywords, `:` / `#` / leading-space, etc.) are covered by the
// deterministic unit tests in `scenario.rs` (the Condition serde tests). All-digit
// operands ARE generated here and provably round-trip (serde forces the typed String).
fn arb_compare() -> impl Strategy<Value = Condition> {
    (
        "(\\{\\{[a-z]{1,5}\\}\\}|[a-z0-9]{0,8})",
        arb_compare_op(),
        option::of("[a-z0-9]{0,8}"),
    )
        .prop_map(|(left, op, right)| Condition::Compare { left, op, right })
}

// One level of grouping over leaves — bounded so the generator terminates.
fn arb_condition() -> impl Strategy<Value = Condition> {
    prop_oneof![
        3 => arb_compare(),
        1 => vec(arb_compare(), 1..3).prop_map(Condition::All),
        1 => vec(arb_compare(), 1..3).prop_map(Condition::Any),
    ]
}

fn arb_if_step() -> impl Strategy<Value = Step> {
    (
        "[0-9A-HJKMNP-TV-Z]{26}",
        arb_ident(),
        arb_condition(),
        vec(arb_http_step().prop_map(Step::Http), 0..3),
        vec(
            (
                arb_condition(),
                vec(arb_http_step().prop_map(Step::Http), 0..2),
            )
                .prop_map(|(cond, then_)| ElifBranch { cond, then_ }),
            0..2,
        ),
        vec(arb_http_step().prop_map(Step::Http), 0..2),
    )
        .prop_map(|(id, name, cond, then_, elif, else_)| {
            Step::If(IfStep {
                id,
                name,
                cond,
                then_,
                elif,
                else_,
            })
        })
}

fn arb_step() -> impl Strategy<Value = Step> {
    prop_oneof![
        4 => arb_http_step().prop_map(Step::Http),
        1 => (
            "[0-9A-HJKMNP-TV-Z]{26}",
            arb_ident(),
            1u32..4u32,
            vec(arb_http_step().prop_map(Step::Http), 1..3),
        )
            .prop_map(|(id, name, repeat, do_)| Step::Loop(LoopStep { id, name, repeat, do_ })),
        1 => arb_if_step(),
    ]
}

fn arb_scenario() -> impl Strategy<Value = Scenario> {
    (
        arb_ident(),
        prop_oneof![Just(CookieJarMode::Auto), Just(CookieJarMode::Off)],
        btree_map(arb_ident(), ".*", 0..3),
        vec(arb_step(), 0..4),
    )
        .prop_map(|(name, cookie_jar, variables, steps)| Scenario {
            version: 1,
            name,
            cookie_jar,
            variables,
            steps,
        })
}

proptest! {
    #[test]
    fn template_render_never_panics(input in ".*") {
        let vars: BTreeMap<String, String> = BTreeMap::new();
        let env: BTreeMap<String, String> = BTreeMap::new();
        let ctx = TemplateContext { vars: &vars, env: &env, vu_id: 0, iter_id: 0, loop_index: None };
        let _ = render(&input, &ctx);
    }

    #[test]
    fn scenario_yaml_round_trip(s in arb_scenario()) {
        let y = s.to_yaml().expect("serialize");
        let s2 = Scenario::from_yaml(&y).unwrap_or_else(|_| panic!("deserialize:\n{y}"));
        prop_assert_eq!(s, s2);
    }

    #[test]
    fn evaluate_is_deterministic(body in ".*", name in "[A-Z][A-Z0-9_]{0,8}") {
        let facts = ResponseFacts {
            status: 200,
            headers: &[("X-T".into(), "v".into())],
            set_cookies: &[format!("{name}=v; Path=/")],
            body: body.as_bytes(),
        };
        let xs = vec![
            Extract::Header { var: "h".into(), name: "X-T".into() },
            Extract::Cookie { var: "c".into(), name: name.clone() },
            Extract::Status { var: "s".into() },
        ];
        let a = evaluate_extracts(&xs, &facts);
        let b = evaluate_extracts(&xs, &facts);
        match (a, b) {
            (Ok(a), Ok(b)) => prop_assert_eq!(a, b),
            (Err(a), Err(b)) => prop_assert_eq!(a.to_string(), b.to_string()),
            _ => prop_assert!(false, "non-deterministic result"),
        }
    }
}
