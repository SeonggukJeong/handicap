//! `type: if` end-to-end: drives `execute_steps` branch selection against wiremock.
//!
//! The scenario is fixed-shape: an if node whose `then`/`elif`/`else` each contain
//! one distinct GET. We assert *which* step id recorded a request — the not-taken
//! branches never run, so they have no metric window at all. The lenient test proves
//! an unbound `{{var}}` in the condition falls through to `else` instead of killing
//! the run.
use std::collections::{BTreeMap, HashMap};
use std::sync::Arc;
use std::time::Duration;

use handicap_engine::{MetricFlush, RunPlan, Scenario, run_scenario};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;
use wiremock::matchers::{method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

const THEN_ID: &str = "01HX0000000000000000000002";
const ELIF_ID: &str = "01HX0000000000000000000003";
const ELSE_ID: &str = "01HX0000000000000000000004";

/// Stub /then, /elif, /else (all 200), run the scenario for one VU / short window,
/// return step_id -> total count.
async fn run_and_count(yaml: &str) -> HashMap<String, u64> {
    let scenario = Arc::new(Scenario::from_yaml(yaml).expect("parses"));
    let (tx, mut rx) = mpsc::channel::<MetricFlush>(64);
    let plan = RunPlan {
        vus: 1,
        ramp_up: Duration::from_secs(0),
        duration: Duration::from_millis(400),
        env: BTreeMap::new(),
        loop_breakdown_cap: 0,
        data_binding: None,
    };
    let cancel = CancellationToken::new();
    let run = tokio::spawn(async move { run_scenario(scenario, plan, tx, cancel).await });
    let mut counts: HashMap<String, u64> = HashMap::new();
    let mut errors: u64 = 0;
    while let Some(f) = rx.recv().await {
        for w in f.windows {
            *counts.entry(w.step_id).or_default() += w.count;
            errors += w.error_count;
        }
    }
    run.await.expect("join").expect("run ok");
    assert_eq!(errors, 0, "no HTTP errors expected (all paths stubbed 200)");
    counts
}

/// Build the canonical if/elif/else scenario with caller-supplied `cond` (top if)
/// and `elif_cond` (single elif). All three branch bodies are static GETs.
fn scenario_yaml(base: &str, cond: &str, elif_cond: &str) -> String {
    format!(
        r#"
version: 1
name: branchy
variables:
  base: "{base}"
steps:
  - id: "01HX0000000000000000000001"
    name: branch
    type: if
    cond: {cond}
    then:
      - id: "{THEN_ID}"
        name: then-step
        type: http
        request: {{ method: GET, url: "{{{{base}}}}/then" }}
        assert: [ {{ status: 200 }} ]
    elif:
      - cond: {elif_cond}
        then:
          - id: "{ELIF_ID}"
            name: elif-step
            type: http
            request: {{ method: GET, url: "{{{{base}}}}/elif" }}
            assert: [ {{ status: 200 }} ]
    else:
      - id: "{ELSE_ID}"
        name: else-step
        type: http
        request: {{ method: GET, url: "{{{{base}}}}/else" }}
        assert: [ {{ status: 200 }} ]
"#
    )
}

async fn server() -> MockServer {
    let s = MockServer::start().await;
    for p in ["/then", "/elif", "/else"] {
        Mock::given(method("GET"))
            .and(path(p))
            .respond_with(ResponseTemplate::new(200))
            .mount(&s)
            .await;
    }
    s
}

#[tokio::test]
async fn then_branch_taken_when_cond_true() {
    let s = server().await;
    // top cond true → only /then runs.
    let yaml = scenario_yaml(
        &s.uri(),
        "{ left: \"1\", op: eq, right: \"1\" }",
        "{ left: \"a\", op: eq, right: \"a\" }",
    );
    let counts = run_and_count(&yaml).await;
    assert!(counts.get(THEN_ID).copied().unwrap_or(0) > 0, "then ran");
    assert_eq!(counts.get(ELIF_ID), None, "elif must not run");
    assert_eq!(counts.get(ELSE_ID), None, "else must not run");
}

#[tokio::test]
async fn elif_branch_taken_when_only_elif_true() {
    let s = server().await;
    // top false, elif true → only /elif runs.
    let yaml = scenario_yaml(
        &s.uri(),
        "{ left: \"1\", op: eq, right: \"2\" }",
        "{ left: \"a\", op: eq, right: \"a\" }",
    );
    let counts = run_and_count(&yaml).await;
    assert_eq!(counts.get(THEN_ID), None, "then must not run");
    assert!(counts.get(ELIF_ID).copied().unwrap_or(0) > 0, "elif ran");
    assert_eq!(counts.get(ELSE_ID), None, "else must not run");
}

#[tokio::test]
async fn else_branch_taken_when_all_false() {
    let s = server().await;
    // top false, elif false → /else runs.
    let yaml = scenario_yaml(
        &s.uri(),
        "{ left: \"1\", op: eq, right: \"2\" }",
        "{ left: \"a\", op: eq, right: \"b\" }",
    );
    let counts = run_and_count(&yaml).await;
    assert_eq!(counts.get(THEN_ID), None, "then must not run");
    assert_eq!(counts.get(ELIF_ID), None, "elif must not run");
    assert!(counts.get(ELSE_ID).copied().unwrap_or(0) > 0, "else ran");
}

#[tokio::test]
async fn unbound_var_in_cond_falls_through_lenient() {
    let s = server().await;
    // {{ghost}} is unbound → lenient "" , "" eq "x" false , elif "" eq "y" false → else.
    // A strict resolver would error and kill the run; lenient must just branch.
    let yaml = scenario_yaml(
        &s.uri(),
        "{ left: \"{{ghost}}\", op: eq, right: \"x\" }",
        "{ left: \"{{ghost}}\", op: eq, right: \"y\" }",
    );
    let counts = run_and_count(&yaml).await;
    assert!(
        counts.get(ELSE_ID).copied().unwrap_or(0) > 0,
        "unbound cond must fall through to else, run must not die"
    );
}
