use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::Duration;

use handicap_engine::{MetricFlush, RampDown, RunPlan, Scenario, run_scenario};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;
use wiremock::matchers::{header, method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

#[tokio::test]
async fn token_extracted_and_reused_in_next_step() {
    let server = MockServer::start().await;

    Mock::given(method("POST"))
        .and(path("/login"))
        .respond_with(ResponseTemplate::new(200).set_body_string(r#"{"access_token":"T0K3N"}"#))
        .mount(&server)
        .await;

    // /me REQUIRES the bearer token; without it wiremock returns 404 (no match).
    Mock::given(method("GET"))
        .and(path("/me"))
        .and(header("authorization", "Bearer T0K3N"))
        .respond_with(ResponseTemplate::new(200).set_body_string("hello"))
        .mount(&server)
        .await;

    let yaml = format!(
        r#"
version: 1
name: token-flow
variables:
  base: "{}"
steps:
  - id: "01HX0000000000000000000001"
    name: login
    type: http
    request:
      method: POST
      url: "{{{{base}}}}/login"
    assert:
      - status: 200
    extract:
      - var: token
        from: body
        path: "$.access_token"
  - id: "01HX0000000000000000000002"
    name: me
    type: http
    request:
      method: GET
      url: "{{{{base}}}}/me"
      headers:
        Authorization: "Bearer {{{{token}}}}"
    assert:
      - status: 200
"#,
        server.uri()
    );

    let scenario = Arc::new(Scenario::from_yaml(&yaml).expect("parses"));
    let (tx, mut rx) = mpsc::channel::<MetricFlush>(64);
    let plan = RunPlan {
        vus: 4,
        ramp_up: Duration::from_secs(0),
        duration: Duration::from_secs(2),
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
    };

    let cancel = CancellationToken::new();
    let scenario_clone = scenario.clone();
    let cancel_clone = cancel.clone();
    let run = tokio::spawn(async move {
        run_scenario(scenario_clone, plan, tx, cancel_clone)
            .await
            .expect("runs");
    });

    let mut total: u64 = 0;
    let mut errors: u64 = 0;
    let mut per_step: BTreeMap<String, (u64, u64)> = BTreeMap::new();
    while let Some(flush) = rx.recv().await {
        for w in flush.windows {
            total += w.count;
            errors += w.error_count;
            let e = per_step.entry(w.step_id.clone()).or_insert((0, 0));
            e.0 += w.count;
            e.1 += w.error_count;
        }
    }
    run.await.expect("join");

    assert!(total > 0, "should record at least one request");
    assert_eq!(
        errors, 0,
        "no extract / assert errors expected; got {total} reqs, {errors} errors"
    );

    let login = per_step
        .get("01HX0000000000000000000001")
        .copied()
        .unwrap_or_default();
    let me = per_step
        .get("01HX0000000000000000000002")
        .copied()
        .unwrap_or_default();
    assert!(
        login.0 > 0 && me.0 > 0,
        "both steps must have requests: login={:?} me={:?}",
        login,
        me
    );
    assert_eq!(login.1, 0);
    assert_eq!(me.1, 0);
}

#[tokio::test]
async fn cookie_jar_session_flow_works() {
    let server = MockServer::start().await;

    Mock::given(method("POST"))
        .and(path("/session-login"))
        .respond_with(
            ResponseTemplate::new(200)
                .insert_header("Set-Cookie", "JSESSIONID=abc; Path=/")
                .set_body_string("ok"),
        )
        .mount(&server)
        .await;

    Mock::given(method("GET"))
        .and(path("/session-me"))
        .and(header("cookie", "JSESSIONID=abc"))
        .respond_with(ResponseTemplate::new(200).set_body_string("hi"))
        .mount(&server)
        .await;

    let yaml = format!(
        r#"
version: 1
name: session-flow
cookie_jar: auto
variables:
  base: "{}"
steps:
  - id: "01HX0000000000000000000010"
    name: login
    type: http
    request:
      method: POST
      url: "{{{{base}}}}/session-login"
    assert:
      - status: 200
  - id: "01HX0000000000000000000011"
    name: me
    type: http
    request:
      method: GET
      url: "{{{{base}}}}/session-me"
    assert:
      - status: 200
"#,
        server.uri()
    );

    let scenario = Arc::new(Scenario::from_yaml(&yaml).expect("parses"));
    let (tx, mut rx) = mpsc::channel::<MetricFlush>(64);
    let plan = RunPlan {
        vus: 3,
        ramp_up: Duration::from_secs(0),
        duration: Duration::from_secs(2),
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
    };

    let cancel = CancellationToken::new();
    let scenario_clone = scenario.clone();
    let cancel_clone = cancel.clone();
    let run = tokio::spawn(async move {
        run_scenario(scenario_clone, plan, tx, cancel_clone)
            .await
            .expect("runs");
    });

    let mut errors: u64 = 0;
    let mut total: u64 = 0;
    while let Some(flush) = rx.recv().await {
        for w in flush.windows {
            total += w.count;
            errors += w.error_count;
        }
    }
    run.await.expect("join");

    assert!(total > 0);
    assert_eq!(errors, 0, "session-me must succeed via cookie jar");
}

#[tokio::test]
async fn env_var_substitution_in_url() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/v2/health"))
        .respond_with(ResponseTemplate::new(200))
        .mount(&server)
        .await;

    let yaml = r#"
version: 1
name: env
variables: {}
steps:
  - id: "01HX0000000000000000000020"
    name: health
    type: http
    request:
      method: GET
      url: "${BASE_URL}/v2/health"
    assert:
      - status: 200
"#;

    let scenario = Arc::new(Scenario::from_yaml(yaml).expect("parses"));
    let env: BTreeMap<String, String> = [("BASE_URL".to_string(), server.uri())]
        .into_iter()
        .collect();
    let (tx, mut rx) = mpsc::channel::<MetricFlush>(64);
    let plan = RunPlan {
        vus: 1,
        ramp_up: Duration::from_secs(0),
        duration: Duration::from_secs(1),
        env,
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
    };

    let cancel = CancellationToken::new();
    let scenario_clone = scenario.clone();
    let cancel_clone = cancel.clone();
    let run = tokio::spawn(async move {
        run_scenario(scenario_clone, plan, tx, cancel_clone)
            .await
            .expect("runs");
    });

    let mut errors: u64 = 0;
    let mut total: u64 = 0;
    while let Some(flush) = rx.recv().await {
        for w in flush.windows {
            total += w.count;
            errors += w.error_count;
        }
    }
    run.await.expect("join");

    assert!(total > 0);
    assert_eq!(errors, 0);
}

#[tokio::test]
async fn cancellation_stops_run_quickly() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/"))
        .respond_with(ResponseTemplate::new(200))
        .mount(&server)
        .await;

    let yaml = format!(
        r#"
version: 1
name: long
variables:
  base: "{}"
steps:
  - id: "01HX0000000000000000000030"
    name: ping
    type: http
    request:
      method: GET
      url: "{{{{base}}}}/"
    assert:
      - status: 200
"#,
        server.uri()
    );
    let scenario = Arc::new(Scenario::from_yaml(&yaml).expect("parses"));
    let (tx, mut rx) = mpsc::channel::<MetricFlush>(64);
    let plan = RunPlan {
        vus: 3,
        ramp_up: Duration::from_secs(0),
        duration: Duration::from_secs(30),
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
    };

    let cancel = CancellationToken::new();
    let scenario_clone = scenario.clone();
    let cancel_clone = cancel.clone();
    let run =
        tokio::spawn(async move { run_scenario(scenario_clone, plan, tx, cancel_clone).await });
    // Drain in the background so the sender doesn't fill up.
    let drain = tokio::spawn(async move { while rx.recv().await.is_some() {} });

    tokio::time::sleep(Duration::from_millis(300)).await;
    cancel.cancel();

    let started = std::time::Instant::now();
    let r = run.await.expect("join");
    drain.await.ok();
    let elapsed = started.elapsed();

    assert!(matches!(r, Err(handicap_engine::EngineError::Aborted)));
    assert!(
        elapsed < Duration::from_secs(6),
        "cancel should land within 6s, took {elapsed:?}"
    );
}
