use std::collections::BTreeMap;
use std::time::Duration;

use handicap_engine::scenario::Scenario;
use handicap_engine::trace::{StepKind, TraceOptions, trace_scenario};
use wiremock::matchers::{method, path, query_param};
use wiremock::{Mock, MockServer, ResponseTemplate};

#[tokio::test]
async fn trace_runs_parallel_branches_and_namespaces_outputs() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/a"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({"id": "AAA"})))
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/b"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({"id": "BBB"})))
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/combine"))
        .and(query_param("u", "AAA"))
        .and(query_param("f", "BBB"))
        .respond_with(ResponseTemplate::new(200))
        .mount(&server)
        .await;

    let mut env = BTreeMap::new();
    env.insert("BASE".to_string(), server.uri());

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
          - id: "01HX0000000000000000000011"
            name: ga
            type: http
            request: { method: GET, url: "${BASE}/a" }
            assert: []
            extract:
              - { var: id, from: body, path: "$.id" }
      - name: b
        steps:
          - id: "01HX0000000000000000000012"
            name: gb
            type: http
            request: { method: GET, url: "${BASE}/b" }
            assert: []
            extract:
              - { var: id, from: body, path: "$.id" }
  - id: "01HX0000000000000000000013"
    name: combine
    type: http
    request: { method: GET, url: "${BASE}/combine?u={{a.id}}&f={{b.id}}" }
    assert: []
"#;

    let sc = Scenario::from_yaml(yaml).unwrap();
    let opts = TraceOptions {
        env,
        max_requests: 50,
        max_wall: Duration::from_secs(10),
        apply_think_time: false,
    };
    let t = trace_scenario(&sc, &opts).await;

    // 3 http rows (2 branch leaves + combine); no decision row for parallel.
    let http_rows: Vec<_> = t
        .steps
        .iter()
        .filter(|s| s.kind == StepKind::Http)
        .collect();
    assert_eq!(
        http_rows.len(),
        3,
        "expected 3 http rows, got: {:?}",
        t.steps
            .iter()
            .map(|s| (&s.step_id, &s.kind))
            .collect::<Vec<_>>()
    );
    // The parallel node emits NO decision row of its own — total rows == http rows.
    // Guards against an accidental extra (e.g. a parallel decision row) that the
    // http-only filter above would not catch.
    assert_eq!(t.steps.len(), 3, "parallel emits no decision row");

    // combine row resolved both namespaced vars (returned 200, no unbound).
    let combine = t
        .steps
        .iter()
        .find(|s| s.step_id == "01HX0000000000000000000013")
        .unwrap();
    assert!(
        combine.unbound_vars.is_empty(),
        "namespaced vars must resolve in trace, unbound: {:?}",
        combine.unbound_vars
    );
    assert_eq!(combine.response.as_ref().unwrap().status, 200);

    // final_vars carries the namespaced outputs.
    assert_eq!(
        t.final_vars.get("a.id").map(String::as_str),
        Some("AAA"),
        "a.id not in final_vars: {:?}",
        t.final_vars
    );
    assert_eq!(
        t.final_vars.get("b.id").map(String::as_str),
        Some("BBB"),
        "b.id not in final_vars: {:?}",
        t.final_vars
    );
}
