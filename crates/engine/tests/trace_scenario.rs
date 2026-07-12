use std::collections::BTreeMap;
use std::time::Duration;

use handicap_engine::{Scenario, StepKind, TraceOptions, trace_scenario};
use wiremock::matchers::{method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

fn opts(env: BTreeMap<String, String>, max_requests: u32) -> TraceOptions {
    TraceOptions {
        env,
        max_requests,
        max_wall: Duration::from_secs(120),
        apply_think_time: false,
    }
}

#[tokio::test]
async fn flat_http_pass_captures_each_step_in_order() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/a"))
        .respond_with(ResponseTemplate::new(200).set_body_string("A"))
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/b"))
        .respond_with(ResponseTemplate::new(204))
        .mount(&server)
        .await;

    let yaml = format!(
        r#"
version: 1
name: flat
steps:
  - type: http
    id: 01HX0000000000000000000010
    name: a
    request: {{ method: GET, url: "{base}/a" }}
  - type: http
    id: 01HX0000000000000000000011
    name: b
    request: {{ method: GET, url: "{base}/b" }}
"#,
        base = server.uri()
    );
    let scenario = Scenario::from_yaml(&yaml).unwrap();
    let trace = trace_scenario(&scenario, &opts(BTreeMap::new(), 50)).await;

    assert!(trace.ok, "{:?}", trace);
    assert!(!trace.truncated);
    assert_eq!(trace.steps.len(), 2);
    assert_eq!(trace.steps[0].step_id, "01HX0000000000000000000010");
    assert_eq!(trace.steps[0].response.as_ref().unwrap().status, 200);
    assert_eq!(trace.steps[1].response.as_ref().unwrap().status, 204);
}

#[tokio::test]
async fn loop_children_carry_loop_index() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/x"))
        .respond_with(ResponseTemplate::new(200))
        .mount(&server)
        .await;

    let yaml = format!(
        r#"
version: 1
name: loopy
steps:
  - type: loop
    id: 01HX0000000000000000000020
    name: rep
    repeat: 3
    do:
      - type: http
        id: 01HX0000000000000000000021
        name: x
        request: {{ method: GET, url: "{base}/x" }}
"#,
        base = server.uri()
    );
    let scenario = Scenario::from_yaml(&yaml).unwrap();
    let trace = trace_scenario(&scenario, &opts(BTreeMap::new(), 50)).await;

    // No loop container row; 3 http rows with loop_index 0,1,2.
    assert_eq!(trace.steps.len(), 3);
    let idxs: Vec<Option<u32>> = trace.steps.iter().map(|s| s.loop_index).collect();
    assert_eq!(idxs, vec![Some(0), Some(1), Some(2)]);
}

#[tokio::test]
async fn if_emits_decision_row_and_runs_taken_branch() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/then"))
        .respond_with(ResponseTemplate::new(200))
        .mount(&server)
        .await;

    let yaml = format!(
        r#"
version: 1
name: branch
variables: {{ go: "yes" }}
steps:
  - type: if
    id: 01HX0000000000000000000030
    name: maybe
    cond: {{ left: "{{{{go}}}}", op: eq, right: "yes" }}
    then:
      - type: http
        id: 01HX0000000000000000000031
        name: t
        request: {{ method: GET, url: "{base}/then" }}
"#,
        base = server.uri()
    );
    let scenario = Scenario::from_yaml(&yaml).unwrap();
    let trace = trace_scenario(&scenario, &opts(BTreeMap::new(), 50)).await;

    assert_eq!(trace.steps.len(), 2);
    assert_eq!(trace.steps[0].kind, StepKind::If);
    assert_eq!(trace.steps[0].branch.as_deref(), Some("then"));
    assert!(trace.steps[0].request.is_none());
    assert_eq!(trace.steps[1].step_id, "01HX0000000000000000000031");
}

#[tokio::test]
async fn max_requests_truncates() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/x"))
        .respond_with(ResponseTemplate::new(200))
        .mount(&server)
        .await;

    let yaml = format!(
        r#"
version: 1
name: big
steps:
  - type: loop
    id: 01HX0000000000000000000040
    name: rep
    repeat: 10
    do:
      - type: http
        id: 01HX0000000000000000000041
        name: x
        request: {{ method: GET, url: "{base}/x" }}
"#,
        base = server.uri()
    );
    let scenario = Scenario::from_yaml(&yaml).unwrap();
    let trace = trace_scenario(&scenario, &opts(BTreeMap::new(), 4)).await;

    assert!(trace.truncated);
    assert_eq!(trace.steps.len(), 4); // stopped at the cap
}

