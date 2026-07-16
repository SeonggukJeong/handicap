//! `type: if` end-to-end: drives `execute_steps` branch selection against wiremock.
//!
//! The scenario is fixed-shape: an if node whose `then`/`elif`/`else` each contain
//! one distinct GET. We assert *which* step id recorded a request — the not-taken
//! branches never run, so they have no metric window at all. The lenient test proves
//! an unbound `{{var}}` in the condition falls through to `else` instead of killing
//! the run.
//!
//! Regression tests (added Slice 9a):
//!   - `if_in_loop_loop_index_visible_in_cond_and_url`: proves that `Step::If` passes
//!     the incoming `loop_index` through to child steps unchanged (the load-bearing
//!     `loop_index` argument in `execute_steps`'s `Step::If` arm). Dropping it would
//!     make `${loop_index}` render as "" in both condition and URL.
//!   - `extract_driven_condition_reads_live_iter_vars`: proves that an `if` cond later
//!     in the same iteration sees variables extracted by an earlier http step.
use std::collections::{BTreeMap, HashMap};
use std::sync::Arc;
use std::time::Duration;

use handicap_engine::{MetricFlush, RampDown, RunPlan, Scenario, run_scenario};
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
        vu_offset: 0,
        data_bindings: vec![],
        http_timeout: Duration::from_secs(30),
        think_time: None,
        think_seed: None,
        target_rps: None,
        max_in_flight: None,
        stages: None,
        measure_phases: false,
        vu_stages: None,
        ramp_down: RampDown::Graceful,
        graceful_ramp_down: None,
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

// ── Slice 9a regression tests ────────────────────────────────────────────────

/// Step IDs used by the if-in-loop and extract-driven tests. All in the
/// Crockford base32 safe range (no I / L / O / U).
const LOOP_IF_ID: &str = "01HX0000000000000000000005";
const LOOP_THEN_ID: &str = "01HX0000000000000000000006";
const LOOP_ELSE_ID: &str = "01HX0000000000000000000007";

const WHO_ID: &str = "01HX0000000000000000000008";
const BRANCH_IF_ID: &str = "01HX0000000000000000000009";
const ADMIN_STEP_ID: &str = "01HX0000000000000000000010";
const USER_STEP_ID: &str = "01HX0000000000000000000011";

