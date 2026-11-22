use std::collections::BTreeMap;
use std::time::Duration;

use handicap_engine::{Scenario, StepKind, TraceOptions, trace_scenario, trace_scenario_with_seed};
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

#[tokio::test]
async fn seeded_trace_overrides_scenario_variables() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/u/dataset-user"))
        .respond_with(ResponseTemplate::new(200))
        .mount(&server)
        .await;

    let yaml = format!(
        r#"
version: 1
name: seeded
variables:
  username: scenario-user
  keep: base
steps:
  - type: http
    id: 01HX0000000000000000000010
    name: a
    request: {{ method: GET, url: "{base}/u/{{{{username}}}}" }}
"#,
        base = server.uri()
    );
    let scenario = Scenario::from_yaml(&yaml).unwrap();
    let mut seed = BTreeMap::new();
    seed.insert("username".to_string(), "dataset-user".to_string());
    let trace = trace_scenario_with_seed(&scenario, &opts(BTreeMap::new(), 50), &seed).await;
    assert!(trace.ok, "{trace:?}");
    // 시드가 동명 시나리오 변수를 이긴다 (run_vu의 variables.clone() 후 insert 미러 — R4)
    let url = &trace.steps[0].request.as_ref().unwrap().url;
    assert!(url.ends_with("/u/dataset-user"), "{url}");
    // 시드 안 된 변수는 유지, final_vars엔 시드 반영
    assert_eq!(
        trace.final_vars.get("keep").map(String::as_str),
        Some("base")
    );
    assert_eq!(
        trace.final_vars.get("username").map(String::as_str),
        Some("dataset-user")
    );
}

#[tokio::test]
async fn seeded_trace_with_empty_seed_matches_plain_trace_shape() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/a"))
        .respond_with(ResponseTemplate::new(200))
        .mount(&server)
        .await;
    let yaml = format!(
        r#"
version: 1
name: plain
steps:
  - type: http
    id: 01HX0000000000000000000010
    name: a
    request: {{ method: GET, url: "{base}/a" }}
"#,
        base = server.uri()
    );
    let scenario = Scenario::from_yaml(&yaml).unwrap();
    let plain = trace_scenario(&scenario, &opts(BTreeMap::new(), 50)).await;
    let seeded =
        trace_scenario_with_seed(&scenario, &opts(BTreeMap::new(), 50), &BTreeMap::new()).await;
    // total_ms(월클록)만 다를 수 있다 — 구조 필드는 동일 (R1 위임 보존)
    assert_eq!(plain.ok, seeded.ok);
    assert_eq!(plain.steps.len(), seeded.steps.len());
    assert_eq!(plain.final_vars, seeded.final_vars);
    assert_eq!(plain.truncated, seeded.truncated);
}
// ---- monitor-step-panels Task 2: branch_eval / timed_out ----

fn http_yaml(url: &str, timeout: Option<u32>) -> String {
    let t = timeout
        .map(|s| format!("\n    timeout_seconds: {s}"))
        .unwrap_or_default();
    format!(
        r#"
version: 1
name: t
steps:
  - type: http
    id: 01HX0000000000000000000050
    name: h
    request: {{ method: GET, url: "{url}" }}{t}
"#
    )
}

#[tokio::test]
async fn if_row_carries_branch_eval() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/elif"))
        .respond_with(ResponseTemplate::new(200))
        .mount(&server)
        .await;
    let yaml = format!(
        r#"
version: 1
name: branch
variables: {{ go: "b" }}
steps:
  - type: if
    id: 01HX0000000000000000000030
    name: maybe
    cond: {{ left: "{{{{go}}}}", op: eq, right: "a" }}
    then: []
    elif:
      - cond: {{ left: "{{{{go}}}}", op: eq, right: "b" }}
        then:
          - type: http
            id: 01HX0000000000000000000031
            name: t
            request: {{ method: GET, url: "{base}/elif" }}
"#,
        base = server.uri()
    );
    let scenario = Scenario::from_yaml(&yaml).unwrap();
    let trace = trace_scenario(&scenario, &opts(BTreeMap::new(), 50)).await;
    let row = &trace.steps[0];
    assert_eq!(row.branch.as_deref(), Some("elif_0"));
    assert_eq!(row.branch_eval.len(), 2);
    assert_eq!(row.branch_eval[0].branch, "then");
    assert!(!row.branch_eval[0].passed);
    let last = row.branch_eval.last().unwrap();
    assert!(last.passed);
    assert_eq!(last.branch, "elif_0");
    assert_eq!(last.leaf.as_ref().unwrap().left_value.as_deref(), Some("b"));
    // http 행에는 branch_eval이 없다
    assert!(trace.steps[1].branch_eval.is_empty());
}