#[tokio::test]
async fn unbound_env_var_is_reported_not_fatal() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/p"))
        .respond_with(ResponseTemplate::new(200))
        .mount(&server)
        .await;

    // URL host from server, but an unbound ${MISSING} in the query.
    let yaml = format!(
        r#"
version: 1
name: unbound
steps:
  - type: http
    id: 01HX0000000000000000000050
    name: p
    request: {{ method: GET, url: "{base}/p?u=${{MISSING}}" }}
"#,
        base = server.uri()
    );
    let scenario = Scenario::from_yaml(&yaml).unwrap();
    let trace = trace_scenario(&scenario, &opts(BTreeMap::new(), 50)).await;

    assert!(
        trace.ok,
        "lenient render must not fail the run: {:?}",
        trace
    );
    assert_eq!(trace.steps[0].unbound_vars, vec!["MISSING".to_string()]);
}

#[tokio::test]
async fn if_condition_unbound_vars_surface_on_decision_row() {
    // An unbound var referenced ONLY inside the if/elif conditions (never in a
    // request) must still be reported on the if decision row's `unbound_vars` —
    // otherwise "wrong branch because a condition var was unbound" is invisible.
    // No HTTP server needed: cond is false (unbound -> empty != "yes"), the elif
    // is false too, else is empty -> branch "none", no leaf executes.
    let yaml = r#"
version: 1
name: condunbound
steps:
  - type: if
    id: 01HX0000000000000000000060
    name: maybe
    cond: { left: "{{missing_cond}}", op: eq, right: "yes" }
    elif:
      - cond: { left: "${MISSING_ENV}", op: eq, right: "x" }
        then: []
    then: []
"#;
    let scenario = Scenario::from_yaml(yaml).unwrap();
    let trace = trace_scenario(&scenario, &opts(BTreeMap::new(), 50)).await;

    assert_eq!(trace.steps.len(), 1);
    assert_eq!(trace.steps[0].kind, handicap_engine::StepKind::If);
    assert_eq!(trace.steps[0].branch.as_deref(), Some("none"));
    assert!(trace.steps[0].request.is_none());
    // Both the primary cond's {{missing_cond}} and the elif cond's ${MISSING_ENV}
    // are surfaced (order-preserving: cond first, then elif).
    assert_eq!(
        trace.steps[0].unbound_vars,
        vec!["missing_cond".to_string(), "MISSING_ENV".to_string()]
    );
}

#[tokio::test]
async fn trace_does_not_sleep_when_apply_think_time_false() {
    let server = wiremock::MockServer::start().await;
    wiremock::Mock::given(wiremock::matchers::method("GET"))
        .respond_with(wiremock::ResponseTemplate::new(200))
        .mount(&server)
        .await;
    let yaml = format!(
        "version: 1\nname: t\nsteps:\n  - type: http\n    id: s\n    name: s\n    request:\n      method: GET\n      url: {}/\n    think_time:\n      min_ms: 5000\n      max_ms: 5000\n",
        server.uri()
    );
    let scenario = handicap_engine::Scenario::from_yaml(&yaml).unwrap();
    let opts = handicap_engine::TraceOptions {
        env: Default::default(),
        max_requests: 50,
        max_wall: std::time::Duration::from_secs(120),
        apply_think_time: false,
    };
    let start = std::time::Instant::now();
    let trace = handicap_engine::trace_scenario(&scenario, &opts).await;
    assert!(trace.ok);
    assert!(
        start.elapsed() < std::time::Duration::from_secs(1),
        "must not sleep the 5s think time"
    );
}

#[tokio::test]
async fn trace_sleeps_when_apply_think_time_true() {
    let server = wiremock::MockServer::start().await;
    wiremock::Mock::given(wiremock::matchers::method("GET"))
        .respond_with(wiremock::ResponseTemplate::new(200))
        .mount(&server)
        .await;
    let yaml = format!(
        "version: 1\nname: t\nsteps:\n  - type: http\n    id: s\n    name: s\n    request:\n      method: GET\n      url: {}/\n    think_time:\n      min_ms: 300\n      max_ms: 300\n",
        server.uri()
    );
    let scenario = handicap_engine::Scenario::from_yaml(&yaml).unwrap();
    let opts = handicap_engine::TraceOptions {
        env: Default::default(),
        max_requests: 50,
        max_wall: std::time::Duration::from_secs(120),
        apply_think_time: true,
    };
    let start = std::time::Instant::now();
    handicap_engine::trace_scenario(&scenario, &opts).await;
    assert!(
        start.elapsed() >= std::time::Duration::from_millis(300),
        "should honor 300ms think time"
    );
}