/// **Test A — if-in-loop: `${loop_index}` is visible in BOTH the condition AND
/// the branch child's URL.**
///
/// Scenario shape:
/// ```yaml
/// loop (repeat: 2)
///   do:
///     - if  cond: ${loop_index} == "0"
///         then: GET /iter/${loop_index}   (LOOP_THEN_ID)
///         else: GET /iter/${loop_index}   (LOOP_ELSE_ID)
/// ```
///
/// - Iteration 0 (loop_index=0): cond true  → THEN branch → hits `/iter/0`
/// - Iteration 1 (loop_index=1): cond false → ELSE branch → hits `/iter/1`
///
/// Assertions:
/// 1. THEN step id has count > 0 (iteration 0 took `then`).
/// 2. ELSE step id has count > 0 (iteration 1 took `else`).
/// 3. wiremock received at least one request to `/iter/0` AND one to `/iter/1`.
///    This proves `${loop_index}` rendered as "0" and "1" in the child URL, NOT
///    as "" (which is what a dropped `loop_index → None` regression would produce,
///    making both iterations hit the un-stubbed path `/iter/`).
///
/// If `execute_steps` passes `None` instead of `loop_index` in the `Step::If`
/// arm, assertion 3 fails (and usually 1/2 too, since `/iter/` is not stubbed
/// and the 200-assert errors out, causing `run_scenario` to return
/// `AllVusFailed`).
#[tokio::test]
async fn if_in_loop_loop_index_visible_in_cond_and_url() {
    let server = MockServer::start().await;
    // Stub /iter/0 and /iter/1 (200). A dropped loop_index would hit /iter/ (not stubbed → 404).
    for i in 0..2 {
        Mock::given(method("GET"))
            .and(path(format!("/iter/{i}")))
            .respond_with(ResponseTemplate::new(200))
            .mount(&server)
            .await;
    }

    let base = server.uri();
    let yaml = format!(
        r#"
version: 1
name: if-in-loop
variables:
  base: "{base}"
steps:
  - id: "01HX0000000000000000000099"
    name: outer-loop
    type: loop
    repeat: 2
    do:
      - id: "{LOOP_IF_ID}"
        name: branch-on-index
        type: if
        cond: {{ left: "${{loop_index}}", op: eq, right: "0" }}
        then:
          - id: "{LOOP_THEN_ID}"
            name: iter-then
            type: http
            request: {{ method: GET, url: "{{{{base}}}}/iter/${{loop_index}}" }}
            assert: [ {{ status: 200 }} ]
        else:
          - id: "{LOOP_ELSE_ID}"
            name: iter-else
            type: http
            request: {{ method: GET, url: "{{{{base}}}}/iter/${{loop_index}}" }}
            assert: [ {{ status: 200 }} ]
"#
    );

    let scenario = Arc::new(Scenario::from_yaml(&yaml).expect("parses"));
    let (tx, mut rx) = mpsc::channel::<MetricFlush>(64);
    let plan = RunPlan {
        vus: 1,
        ramp_up: Duration::from_secs(0),
        // Long enough to complete at least one full loop (2 iters × ~1ms each).
        // Short enough not to slow CI: wiremock responds instantly.
        duration: Duration::from_millis(500),
        env: BTreeMap::new(),
        loop_breakdown_cap: 0,
        vu_offset: 0,
        data_bindings: vec![],
        http_timeout: Duration::from_secs(30),
        think_time: None,
        think_seed: None,
        target_rps: None,
        max_in_flight: None,
        stages: None,
        measure_phases: false,
        vu_stages: None,
        ramp_down: RampDown::Graceful,
        graceful_ramp_down: None,
    };
    let cancel = CancellationToken::new();
    let run = tokio::spawn(async move { run_scenario(scenario, plan, tx, cancel).await });

    let mut counts: HashMap<String, u64> = HashMap::new();
    while let Some(f) = rx.recv().await {
        for w in f.windows {
            *counts.entry(w.step_id).or_default() += w.count;
        }
    }
    run.await.expect("join").expect("run ok — all stubs 200");

    // 1 & 2: both branches were taken at least once.
    assert!(
        counts.get(LOOP_THEN_ID).copied().unwrap_or(0) > 0,
        "THEN branch (loop_index==0) must have run; counts={counts:?}"
    );
    assert!(
        counts.get(LOOP_ELSE_ID).copied().unwrap_or(0) > 0,
        "ELSE branch (loop_index==1) must have run; counts={counts:?}"
    );

    // 3: wiremock actually received requests to /iter/0 AND /iter/1 — proving
    //    ${loop_index} rendered to "0"/"1" in the child URL, not to "".
    let reqs = server.received_requests().await.unwrap();
    let paths: Vec<String> = reqs.iter().map(|r| r.url.path().to_string()).collect();
    assert!(
        paths.iter().any(|p| p == "/iter/0"),
        "/iter/0 never hit — loop_index was not rendered in the branch child URL; paths={paths:?}"
    );
    assert!(
        paths.iter().any(|p| p == "/iter/1"),
        "/iter/1 never hit — loop_index was not rendered in the branch child URL; paths={paths:?}"
    );
}

