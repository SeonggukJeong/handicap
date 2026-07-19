use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::Duration;

use handicap_engine::runner::{MetricFlush, RampDown, RunPlan, run_scenario};
use handicap_engine::scenario::Scenario;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;
use wiremock::matchers::{method, path, query_param};
use wiremock::{Mock, MockServer, ResponseTemplate};

fn plan(base: &str, secs: u64) -> RunPlan {
    let mut env = BTreeMap::new();
    env.insert("BASE".to_string(), base.to_string());
    RunPlan {
        vus: 1,
        ramp_up: Duration::from_secs(0),
        duration: Duration::from_secs(secs),
        env,
        loop_breakdown_cap: 256,
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
    }
}

async fn drain(mut rx: mpsc::Receiver<MetricFlush>) -> Vec<MetricFlush> {
    let mut v = Vec::new();
    while let Some(f) = rx.recv().await {
        v.push(f);
    }
    v
}

#[tokio::test]
async fn parallel_branches_run_concurrently() {
    let server = MockServer::start().await;
    // Each branch delays 300 ms. SEQUENTIAL would run one iteration in 600 ms, so a
    // 2-second run starts at most 4 iterations → /a hit ≤ 4 (and /b ≤ 4). CONCURRENT
    // runs one iteration in ~300 ms → ~6-7 iterations → ≥ 6 hits per path. The ≥ 5
    // threshold sits firmly in the gap: a sequential regression caps at 4 and fails,
    // while the concurrent impl clears 5 with margin (wider separation than a bare 2×).
    Mock::given(method("GET"))
        .and(path("/a"))
        .respond_with(ResponseTemplate::new(200).set_delay(Duration::from_millis(300)))
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/b"))
        .respond_with(ResponseTemplate::new(200).set_delay(Duration::from_millis(300)))
        .mount(&server)
        .await;
    // BASE env var is injected via plan(); ${BASE} is the engine env-template syntax.
    let yaml = r#"
version: 1
name: par
steps:
  - id: "01HX0000000000000000000010"
    name: fan
    type: parallel
    branches:
      - name: a
        steps:
          - { id: "01HX0000000000000000000011", name: ga, type: http, request: { method: GET, url: "${BASE}/a" }, assert: [] }
      - name: b
        steps:
          - { id: "01HX0000000000000000000012", name: gb, type: http, request: { method: GET, url: "${BASE}/b" }, assert: [] }
"#;
    let sc = Arc::new(Scenario::from_yaml(yaml).unwrap());
    let (tx, rx) = mpsc::channel(64);
    run_scenario(sc, plan(&server.uri(), 2), tx, CancellationToken::new())
        .await
        .unwrap();
    let _ = drain(rx).await;
    let reqs = server.received_requests().await.unwrap();
    let a_count = reqs.iter().filter(|r| r.url.path() == "/a").count();
    let b_count = reqs.iter().filter(|r| r.url.path() == "/b").count();
    assert!(
        a_count >= 5,
        "concurrent: /a should be hit ≥5 times in 2s with 300ms delay (seq caps at 4), got {a_count}"
    );
    assert!(
        b_count >= 5,
        "concurrent: /b should be hit ≥5 times in 2s with 300ms delay (seq caps at 4), got {b_count}"
    );
}

#[tokio::test]
async fn parallel_namespaces_branch_outputs_key_origin() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/a"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({"id": "AAA"})))
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/b"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({"id": "SEED"})))
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/combine"))
        .and(query_param("u", "AAA"))
        .and(query_param("f", "SEED"))
        .respond_with(ResponseTemplate::new(200))
        .mount(&server)
        .await;
    // Branch a extracts id=AAA, branch b extracts id=SEED (scenario variable id=SEED
    // is the entry snapshot — branch b re-extracts the same value it started with).
    // After the parallel node: {{a.id}}=AAA (key-origin), {{b.id}}=SEED (key-origin).
    // The "id" scenario variable must NOT be clobbered by either branch's extract.
    let yaml = r#"
version: 1
name: par
variables:
  id: SEED