#[tokio::test]
async fn http_row_json_has_no_new_keys() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .respond_with(ResponseTemplate::new(200))
        .mount(&server)
        .await;
    let scenario = Scenario::from_yaml(&http_yaml(&server.uri(), None)).unwrap();
    let trace = trace_scenario(&scenario, &opts(BTreeMap::new(), 50)).await;
    let v = serde_json::to_value(&trace.steps[0]).unwrap();
    let obj = v.as_object().unwrap();
    assert!(!obj.contains_key("branch_eval"));
    assert!(!obj.contains_key("timed_out"));
}

#[tokio::test]
async fn timed_out_on_send_timeout() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .respond_with(ResponseTemplate::new(200).set_delay(Duration::from_secs(2)))
        .mount(&server)
        .await;
    let scenario = Scenario::from_yaml(&http_yaml(&server.uri(), Some(1))).unwrap();
    let trace = trace_scenario(&scenario, &opts(BTreeMap::new(), 50)).await;
    let row = &trace.steps[0];
    assert!(row.timed_out, "{row:?}");
    assert!(row.error.is_some());
    let v = serde_json::to_value(row).unwrap();
    assert_eq!(v["timed_out"], serde_json::json!(true));
}

#[tokio::test]
async fn timed_out_on_body_read_timeout() {
    use tokio::io::AsyncWriteExt;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        let (mut sock, _) = listener.accept().await.unwrap();
        let _ = sock
            .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\n")
            .await;
        // 본문을 보내지 않고 연결을 유지한다.
        tokio::time::sleep(Duration::from_secs(5)).await;
    });
    let scenario = Scenario::from_yaml(&http_yaml(&format!("http://{addr}/"), Some(1))).unwrap();
    let trace = trace_scenario(&scenario, &opts(BTreeMap::new(), 50)).await;
    let row = &trace.steps[0];
    assert!(row.timed_out, "{row:?}");
    assert!(
        row.error.as_deref().unwrap().starts_with("read body:"),
        "{row:?}"
    );
}

#[tokio::test]
async fn not_timed_out_on_refused() {
    let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let addr = l.local_addr().unwrap();
    drop(l);
    let scenario = Scenario::from_yaml(&http_yaml(&format!("http://{addr}/"), Some(1))).unwrap();
    let trace = trace_scenario(&scenario, &opts(BTreeMap::new(), 50)).await;
    let row = &trace.steps[0];
    assert!(row.error.is_some());
    assert!(!row.timed_out);
}

// ---- 준비 스텝 (vu-setup-steps D11) ----

use handicap_engine::Section;
use wiremock::matchers::header;

fn setup_yaml(setup_req: &str, main_url: &str) -> String {
    format!(
        r#"
version: 1
name: with-setup
setup:
  steps:
    - type: http
      id: 01HX0000000000000000000009
      name: login
      request: {setup_req}
      extract:
        - {{ var: token, from: body, path: "$.token" }}
steps:
  - type: http
    id: 01HX0000000000000000000010
    name: main
    request: {{ method: GET, url: "{main_url}", headers: {{ Authorization: "Bearer {{{{token}}}}" }} }}
"#
    )
}

