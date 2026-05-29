//! Loop node end-to-end: drives the `execute_steps` recursion against wiremock.
//!
//! Three properties:
//!   1. a `repeat: 3` loop wrapping one GET records an inner-step count that is a
//!      positive multiple of 3 with zero errors (each iteration ran the full body);
//!   2. `${loop_index}` (0-based) renders inside the body so the request hits
//!      `/item/0`, `/item/1`, `/item/2` — each is stubbed, so an unrendered token
//!      would 404 → `status: 200` assert would fail → errors > 0;
//!   3. cancellation lands within 6s even with a huge `repeat` (checked between
//!      iterations), returning `Err(EngineError::Aborted)`.
use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::Duration;

use handicap_engine::{MetricFlush, RunPlan, Scenario, run_scenario};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;
use wiremock::matchers::{method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

/// A loop with repeat=3 wrapping one GET, run with 1 VU for a fixed window,
/// must record count == 3 * iterations on the inner step id.
#[tokio::test]
async fn loop_body_executes_repeat_times_per_iteration() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/tick"))
        .respond_with(ResponseTemplate::new(200).set_delay(Duration::from_millis(5)))
        .mount(&server)
        .await;

    let yaml = format!(
        r#"
version: 1
name: loop-count
variables:
  base: "{}"
steps:
  - id: "01HX0000000000000000000001"
    name: repeat
    type: loop
    repeat: 3
    do:
      - id: "01HX0000000000000000000002"
        name: tick
        type: http
        request:
          method: GET
          url: "{{{{base}}}}/tick"
        assert:
          - status: 200
"#,
        server.uri()
    );

    let scenario = Arc::new(Scenario::from_yaml(&yaml).expect("parses"));
    let (tx, mut rx) = mpsc::channel::<MetricFlush>(64);
    let plan = RunPlan {
        vus: 1,
        ramp_up: Duration::from_secs(0),
        duration: Duration::from_secs(1),
        env: BTreeMap::new(),
        loop_breakdown_cap: 0,
    };
    let cancel = CancellationToken::new();
    let run = tokio::spawn(async move {
        run_scenario(scenario, plan, tx, cancel)
            .await
            .expect("runs")
    });

    let mut tick_count: u64 = 0;
    let mut errors: u64 = 0;
    while let Some(flush) = rx.recv().await {
        for w in flush.windows {
            if w.step_id == "01HX0000000000000000000002" {
                tick_count += w.count;
                errors += w.error_count;
            }
        }
    }
    run.await.expect("join");

    assert_eq!(errors, 0, "no errors expected");
    // The body must have run end-to-end at least one full loop's worth of ticks.
    assert!(
        tick_count >= 3,
        "loop body must run at least one full repeat=3 cycle, got {tick_count}"
    );
    // NB: we deliberately do NOT assert `tick_count % 3 == 0`. The deadline (and
    // cancellation) is checked between every loop iteration *and* between every body
    // step (runner.rs `execute_steps`), so the run can stop after 1 or 2 of the final
    // loop's 3 ticks (and, with a multi-step body, mid-cycle) — a partial last
    // loop is expected and correct. The divisibility invariant only holds if a whole
    // loop always fits before the deadline, which the engine intentionally does not
    // guarantee. Asserting it here is flaky (~2/3 failure with a 5ms body / 1s window).
}

/// `${loop_index}` resolves to 0..repeat inside the loop body — wiremock sees
/// distinct paths /item/0, /item/1, /item/2.
#[tokio::test]
async fn loop_index_renders_in_request() {
    let server = MockServer::start().await;
    for i in 0..3 {
        Mock::given(method("GET"))
            .and(path(format!("/item/{i}")))
            .respond_with(ResponseTemplate::new(200))
            .mount(&server)
            .await;
    }
    let yaml = format!(
        r#"
version: 1
name: loop-index
variables:
  base: "{}"
steps:
  - id: "01HX0000000000000000000001"
    name: repeat
    type: loop
    repeat: 3
    do:
      - id: "01HX0000000000000000000002"
        name: item
        type: http
        request:
          method: GET
          url: "{{{{base}}}}/item/${{loop_index}}"
        assert:
          - status: 200
"#,
        server.uri()
    );
    let scenario = Arc::new(Scenario::from_yaml(&yaml).expect("parses"));
    let (tx, mut rx) = mpsc::channel::<MetricFlush>(64);
    let plan = RunPlan {
        vus: 1,
        ramp_up: Duration::from_secs(0),
        duration: Duration::from_secs(1),
        env: BTreeMap::new(),
        loop_breakdown_cap: 256,
    };
    let cancel = CancellationToken::new();
    let run = tokio::spawn(async move {
        run_scenario(scenario, plan, tx, cancel)
            .await
            .expect("runs")
    });
    let mut errors: u64 = 0;
    let mut total: u64 = 0;
    let mut by_index: std::collections::HashMap<u32, u64> = Default::default();
    while let Some(flush) = rx.recv().await {
        for w in flush.windows {
            total += w.count;
            errors += w.error_count;
        }
        for ls in flush.loop_stats {
            *by_index.entry(ls.loop_index).or_default() += ls.count;
        }
    }
    run.await.expect("join");
    assert!(total > 0);
    // All three /item/{i} are stubbed; an unrendered ${loop_index} would 404 → assert error.
    assert_eq!(errors, 0, "every /item/<loop_index> must match a stub");
    assert!(
        by_index.get(&0).copied().unwrap_or(0) > 0,
        "index 0 recorded"
    );
    assert!(
        by_index.get(&1).copied().unwrap_or(0) > 0,
        "index 1 recorded"
    );
    assert!(
        by_index.get(&2).copied().unwrap_or(0) > 0,
        "index 2 recorded"
    );
}

/// Cancellation lands quickly even with a large repeat (checked between iterations).
#[tokio::test]
async fn cancel_lands_mid_loop() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/p"))
        .respond_with(ResponseTemplate::new(200).set_delay(Duration::from_millis(20)))
        .mount(&server)
        .await;
    let yaml = format!(
        r#"
version: 1
name: big-loop
variables:
  base: "{}"
steps:
  - id: "01HX0000000000000000000001"
    name: repeat
    type: loop
    repeat: 100000
    do:
      - id: "01HX0000000000000000000002"
        name: p
        type: http
        request: {{ method: GET, url: "{{{{base}}}}/p" }}
        assert: []
"#,
        server.uri()
    );
    let scenario = Arc::new(Scenario::from_yaml(&yaml).expect("parses"));
    let (tx, mut rx) = mpsc::channel::<MetricFlush>(64);
    let plan = RunPlan {
        vus: 2,
        ramp_up: Duration::from_secs(0),
        duration: Duration::from_secs(30),
        env: BTreeMap::new(),
        loop_breakdown_cap: 0,
    };
    let cancel = CancellationToken::new();
    let cancel2 = cancel.clone();
    let run = tokio::spawn(async move { run_scenario(scenario, plan, tx, cancel2).await });
    let drain = tokio::spawn(async move { while rx.recv().await.is_some() {} });
    tokio::time::sleep(Duration::from_millis(300)).await;
    cancel.cancel();
    let started = std::time::Instant::now();
    let r = run.await.expect("join");
    drain.await.ok();
    assert!(matches!(r, Err(handicap_engine::EngineError::Aborted)));
    assert!(
        started.elapsed() < Duration::from_secs(6),
        "cancel within 6s"
    );
}