/// **Test B — extract → condition: a var extracted by an earlier http step is
/// visible to a later `if` condition in the same iteration.**
///
/// Scenario shape:
/// ```yaml
/// - GET /who   (extract `kind` from body via JSONPath $.kind)
/// - if  cond: {{kind}} == "admin"
///     then: GET /admin   (ADMIN_STEP_ID)
///     else: GET /user    (USER_STEP_ID)
/// ```
///
/// `/who` returns `{"kind":"admin"}` → `kind` is extracted → cond true → THEN (/admin) runs.
/// Assert ADMIN step ran, USER step did not.
#[tokio::test]
async fn extract_driven_condition_reads_live_iter_vars() {
    let server = MockServer::start().await;

    // /who returns a JSON body; we extract $.kind from it.
    Mock::given(method("GET"))
        .and(path("/who"))
        .respond_with(
            ResponseTemplate::new(200)
                .set_body_string(r#"{"kind":"admin"}"#)
                .insert_header("content-type", "application/json"),
        )
        .mount(&server)
        .await;

    Mock::given(method("GET"))
        .and(path("/admin"))
        .respond_with(ResponseTemplate::new(200))
        .mount(&server)
        .await;

    Mock::given(method("GET"))
        .and(path("/user"))
        .respond_with(ResponseTemplate::new(200))
        .mount(&server)
        .await;

    let base = server.uri();
    let yaml = format!(
        r#"
version: 1
name: extract-cond
variables:
  base: "{base}"
steps:
  - id: "{WHO_ID}"
    name: who
    type: http
    request:
      method: GET
      url: "{{{{base}}}}/who"
    assert:
      - status: 200
    extract:
      - var: kind
        from: body
        path: "$.kind"
  - id: "{BRANCH_IF_ID}"
    name: branch
    type: if
    cond: {{ left: "{{{{kind}}}}", op: eq, right: "admin" }}
    then:
      - id: "{ADMIN_STEP_ID}"
        name: admin-path
        type: http
        request: {{ method: GET, url: "{{{{base}}}}/admin" }}
        assert: [ {{ status: 200 }} ]
    else:
      - id: "{USER_STEP_ID}"
        name: user-path
        type: http
        request: {{ method: GET, url: "{{{{base}}}}/user" }}
        assert: [ {{ status: 200 }} ]
"#
    );

    let counts = run_and_count(&yaml).await;

    assert!(
        counts.get(ADMIN_STEP_ID).copied().unwrap_or(0) > 0,
        "admin branch must have run (kind=admin extracted → cond true); counts={counts:?}"
    );
    assert_eq!(
        counts.get(USER_STEP_ID),
        None,
        "user branch must NOT run when kind=admin; counts={counts:?}"
    );
}

// Test C (all/any group condition via scenario_yaml helper) is intentionally
// omitted. The `scenario_yaml` helper interpolates `cond: {cond}` as a single
// YAML flow-line — an `all:` / `any:` group requires a block-scalar nested list
// that cannot be cleanly inline-substituted on one line without escaping
// gymnastics. The `all`/`any` group evaluation logic is already exhaustively
// unit-tested in `crates/engine/src/condition.rs` (the `all_any_short_circuit_and_empty_groups`
// and `nested_tree_depth_two` tests). The coverage gap closed here (Test A / Test B)
// is the if-in-loop `loop_index` passthrough and the extract → condition
// live-vars path — both of which are integration-level concerns not covered by
// condition.rs unit tests.

// ── Slice 9d branch-metric tests ─────────────────────────────────────────────

/// The if-node id embedded in `scenario_yaml` helper.
const IF_ID: &str = "01HX0000000000000000000001";

/// Run the scenario for one VU / short window, return (if_id, branch) -> total decisions.
async fn run_and_branches(yaml: &str) -> HashMap<(String, String), u64> {
    let scenario = Arc::new(Scenario::from_yaml(yaml).expect("parses"));
    let (tx, mut rx) = mpsc::channel::<MetricFlush>(64);
    let plan = RunPlan {
        vus: 1,
        ramp_up: Duration::from_secs(0),
        duration: Duration::from_millis(400),
        env: BTreeMap::new(),
        loop_breakdown_cap: 0,
        vu_offset: 0,
        data_bindings: vec![],
        http_timeout: Duration::from_secs(30),
        think_time: None,
        think_seed: None,
        target_rps: None,
        max_in_flight: None,
        stages: None,
        measure_phases: false,
        vu_stages: None,
        ramp_down: RampDown::Graceful,
        graceful_ramp_down: None,
    };
    let cancel = CancellationToken::new();
    let run = tokio::spawn(async move { run_scenario(scenario, plan, tx, cancel).await });
    let mut branches: HashMap<(String, String), u64> = HashMap::new();
    while let Some(f) = rx.recv().await {
        for b in f.branch_stats {
            *branches.entry((b.step_id, b.branch)).or_default() += b.count;
        }
    }
    run.await.expect("join").expect("run ok");
    branches
}

#[tokio::test]
async fn branch_metrics_record_then_when_cond_true() {
    let server = server().await;
    // top cond always true ("x" eq "x"); elif cond never true.
    let cond = r#"{ left: "x", op: eq, right: "x" }"#;
    let elif_cond = r#"{ left: "x", op: eq, right: "y" }"#;
    let yaml = scenario_yaml(&server.uri(), cond, elif_cond);
    let b = run_and_branches(&yaml).await;
    let then: u64 = b
        .iter()
        .filter(|((id, br), _)| id == IF_ID && br == "then")
        .map(|(_, c)| *c)
        .sum();
    assert!(then > 0, "then branch decisions recorded");
    assert!(
        !b.keys()
            .any(|(id, br)| id == IF_ID && (br == "else" || br == "elif_0")),
        "only the then branch should be taken"
    );
}

#[tokio::test]
async fn branch_metrics_record_none_when_no_match_and_no_else() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/then"))
        .respond_with(ResponseTemplate::new(200))
        .mount(&server)
        .await;
    // if with only `then`, cond false, NO elif, NO else → "none".
    let base = server.uri();
    let yaml = format!(
        r#"
version: 1
name: nonebranch
variables:
  base: "{base}"
steps:
  - id: "{IF_ID}"
    name: branch
    type: if
    cond: {{ left: "1", op: eq, right: "2" }}
    then:
      - id: "{THEN_ID}"
        name: then-step
        type: http
        request: {{ method: GET, url: "{{{{base}}}}/then" }}
        assert: [ {{ status: 200 }} ]
"#
    );
    let b = run_and_branches(&yaml).await;
    let none: u64 = b
        .iter()
        .filter(|((id, br), _)| id == IF_ID && br == "none")
        .map(|(_, c)| *c)
        .sum();
    assert!(none > 0, "none branch (no match + no else) recorded");
    assert_eq!(
        b.keys()
            .filter(|(id, br)| id == IF_ID && br == "then")
            .count(),
        0,
        "then must not be recorded when cond is false"
    );
}