#[tokio::test]
async fn trace_applies_scenario_default_think_only_when_enabled() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/a"))
        .respond_with(ResponseTemplate::new(200))
        .mount(&server)
        .await;
    let yaml = format!(
        r#"
version: 1
name: d
default_think_time:
  min_ms: 300
  max_ms: 300
steps:
  - type: http
    id: 01HX0000000000000000000010
    name: a
    request: {{ method: GET, url: "{base}/a" }}
"#,
        base = server.uri()
    );
    let scenario = Scenario::from_yaml(&yaml).unwrap();

    // apply_think_time=false(기본) → 상속값도 재우지 않는다(현행 게이트 유지).
    let fast = trace_scenario(&scenario, &opts(BTreeMap::new(), 10)).await;
    assert!(fast.ok, "fast trace failed: {:?}", fast.error);
    assert!(fast.total_ms < 300, "fast.total_ms={}", fast.total_ms);

    // apply_think_time=true → 스텝이 상속한 300ms를 실제로 잔다.
    let mut o = opts(BTreeMap::new(), 10);
    o.apply_think_time = true;
    let slow = trace_scenario(&scenario, &o).await;
    assert!(slow.ok, "slow trace failed: {:?}", slow.error);
    assert!(slow.total_ms >= 300, "slow.total_ms={}", slow.total_ms);
}

#[tokio::test]
async fn trace_parallel_branch_ignores_scenario_default_think() {
    // 최종 리뷰 S2: trace.rs의 Parallel arm이 분기 재귀에 `None`을 넘기는 규칙(runner와
    // 쌍둥이 — spec R4)에 대한 테스트가 없었다. 사이징 헬퍼(SlotSizingHelper/VuSizingHelper)가
    // `apply_think_time: true`로 test-run trace를 발사해 `total_ms`를 측정 hold 앵커로 쓰므로,
    // 이 배제가 회귀하면 (분기 스텝 수 × 기본값)만큼 hold가 조용히 부풀어 슬롯/VU
    // 과대추천으로 이어진다(부하 divergence) — 그런데 지금은 아무 테스트도 안 잡는다.
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/a"))
        .respond_with(ResponseTemplate::new(200))
        .mount(&server)
        .await;

    let yaml = format!(
        r#"
version: 1
name: d
default_think_time:
  min_ms: 300
  max_ms: 300
steps:
  - type: parallel
    id: 01HX0000000000000000000070
    name: p
    branches:
      - name: b1
        steps:
          - type: http
            id: 01HX0000000000000000000071
            name: a
            request: {{ method: GET, url: "{base}/a" }}
"#,
        base = server.uri()
    );
    let scenario = Scenario::from_yaml(&yaml).unwrap();

    let mut o = opts(BTreeMap::new(), 10);
    o.apply_think_time = true;
    let no_default = trace_scenario(&scenario, &o).await;
    assert!(no_default.ok, "trace failed: {:?}", no_default.error);
    assert!(
        no_default.total_ms < 300,
        "분기엔 기본값이 미적용이어야 한다(안 잠) — total_ms={}",
        no_default.total_ms
    );

    // 짝 단언: 분기 스텝에 think_time을 **명시**하면 여전히 적용된다(현행 보존).
    let yaml_explicit = format!(
        r#"
version: 1
name: d
steps:
  - type: parallel
    id: 01HX0000000000000000000070
    name: p
    branches:
      - name: b1
        steps:
          - type: http
            id: 01HX0000000000000000000071
            name: a
            request: {{ method: GET, url: "{base}/a" }}
            think_time:
              min_ms: 300
              max_ms: 300
"#,
        base = server.uri()
    );
    let scenario_explicit = Scenario::from_yaml(&yaml_explicit).unwrap();
    let explicit = trace_scenario(&scenario_explicit, &o).await;
    assert!(explicit.ok, "trace failed: {:?}", explicit.error);
    assert!(
        explicit.total_ms >= 300,
        "분기 스텝의 명시 think_time은 적용돼야 한다 — total_ms={}",
        explicit.total_ms
    );
}