async fn login_server(body: &str, status: u16) -> MockServer {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/login"))
        .respond_with(ResponseTemplate::new(status).set_body_string(body.to_string()))
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/me"))
        .and(header("authorization", "Bearer t1"))
        .respond_with(ResponseTemplate::new(200))
        .mount(&server)
        .await;
    server
}

fn login_req(base: &str) -> String {
    format!(r#"{{ method: POST, url: "{base}/login" }}"#)
}

#[tokio::test]
async fn trace_setup_then_steps() {
    let server = login_server(r#"{"token":"t1"}"#, 200).await;
    let base = server.uri();
    let y = setup_yaml(&login_req(&base), &format!("{base}/me"));
    let scenario = Scenario::from_yaml(&y).unwrap();
    let trace = trace_scenario(&scenario, &opts(BTreeMap::new(), 50)).await;
    assert!(trace.ok, "{trace:?}");
    assert!(!trace.setup_failed);
    assert!(trace.setup_ms.is_some());
    assert_eq!(trace.steps.len(), 2);
    assert_eq!(trace.steps[0].section, Some(Section::Setup));
    assert_eq!(trace.steps[1].section, None);
    let main_req = trace.steps[1].request.as_ref().unwrap();
    assert_eq!(
        main_req.headers.get("Authorization").map(String::as_str),
        Some("Bearer t1")
    );
    assert_eq!(trace.steps[1].response.as_ref().unwrap().status, 200);
}

#[tokio::test]
async fn trace_setup_failure_stops() {
    let server = login_server("denied", 401).await;
    let base = server.uri();
    let y = setup_yaml(&login_req(&base), &format!("{base}/me"));
    let scenario = Scenario::from_yaml(&y).unwrap();
    let trace = trace_scenario(&scenario, &opts(BTreeMap::new(), 50)).await;
    // 본문이 JSON이 아니라 추출이 실패한다.
    assert!(trace.setup_failed, "{trace:?}");
    assert!(!trace.ok);
    assert_eq!(trace.steps.len(), 1, "본 행 없음");
    assert_eq!(trace.steps[0].section, Some(Section::Setup));
    assert!(trace.steps[0].error.is_some());
    assert!(trace.error.is_none());
}

#[tokio::test]
async fn trace_setup_unbound_var_fails_with_fixed_error() {
    let server = login_server(r#"{"token":"t1"}"#, 200).await;
    let base = server.uri();
    Mock::given(method("POST"))
        .and(path("/login/"))
        .respond_with(ResponseTemplate::new(200).set_body_string(r#"{"token":"t1"}"#))
        .mount(&server)
        .await;
    let req = format!(r#"{{ method: POST, url: "{base}/login/{{{{nope}}}}" }}"#);
    let y = setup_yaml(&req, &format!("{base}/me"));
    let scenario = Scenario::from_yaml(&y).unwrap();
    let trace = trace_scenario(&scenario, &opts(BTreeMap::new(), 50)).await;
    assert!(trace.setup_failed, "{trace:?}");
    assert!(!trace.ok);
    assert_eq!(trace.steps.len(), 1);
    assert_eq!(
        trace.steps[0].error.as_deref(),
        Some("setup: unbound variable")
    );
}

#[tokio::test]
async fn trace_setup_empty_extract_fails() {
    let server = login_server(r#"{"token": null}"#, 200).await;
    let base = server.uri();
    let y = setup_yaml(&login_req(&base), &format!("{base}/me"));
    let scenario = Scenario::from_yaml(&y).unwrap();
    let trace = trace_scenario(&scenario, &opts(BTreeMap::new(), 50)).await;
    assert!(trace.setup_failed, "{trace:?}");
    assert_eq!(trace.steps.len(), 1);
    assert_eq!(
        trace.steps[0].error.as_deref(),
        Some("setup: empty extract")
    );
}

#[tokio::test]
async fn trace_setup_truncated_is_not_failed() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .respond_with(ResponseTemplate::new(200))
        .mount(&server)
        .await;
    let base = server.uri();
    let y = format!(
        r#"
version: 1
name: two-setup
setup:
  steps:
    - type: http
      id: 01HX0000000000000000000008
      name: s1
      request: {{ method: GET, url: "{base}/a" }}
    - type: http
      id: 01HX0000000000000000000009
      name: s2
      request: {{ method: GET, url: "{base}/b" }}
steps:
  - type: http
    id: 01HX0000000000000000000010
    name: main
    request: {{ method: GET, url: "{base}/c" }}
"#
    );
    let scenario = Scenario::from_yaml(&y).unwrap();
    let trace = trace_scenario(&scenario, &opts(BTreeMap::new(), 1)).await;
    assert!(trace.truncated, "{trace:?}");
    assert!(!trace.setup_failed);
    assert_eq!(trace.steps.len(), 1, "본 스텝은 실행하지 않는다");
}

#[tokio::test]
async fn trace_first_pass_reuses_setup_seeded_scenario_vars() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .respond_with(ResponseTemplate::new(200).set_body_string(r#"{"token":"t1"}"#))
        .mount(&server)
        .await;
    let base = server.uri();
    let y = format!(
        r#"
version: 1
name: reuse
variables:
  oid: {{ gen: uuid }}
setup:
  steps:
    - type: http
      id: 01HX0000000000000000000009
      name: login
      request: {{ method: GET, url: "{base}/s/{{{{oid}}}}" }}
      extract:
        - {{ var: token, from: body, path: "$.token" }}
steps:
  - type: http
    id: 01HX0000000000000000000010
    name: main
    request: {{ method: GET, url: "{base}/m/{{{{oid}}}}" }}
"#
    );
    let scenario = Scenario::from_yaml(&y).unwrap();
    let trace = trace_scenario(&scenario, &opts(BTreeMap::new(), 50)).await;
    assert!(trace.ok, "{trace:?}");
    let setup_url = &trace.steps[0].request.as_ref().unwrap().url;
    let main_url = &trace.steps[1].request.as_ref().unwrap().url;
    let setup_id = setup_url.rsplit('/').next().unwrap();
    let main_id = main_url.rsplit('/').next().unwrap();
    assert!(!setup_id.is_empty());
    assert_eq!(setup_id, main_id, "첫 패스는 다시 시드하지 않는다");
}

#[tokio::test]
async fn trace_no_setup_json_unchanged() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .respond_with(ResponseTemplate::new(200))
        .mount(&server)
        .await;
    let base = server.uri();
    let y = format!(
        r#"
version: 1
name: plain
steps:
  - type: http
    id: 01HX0000000000000000000010
    name: a
    request: {{ method: GET, url: "{base}/a" }}
"#
    );
    let scenario = Scenario::from_yaml(&y).unwrap();
    let trace = trace_scenario(&scenario, &opts(BTreeMap::new(), 50)).await;
    let v = serde_json::to_value(&trace).unwrap();
    for key in ["setup_failed", "setup_ms"] {
        assert!(v.get(key).is_none(), "{key}");
    }
    assert!(v["steps"][0].get("section").is_none());
}

#[test]
fn trace_without_new_keys_deserializes() {
    let t: handicap_engine::ScenarioTrace = serde_json::from_str(
        r#"{"ok":true,"total_ms":1,"steps":[],"final_vars":{},"truncated":false,"error":null}"#,
    )
    .unwrap();
    assert!(!t.setup_failed);
    assert_eq!(t.setup_ms, None);
    let r: handicap_engine::RowsTrace =
        serde_json::from_str(r#"{"ok":true,"truncated":false,"total_ms":1,"rows":[]}"#).unwrap();
    assert!(!r.setup_failed);
    assert_eq!(r.setup_ms, None);
    assert!(r.setup_steps.is_empty());
    let s: handicap_engine::StepTrace = serde_json::from_str(
        r#"{"step_id":"x","kind":"http","loop_index":null,"branch":null,"request":null,"response":null,"error":null}"#,
    )
    .unwrap();
    assert_eq!(s.section, None);
}