steps:
  - id: "01HX0000000000000000000010"
    name: fan
    type: parallel
    branches:
      - name: a
        steps:
          - { id: "01HX0000000000000000000011", name: ga, type: http, request: { method: GET, url: "${BASE}/a" }, assert: [], extract: [ { var: id, from: body, path: "$.id" } ] }
      - name: b
        steps:
          - { id: "01HX0000000000000000000012", name: gb, type: http, request: { method: GET, url: "${BASE}/b" }, assert: [], extract: [ { var: id, from: body, path: "$.id" } ] }
  - id: "01HX0000000000000000000013"
    name: combine
    type: http
    request: { method: GET, url: "${BASE}/combine?u={{a.id}}&f={{b.id}}" }
    assert: []
"#;
    let sc = Arc::new(Scenario::from_yaml(yaml).unwrap());
    let (tx, rx) = mpsc::channel(64);
    run_scenario(sc, plan(&server.uri(), 1), tx, CancellationToken::new())
        .await
        .unwrap();
    let _ = drain(rx).await;
    let reqs = server.received_requests().await.unwrap();
    assert!(
        reqs.iter().any(|r| r.url.path() == "/combine"
            && r.url.query().unwrap_or("").contains("u=AAA")
            && r.url.query().unwrap_or("").contains("f=SEED")),
        "downstream must see a.id=AAA and b.id=SEED (key-origin namespace)"
    );
}

#[tokio::test]
async fn parallel_branch_http_failure_does_not_kill_vu() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/ok"))
        .respond_with(ResponseTemplate::new(200))
        .mount(&server)
        .await;
    // Branch b points at a refused port; execute_step returns Ok(ExecOutcome{error:Some(…)})
    // so the Parallel arm's flow? never sees an Err — connection failures stay in metrics.
    let yaml = r#"
version: 1
name: par
steps:
  - id: "01HX0000000000000000000010"
    name: fan
    type: parallel
    branches:
      - name: a
        steps:
          - { id: "01HX0000000000000000000011", name: ga, type: http, request: { method: GET, url: "${BASE}/ok" }, assert: [] }
      - name: b
        steps:
          - { id: "01HX0000000000000000000012", name: gb, type: http, request: { method: GET, url: "http://127.0.0.1:1/dead" }, assert: [] }
"#;
    let sc = Arc::new(Scenario::from_yaml(yaml).unwrap());
    let (tx, rx) = mpsc::channel(64);
    run_scenario(sc, plan(&server.uri(), 1), tx, CancellationToken::new())
        .await
        .expect("connection error in a branch must not fail the run");
    let _ = drain(rx).await;
    assert!(
        server
            .received_requests()
            .await
            .unwrap()
            .iter()
            .any(|r| r.url.path() == "/ok")
    );
}

#[tokio::test]
async fn parallel_records_group_latency_sample() {
    let server = MockServer::start().await;
    // Two branches, each ~300 ms. The block's wall-clock ≈ max(300, 300) = ~300 ms,
    // recorded once per clean iteration under the parallel node's id.
    Mock::given(method("GET"))
        .and(path("/a"))
        .respond_with(ResponseTemplate::new(200).set_delay(Duration::from_millis(300)))
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/b"))
        .respond_with(ResponseTemplate::new(200).set_delay(Duration::from_millis(300)))
        .mount(&server)
        .await;
    let yaml = r#"
version: 1
name: par
steps:
  - id: "01HX0000000000000000000010"
    name: fan
    type: parallel
    branches:
      - name: a
        steps:
          - { id: "01HX0000000000000000000011", name: ga, type: http, request: { method: GET, url: "${BASE}/a" }, assert: [] }
      - name: b
        steps:
          - { id: "01HX0000000000000000000012", name: gb, type: http, request: { method: GET, url: "${BASE}/b" }, assert: [] }
"#;
    let sc = Arc::new(Scenario::from_yaml(yaml).unwrap());
    let (tx, rx) = mpsc::channel(64);
    run_scenario(sc, plan(&server.uri(), 2), tx, CancellationToken::new())
        .await
        .unwrap();
    let flushes = drain(rx).await;

    let mut page_count = 0u64;
    let mut page_max_us = 0u64;
    let mut branch_counts: std::collections::BTreeMap<String, u64> = Default::default();
    for f in &flushes {
        for g in &f.group_stats {
            assert_eq!(g.step_id, "01HX0000000000000000000010");
            if g.branch.is_empty() {
                page_count += g.count;
                page_max_us = page_max_us.max(g.histogram.max());
            } else {
                *branch_counts.entry(g.branch.clone()).or_default() += g.count;
            }
        }
    }
    assert!(
        page_count >= 1,
        "at least one clean page-load sample, got {page_count}"
    );
    assert!(
        page_max_us >= 250_000,
        "page-load ~= 300ms (max not sum), got {page_max_us}µs"
    );
    assert_eq!(
        branch_counts.keys().cloned().collect::<Vec<_>>(),
        vec!["a".to_string(), "b".to_string()],
        "both branch labels recorded"
    );
    assert_eq!(
        branch_counts["a"], page_count,
        "branch a fires once per clean page"
    );
    assert_eq!(
        branch_counts["b"], page_count,
        "branch b fires once per clean page"
    );
}

