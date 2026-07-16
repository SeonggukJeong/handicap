use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::Duration;

use handicap_engine::{MetricFlush, RampDown, RunPlan, Scenario, run_scenario};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;
use wiremock::matchers::{body_json, method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

/// `{{age:num}}` / `{{vip:bool}}`가 JSON **number/bool**로 타겟에 도달하는지.
/// wiremock Mock이 `body_json`으로 정확한 타입의 본문만 200으로 매칭하므로,
/// 엔진이 문자열("30"/"true")을 보내면 매칭 실패 → wiremock 404 → assert 실패 →
/// error_count > 0. 하니스는 `crates/engine/tests/multi_step.rs`와 동일 형태
/// (bounded 채널이라 run_scenario를 spawn하고 rx를 동시 drain — await-후-drain은
/// 데드락).
#[tokio::test]
async fn casts_send_json_number_and_bool() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/order"))
        .and(body_json(serde_json::json!({ "age": 30, "vip": true })))
        .respond_with(ResponseTemplate::new(200))
        .mount(&server)
        .await;

    let yaml = format!(
        r#"
version: 1
name: cast-flow
variables:
  base: "{}"
  age: "30"
  vip: "true"
steps:
  - id: "01HX0000000000000000000001"
    name: order
    type: http
    request:
      method: POST
      url: "{{{{base}}}}/order"
      body:
        json:
          age: "{{{{age:num}}}}"
          vip: "{{{{vip:bool}}}}"
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
    let cancel_clone = cancel.clone();
    let run = tokio::spawn(async move {
        run_scenario(scenario, plan, tx, cancel_clone)
            .await
            .expect("runs");
    });

    let mut total: u64 = 0;
    let mut errors: u64 = 0;
    while let Some(flush) = rx.recv().await {
        for w in flush.windows {
            total += w.count;
            errors += w.error_count;
        }
    }
    run.await.expect("join");

    assert!(total > 0, "no requests recorded");
    assert_eq!(errors, 0, "casted body did not match (sent as string?)");
}
