//! Multi-dataset binding: `RunPlan.data_bindings` is a `Vec<Arc<DataSet>>`, and
//! every binding is injected into a VU's iteration vars (declared order). Two
//! differently-sized/policied datasets both reach the wire; a unique binding
//! whose slice is exhausted stops the VU (break-on-first-None, spec §7).
use std::collections::{BTreeMap, HashSet};
use std::sync::Arc;
use std::time::Duration;

use handicap_engine::{
    BindingPolicy, DataSet, MetricFlush, RampDown, RunPlan, Scenario, run_scenario,
};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;
use wiremock::matchers::{method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

fn row(key: &str, val: &str) -> BTreeMap<String, String> {
    let mut m = BTreeMap::new();
    m.insert(key.to_string(), val.to_string());
    m
}

fn plan_with(bindings: Vec<Arc<DataSet>>, vus: u32, secs: u64) -> RunPlan {
    RunPlan {
        vus,
        ramp_up: Duration::from_secs(0),
        duration: Duration::from_secs(secs),
        env: BTreeMap::new(),
        loop_breakdown_cap: 0,
        vu_offset: 0,
        data_bindings: bindings,
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
    }
}

/// Two datasets with DIFFERENT policies (per_vu + iter_sequential) and DIFFERENT
/// row counts: both bound variables (`user`, `tok`) must appear together in the
/// SAME request query string — proving N>1 bindings inject simultaneously.
#[tokio::test]
async fn two_bindings_both_inject_into_each_request() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/hit"))
        .respond_with(ResponseTemplate::new(200).set_delay(Duration::from_millis(2)))
        .mount(&server)
        .await;

    let yaml = format!(
        r#"
version: 1
name: two-bindings
variables:
  base: "{}"
steps:
  - id: "01HX0000000000000000000030"
    name: hit
    type: http
    request:
      method: GET
      url: "{{{{base}}}}/hit?u={{{{user}}}}&t={{{{tok}}}}"
"#,
        server.uri()
    );
    let scenario: Scenario = serde_yaml::from_str(&yaml).unwrap();

    // ds_a: per_vu, 2 rows (user). ds_b: iter_sequential, 3 rows (tok).
    let ds_a = DataSet {
        policy: BindingPolicy::PerVu,
        seed: 0,
        rows: vec![row("user", "alice"), row("user", "bob")],
    };
    let ds_b = DataSet {
        policy: BindingPolicy::IterSequential,
        seed: 0,
        rows: vec![row("tok", "t0"), row("tok", "t1"), row("tok", "t2")],
    };
    let plan = plan_with(vec![Arc::new(ds_a), Arc::new(ds_b)], 2, 2);

    let (tx, mut rx) = mpsc::channel::<MetricFlush>(16);
    let drain = tokio::spawn(async move { while rx.recv().await.is_some() {} });
    run_scenario(Arc::new(scenario), plan, tx, CancellationToken::new())
        .await
        .unwrap();
    drain.await.unwrap();

    let reqs = server.received_requests().await.unwrap();
    assert!(!reqs.is_empty(), "no requests reached the server");
    let queries: Vec<String> = reqs
        .iter()
        .map(|r| r.url.query().unwrap_or("").to_string())
        .collect();
    // Every request must carry BOTH variables (both bindings always inject).
    for q in &queries {
        assert!(
            q.contains("u=") && q.contains("t="),
            "request missing one of the two bound vars: {q:?}"
        );
        // Neither token must be left unresolved ({{user}}/{{tok}} would mean the
        // binding never injected).
        assert!(
            !q.contains("%7B%7B") && !q.contains("{{"),
            "unresolved template token in query: {q:?}"
        );
    }
    // Both ds_a values (per_vu across 2 VUs) reach the wire.
    assert!(
        queries.iter().any(|q| q.contains("u=alice")),
        "ds_a alice missing: {queries:?}"
    );
    assert!(
        queries.iter().any(|q| q.contains("u=bob")),
        "ds_a bob missing: {queries:?}"
    );
    // ds_b iter_sequential walks all 3 tok values across iterations.
    for v in ["t=t0", "t=t1", "t=t2"] {
        assert!(
            queries.iter().any(|q| q.contains(v)),
            "ds_b {v} missing: {queries:?}"
        );
    }
}

/// A `unique` binding bounds the total request count to its row count: with a
/// single VU and a 2-row unique dataset alongside a non-unique one, exactly 2
/// requests go out, then the VU stops (break-on-first-None). Both vars inject on
/// the requests that DO go out.
#[tokio::test]
async fn unique_binding_bounds_requests_to_row_count() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/hit"))
        .respond_with(ResponseTemplate::new(200).set_delay(Duration::from_millis(2)))
        .mount(&server)
        .await;

    let yaml = format!(
        r#"
version: 1
name: unique-bound
variables:
  base: "{}"
steps:
  - id: "01HX0000000000000000000031"
    name: hit
    type: http
    request:
      method: GET
      url: "{{{{base}}}}/hit?u={{{{user}}}}&t={{{{tok}}}}"
"#,
        server.uri()
    );
    let scenario: Scenario = serde_yaml::from_str(&yaml).unwrap();

    // ds_a: per_vu (always Some). ds_b: unique with only 2 rows → after 2
    // iterations it returns None and the VU stops.
    let ds_a = DataSet {
        policy: BindingPolicy::PerVu,
        seed: 0,
        rows: vec![row("user", "alice")],
    };
    let ds_b = DataSet {
        policy: BindingPolicy::Unique,
        seed: 0,
        rows: vec![row("tok", "uniq0"), row("tok", "uniq1")],
    };
    // Long duration; the unique exhaustion (not the clock) must terminate work.
    let plan = plan_with(vec![Arc::new(ds_a), Arc::new(ds_b)], 1, 5);

    let (tx, mut rx) = mpsc::channel::<MetricFlush>(16);
    let drain = tokio::spawn(async move { while rx.recv().await.is_some() {} });
    run_scenario(Arc::new(scenario), plan, tx, CancellationToken::new())
        .await
        .unwrap();
    drain.await.unwrap();

    let reqs = server.received_requests().await.unwrap();
    assert_eq!(
        reqs.len(),
        2,
        "unique 2-row slice must bound the VU to exactly 2 requests (got {})",
        reqs.len()
    );
    let toks: HashSet<String> = reqs
        .iter()
        .map(|r| r.url.query().unwrap_or("").to_string())
        .collect();
    // Both unique tokens consumed exactly once, and the non-unique var injected too.
    for q in &toks {
        assert!(q.contains("u=alice"), "ds_a var missing on request: {q:?}");
    }
    assert!(
        toks.iter().any(|q| q.contains("t=uniq0")),
        "uniq0 missing: {toks:?}"
    );
    assert!(
        toks.iter().any(|q| q.contains("t=uniq1")),
        "uniq1 missing: {toks:?}"
    );
}
