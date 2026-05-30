//! Data binding end-to-end against wiremock: per_vu makes each VU send a
//! distinct dataset value; iter_sequential walks the dataset across iterations;
//! iter_random reaches multiple dataset values across iterations.
use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::Duration;

use handicap_engine::{BindingPolicy, DataSet, MetricFlush, RunPlan, Scenario, run_scenario};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;
use wiremock::matchers::{method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

fn row(user: &str) -> BTreeMap<String, String> {
    let mut m = BTreeMap::new();
    m.insert("user".to_string(), user.to_string());
    m
}

#[tokio::test]
async fn per_vu_sends_distinct_dataset_values() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/hit"))
        .respond_with(ResponseTemplate::new(200))
        .mount(&server)
        .await;

    let yaml = format!(
        r#"
version: 1
name: per-vu
variables:
  base: "{}"
steps:
  - id: "01HX0000000000000000000020"
    name: hit
    type: http
    request:
      method: GET
      url: "{{{{base}}}}/hit?u={{{{user}}}}"
"#,
        server.uri()
    );
    let scenario: Scenario = serde_yaml::from_str(&yaml).unwrap();

    let ds = DataSet {
        policy: BindingPolicy::PerVu,
        seed: 0,
        rows: vec![row("alice"), row("bob")],
    };
    let plan = RunPlan {
        vus: 2,
        ramp_up: Duration::from_secs(0),
        duration: Duration::from_secs(2),
        env: BTreeMap::new(),
        loop_breakdown_cap: 0,
        data_binding: Some(Arc::new(ds)),
    };

    let (tx, mut rx) = mpsc::channel::<MetricFlush>(16);
    let drain = tokio::spawn(async move { while rx.recv().await.is_some() {} });
    run_scenario(Arc::new(scenario), plan, tx, CancellationToken::new())
        .await
        .unwrap();
    drain.await.unwrap();

    let reqs = server.received_requests().await.unwrap();
    let queries: Vec<String> = reqs
        .iter()
        .map(|r| r.url.query().unwrap_or("").to_string())
        .collect();
    assert!(
        queries.iter().any(|q| q.contains("u=alice")),
        "alice missing: {queries:?}"
    );
    assert!(
        queries.iter().any(|q| q.contains("u=bob")),
        "bob missing: {queries:?}"
    );
}

#[tokio::test]
async fn iter_sequential_walks_the_dataset() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/hit"))
        .respond_with(ResponseTemplate::new(200).set_delay(Duration::from_millis(2)))
        .mount(&server)
        .await;

    let yaml = format!(
        r#"
version: 1
name: iter-seq
variables:
  base: "{}"
steps:
  - id: "01HX0000000000000000000021"
    name: hit
    type: http
    request:
      method: GET
      url: "{{{{base}}}}/hit?u={{{{user}}}}"
"#,
        server.uri()
    );
    let scenario: Scenario = serde_yaml::from_str(&yaml).unwrap();

    let ds = DataSet {
        policy: BindingPolicy::IterSequential,
        seed: 0,
        rows: vec![row("a0"), row("a1"), row("a2")],
    };
    let plan = RunPlan {
        vus: 1,
        ramp_up: Duration::from_secs(0),
        duration: Duration::from_secs(1),
        env: BTreeMap::new(),
        loop_breakdown_cap: 0,
        data_binding: Some(Arc::new(ds)),
    };

    let (tx, mut rx) = mpsc::channel::<MetricFlush>(16);
    let drain = tokio::spawn(async move { while rx.recv().await.is_some() {} });
    run_scenario(Arc::new(scenario), plan, tx, CancellationToken::new())
        .await
        .unwrap();
    drain.await.unwrap();

    let reqs = server.received_requests().await.unwrap();
    let queries: Vec<String> = reqs
        .iter()
        .map(|r| r.url.query().unwrap_or("").to_string())
        .collect();
    for v in ["u=a0", "u=a1", "u=a2"] {
        assert!(
            queries.iter().any(|q| q.contains(v)),
            "{v} missing: {queries:?}"
        );
    }
}

#[tokio::test]
async fn iter_random_reaches_multiple_dataset_values() {
    use std::collections::HashSet;

    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/hit"))
        .respond_with(ResponseTemplate::new(200).set_delay(Duration::from_millis(1)))
        .mount(&server)
        .await;

    let yaml = format!(
        r#"
version: 1
name: iter-random
variables:
  base: "{}"
steps:
  - id: "01HX0000000000000000000022"
    name: hit
    type: http
    request:
      method: GET
      url: "{{{{base}}}}/hit?u={{{{user}}}}"
"#,
        server.uri()
    );
    let scenario: Scenario = serde_yaml::from_str(&yaml).unwrap();

    let ds = DataSet {
        policy: BindingPolicy::IterRandom,
        seed: 12345,
        rows: (0..10).map(|i| row(&format!("u{i}"))).collect(),
    };
    let plan = RunPlan {
        vus: 1,
        ramp_up: Duration::from_secs(0),
        duration: Duration::from_secs(2),
        env: BTreeMap::new(),
        loop_breakdown_cap: 0,
        data_binding: Some(Arc::new(ds)),
    };

    let (tx, mut rx) = mpsc::channel::<MetricFlush>(16);
    let drain = tokio::spawn(async move { while rx.recv().await.is_some() {} });
    run_scenario(Arc::new(scenario), plan, tx, CancellationToken::new())
        .await
        .unwrap();
    drain.await.unwrap();

    let reqs = server.received_requests().await.unwrap();
    let seen: HashSet<String> = reqs
        .iter()
        .map(|r| r.url.query().unwrap_or("").to_string())
        .collect();
    assert!(
        seen.len() >= 2,
        "IterRandom should reach >= 2 distinct query strings over 2s; got: {seen:?}"
    );
}