#[tokio::test]
async fn parallel_branch_nested_loop_extract_reaches_downstream_request() {
    // task-1-brief acceptance (load path): a branch's extract nested inside a
    // loop/if is NOT merged if output_var_names() only walks top-level Http steps
    // (the pre-fix bug). Assert the downstream request actually carries the
    // extracted value — the wire-level proof, not just that the run completes.
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/auth"))
        .respond_with(
            ResponseTemplate::new(200).set_body_json(serde_json::json!({"token": "TOK123"})),
        )
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/use"))
        .and(query_param("t", "TOK123"))
        .respond_with(ResponseTemplate::new(200))
        .mount(&server)
        .await;
    let yaml = r#"
version: 1
name: par
steps:
  - id: "01HX0000000000000000000010"
    name: fan
    type: parallel
    branches:
      - name: auth
        steps:
          - id: "01HX0000000000000000000014"
            name: lp
            type: loop
            repeat: 1
            do:
              - { id: "01HX0000000000000000000011", name: ga, type: http, request: { method: GET, url: "${BASE}/auth" }, assert: [], extract: [ { var: token, from: body, path: "$.token" } ] }
  - id: "01HX0000000000000000000013"
    name: use
    type: http
    request: { method: GET, url: "${BASE}/use?t={{auth.token}}" }
    assert: []
"#;
    let sc = Arc::new(Scenario::from_yaml(yaml).unwrap());
    let (tx, rx) = mpsc::channel(64);
    run_scenario(sc, plan(&server.uri(), 1), tx, CancellationToken::new())
        .await
        .unwrap();
    let _ = drain(rx).await;
    let reqs = server.received_requests().await.unwrap();
    assert!(
        reqs.iter()
            .any(|r| r.url.path() == "/use" && r.url.query().unwrap_or("").contains("t=TOK123")),
        "downstream request must carry auth.token extracted inside the branch's nested loop, got: {:?}",
        reqs.iter().map(|r| r.url.to_string()).collect::<Vec<_>>()
    );
}

#[tokio::test]
async fn flat_scenario_emits_no_group_stats() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/a"))
        .respond_with(ResponseTemplate::new(200))
        .mount(&server)
        .await;
    let yaml = r#"
version: 1
name: flat
steps:
  - { id: "01HX0000000000000000000011", name: ga, type: http, request: { method: GET, url: "${BASE}/a" }, assert: [] }
"#;
    let sc = Arc::new(Scenario::from_yaml(yaml).unwrap());
    let (tx, rx) = mpsc::channel(64);
    run_scenario(sc, plan(&server.uri(), 1), tx, CancellationToken::new())
        .await
        .unwrap();
    let flushes = drain(rx).await;
    assert!(
        flushes.iter().all(|f| f.group_stats.is_empty()),
        "non-parallel scenario emits no group stats (byte-identical wire)"
    );
}