#[tokio::test]
async fn branch_metrics_record_elif_when_only_elif_true() {
    let server = server().await;
    // top false ("1" eq "2"), elif true ("a" eq "a") → only elif_0 taken.
    let cond = r#"{ left: "1", op: eq, right: "2" }"#;
    let elif_cond = r#"{ left: "a", op: eq, right: "a" }"#;
    let yaml = scenario_yaml(&server.uri(), cond, elif_cond);
    let b = run_and_branches(&yaml).await;
    let elif: u64 = b
        .iter()
        .filter(|((id, br), _)| id == IF_ID && br == "elif_0")
        .map(|(_, c)| *c)
        .sum();
    assert!(elif > 0, "elif_0 branch decisions recorded");
    assert!(
        !b.keys()
            .any(|(id, br)| id == IF_ID && (br == "then" || br == "else" || br == "none")),
        "only elif_0 branch should be taken"
    );
}

#[tokio::test]
async fn branch_metrics_record_else_when_all_false() {
    let server = server().await;
    // top false ("1" eq "2"), elif false ("a" eq "b") → else taken.
    let cond = r#"{ left: "1", op: eq, right: "2" }"#;
    let elif_cond = r#"{ left: "a", op: eq, right: "b" }"#;
    let yaml = scenario_yaml(&server.uri(), cond, elif_cond);
    let b = run_and_branches(&yaml).await;
    let els: u64 = b
        .iter()
        .filter(|((id, br), _)| id == IF_ID && br == "else")
        .map(|(_, c)| *c)
        .sum();
    assert!(els > 0, "else branch decisions recorded");
    assert!(
        !b.keys()
            .any(|(id, br)| id == IF_ID && (br == "then" || br == "elif_0" || br == "none")),
        "only else branch should be taken"
    );
}

// ── Slice 9c regression tests ────────────────────────────────────────────────

/// Step IDs used by the loop-in-if test. Crockford base32 safe (no I/L/O/U).
const LOOP_IN_IF_PING_ID: &str = "01HX00000000000000000000A3";

/// **Test D — loop-in-if: a `loop` nested inside an `if`'s THEN branch must
/// execute its body `repeat` times per if-pass.**
///
/// Scenario shape:
/// ```yaml
/// if  cond: 1 == 1   (always true)
///   then:
///     - loop repeat=3
///         do:
///           - GET /ping   (LOOP_IN_IF_PING_ID)
/// ```
///
/// Engine already supports this via the generic `Box::pin` recursion in both
/// `Step::Loop` and `Step::If` arms. This test guards the path that Slice 9c
/// first exposes via the UI authoring layer.
///
/// Assertion: the ping step count >= 3 (at least one full loop body triplet ran).
/// We do NOT assert `pings % 3 == 0` — per `crates/engine/CLAUDE.md`, a
/// window/deadline can land between loop body steps, so counts are not
/// guaranteed to be exact `repeat` multiples.
#[tokio::test]
async fn loop_in_if_then_repeats_body() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/ping"))
        .respond_with(ResponseTemplate::new(200))
        .mount(&server)
        .await;

    let base = server.uri();
    // if (1 == 1) { loop repeat=3 { GET /ping } }  — condition always true.
    let yaml = format!(
        r#"
version: 1
name: loop-in-if
variables:
  base: "{base}"
steps:
  - id: "01HX00000000000000000000A1"
    name: gate
    type: if
    cond: {{ left: "1", op: eq, right: "1" }}
    then:
      - id: "01HX00000000000000000000A2"
        name: rep
        type: loop
        repeat: 3
        do:
          - id: "{LOOP_IN_IF_PING_ID}"
            name: ping
            type: http
            request: {{ method: GET, url: "{{{{base}}}}/ping" }}
            assert: [ {{ status: 200 }} ]
"#
    );

    // run_and_count asserts errors == 0 internally and returns per-step counts.
    let counts = run_and_count(&yaml).await;
    let pings = counts.get(LOOP_IN_IF_PING_ID).copied().unwrap_or(0);
    assert!(
        pings >= 3,
        "nested loop body must run repeatedly (repeat=3) inside the if-then; got {pings}; counts={counts:?}"
    );
}
