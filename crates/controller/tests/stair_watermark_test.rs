//! 계단 자동 정지 감시의 데이터 완결 전제(spec §4.4): 워커 수위 = 받은 open-loop 초의
//! 최댓값이면 그 초까지의 metric window도 다 왔다. 엔진을 고치지 않고 공개 진입점
//! `run_scenario_open_loop`로 짧은 계단 open-loop를 돌려 받은 `MetricFlush` 열에서 단언한다.

use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::Duration;

use handicap_controller::stair::{StairConfig, expand_stair};
use handicap_engine::{MetricFlush, RampDown, RunPlan, Scenario, run_scenario_open_loop};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;
use wiremock::matchers::method;
use wiremock::{Mock, MockServer, ResponseTemplate};

fn scenario(url: &str) -> Arc<Scenario> {
    let yaml = format!(
        "version: 1\nname: wm\nsteps:\n  - id: 01HX0000000000000000000010\n    name: get\n    type: http\n    request:\n      method: GET\n      url: {url}\n"
    );
    Arc::new(serde_yaml::from_str(&yaml).unwrap())
}

#[tokio::test]
async fn watermark_implies_windows_arrived() {
    let server = MockServer::start().await;
    // 응답이 초 경계를 넘도록 지연 — 시작한 초와 끝난 초가 갈리는 요청을 만든다.
    Mock::given(method("GET"))
        .respond_with(ResponseTemplate::new(200).set_delay(Duration::from_millis(400)))
        .mount(&server)
        .await;
    // 짧은 계단 2개(상승 1초 + 유지 2초) — 약 6초.
    let stages = expand_stair(&StairConfig {
        targets: vec![20, 40],
        hold_seconds: 2,
        ramp_seconds: 1,
        discard_seconds: 0,
        p99_cap_ms: None,
        auto_stop: None,
    });
    let secs: u32 = stages.iter().map(|s| s.duration_seconds).sum();
    let plan = RunPlan {
        vus: 0,
        ramp_up: Duration::ZERO,
        duration: Duration::from_secs(u64::from(secs)),
        env: BTreeMap::new(),
        loop_breakdown_cap: 256,
        vu_offset: 0,
        data_bindings: vec![],
        http_timeout: Duration::from_secs(30),
        think_time: None,
        think_seed: None,
        target_rps: Some(40),
        max_in_flight: Some(64),
        stages: Some(stages),
        measure_phases: false,
        vu_stages: None,
        ramp_down: RampDown::Graceful,
        graceful_ramp_down: None,
        connect_timeout: None,
    };
    let (tx, mut rx) = mpsc::channel::<MetricFlush>(256);
    let h = tokio::spawn(run_scenario_open_loop(
        scenario(&format!("{}/", server.uri())),
        plan,
        tx,
        CancellationToken::new(),
    ));
    let mut flushes = Vec::new();
    while let Some(f) = rx.recv().await {
        flushes.push(f);
    }
    h.await.unwrap().unwrap();

    // W = 앞 flush들까지 받은 open-loop 초의 최댓값. 뒤 flush의 window는 모두 W보다 뒤 초다.
    let mut w: Option<i64> = None;
    let mut checked = 0usize;
    let mut marks = 0usize;
    for (k, f) in flushes.iter().enumerate() {
        if let Some(wk) = w {
            for win in &f.windows {
                assert!(
                    win.ts_second > wk,
                    "flush {k}: window ts {} ≤ 앞 수위 {wk}",
                    win.ts_second
                );
                checked += 1;
            }
        }
        let m = f.open_loop_seconds.iter().map(|s| s.ts_second).max();
        if m.is_some() {
            marks += 1;
        }
        w = w.max(m);
    }
    assert!(marks >= 3, "open-loop 초를 실은 flush가 {marks}개");
    assert!(checked > 0, "수위 뒤에 온 window가 없다 — 성질을 보지 못함");
}
